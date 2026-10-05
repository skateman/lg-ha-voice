/**
 * Entry point – wires UI and HAClient together.
 * Voice pipeline runs in the Luna service (service/index.js) because the
 * Magic Remote mic is only accessible via com.webos.service.voiceinput, not
 * via WebRTC getUserMedia.  The browser app drives the UI and TTS playback.
 *
 * webOS Magic Remote key codes relevant to us:
 *   409  – RECORD / MIC button (on some models)
 *   1060 – webOS AI button (some firmwares)
 *   13   – OK / Enter (also triggers voice)
 *   461  – BACK
 *
 * Mic button (keycode 428) is handled by inputhook → service/voice/start.
 * Legacy inputhook also signals service/voice/stop on release; inputhookpp
 * relies on voiceinput VAD. The OK button and orb click use the same endpoints.
 */

import { HAClient } from './ha-client.js';
import { lunaCall, lunaSubscribe } from './luna.js';

// ── Key codes ──────────────────────────────────────────────────────────────────
const KEY = {
  OK: 13,
  BACK: 461,
  MIC: 409,
  AI: 1060,
};
const VOICE_KEYS = new Set([KEY.OK, KEY.MIC, KEY.AI]);

// ── Voice state (mirrored from service via subscription) ──────────────────────
const SvcState = Object.freeze({
  IDLE:       'idle',
  STARTING:   'starting',
  LISTENING:  'listening',
  PROCESSING: 'processing',
  SPEAKING:   'speaking',
  ERROR:      'error',
});

let svcState          = SvcState.IDLE;
let svcTranscript     = '';
let _voiceStateSub    = null;  // cancel function for the voice/state subscription
let _appInitiatedVoice = false; // true when THIS app called voiceStart(), to distinguish from mic-button

// ── Config storage ─────────────────────────────────────────────────────────────
const CONFIG_KEY = 'ha_voice_config';

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null') ?? {};
  } catch (_) { return {}; }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function syncServiceConfig(overrideToken) {
  if (!config.url) return Promise.resolve();
  return lunaCall('luna://com.homebrew.havoice.service/setHAConfig', {
    url:          config.url,
    token:        overrideToken || config.token,
    pipelineId:   config.pipelineId   || '',
    refreshToken: config.refreshToken || '',
    clientId:     config.clientId     || '',
    sttMode:      config.sttMode      || 'lg',
  }).catch(err => console.warn('[main] setHAConfig failed:', err.message));
}

