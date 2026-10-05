'use strict';

/**
 * HA Voice – Luna service
 *
 * Endpoints:
 *   /setup            – configures the Magic Remote mic keybind (requires root).
 *   /isSetupDone      – returns whether the mic button keybind is configured.
 *   /startSetupServer – starts the OAuth companion HTTP server, returns { url }.
 *   /stopSetupServer  – shuts down the companion HTTP server.
 *   /getConfig        – return persisted HA config (for localStorage recovery).
 *   /setHAConfig      – store { url, token, pipelineId } for voice pipeline.
 *   /voice/start      – begin a voice interaction (voiceinput → HA pipeline).
 *   /voice/stop       – stop recording, let HA finish STT → TTS.
 *   /voice/toggle     – start/stop for press-only inputhookpp key events.
 *   /voice/abort      – abort immediately, return to idle.
 *   /voice/state      – subscribe to { state, transcript, responseText, ttsUrl }.
 *   /voice/ackTts     – acknowledge receipt of a pending TTS URL.
 *
 * webos-service is provided by the TV's Node.js runtime – do NOT bundle it.
 */

var Service = require('webos-service');
var fs      = require('fs');
var path    = require('path');
var http    = require('http');
var https   = require('https');
var tls     = require('tls');
var net     = require('net');
var crypto  = require('crypto');

var os      = require('os');
var urlLib  = require('url');

var APP_ID      = 'com.homebrew.havoice';
var SERVICE_ID  = 'com.homebrew.havoice.service';
var SETUP_PORT  = 8642;

// ── Logging ───────────────────────────────────────────────────────────────────

var LOG_FILE     = '/tmp/ha-voice-service.log';
var LOG_MAX_SIZE = 512 * 1024; // 512 KB – rotate when exceeded
function log() {
  var ts   = new Date().toISOString().slice(11, 19);
  var args = Array.prototype.slice.call(arguments);
  var line = '[' + ts + '] [ha-voice] ' + args.join(' ') + '\n';
  process.stdout.write(line);
  try {
    var stat = fs.statSync(LOG_FILE);
    if (stat.size > LOG_MAX_SIZE) fs.writeFileSync(LOG_FILE, line);
    else                          fs.appendFileSync(LOG_FILE, line);
  } catch (_) { try { fs.appendFileSync(LOG_FILE, line); } catch (_2) {} }
}

// ── CA bundle (webOS Node has no built-in CA store) ───────────────────────────
var HBC_CERTS = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/certs/cacert-2024-03-11.pem';
var CA_BUNDLE = null;
try {
  var pem = fs.readFileSync(HBC_CERTS, 'utf8');
  CA_BUNDLE = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  var orig = tls.createSecureContext;
  tls.createSecureContext = function(opts) {
    opts = opts || {};
    if (!opts.ca) opts.ca = CA_BUNDLE;
    return orig.call(tls, opts);
  };
  log('CA bundle loaded:', CA_BUNDLE.length, 'certs');
} catch (_) { /* HBChannel not present – HTTPS will fall back to system default */ }

// ── inputhook keybind setup ───────────────────────────────────────────────────

var KEYBINDS_PATH  = '/home/root/.config/lginputhook/keybinds.json';
var HANDLER_DIR    = '/home/root/.config/lginputhook';
var HANDLER_SCRIPT = path.join(HANDLER_DIR, 'ha-voice-mic.sh');
var MIC_KEYCODE    = '428';

// Launch the app in background first (so it can show the orb), then start voice.
// Running applicationManager/launch with & decouples it from the service process –
// calling it inside the service would cause webOS to restart the service mid-pipeline.
var HANDLER_CONTENT = '#!/bin/sh\n'
  + 'VALUE="$1"\n'
  + 'if [ -z "$VALUE" ]; then\n'
  + '  luna-send -n 1 luna://com.webos.applicationManager/launch \'{"id":"com.homebrew.havoice","params":{"action":"overlay"}}\' &\n'
  + '  luna-send -n 1 luna://com.homebrew.havoice.service/voice/toggle \'{}\'\n'
  + 'elif [ "$VALUE" = "1" ]; then\n'
  + '  luna-send -n 1 luna://com.webos.applicationManager/launch \'{"id":"com.homebrew.havoice","params":{"action":"overlay"}}\' &\n'
  + '  luna-send -n 1 luna://com.homebrew.havoice.service/voice/start \'{}\'\n'
  + 'elif [ "$VALUE" = "0" ]; then\n'
  + '  luna-send -n 1 luna://com.homebrew.havoice.service/voice/stop \'{}\'\n'
  + 'fi\n';

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function setupInputHook() {
  fs.mkdirSync(HANDLER_DIR, { recursive: true });
  fs.writeFileSync(HANDLER_SCRIPT, HANDLER_CONTENT, { mode: 0o755 });

  var keybinds = {};
  try { keybinds = JSON.parse(fs.readFileSync(KEYBINDS_PATH, 'utf8')); } catch (_) {}
  keybinds[MIC_KEYCODE] = { action: 'exec', command: HANDLER_SCRIPT };
  fs.writeFileSync(KEYBINDS_PATH, JSON.stringify(keybinds, null, 2));
  log('keybinds configured');
}

function isSetupDone() {
  try {
    var kb = JSON.parse(fs.readFileSync(KEYBINDS_PATH, 'utf8'));
    var e  = kb[MIC_KEYCODE];
    if (!e || e.action !== 'exec' || e.command !== HANDLER_SCRIPT) return false;
    return fs.readFileSync(HANDLER_SCRIPT, 'utf8') === HANDLER_CONTENT;
  } catch (_) { return false; }
}

function sendToast(svc, message) {
  svc.call('luna://com.webos.notification/createToast', { sourceId: APP_ID, message: message }, function() {});
}