function updateStoredToken(newToken, newRefreshToken) {
  config.token = newToken;
  if (newRefreshToken) config.refreshToken = newRefreshToken;
  const cfg = loadConfig();
  cfg.token = newToken;
  if (newRefreshToken) cfg.refreshToken = newRefreshToken;
  saveConfig(cfg);
  syncServiceConfig(newToken);
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screenConfig  = $('screen-config');
const screenMain    = $('screen-main');
const inputUrl      = $('ha-url');
const inputToken    = $('ha-token');
const inputPipeline = $('pipeline-id');
const selectSttMode = $('stt-mode');
const btnSave       = $('btn-save');
const configStatus  = $('config-status');
const orb           = $('orb');
const stateLabel    = $('state-label');
const transcriptBox = $('transcript-box');
const transcriptText = $('transcript-text');
const connIndicator = $('conn-indicator');
const connLabel     = $('conn-label');
const btnSettings      = $('btn-settings');
const setupNotice      = $('setup-notice');
const btnSetup         = $('btn-setup');
const setupStatus      = $('setup-status');
const setupUrl         = $('setup-url');
const voiceOverlay     = $('voice-overlay');
const overlayLabel     = $('overlay-label');
const overlayTranscript = $('overlay-transcript');
const appEl            = $('app');

// ── App state ──────────────────────────────────────────────────────────────────
let haClient     = null;
let config       = loadConfig();
let _overlayMode = false;  // true when launched from another app via overlay param
let _authRecoveryTried = false; // guard: only try service-config recovery once per session
let _lastTtsUrl = '';

// ── webOS launch params ────────────────────────────────────────────────────────
function getLaunchParams() {
  try {
    return JSON.parse(window.PalmSystem?.launchParams ?? '{}');
  } catch (_) { return {}; }
}

if (window.PalmSystem) {
  document.addEventListener('webOSRelaunch', (e) => {
    let params = {};
    try { params = JSON.parse(e.detail ?? '{}'); } catch (_) {}
    handleLaunchParams(params);
  });
}

// ── Launch param handling ───────────────────────────────────────────────────────
function handleLaunchParams(params) {
  if (params.config) {
    const { url, token, refreshToken, clientId } = params.config;
    if (url && token) {
      config = { url, token, refreshToken: refreshToken ?? '', clientId: clientId ?? '', pipelineId: '', sttMode: config.sttMode || 'lg' };
      saveConfig(config);
      haClient?.disconnect();
      haClient = null;
      _overlayMode = false;
      showMain();
      subscribeVoiceState();
      initClient({});
    }
    return;
  }

  if (params.action === 'overlay') {
    // Launched from another app via mic button – show overlay, auto-hide when done.
    // webOSRelaunch does not reliably fire on all TV models, so subscribeVoiceState
    // is also auto-triggered from the subscription callback on state transitions.
    _overlayMode = true;
    showMain();
    subscribeVoiceState();
    return;
  }

  if (!haClient?.connected) return;

  if (params.action === 'start') {
    voiceStart();
  } else if (params.action === 'stop') {
    voiceStop();
  } else if (params.autoListen) {
    voiceStart();
  }
}

// ── Visibility-based re-subscribe ─────────────────────────────────────────────
// webOS WAM may freeze JS when the app is backgrounded, so the voice/state
// subscription callback won't fire while frozen.  When applicationManager/launch
// brings the app to the foreground, visibilitychange fires and we re-subscribe
// to get the current service state immediately.
function refreshVoiceStateSubscription() {
  if (!document.hidden && screenMain.classList.contains('active')) {
    subscribeVoiceState();
  }
}

document.addEventListener('visibilitychange', refreshVoiceStateSubscription);
window.addEventListener('focus', refreshVoiceStateSubscription);
window.addEventListener('pageshow', refreshVoiceStateSubscription);

// ── Boot ───────────────────────────────────────────────────────────────────────
const launchParams = getLaunchParams();

// Set overlay mode immediately from launch params — don't wait for HA connection
// or the voice/state subscription. If the pipeline finishes before those are ready,
// _overlayMode would stay false and PalmSystem.hide() would never be called.
if (launchParams.action === 'overlay') {
  _overlayMode = true;
}

function startConfiguredApp(params) {
  showMain();
  subscribeVoiceState();
  initClient(params);
}

if (window.PalmServiceBridge) {
  // The service copy survives WAM localStorage loss and can refresh OAuth
  // tokens. Prefer it on every boot so updates never start from stale creds.
  lunaCall('luna://com.homebrew.havoice.service/getConfig', {})
    .then(svcCfg => {
      applyServiceConfig(svcCfg);
      startConfiguredApp(launchParams);
    })
    .catch(() => {
      if (config.url && config.token) startConfiguredApp(launchParams);
      else showConfig();
    });
} else if (config.url && config.token) {
  startConfiguredApp(launchParams);
} else {
  showConfig();
}

// ── Config screen ──────────────────────────────────────────────────────────────
function showConfig() {
  screenConfig.classList.add('active');
  screenMain.classList.remove('active');

  inputUrl.value      = config.url ?? '';
  inputToken.value    = config.token ?? '';
  inputPipeline.value = config.pipelineId ?? '';
  selectSttMode.value = config.sttMode ?? 'lg';

  setTimeout(() => inputUrl.focus(), 100);
  startSetupServer();
}

let _configPollTimer = null;

function stopConfigPolling() {
  if (_configPollTimer) { clearInterval(_configPollTimer); _configPollTimer = null; }
}

function startConfigPolling() {
  stopConfigPolling();
  _configPollTimer = setInterval(async () => {
    if (!screenConfig.classList.contains('active')) { stopConfigPolling(); return; }
    try {
      // F3: pull the phone-completed setup config over Luna (bus-authenticated),
      // not the old public /pending-config HTTP route.
      const res = await lunaCall('luna://com.homebrew.havoice.service/getPendingConfig', {});
      const cfg = res && res.config;
      if (cfg && cfg.url && cfg.token) {
        stopConfigPolling();
        config = { url: cfg.url, token: cfg.token, refreshToken: cfg.refreshToken || '', clientId: cfg.clientId || '', pipelineId: '' };
        saveConfig(config);
        showMain();
        initClient({});
      }
    } catch (_) {}
  }, 2000);
}

async function startSetupServer() {
  if (!window.PalmServiceBridge) return;

  setupUrl.textContent = 'Starting…';

  let lastErr = '';
  for (let i = 0; i < 8; i++) {
    try {
      const res = await lunaCall('luna://com.homebrew.havoice.service/startSetupServer', {});
      if (res.url) {
        setupUrl.textContent = res.url;
        startConfigPolling();
        return;
      }
      lastErr = 'no url in response';
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  setupUrl.textContent = 'Error: ' + lastErr;
}

// Build the app config from the service's persisted copy (which holds the OAuth
// refresh token + clientId and auto-refreshes the access token in getConfig).
function applyServiceConfig(svcCfg) {
  config = {
    url:          svcCfg.url,
    token:        svcCfg.token,
    pipelineId:   svcCfg.pipelineId   || '',
    refreshToken: svcCfg.refreshToken || '',
    clientId:     svcCfg.clientId     || '',
    sttMode:      svcCfg.sttMode      || 'lg',
  };
  saveConfig(config); // heal any localStorage/service divergence
}

/**
 * Last-ditch recovery when the stored token fails auth: the Luna service keeps
 * the refresh token + clientId and refreshes the access token inside getConfig,
 * so a localStorage copy that lost its refresh creds can be rescued from it
 * instead of dumping the user back to the setup screen.
 */
async function recoverFromServiceConfig() {
  if (!window.PalmServiceBridge) throw new Error('no service bridge');
  const svcCfg = await lunaCall('luna://com.homebrew.havoice.service/getConfig', {});
  if (!svcCfg || !svcCfg.url || !svcCfg.token) throw new Error('no service config');
  // Only worth retrying if the service can actually refresh (has creds) or gave
  // us a different (freshly-refreshed) token than the one that just failed.
  if (svcCfg.token === config.token && !svcCfg.refreshToken) throw new Error('nothing better to try');
  applyServiceConfig(svcCfg);
  haClient?.disconnect();
  haClient = null;
  showMain();
  initClient({});
}

function showMain() {
  screenConfig.classList.remove('active');
  screenMain.classList.add('active');
  armIdle();
}

function showConfigStatus(msg, type) {
  configStatus.textContent = msg;
  configStatus.className = `status-msg ${type}`;
}

btnSave.addEventListener('click', () => {
  const url        = inputUrl.value.trim();
  const token      = inputToken.value.trim();
  const pipelineId = inputPipeline.value.trim();
  const sttMode    = selectSttMode.value || 'lg';

  if (!url || !token) {
    showConfigStatus('URL and token are required.', 'error');
    return;
  }

  stopConfigPolling();
  const preserveOAuth = url === config.url && token === config.token;
  config = {
    url,
    token,
    pipelineId,
    sttMode,
    refreshToken: preserveOAuth ? (config.refreshToken ?? '') : '',
    clientId:     preserveOAuth ? (config.clientId ?? '') : '',
  };
  saveConfig(config);
  lunaCall('luna://com.homebrew.havoice.service/stopSetupServer', {}).catch(() => {});
  showConfigStatus('Connecting…', '');

  haClient?.disconnect();
  haClient = null;

  showMain();
  initClient({});
});

btnSettings.addEventListener('click', () => {
  haClient?.disconnect();
  haClient = null;
  cancelVoiceStateSub();
  cancelTvPowerSub();
  showConfig();
});

// ── HA Client ──────────────────────────────────────────────────────────────────
function initClient(initialParams = {}) {
  haClient = new HAClient({
    url:              config.url,
    token:            config.token,
    refreshToken:     config.refreshToken ?? '',
    clientId:         config.clientId ?? '',
    onTokenRefreshed: updateStoredToken,
  });

  haClient.on('connecting',    () => setConnState('connecting', 'Connecting…'));
  haClient.on('reconnecting', (delay) => setConnState('connecting', `Reconnecting in ${Math.round(delay/1000)}s…`));

  haClient.on('connected', () => {
    setConnState('connected', 'Connected');
    _authRecoveryTried = false;

    // Push HA config to service so it can run the voice pipeline.
    syncServiceConfig();

    checkSetup();
    subscribeVoiceState();
    subscribeTvPower();

    if (initialParams && Object.keys(initialParams).length) {
      const p = initialParams;
      initialParams = {};
      setTimeout(() => handleLaunchParams(p), 300);
    }
  });

  haClient.on('disconnected', () => {
    setConnState('disconnected', 'Disconnected');
    // Do NOT cancel voice/state subscription on HA disconnect — it is a local
    // Luna service subscription and must stay alive for mic-button feedback.
    cancelTvPowerSub();
  });

  haClient.on('auth_error', (msg) => {
    setConnState('disconnected', 'Auth failed');
    if (!_authRecoveryTried) {
      _authRecoveryTried = true;
      setConnState('connecting', 'Recovering…');
      recoverFromServiceConfig().catch(() => {
        showConfig();
        showConfigStatus(`Authentication failed: ${msg}`, 'error');
      });
      return;
    }
    showConfig();
    showConfigStatus(`Authentication failed: ${msg}`, 'error');
  });

  haClient.connect();
}

function setConnState(cls, label) {
  connIndicator.className = `conn-dot ${cls}`;
  connLabel.textContent = label;
}

// ── First-run setup ────────────────────────────────────────────────────────────
async function checkSetup() {
  try {
    const res = await lunaCall('luna://com.homebrew.havoice.service/isSetupDone', {});
    if (!res.done) showSetupNotice();
  } catch (_) {}
}

function showSetupNotice() { setupNotice.classList.remove('hidden'); }
function hideSetupNotice() { setupNotice.classList.add('hidden'); }

btnSetup.addEventListener('click', async () => {
  btnSetup.disabled  = true;
  setupStatus.textContent = 'Requesting elevation…';

  try {
    await lunaCall('luna://org.webosbrew.hbchannel.service/elevateService', {
      id: 'com.homebrew.havoice.service',
    });
  } catch (err) {
    console.warn('[Setup] elevateService failed:', err.message);
  }

  setupStatus.textContent = 'Configuring mic button…';

  try {
    await lunaCall('luna://com.homebrew.havoice.service/setup', {});
    setupStatus.textContent = 'Done! Press the mic button to talk.';
    setTimeout(hideSetupNotice, 2000);
  } catch (err) {
    setupStatus.textContent = `Failed: ${err.message}. Run setup.sh via SSH.`;
    btnSetup.disabled = false;
  }
});

// ── Service state subscription ────────────────────────────────────────────────
// Subscribe once; the service pushes a message on every state transition.

function subscribeVoiceState() {
  cancelVoiceStateSub();
  _voiceStateSub = lunaSubscribe(
    'luna://com.homebrew.havoice.service/voice/state',
    {},
    (res) => {
      if (!res.returnValue) return;
      const newState = res.state || SvcState.IDLE;
      svcTranscript  = res.transcript || '';

      // Mic button pressed while in another app: service launched us but
      // webOSRelaunch may not fire on this TV model.  Detect the idle→listening
      // transition and enter overlay mode so we auto-hide when the pipeline ends.
      if ((newState === SvcState.STARTING || newState === SvcState.LISTENING)
          && svcState === SvcState.IDLE) {
        if (_appInitiatedVoice) {
          _appInitiatedVoice = false; // app started it — stay in normal mode
        } else if (!_overlayMode && document.hidden) {
          // External trigger (mic button) while app is backgrounded — act as overlay.
          // Skip when app is foreground: PalmSystem.hide() would wrongly dismiss it.
          _overlayMode = true;
          try { window.PalmSystem?.show?.(); } catch (_) {}
        }
      }

      svcState = newState;
      setOrbState(svcState);
      if (svcTranscript) {
        showTranscript(svcTranscript);
        showToast(svcTranscript);
      }
      if (res.ttsUrl) {
        if (res.ttsUrl !== _lastTtsUrl) {
          _lastTtsUrl = res.ttsUrl;
          playTts(res.ttsUrl, res.responseText || '');
        }
        lunaCall('luna://com.homebrew.havoice.service/voice/ackTts', {
          ttsUrl: res.ttsUrl,
        }).catch(() => {});
      }
    }
  );
}

function cancelVoiceStateSub() {
  if (_voiceStateSub) { _voiceStateSub(); _voiceStateSub = null; }
}

// ── WebOS native integrations ─────────────────────────────────────────────────

function showToast(message) {
  lunaCall('luna://com.webos.notification/createToast', {
    sourceId: 'com.homebrew.havoice',
    message,
  }).catch(() => {});
}

function speakNative(text) {
  lunaCall('luna://com.webos.service.tts/speak', { text, clear: true }).catch(() => {});
}

let _tvPowerSub = null;

function subscribeTvPower() {
  cancelTvPowerSub();
  _tvPowerSub = lunaSubscribe(
    'luna://com.webos.service.tvpower/power/getPowerState',
    {},
    (res) => {
      if (!res.returnValue) return;
      const suspendStates   = new Set(['Suspend', 'Active Standby']);
      const suspendProcess  = new Set([
        'Request Suspend', 'Request Active Standby',
        'Prepare Suspend',  'Prepare Active Standby',
        'Request Power Off', 'Prepare Power Off',
      ]);
      if ((suspendStates.has(res.state) || suspendProcess.has(res.processing))
          && svcState !== SvcState.IDLE && svcState !== SvcState.ERROR) {
        voiceAbort();
      }
    }
  );
}

function cancelTvPowerSub() {
  if (_tvPowerSub) { _tvPowerSub(); _tvPowerSub = null; }
}

// ── TTS playback ──────────────────────────────────────────────────────────────

let _ttsAudio = null;
let _ttsStartTimer = null;
let _overlayHideTimer = null;

function scheduleOverlayHide(delay = 1200) {
  if (_overlayHideTimer) clearTimeout(_overlayHideTimer);
  _overlayHideTimer = setTimeout(() => {
    _overlayHideTimer = null;
    if (!_overlayMode) return;
    if (_ttsAudio || _ttsStartTimer) {
      scheduleOverlayHide(1000);
      return;
    }
    _overlayMode = false;
    if (window.PalmSystem) window.PalmSystem.hide();
  }, delay);
}

function stopTtsPlayback() {
  if (_ttsStartTimer) {
    clearTimeout(_ttsStartTimer);
    _ttsStartTimer = null;
  }
  if (_ttsAudio) {
    try { _ttsAudio.pause(); } catch (_) {}
    _ttsAudio.src = '';
    _ttsAudio = null;
  }
  lunaCall('luna://com.webos.service.audio/tv/mixDigitalSoundOutput', { mix: false }).catch(() => {});
}

function playTts(ttsUrl, responseText) {
  stopTtsPlayback();
  try {
    const url = ttsUrl.startsWith('http') ? ttsUrl : config.url.replace(/\/$/, '') + ttsUrl;
    lunaCall('luna://com.webos.service.audio/tv/mixDigitalSoundOutput', { mix: true }).catch(() => {});
    const audio = new Audio();
    _ttsAudio = audio;
    let fallbackUsed = false;

    const fallback = (reason) => {
      if (fallbackUsed || _ttsAudio !== audio) return;
      fallbackUsed = true;
      console.warn('[TTS] falling back to native TTS:', reason);
      stopTtsPlayback();
      speakNative(responseText || 'Sorry, I could not play the response.');
    };

    audio.preload = 'auto';
    audio.src = url;
    audio.onplaying = () => {
      if (_ttsStartTimer) {
        clearTimeout(_ttsStartTimer);
        _ttsStartTimer = null;
      }
    };
    audio.onended = () => {
      if (_ttsAudio === audio) stopTtsPlayback();
    };
    audio.onerror = () => {
      fallback('audio error');
    };
    audio.play().catch(e => {
      fallback(`play() rejected: ${e?.message || e}`);
    });
    _ttsStartTimer = setTimeout(() => fallback('playback did not start'), 5000);
  } catch (e) {
    console.warn('[TTS] playTts error', e);
    stopTtsPlayback();
    speakNative(responseText || 'Sorry, I could not play the response.');
  }
}

// ── Voice control ─────────────────────────────────────────────────────────────

function voiceStart() {
  if (!haClient?.connected) return;
  _appInitiatedVoice = true;
  lunaCall('luna://com.homebrew.havoice.service/voice/start', { fromApp: true }).catch(
    e => console.warn('[voice] start failed:', e.message)
  );
}

function voiceStop() {
  lunaCall('luna://com.homebrew.havoice.service/voice/stop', {}).catch(
    e => console.warn('[voice] stop failed:', e.message)
  );
}

function voiceAbort() {
  lunaCall('luna://com.homebrew.havoice.service/voice/abort', {}).catch(
    e => console.warn('[voice] abort failed:', e.message)
  );
}

// ── Orb UI ─────────────────────────────────────────────────────────────────────
const STATE_LABELS = {
  [SvcState.IDLE]:       'Press mic button or OK to talk',
  [SvcState.STARTING]:   'Starting microphone…',
  [SvcState.LISTENING]:  'Listening… press again or pause to send',
  [SvcState.PROCESSING]: 'Processing…',
  [SvcState.SPEAKING]:   'Speaking…',
  [SvcState.ERROR]:      'Something went wrong',
};

const OVERLAY_LABELS = {
  [SvcState.STARTING]:   'Starting microphone…',
  [SvcState.LISTENING]:  'Listening…',
  [SvcState.PROCESSING]: 'Processing…',
  [SvcState.SPEAKING]:   'Speaking…',
};

const ACTIVE_STATES = new Set([
  SvcState.STARTING,
  SvcState.LISTENING,
  SvcState.PROCESSING,
  SvcState.SPEAKING,
]);

function setOrbState(state) {
  armIdle(state);
  orb.className = `orb ${state}`;
  stateLabel.textContent = STATE_LABELS[state] ?? '';

  const overlayActive = ACTIVE_STATES.has(state);
  if (overlayActive && _overlayHideTimer) {
    clearTimeout(_overlayHideTimer);
    _overlayHideTimer = null;
  }
  voiceOverlay.className = overlayActive ? `voice-overlay active ${state}` : 'voice-overlay';
  if (overlayActive) {
    overlayLabel.textContent = OVERLAY_LABELS[state] ?? '';
  } else {
    overlayTranscript.textContent = '';
  }

  if (state === SvcState.IDLE || state === SvcState.ERROR) {
    setTimeout(() => hideTranscript(), state === SvcState.IDLE ? 4000 : 0);

    if (state === SvcState.ERROR) {
      speakNative('Sorry, something went wrong.');
    }

    if (_overlayMode && state === SvcState.IDLE) {
      // webOS freezes background WAM apps. Keep the overlay alive until the
      // HA audio either starts and finishes or falls back to native TTS.
      scheduleOverlayHide();
    }
  }
}

function showTranscript(text) {
  transcriptText.textContent = text;
  transcriptBox.classList.remove('hidden');
  overlayTranscript.textContent = text;
}

function hideTranscript() {
  transcriptBox.classList.add('hidden');
  transcriptText.textContent = '';
}

// ── OLED burn-in: idle screen-protection ───────────────────────────────────────
// A bright, static orb left on an OLED panel risks burn-in. After a spell of
// inactivity we dim the screen (reduces luminance, the real driver), and after a
// longer spell hand off to LG's own screensaver. Thresholds are overridable via
// window.__havoiceIdle (used by the UI tests). The perpetual pixel-shift lives in
// styles/app.css. Rationale mirrors the lg-webos-dashboard OLED-care notes.
const _idleCfg = (typeof window !== 'undefined' && window.__havoiceIdle) || {};
const IDLE_DIM_MS   = _idleCfg.dimMs   ?? 60000;    // dim after 60s idle
const IDLE_SAVER_MS = _idleCfg.saverMs ?? 300000;   // LG screensaver after 5 min idle
let _idleDimTimer = null, _idleSaverTimer = null, _lastWake = 0;

function clearIdleTimers() {
  if (_idleDimTimer)   { clearTimeout(_idleDimTimer);   _idleDimTimer = null; }
  if (_idleSaverTimer) { clearTimeout(_idleSaverTimer); _idleSaverTimer = null; }
}

/** (Re)start the idle countdown. Only protects while idle on the main screen. */
function armIdle(state) {
  const s = state ?? svcState;
  clearIdleTimers();
  appEl.classList.remove('screen-dim');
  if (!screenMain.classList.contains('active')) return;
  if (s !== SvcState.IDLE) return;
  _idleDimTimer = setTimeout(() => {
    if (svcState === SvcState.IDLE && screenMain.classList.contains('active')) {
      appEl.classList.add('screen-dim');
    }
  }, IDLE_DIM_MS);
  _idleSaverTimer = setTimeout(() => {
    // Only on a real TV, when idle and not acting as an overlay over another app.
    if (svcState === SvcState.IDLE && !_overlayMode && window.PalmSystem) {
      lunaCall('luna://com.webos.service.tvpower/power/turnOnScreenSaver', {}).catch(() => {});
    }
  }, IDLE_SAVER_MS);
}

/** Any user activity wakes the screen and restarts the countdown (throttled). */
function wakeIdle() {
  appEl.classList.remove('screen-dim');
  const now = Date.now();
  if (now - _lastWake < 1000) return;
  _lastWake = now;
  armIdle();
}

['keydown', 'pointerdown', 'mousemove'].forEach((ev) =>
  document.addEventListener(ev, wakeIdle, true));

// ── Input handling ─────────────────────────────────────────────────────────────
orb.addEventListener('click', handleVoiceActivation);
voiceOverlay.addEventListener('click', handleVoiceActivation);

document.addEventListener('keydown', (e) => {
  if (screenConfig.classList.contains('active')) return;

  if (VOICE_KEYS.has(e.keyCode)) {
    e.preventDefault();
    handleVoiceActivation();
  } else if (e.keyCode === KEY.BACK) {
    if (svcState !== SvcState.IDLE && svcState !== SvcState.ERROR) {
      e.preventDefault();
      voiceAbort();
    } else if (_overlayMode) {
      // Dismiss a stuck overlay (e.g. pipeline never ran) with the Back key.
      e.preventDefault();
      _overlayMode = false;
      if (window.PalmSystem) window.PalmSystem.hide();
    }
  }
});

function handleVoiceActivation() {
  if (!haClient?.connected) return;

  if (svcState === SvcState.IDLE || svcState === SvcState.ERROR) {
    hideTranscript();
    voiceStart();
  } else if (svcState === SvcState.STARTING) {
    voiceAbort();
  } else if (svcState === SvcState.LISTENING) {
    voiceStop();
  } else if (svcState === SvcState.SPEAKING || svcState === SvcState.PROCESSING) {
    voiceAbort();
  }
}