function speakNative(text) {
  if (!text) return;
  service.call('luna://com.webos.service.tts/speak', { text: text, clear: true }, function() {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalIP() {
  var ip = null;
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function(name) {
    ifaces[name].forEach(function(iface) {
      if (!iface.internal && iface.family === 'IPv4' && !ip) ip = iface.address;
    });
  });
  return ip;
}

// ── OAuth companion HTTP server ───────────────────────────────────────────────

var setupServer    = null;
var setupStopTimer = null; // F2: auto-stop the setup server after a window of inactivity
var SETUP_TIMEOUT_MS = 10 * 60 * 1000;
var pendingOAuth   = null; // { haUrl, state }
var pendingConfig  = null; // config ready for the app to pick up via getPendingConfig (Luna)
var OAUTH_STATE_FILE = '/tmp/ha-voice-oauth.json';

function savePendingOAuth(obj) {
  pendingOAuth = obj;
  try { fs.writeFileSync(OAUTH_STATE_FILE, JSON.stringify(obj), { mode: 0o600 }); } catch (_) {}
}

function loadPendingOAuth() {
  if (pendingOAuth) return pendingOAuth;
  try { pendingOAuth = JSON.parse(fs.readFileSync(OAUTH_STATE_FILE, 'utf8')); } catch (_) {}
  return pendingOAuth;
}

function clearPendingOAuth() {
  pendingOAuth = null;
  try { fs.unlinkSync(OAUTH_STATE_FILE); } catch (_) {}
}

function httpPost(urlStr, body) {
  return new Promise(function(resolve, reject) {
    var url      = urlLib.parse(urlStr);
    var mod      = url.protocol === 'https:' ? https : http;
    var postData = body;
    var req      = mod.request({
      hostname:           url.hostname,
      port:               url.port || (url.protocol === 'https:' ? 443 : 80),
      path:               url.pathname + (url.search || ''),
      method:             'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { reject(new Error('Bad JSON from HA: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}


function makeHtml(title, body) {
  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title>'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
    + '  background:#111827;color:#f9fafb;min-height:100vh;display:flex;'
    + '  align-items:center;justify-content:center;padding:24px}'
    + '.card{background:#1f2937;border-radius:16px;padding:32px;width:100%;max-width:440px}'
    + 'h1{color:#60a5fa;font-size:1.6rem;margin-bottom:6px}'
    + 'p.sub{color:#9ca3af;font-size:.9rem;margin-bottom:28px}'
    + 'label{display:block;font-size:.8rem;color:#9ca3af;text-transform:uppercase;'
    + '  letter-spacing:.05em;margin-bottom:6px}'
    + 'input{width:100%;padding:14px;background:#111827;border:1.5px solid #374151;'
    + '  border-radius:8px;color:#f9fafb;font-size:1rem;margin-bottom:20px;outline:none}'
    + 'input:focus{border-color:#60a5fa}'
    + 'button{width:100%;padding:14px;background:#2563eb;color:#fff;border:none;'
    + '  border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}'
    + 'button:active{background:#1d4ed8}'
    + '.msg{margin-top:20px;text-align:center;font-size:.95rem}'
    + '.ok{color:#34d399}.err{color:#f87171}'
    + '</style></head><body><div class="card">' + body + '</div></body></html>';
}

var SETUP_PAGE = makeHtml('HA Voice Setup',
  '<h1>HA Voice</h1>'
  + '<p class="sub">Connect your LG TV to Home Assistant</p>'
  + '<form method="POST" action="/start-auth">'
  + '  <label>Home Assistant URL</label>'
  + '  <input type="url" name="haUrl" placeholder="http://homeassistant.local:8123" required autocomplete="url">'
  + '  <button type="submit">Login with Home Assistant &rsaquo;</button>'
  + '</form>'
);

// F6: a cross-origin POST carries an Origin/Referer that is not our own setup
// origin (clientId). Browsers always attach Origin to cross-site form submits, so
// this refuses an attacker page auto-submitting /start-auth to the TV, while a
// genuine submit from our setup page (same-origin) passes. Requests with neither
// header (non-browser) are not treated as cross-origin.
function isCrossOrigin(req, clientId) {
  var origin = req.headers.origin;
  if (origin) return origin !== clientId;
  var ref = req.headers.referer;
  if (ref) return ref !== clientId && ref.indexOf(clientId + '/') !== 0;
  return false;
}

function startOAuthServer(clientId) {
  return new Promise(function(resolve, reject) {
    if (setupServer) { resolve(); return; }

    var server = http.createServer(function(req, res) {
      var parsed = urlLib.parse(req.url, true);

      // ── POST /start-auth ──
      if (req.method === 'POST' && parsed.pathname === '/start-auth') {
        // F6: CSRF defenses — refuse cross-origin submits and anything that isn't
        // the setup form's own urlencoded body.
        if (isCrossOrigin(req, clientId)) { res.writeHead(403); res.end('cross-origin blocked'); return; }
        var ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ctype !== 'application/x-www-form-urlencoded') { res.writeHead(415); res.end('unsupported content-type'); return; }
        var body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() {
          var haUrl = '';
          body.split('&').forEach(function(pair) {
            var kv = pair.split('=');
            if (decodeURIComponent(kv[0]) === 'haUrl') haUrl = decodeURIComponent(kv[1] || '').replace(/\/$/, '');
          });
          if (!haUrl) { res.writeHead(400); res.end('haUrl required'); return; }
          // F6: haUrl is fed to server-side httpPost() below (SSRF sink). Require an
          // http(s) URL so schemes like file:// cannot be injected. (Private-range-only
          // would be stronger but breaks legitimately-remote HA instances.)
          if (!/^https?:\/\/[^\s]+$/i.test(haUrl)) { res.writeHead(400); res.end('invalid haUrl'); return; }

          var state  = crypto.randomBytes(8).toString('hex');
          savePendingOAuth({ haUrl: haUrl, state: state });

          var authUrl = haUrl + '/auth/authorize'
            + '?client_id='     + encodeURIComponent(clientId)
            + '&redirect_uri='  + encodeURIComponent(clientId + '/callback')
            + '&state='         + encodeURIComponent(state)
            + '&response_type=code';

          res.writeHead(302, { Location: authUrl });
          res.end();
        });
        return;
      }

      // ── GET /callback ──
      if (parsed.pathname === '/callback') {
        var code  = parsed.query.code;
        var state = parsed.query.state;
        var pending = loadPendingOAuth();

        if (!code || !pending || pending.state !== state) {
          // F5: never reflect attacker-controlled `state` into the page. Keep detail in the log.
          log('callback state mismatch: got=' + state + ' expected=' + (pending ? pending.state : 'NO_PENDING'));
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(makeHtml('Error', '<p class="msg err">Invalid OAuth state. Please try again.</p>'));
          return;
        }

        var haUrl = pending.haUrl;
        clearPendingOAuth();

        var params = 'grant_type=authorization_code'
          + '&code='         + encodeURIComponent(code)
          + '&client_id='    + encodeURIComponent(clientId)
          + '&redirect_uri=' + encodeURIComponent(clientId + '/callback');

        log('callback: exchanging token with', haUrl);
        httpPost(haUrl + '/auth/token', params)
          .then(function(r) {
            var status = r.status;
            var tokens = r.body;
            log('token exchange status:', status, 'has_token:', !!tokens.access_token);
            if (status !== 200 || !tokens.access_token) {
              throw new Error('Token exchange failed (status ' + status + ')');
            }

            var newCfg = {
              url:          haUrl,
              token:        tokens.access_token,
              refreshToken: tokens.refresh_token || '',
              clientId:     clientId,
              pipelineId:   (voiceHAConfig && voiceHAConfig.pipelineId) || '',
              sttMode:      (voiceHAConfig && voiceHAConfig.sttMode)    || STT_MODE.LG,
            };
            pendingConfig = newCfg;
            // Persist immediately to the shared config file + in-memory so the fresh
            // creds survive even if the app isn't foreground-polling getPendingConfig
            // (the app then recovers them via getConfig). Delivery no longer depends
            // on a consume-once handoff.
            voiceHAConfig = newCfg;
            try { fs.writeFileSync(HA_CONFIG_FILE, JSON.stringify(newCfg), { mode: 0o600 }); } catch (_) {}
            log('OAuth complete, config persisted for', haUrl);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(makeHtml('Connected!', '<p class="msg ok">Connected! You can close this page.</p>'));
          })
          .catch(function(err) {
            log('token exchange error:', err.message);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(makeHtml('Error', '<p class="msg err">Authentication failed. Please try again.</p>'));
          });
        return;
      }

      // ── GET /ip ──
      if (parsed.pathname === '/ip') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(clientId);
        return;
      }

      // ── GET / ──
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SETUP_PAGE);
    });

    server.on('error', reject);
    server.listen(SETUP_PORT, '0.0.0.0', function() {
      setupServer = server;
      log('Setup server listening on port', SETUP_PORT);
      resolve();
    });
  });
}

// ── Minimal WebSocket client (Node 0.12 compatible) ───────────────────────────
//
// Sends masked client→server frames; parses unmasked server→client frames.
// Only handles text (opcode 0x01) and binary (0x02) frames; responds to ping.

function wsConnect(wsUrl, onMessage, onError, onClose) {
  var parsed    = urlLib.parse(wsUrl);
  var isSecure  = parsed.protocol === 'wss:';
  var port      = parseInt(parsed.port) || (isSecure ? 443 : 80);
  var host      = parsed.hostname;
  var reqPath   = (parsed.pathname || '/') + (parsed.search || '');
  var wsKey     = crypto.randomBytes(16).toString('base64');

  var handshake = 'GET ' + reqPath + ' HTTP/1.1\r\n'
    + 'Host: ' + host + ':' + port + '\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: ' + wsKey + '\r\n'
    + 'Sec-WebSocket-Version: 13\r\n'
    + '\r\n';

  var connectOpts = isSecure
    ? { host: host, port: port, ca: CA_BUNDLE, rejectUnauthorized: !!CA_BUNDLE }
    : { host: host, port: port };

  var socket   = (isSecure ? tls : net).connect(connectOpts, function() {
    socket.write(handshake);
  });

  var buf      = new Buffer(0);
  var upgraded = false;
  var closed   = false;

  socket.on('data', function(chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      // Find end of HTTP response headers (\r\n\r\n)
      var idx = -1;
      for (var i = 0; i < buf.length - 3; i++) {
        if (buf[i] === 13 && buf[i+1] === 10 && buf[i+2] === 13 && buf[i+3] === 10) {
          idx = i; break;
        }
      }
      if (idx === -1) return;
      upgraded = true;
      buf = buf.slice(idx + 4);
    }
    parseFrames();
  });

  function parseFrames() {
    while (buf.length >= 2) {
      var opcode     = buf[0] & 0x0f;
      var masked     = (buf[1] & 0x80) !== 0;
      var payloadLen = buf[1] & 0x7f;
      var off        = 2;

      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        off        = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        // Only handle messages < 4 GB (lower 32 bits)
        payloadLen = buf.readUInt32BE(6);
        off        = 10;
      }

      var totalLen = off + (masked ? 4 : 0) + payloadLen;
      if (buf.length < totalLen) return;

      var maskKey = null;
      if (masked) { maskKey = buf.slice(off, off + 4); off += 4; }

      var payload = new Buffer(payloadLen);
      buf.copy(payload, 0, off, off + payloadLen);
      if (masked) {
        for (var i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      buf = buf.slice(off + payloadLen);

      if (opcode === 0x01 || opcode === 0x02) {
        try { onMessage(payload.toString('utf8')); } catch (_) {}
      } else if (opcode === 0x08) {
        socket.destroy();
        if (!closed) { closed = true; onClose(); }
        return;
      } else if (opcode === 0x09) {
        // Ping → Pong
        wsSend(0x0A, payload);
      }
    }
  }

  function wsSend(opcode, payload) {
    var maskKey = crypto.randomBytes(4);
    var payLen  = payload.length;
    var hdrLen  = 2 + 4 + (payLen < 126 ? 0 : payLen < 65536 ? 2 : 8);
    var frame   = new Buffer(hdrLen + payLen);
    frame[0] = 0x80 | opcode;
    var off  = 1;
    if (payLen < 126) {
      frame[off++] = 0x80 | payLen;
    } else if (payLen < 65536) {
      frame[off++] = 0x80 | 126;
      frame.writeUInt16BE(payLen, off); off += 2;
    } else {
      frame[off++] = 0x80 | 127;
      frame.writeUInt32BE(0,      off); off += 4;
      frame.writeUInt32BE(payLen, off); off += 4;
    }
    maskKey.copy(frame, off); off += 4;
    for (var i = 0; i < payLen; i++) frame[off + i] = payload[i] ^ maskKey[i % 4];
    socket.write(frame);
  }

  socket.on('error', function(err) {
    log('WS socket error:', err.message);
    if (!closed) { closed = true; onError(err.message); }
  });
  socket.on('close', function() {
    if (!closed) { closed = true; onClose(); }
  });

  return {
    send: function(data) {
      var payload = new Buffer(String(data), 'utf8');
      wsSend(0x01, payload);
    },
    sendBinary: function(data) {
      var payload = Buffer.isBuffer(data) ? data : new Buffer(data);
      wsSend(0x02, payload);
    },
    close: function() {
      socket.destroy();
    },
  };
}

// ── Voice pipeline state ──────────────────────────────────────────────────────

var STT_MODE = { LG: 'lg', HA: 'ha' };

var voiceState       = 'idle';   // idle | starting | listening | processing | speaking | error
var voiceTranscript  = '';
var voiceTtsUrl      = '';
var voiceResponseText = '';
var voiceHAConfig    = null;     // { url, token, pipelineId, sttMode }
var voiceWS          = null;     // active HA WebSocket (STT or text pipeline)
var voiceSocket      = null;     // Unix socket to voiceinput
var voiceSubscribers = {};       // token → Luna message (for voice/state subscriptions)
var voiceSub        = null;     // voiceinput luna subscription handle
var voiceMsgId      = 1;
var voiceSttHandlerId = null;   // HA binary WebSocket handler for PCM audio
var voiceStopPending = false;
var voiceListenTimer = null;
var voiceTtsDeliveryTimer = null;
var VOICE_LISTEN_TIMEOUT_MS = 12000;
var TTS_DELIVERY_TIMEOUT_MS = 3000;

// Persist HA config so mic button works without the app being open first.
// /media/developer/ is on NAND and survives TV reboots (unlike /tmp/).
var HA_CONFIG_FILE = '/media/developer/ha-voice-config.json';
try {
  voiceHAConfig = JSON.parse(fs.readFileSync(HA_CONFIG_FILE, 'utf8'));
  log('Loaded HA config for:', voiceHAConfig.url);
} catch (_) {}
// Harden perms on the token file (historically created 0777). Owner-only.
try { fs.chmodSync(HA_CONFIG_FILE, 0o600); } catch (_) {}

/**
 * Push current voice state to all subscribers. ttsUrl remains available until
 * the app acknowledges it, so a frozen WAM subscription can recover on relaunch.
 */
function broadcastVoiceState() {
  var payload = {
    returnValue: true,
    state:       voiceState,
    transcript:  voiceTranscript,
    ttsUrl:      voiceTtsUrl,
    responseText: voiceResponseText,
  };
  Object.keys(voiceSubscribers).forEach(function(token) {
    try { voiceSubscribers[token].respond(payload); } catch (_) {}
  });
}

function setVoiceState(s) {
  if (voiceState === s) return;
  log('voice state:', voiceState, '->', s);
  voiceState = s;
  broadcastVoiceState();
}

function voiceCleanup() {
  if (voiceListenTimer) { clearTimeout(voiceListenTimer); voiceListenTimer = null; }
  if (voiceSocket) { try { voiceSocket.destroy(); } catch (_) {} voiceSocket = null; }
  if (voiceSub)    { try { voiceSub.cancel();     } catch (_) {} voiceSub    = null; }
  if (voiceWS)     { try { voiceWS.close();       } catch (_) {} voiceWS     = null; }
  voiceSttHandlerId = null;
  voiceStopPending = false;
}

function clearPendingTts() {
  if (voiceTtsDeliveryTimer) {
    clearTimeout(voiceTtsDeliveryTimer);
    voiceTtsDeliveryTimer = null;
  }
  voiceTtsUrl = '';
}

function scheduleTtsDeliveryFallback() {
  if (voiceTtsDeliveryTimer) clearTimeout(voiceTtsDeliveryTimer);
  if (!voiceTtsUrl) return;
  var pendingUrl = voiceTtsUrl;
  voiceTtsDeliveryTimer = setTimeout(function() {
    voiceTtsDeliveryTimer = null;
    if (!voiceTtsUrl || voiceTtsUrl !== pendingUrl) return;
    log('TTS was not acknowledged by the app; using native fallback');
    voiceTtsUrl = '';
    if (voiceResponseText) speakNative(voiceResponseText);
    broadcastVoiceState();
  }, TTS_DELIVERY_TIMEOUT_MS);
}

function armVoiceListenTimeout() {
  if (voiceListenTimer) clearTimeout(voiceListenTimer);
  voiceListenTimer = setTimeout(function() {
    voiceListenTimer = null;
    if (voiceState === 'starting') {
      setVoiceError('voice pipeline start timeout');
    } else if (voiceState === 'listening') {
      log('listen timeout – finishing STT stream');
      doStopListening();
    }
  }, VOICE_LISTEN_TIMEOUT_MS);
}

// Transition to error then auto-recover to idle after 3 s.
function setVoiceError(reason) {
  log('voice error:', reason);
  clearPendingTts();
  voiceCleanup();
  setVoiceState('error');
  setTimeout(function() { if (voiceState === 'error') setVoiceState('idle'); }, 3000);
}

// ── Voice pipeline ────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without verification (we trust HA tokens).
 * Returns the payload object, or null if malformed.
 */
function jwtPayload(token) {
  try {
    var parts = token.split('.');
    if (parts.length < 2) return null;
    var pad = parts[1];
    while (pad.length % 4) pad += '=';
    return JSON.parse(new Buffer(pad, 'base64').toString('utf8'));
  } catch (_) { return null; }
}

/**
 * Ensure voiceHAConfig.token is valid (not expired / expiring within 60 s).
 * Returns a Promise that resolves when the token is ready.
 */
function ensureFreshToken() {
  var cfg = voiceHAConfig;
  var payload = jwtPayload(cfg.token);
  var nowSec = Date.now() / 1000;
  // Long-lived access tokens may have no exp (or a far-future exp): treat as good.
  // Only try to refresh when we can actually decode an expiry that is near.
  if (!payload || !payload.exp || payload.exp - nowSec > 60) {
    return Promise.resolve(); // token still good (no exp = LLAT, or not near expiry)
  }
  if (!cfg.refreshToken || !cfg.clientId) {
    return Promise.reject(new Error('token expired and no refresh credentials'));
  }
  log('token near expiry, refreshing…');
  var body = 'grant_type=refresh_token'
    + '&refresh_token=' + encodeURIComponent(cfg.refreshToken)
    + '&client_id='     + encodeURIComponent(cfg.clientId);
  return httpPost(cfg.url + '/auth/token', body).then(function(res) {
    if (res.status !== 200 || !res.body.access_token) {
      var errCode = (res.body && res.body.error) || ('HTTP ' + res.status);
      log('token refresh FAILED:', errCode);
      // A revoked/expired refresh token (invalid_grant) will never succeed —
      // clear it so getConfig stops handing back a dead token and the app
      // prompts for a fresh login instead of looping on auth_invalid.
      if (res.status === 400 || (res.body && res.body.error === 'invalid_grant')) {
        cfg.refreshToken = '';
        cfg.clientId = '';
        voiceHAConfig = cfg;
        try { fs.writeFileSync(HA_CONFIG_FILE, JSON.stringify(cfg), { mode: 0o600 }); } catch (_) {}
        log('cleared revoked refresh token — re-auth required');
      }
      throw new Error('token refresh failed: ' + errCode);
    }
    log('token refreshed OK');
    cfg.token = res.body.access_token;
    if (res.body.refresh_token) cfg.refreshToken = res.body.refresh_token;
    voiceHAConfig = cfg;
    try { fs.writeFileSync(HA_CONFIG_FILE, JSON.stringify(cfg), { mode: 0o600 }); } catch (_) {}
  });
}

function startVoicePipeline() {
  if (!voiceHAConfig || !voiceHAConfig.url || !voiceHAConfig.token) {
    setVoiceError('no HA config stored');
    return;
  }

  armVoiceListenTimeout();
  ensureFreshToken().then(function() {
    doStartVoicePipeline();
  }).catch(function(err) {
    setVoiceError('token refresh failed: ' + err.message);
  });
}

function doStartVoicePipeline() {
  var wsUrl = voiceHAConfig.url.replace(/^http/, 'ws') + '/api/websocket';
  log('connecting to HA WS:', wsUrl);

  var runId = voiceMsgId++;
  voiceWS = wsConnect(
    wsUrl,
    function onMsg(data) {
      var msg;
      try { msg = JSON.parse(data); } catch (_) { return; }

      if (msg.type === 'auth_required') {
        voiceWS.send(JSON.stringify({ type: 'auth', access_token: voiceHAConfig.token }));

      } else if (msg.type === 'auth_ok') {
        log('HA WS auth ok, starting pipeline');
        var startMsg = {
          id:          runId,
          type:        'assist_pipeline/run',
          start_stage: 'stt',
          end_stage:   'tts',
          input:       { sample_rate: 16000 },
        };
        if (voiceHAConfig.pipelineId) startMsg.pipeline = voiceHAConfig.pipelineId;
        voiceWS.send(JSON.stringify(startMsg));

      } else if (msg.type === 'auth_invalid') {
        setVoiceError('HA auth invalid: ' + msg.message);

      } else if (msg.type === 'result' && msg.id === runId) {
        if (msg.success) {
          log('pipeline accepted, waiting for binary audio handler');
        } else {
          var errMsg = msg.error && msg.error.message ? msg.error.message : 'pipeline start failed';
          setVoiceError(errMsg);
        }

      } else if (msg.type === 'event' && msg.id === runId) {
        handlePipelineEvent(msg.event);
      }
    },
    function onErr(err) {
      setVoiceError('HA WS error: ' + err);
    },
    function onClose() {
      log('HA WS closed');
      if (voiceState !== 'idle') {
        voiceCleanup();
        setVoiceState('idle');
      }
    }
  );
}

function handlePipelineEvent(evt) {
  if (!evt) return;
  log('pipeline event:', evt.type);
  if (evt.type === 'run-start') {
    var handlerId = evt.data && evt.data.runner_data && evt.data.runner_data.stt_binary_handler_id;
    if (typeof handlerId !== 'number') {
      setVoiceError('pipeline did not provide an STT binary handler');
      return;
    }
    voiceSttHandlerId = handlerId;
    log('STT binary handler:', handlerId);
    if (voiceStopPending) {
      doStopListening();
    } else {
      startVoiceInput();
    }

  } else if (evt.type === 'stt-end') {
    voiceTranscript = (evt.data && evt.data.stt_output && evt.data.stt_output.text) || '';
    log('transcript received, len=' + voiceTranscript.length); // F7: never log the text
    setVoiceState('processing');

  } else if (evt.type === 'intent-end') {
    var intentOut = evt.data && evt.data.intent_output;
    voiceResponseText = (intentOut && intentOut.response && intentOut.response.speech
                         && intentOut.response.speech.plain
                         && intentOut.response.speech.plain.speech) || voiceResponseText;

  } else if (evt.type === 'tts-start' || evt.type === 'tts-end') {
    var url = (evt.data && evt.data.tts_output && evt.data.tts_output.url) || '';
    voiceResponseText = (evt.data && evt.data.tts_input) || voiceResponseText;
    if (url) {
      log(evt.type + ' url:', url);
      voiceTtsUrl = url;
      scheduleTtsDeliveryFallback();
      setVoiceState('speaking');
    }

  } else if (evt.type === 'error') {
    setVoiceError((evt.data && evt.data.message) || 'pipeline error');

  } else if (evt.type === 'run-end') {
    log('pipeline run-end');
    voiceCleanup();
    setVoiceState('idle');
  }
}

function startVoiceInput() {
  log('calling voiceinput/startStreaming');
  service.call(
    'luna://com.webos.service.voiceinput/startStreaming',
    { deviceType: 'remote', subscribe: true },
    function(msg) {
      var p = msg.payload;
      log('voiceinput response:', JSON.stringify(p).slice(0, 120));

      if (p.returnValue && p.socketPath && !voiceSocket) {
        log('voiceinput socket path:', p.socketPath);
        connectToAudioSocket(p.socketPath);
        voiceSub = msg; // store handle for cancel

      } else if (p.state === 'voice stop' && voiceState === 'listening') {
        log('voiceinput VAD: voice stop – auto sending stt_stream/end');
        doStopListening();

      } else if (p.returnValue === false) {
        setVoiceError('voiceinput: ' + (p.errorText || 'unknown'));
      }
    }
  );
}

function connectToAudioSocket(socketPath) {
  var sock = net.createConnection(socketPath);
  voiceSocket = sock;

  sock.on('connect', function() {
    log('connected to voiceinput audio socket');
    if (voiceStopPending) {
      doStopListening();
    } else {
      setVoiceState('listening');
      armVoiceListenTimeout();
    }
  });

  sock.on('data', function(chunk) {
    if (voiceState !== 'listening' || !voiceWS || voiceSttHandlerId === null) return;
    // HA expects binary PCM frames prefixed by the assigned handler byte.
    var framed = new Buffer(chunk.length + 1);
    framed[0] = voiceSttHandlerId;
    chunk.copy(framed, 1);
    voiceWS.sendBinary(framed);
  });

  sock.on('error', function(err) {
    log('voiceSocket error:', err.message);
  });

  sock.on('close', function() {
    log('voiceSocket closed');
    if (voiceSocket === sock) voiceSocket = null;
  });
}

function doStopListening() {
  if (voiceListenTimer) { clearTimeout(voiceListenTimer); voiceListenTimer = null; }
  if (voiceSocket) { voiceSocket.destroy(); voiceSocket = null; }
  if (voiceSub)    { try { voiceSub.cancel(); } catch (_) {} voiceSub = null; }
  setVoiceState('processing');
  if (voiceWS && voiceSttHandlerId !== null) {
    voiceWS.sendBinary(new Buffer([voiceSttHandlerId]));
    voiceStopPending = false;
    log('sent binary STT end frame');
  } else {
    voiceStopPending = true;
  }
}

// ── Service registration ───────────────────────────────────────────────────────

var service = new Service(SERVICE_ID);

function beginVoiceInteraction(fromApp) {
  log('begin voice interaction, state=' + voiceState);
  if (voiceState !== 'idle' && voiceState !== 'error') {
    log('voice interaction already active, ignoring');
    return;
  }
  voiceTranscript = '';
  clearPendingTts();
  voiceResponseText = '';

  if (!fromApp) {
    sendToast(service, 'Listening…');
    // The inputhook handler launches the overlay independently. Launching it
    // from this service would restart the service and abort the pipeline.
  }

  var sttMode = (voiceHAConfig && voiceHAConfig.sttMode) || STT_MODE.LG;
  if (sttMode === STT_MODE.HA) {
    setVoiceState('starting');
    startVoicePipeline();
    return;
  }

  setVoiceState('listening');
  service.call(
    'luna://com.webos.service.voiceconductor/recognizeVoice',
    {},
    function(msg) {
      var p = msg.payload;
      log('recognizeVoice response:', JSON.stringify(p).slice(0, 120));
      if (!p.returnValue) {
        log('voiceconductor unavailable, falling back to HA STT pipeline');
        startVoicePipeline();
        return;
      }

      var candidates = (p.text || []).filter(Boolean);
      log('[vc] recognizeVoice candidates:', JSON.stringify(candidates));
      if (candidates.length > 0) {
        if (voiceListenTimer) { clearTimeout(voiceListenTimer); voiceListenTimer = null; }
        voiceTranscript = candidates[0];
        setVoiceState('processing');
        runHATextPipelineWithFallback(candidates);
      } else {
        voiceCleanup();
        setVoiceState('idle');
      }
    }
  );
}

// Disable the idle timer – keep the process alive for HTTP server + voice pipeline.
service.activityManager._stopTimer();
service.activityManager._startTimer = function() {};

service.register('isSetupDone', function(message) {
  message.respond({ returnValue: true, done: isSetupDone() });
});

service.register('setup', function(message) {
  log('setup called, root:', isRoot());
  if (!isRoot()) {
    if (!isSetupDone()) sendToast(service, 'HA Voice: open the app to configure mic button.');
    message.respond({ returnValue: true, root: false });
    return;
  }
  try {
    setupInputHook();
    message.respond({ returnValue: true, root: true });
  } catch (err) {
    message.respond({ returnValue: false, errorText: err.message });
  }
});

/**
 * /getConfig – returns the persisted HA config so the browser app can restore
 * its state after webOS clears localStorage (memory pressure / reinstall).
 * For OAuth configs, tries to refresh the access token first so the browser
 * gets a fresh token and avoids an auth_invalid round-trip on reconnect.
 */
service.register('getConfig', function(message) {
  if (!voiceHAConfig || !voiceHAConfig.url) {
    message.respond({ returnValue: false, errorText: 'no config stored' });
    return;
  }
  function respond() {
    message.respond({
      returnValue:  true,
      url:          voiceHAConfig.url,
      token:        voiceHAConfig.token,
      pipelineId:   voiceHAConfig.pipelineId   || '',
      refreshToken: voiceHAConfig.refreshToken || '',
      clientId:     voiceHAConfig.clientId     || '',
      sttMode:      voiceHAConfig.sttMode      || STT_MODE.LG,
    });
  }
  // Best-effort refresh for OAuth tokens before returning. If refresh fails we
  // still respond (with whatever creds remain — ensureFreshToken clears a revoked
  // token), but we log it rather than swallowing it silently.
  ensureFreshToken().then(respond).catch(function(err) {
    log('getConfig: token refresh failed:', err.message);
    respond();
  });
});

/**
 * /setHAConfig – browser app calls this after connecting to HA so the service
 * can run the voice pipeline on behalf of the mic button.
 */
service.register('setHAConfig', function(message) {
  var p = message.payload;
  if (p && p.url && p.token) {
    voiceHAConfig = {
      url:          p.url,
      token:        p.token,
      pipelineId:   p.pipelineId   || '',
      refreshToken: p.refreshToken || '',
      clientId:     p.clientId     || '',
      sttMode:      p.sttMode      || STT_MODE.LG,
    };
    try { fs.writeFileSync(HA_CONFIG_FILE, JSON.stringify(voiceHAConfig), { mode: 0o600 }); } catch (_) {}
    log('HA config updated for:', voiceHAConfig.url);
  }
  message.respond({ returnValue: true });
});

/**
 * /voice/start – begin voice interaction (called by inputhook or browser app).
 */
service.register('voice/start', function(message) {
  message.respond({ returnValue: true });
  log('voice/start, state=' + voiceState);
  beginVoiceInteraction(message.payload && message.payload.fromApp);
});

/**
 * /voice/toggle – inputhookpp has key-down events only, so consecutive presses
 * start and stop a recording.
 */
service.register('voice/toggle', function(message) {
  message.respond({ returnValue: true });
  log('voice/toggle, state=' + voiceState);
  if (voiceState === 'listening') {
    doStopListening();
  } else if (voiceState === 'starting') {
    voiceStopPending = true;
    log('voice/toggle: stop requested while microphone is starting');
  } else {
    beginVoiceInteraction(false);
  }
});

/**
 * /voice/stop – stop recording and let HA finish STT → TTS.
 */
service.register('voice/stop', function(message) {
  message.respond({ returnValue: true });
  log('voice/stop, state=' + voiceState);
  if (voiceState === 'listening') {
    doStopListening();
  } else if (voiceState === 'starting') {
    voiceStopPending = true;
    log('voice/stop: stop requested while microphone is starting');
  }
});

/**
 * /voice/abort – cancel immediately and return to idle.
 */
service.register('voice/abort', function(message) {
  message.respond({ returnValue: true });
  log('voice/abort');
  clearPendingTts();
  voiceCleanup();
  setVoiceState('idle');
});

/**
 * /voice/state – returns current voice state; with subscribe:true the service
 * pushes an update on every state transition so the browser does not need to
 * poll. ttsUrl remains pending until /voice/ackTts confirms receipt.
 */
service.register('voice/state', function(message) {
  message.respond({
    returnValue: true,
    state:       voiceState,
    transcript:  voiceTranscript,
    ttsUrl:      voiceTtsUrl,
    responseText: voiceResponseText,
  });

  if (message.isSubscription()) {
    voiceSubscribers[message.uniqueToken] = message;
    message.setCancelFunction(function() {
      delete voiceSubscribers[message.uniqueToken];
    });
  }
});

service.register('voice/ackTts', function(message) {
  var ackUrl = message.payload && message.payload.ttsUrl;
  if (!ackUrl || ackUrl === voiceTtsUrl) clearPendingTts();
  message.respond({ returnValue: true });
});

/**
 * /startSetupServer – start OAuth companion HTTP server, return { url }.
 */
service.register('startSetupServer', function(message) {
  var ip = getLocalIP();
  if (!ip) {
    message.respond({ returnValue: false, errorText: 'Could not determine TV IP address' });
    return;
  }

  var clientId = 'http://' + ip + ':' + SETUP_PORT;
  message.respond({ returnValue: true, url: clientId });

  startOAuthServer(clientId).catch(function(err) {
    log('startOAuthServer error:', err.message);
  });

  // F2: the setup server is only needed for the few minutes of OAuth. Auto-stop it
  // so 0.0.0.0:8642 isn't left listening for the life of the TV.
  if (setupStopTimer) clearTimeout(setupStopTimer);
  setupStopTimer = setTimeout(function() {
    setupStopTimer = null;
    if (setupServer) {
      setupServer.close();
      setupServer = null;
      clearPendingOAuth();
      log('setup server auto-stopped after timeout');
    }
  }, SETUP_TIMEOUT_MS);
});

/**
 * /stopSetupServer – shut down the companion HTTP server.
 */
service.register('stopSetupServer', function(message) {
  if (setupStopTimer) { clearTimeout(setupStopTimer); setupStopTimer = null; }
  if (setupServer) {
    setupServer.close();
    setupServer = null;
    clearPendingOAuth();
  }
  message.respond({ returnValue: true });
});

/**
 * /getPendingConfig – Luna replacement for the old public /pending-config HTTP
 * route (F3). The phone-based setup flow stores the freshly-obtained HA config in
 * `pendingConfig`; the on-TV app polls this over the (bus-authenticated) Luna
 * socket instead of an open, wildcard-CORS HTTP endpoint. Delivered once.
 */
service.register('getPendingConfig', function(message) {
  var cfg = pendingConfig;
  pendingConfig = null;
  if (cfg) log('pending-config picked up by app (luna)');
  message.respond({ returnValue: true, config: cfg || null });
});

log('Service started (PID ' + process.pid + ', root: ' + isRoot() + ')');

// ── voiceconductor interactor ─────────────────────────────────────────────────
// Registers as a voiceconductor interactor so we can intercept the result of LG's
// native voice recognition and forward the text to HA's conversation pipeline.
// This fires when the user uses the Magic Remote mic button without our inputhook
// intercepting it (or if voiceconductor triggers independently).

function startVcInteractor() {
  service.call(
    'luna://com.webos.service.voiceconductor/interactor/register',
    { subscribe: true, type: 'foreground' },
    function(msg) {
      handleVcEvent(msg.payload);
    }
  );
  log('[vc] registered as interactor');
}

function handleVcEvent(p) {
  if (!p || !p.command) return;
  log('[vc] event cmd=' + p.command + ' ticket=' + (p.voiceTicket || '') +
      ' action=' + JSON.stringify(p.action || null).slice(0, 200));

  var cmd    = p.command;
  var ticket = p.voiceTicket;

  if (cmd === 'setContext') {
    // We don't claim context – let the native system handle it.
    vcReportResult(ticket, false, {});

  } else if (cmd === 'performAction') {
    handleVcPerformAction(ticket, p.action);
  }
}

function vcReportResult(ticket, result, feedback) {
  service.call(
    'luna://com.webos.service.voiceconductor/interactor/reportActionResult',
    { voiceTicket: ticket, result: !!result, feedback: feedback || {} },
    function(msg) {
      log('[vc] reportActionResult:', JSON.stringify(msg.payload));
    }
  );
}

/**
 * Try to extract the recognized text from whatever NLP result structure
 * voiceconductor sends.  We log the full action first so we can refine this.
 */
function extractVcText(action) {
  if (!action) return '';
  return action.displayString
      || action.utterance
      || action.text
      || action.sttResult
      || action.recognized
      || (action.nlpResult && (action.nlpResult.displayString || action.nlpResult.utterance))
      || '';
}

function handleVcPerformAction(ticket, action) {
  var text = extractVcText(action);
  log('[vc] performAction text=' + JSON.stringify(text) +
      ' fullAction=' + JSON.stringify(action || null).slice(0, 400));

  if (!text || !voiceHAConfig) {
    // Can't handle – let native proceed.
    vcReportResult(ticket, false, {});
    return;
  }

  // Claim the action so native handlers don't also fire.
  vcReportResult(ticket, true, {});
  voiceTranscript = text;
  setVoiceState('processing');
  runHATextPipeline(text);
}

/**
 * Try each LG STT candidate against HA's intent engine in sequence.
 * The first candidate whose intent-end response_type is not "error" wins.
 * If all candidates fail, state returns to idle.
 */
function runHATextPipelineWithFallback(candidates) {
  var text = candidates[0];
  var rest = candidates.slice(1);
  log('[vc] trying candidate:', JSON.stringify(text), '(' + rest.length + ' remaining)');
  voiceTranscript = text;
  // State may already be 'processing' on a retry – broadcast so subscribers
  // see the updated transcript even though the state hasn't changed.
  if (voiceState === 'processing') broadcastVoiceState();

  runHATextPipeline(text, function onIntentResult(matched) {
    if (!matched && rest.length > 0) {
      log('[vc] candidate unmatched, trying next');
      runHATextPipelineWithFallback(rest);
    } else if (!matched) {
      log('[vc] all candidates exhausted, no match');
      setVoiceState('idle');
    }
    // matched = true: pipeline continues naturally to tts-start / run-end
  });
}

/**
 * Run HA's assist_pipeline starting from the intent stage (skipping STT).
 * onIntentResult(matched: bool) is called when intent-end is received so the
 * caller can decide whether to try the next candidate.
 */
function runHATextPipeline(text, onIntentResult) {
  if (!voiceHAConfig) { setVoiceError('no HA config'); return; }
  ensureFreshToken().then(function() {
    var wsUrl = voiceHAConfig.url.replace(/^http/, 'ws') + '/api/websocket';
    log('[vc] HA text pipeline for:', JSON.stringify(text));
    var runId   = voiceMsgId++;
    var localWS = null;       // ref to this specific WS so onClose can guard
    var intentDone = false;   // fire onIntentResult only once
    var vcSpeechText = '';    // speech text from intent-end for native TTS fallback

    function signalIntent(matched) {
      if (intentDone) return;
      intentDone = true;
      if (onIntentResult) onIntentResult(matched);
    }

    localWS = voiceWS = wsConnect(
      wsUrl,
      function onMsg(data) {
        var msg;
        try { msg = JSON.parse(data); } catch (_) { return; }

        if (msg.type === 'auth_required') {
          localWS.send(JSON.stringify({ type: 'auth', access_token: voiceHAConfig.token }));

        } else if (msg.type === 'auth_ok') {
          var startMsg = {
            id:          runId,
            type:        'assist_pipeline/run',
            start_stage: 'intent',
            end_stage:   'tts',
            input:       { text: text },
          };
          if (voiceHAConfig.pipelineId) startMsg.pipeline = voiceHAConfig.pipelineId;
          localWS.send(JSON.stringify(startMsg));

        } else if (msg.type === 'auth_invalid') {
          signalIntent(false);
          setVoiceError('[vc] HA auth invalid');

        } else if (msg.type === 'result' && msg.id === runId && !msg.success) {
          signalIntent(false);
          setVoiceError('[vc] pipeline failed: ' + (msg.error && msg.error.message || ''));

        } else if (msg.type === 'event' && msg.id === runId) {
          var evt = msg.event;
          if (!evt) return;
          log('[vc] pipeline evt:', evt.type);

          if (evt.type === 'intent-end') {
            // response_type: 'action_done' | 'query_answer' = matched
            //                'error'                         = no intent found
            var intentOut    = evt.data && evt.data.intent_output;
            var responseType = intentOut && intentOut.response && intentOut.response.response_type;
            var matched      = responseType !== 'error';
            log('[vc] intent-end response_type:', responseType, '→', matched ? 'matched' : 'no match');
            // Stash HA's spoken reply for native TTS fallback if tts-start has no URL.
            vcSpeechText = (intentOut && intentOut.response && intentOut.response.speech
                           && intentOut.response.speech.plain && intentOut.response.speech.plain.speech) || '';
            voiceResponseText = vcSpeechText || voiceResponseText;
            if (vcSpeechText) log('[vc] speech text:', JSON.stringify(vcSpeechText));
            signalIntent(matched);

            if (!matched) {
              // Close this WS cleanly; caller will try the next candidate.
              // Null voiceWS first so onClose won't see it as the active pipeline.
              voiceWS = null;
              localWS.close();
            }

          } else if (evt.type === 'tts-start' || evt.type === 'tts-end') {
            var url = (evt.data && evt.data.tts_output && evt.data.tts_output.url) || '';
            voiceResponseText = (evt.data && evt.data.tts_input) || voiceResponseText;
            log('[vc] ' + evt.type + ' url:', url);
            if (url) {
              voiceTtsUrl = url;
              scheduleTtsDeliveryFallback();
              setVoiceState('speaking');
            } else if (evt.type === 'tts-end' && vcSpeechText) {
              speakNative(vcSpeechText);
              vcSpeechText = '';
            }

          } else if (evt.type === 'error') {
            signalIntent(false);
            setVoiceError('[vc] ' + (evt.data && evt.data.message || 'pipeline error'));

          } else if (evt.type === 'run-end') {
            signalIntent(true);
            voiceCleanup();
            if (voiceState !== 'speaking') setVoiceState('idle');
          }
        }
      },
      function onErr(e) {
        log('[vc] HA WS error:', e);
        signalIntent(false);
        setVoiceError('[vc] WS error');
      },
      function onClose() {
        log('[vc] HA WS closed');
        // Only reset state when this socket is still the active pipeline.
        // If we nulled voiceWS to switch candidates, leave state alone.
        if (voiceWS === localWS && voiceState === 'processing') setVoiceState('idle');
      }
    );
  }).catch(function(err) {
    log('[vc] token error:', err.message);
    if (onIntentResult) onIntentResult(false);
    setVoiceError('token error: ' + err.message);
  });
}

startVcInteractor();

// F2: the setup server no longer runs from boot — it is started on demand via
// startSetupServer and stopped on completion/timeout. Keep the Node event loop
// alive explicitly (previously the always-on HTTP server did this implicitly).
setInterval(function() {}, 1 << 30);
