# HA Voice

A Home Assistant voice satellite for rooted LG webOS TVs. Press the Magic Remote mic button — the TV listens, sends your speech to Home Assistant, and speaks the response back through the TV's audio output.

---

## Contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [First-run setup](#first-run-setup)
- [Configuration](#configuration)
- [STT modes](#stt-modes)
  - [LG ThinQ AI (default)](#lg-thinq-ai-default)
  - [Home Assistant Whisper](#home-assistant-whisper)
- [OAuth setup from your phone](#oauth-setup-from-your-phone)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## How it works

The app has two parts that work together:

- **Browser app** (`com.homebrew.havoice`) — runs in WebAppManager (WAM). Displays the orb UI, plays TTS audio, connects to HA over WebSocket for token refresh.
- **Luna service** (`com.homebrew.havoice.service`) — runs as a persistent Node.js process. Handles the actual voice pipeline: audio capture, speech recognition, sending commands to HA, receiving TTS URLs.

The Magic Remote mic button is intercepted by [lginputhook](https://github.com/Simon34545/lginputhook), which calls the Luna service directly via `luna-send`. The service runs the entire voice pipeline independently — the browser app only needs to be open for its UI and audio playback.

---

## Prerequisites

- **Rooted LG webOS TV** with [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) installed
- **[lginputhook](https://github.com/Simon34545/lginputhook)** installed (provides key interception)
- **Home Assistant** with the [Assist pipeline](https://www.home-assistant.io/docs/assist/) configured
- A development machine with Node.js ≥ 18 and `@webos-tools/cli` (`npm install -g @webos-tools/cli`)

For HA STT mode specifically, you also need:
- [Wyoming Whisper](https://my.home-assistant.io/redirect/supervisor_addon/?addon=47701997_whisper) or another STT integration configured in your HA pipeline
- [Wyoming Piper](https://my.home-assistant.io/redirect/supervisor_addon/?addon=47701997_piper) or another TTS integration

---

## Installation

```sh
# Clone and install dev dependencies
git clone https://github.com/lorek123/lg-ha-voice
cd lg-ha-voice
npm install

# Build the IPK
npm run build

# Install to your TV (replace <your-tv> with the device name from ares-setup-device)
ares-install --device <your-tv> com.homebrew.havoice_*.ipk
```

After install, run first-run setup — see [below](#first-run-setup).

---

## First-run setup

The mic button integration requires root access to write the lginputhook keybind. There are two ways to do this:

### Option A — From the app UI

1. Open HA Voice on the TV. If not configured yet, set it up first (see [Configuration](#configuration)).
2. After connecting, a yellow banner appears: **"Mic button not configured"**.
3. Click **Enable Mic Button**. This uses Homebrew Channel's `elevateService` to temporarily grant root, then calls `/setup` on the Luna service.
4. The banner disappears. The mic button is now wired up.

### Option B — Via SSH

```sh
ssh root@<tv-ip>
sh /media/developer/apps/usr/palm/applications/com.homebrew.havoice/services/setup.sh
```

What setup does:
1. Writes `/home/root/.config/lginputhook/ha-voice-mic.sh` — a shell script that calls `luna-send` to the HA Voice service.
2. Adds keycode `428` (Magic Remote mic button) to `/home/root/.config/lginputhook/keybinds.json` with `action: exec`.

Legacy lginputhook calls the script with argument `1` on press and `0` on
release. Input Hook 1.5+ (`inputhookpp`) executes it once on key-down without an
argument, so one press starts recording and a second press stops it. Voice
activity detection or the 12-second safety timeout can also finish recording.

---

## Configuration

Open the app on the TV. You will see the config screen with these fields:

| Field | Description |
|---|---|
| **Home Assistant URL** | Full URL including port, e.g. `http://homeassistant.local:8123` |
| **Long-Lived Access Token** | Created in HA → Profile → Long-Lived Access Tokens. Not needed if using OAuth setup. |
| **Pipeline ID** | Optional. Leave blank to use the default Assist pipeline. Get the ID from HA → Settings → Voice Assistants. |
| **Speech Recognition** | `LG (ThinQ AI)` or `Home Assistant (Whisper)`. See [STT modes](#stt-modes). |

Click **Save & Connect**. The orb appears and the connection dot turns green when authenticated.

### Setting up from your phone (OAuth)

If you would rather not create a long-lived token, the config screen shows a URL like `http://192.168.1.x:8642`. Open that on your phone or computer — it walks through a standard HA OAuth flow and delivers the credentials automatically. See [OAuth setup](#oauth-setup-from-your-phone) for the full walkthrough.

---

## STT modes

### LG ThinQ AI (default)

Uses LG's built-in `voiceconductor` service for speech recognition. The TV's mic system handles audio capture and sends the result back as text. The text is then forwarded to HA's `assist_pipeline` starting from the **intent stage** (no audio sent to HA).

**Full flow:**

```
[mic button press]
       │
       ▼
lginputhook intercepts keycode 428 (state=1)
       │  runs ha-voice-mic.sh 1
       ▼
luna-send → /voice/start
       │
       ▼
service: voiceState = "listening"
       │
       ▼
service calls voiceconductor/recognizeVoice
       │  LG handles audio capture internally
       │  ThinQ AI cloud or on-device speech recognition
       ▼
recognizeVoice response: { returnValue: true, text: ["recognized text", …] }
       │  takes text[0]
       ▼
voiceTranscript = text
voiceState = "processing"
       │
       ▼
runHATextPipeline(text)
       │  opens HA WebSocket (ws://ha:8123/api/websocket)
       │  authenticates with stored token
       ▼
assist_pipeline/run {
  start_stage: "intent",   ← skips STT, text already known
  end_stage:   "tts",
  input:       { text: "recognized text" }
}
       │
       ▼
HA: NLU → intent match → action execution → TTS synthesis
       │
       ▼
event: tts-start { tts_output: { url: "/api/tts_proxy/…" } }
       │
       ▼
voiceTtsUrl = url
voiceState = "speaking"
       │
       ▼
app polls /voice/state → gets ttsUrl → Audio.play()
       │  plays TTS response through TV speakers
       ▼
event: run-end → voiceState = "idle"


[mic button release]
       │
       ▼
lginputhook: state=0 → ha-voice-mic.sh 0
       │
       ▼
luna-send → /voice/stop   (no-op: state is already "processing" or later)
```

**Fallback:** if `voiceconductor` is unavailable or returns no text (e.g. silence, unsupported firmware), the service automatically falls back to the HA STT pipeline.

**VoiceConductor interactor:** The service also registers as a `voiceconductor` interactor. This passive path fires when the user presses the mic button *without* the inputhook intercepting it — for example before setup is done, or when the built-in LG voice UI would otherwise handle it. The interactor receives the `performAction` event with the recognized text and forwards it to HA, claiming the action so the native LG handler does not also fire.

---

### Home Assistant Whisper

Uses HA's Whisper STT add-on for speech recognition. Raw PCM audio is streamed from the Magic Remote mic directly to HA over WebSocket. The full `stt → intent → tts` pipeline runs inside HA.

**Full flow:**

```
[mic button press]
       │
       ▼
lginputhook intercepts keycode 428 (state=1)
       │  runs ha-voice-mic.sh 1
       ▼
luna-send → /voice/start
       │
       ▼
service: voiceState = "listening"
       │
       ▼
service opens HA WebSocket (ws://ha:8123/api/websocket)
       │  authenticates with stored token
       ▼
assist_pipeline/run {
  start_stage: "stt",     ← full pipeline from audio
  end_stage:   "tts",
  input:       { sample_rate: 16000 }
}
       │  pipeline/result: success
       ▼
service calls voiceinput/startStreaming { deviceType: "remote", subscribe: true }
       │  voiceinput allocates a Unix domain socket
       ▼
voiceinput response: { socketPath: "/tmp/voiceinput_…" }
       │
       ▼
service connects to Unix socket
       │  reads raw PCM16 chunks (16 kHz mono, little-endian)
       │  for each chunk:
       ▼
binary WebSocket frame: <handler id byte><raw PCM>
       │  (streams continuously while the mic is active)
       │
       │  [optional: VAD]
       │  voiceinput fires state="voice stop" when silence detected
       │  → service auto-sends an empty binary frame without waiting for release


[mic button release]
       │
       ▼
lginputhook: state=0 → ha-voice-mic.sh 0
       │
       ▼
luna-send → /voice/stop
       │
       ▼
service: destroys Unix socket, cancels voiceinput subscription
       │
       ▼
binary WebSocket frame: <handler id byte>
       │
       ▼
HA Whisper: transcribes audio → transcript text
       │
       ▼
event: stt-end { stt_output: { text: "recognized text" } }
       │
       ▼
voiceTranscript = text
voiceState = "processing"
       │
       ▼
HA: NLU → intent match → action execution → TTS synthesis
       │
       ▼
event: tts-start { tts_output: { url: "/api/tts_proxy/…" } }
       │
       ▼
voiceTtsUrl = url
voiceState = "speaking"
       │
       ▼
app polls /voice/state → gets ttsUrl → Audio.play()
       │  plays TTS response through TV speakers
       ▼
event: run-end → voiceCleanup() → voiceState = "idle"
```

**Why a custom WebSocket client?** webOS 4 ships Node.js 0.12.2, which predates the `ws` npm package's minimum supported Node version. The service uses a hand-rolled WebSocket client (`wsConnect`) that handles the HTTP upgrade handshake, frame parsing/masking, and ping/pong — all compatible with Node 0.12.

**Audio format:** `com.webos.service.voiceinput` provides raw 16-bit signed PCM
at 16 kHz mono. HA assigns a binary WebSocket handler for each pipeline run;
every PCM frame is prefixed with that one-byte handler ID, and a frame containing
only the handler ID ends the stream.

---

## OAuth setup from your phone

This is the easiest way to connect when you don't want to create a long-lived token manually.

1. Open HA Voice on the TV. The config screen shows:
   ```
   Or set up from your phone — open this URL:
   http://192.168.1.x:8642
   ```
2. Open that URL on your phone or computer (must be on the same network as the TV).
3. Enter your **Home Assistant URL** and click **Login with Home Assistant**.
4. You are redirected to your HA login page. Sign in and click **Authorize**.
5. HA redirects back to the TV's HTTP server (`/callback`) with an authorization code.
6. The server exchanges the code for an `access_token` + `refresh_token` pair.
7. The TV app polls `/pending-config` every 2 seconds — it picks up the credentials automatically and connects.

The refresh token is stored so the app can renew the access token silently when it expires (HA access tokens expire after a few minutes when issued via OAuth; long-lived tokens do not expire).

**Flow diagram:**

```
Phone browser          TV HTTP server (:8642)      Home Assistant
      │                        │                         │
      │  GET /                 │                         │
      │──────────────────────►│                         │
      │  ◄── setup HTML page ──│                         │
      │                        │                         │
      │  POST /start-auth      │                         │
      │  { haUrl }             │                         │
      │──────────────────────►│                         │
      │                        │  generate state token   │
      │  302 → HA /auth/authorize                        │
      │◄──────────────────────│                         │
      │                        │                         │
      │  GET /auth/authorize?…                           │
      │─────────────────────────────────────────────────►│
      │  ◄─────────── login page ────────────────────── │
      │  [user logs in]        │                         │
      │  302 → /callback?code=…                          │
      │◄─────────────────────────────────────────────── │
      │                        │                         │
      │  GET /callback?code=…  │                         │
      │──────────────────────►│                         │
      │                        │  POST /auth/token       │
      │                        │  { code, client_id, … } │
      │                        │────────────────────────►│
      │                        │  ◄── { access_token,    │
      │                        │         refresh_token } │
      │  ◄── "Connected!" ─────│                         │
      │                        │  pendingConfig = { … }  │
      │                        │                         │
                    TV app polls /pending-config
                               │
                    picks up config, saves to localStorage
                    connects to HA WebSocket
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  LG webOS TV                                            │
│                                                         │
│  ┌──────────────────────┐    Luna IPC                   │
│  │  lginputhook         │──────────────────────────┐    │
│  │  (injected into      │  /voice/start (press)     │    │
│  │   lginput2 process)  │  /voice/stop  (release)   │    │
│  └──────────────────────┘                           │    │
│                                                     ▼    │
│  ┌──────────────────────┐    Luna IPC   ┌───────────────┐│
│  │  Browser app (WAM)   │◄────────────►│  Luna service ││
│  │  com.homebrew.havoice│  /voice/state │  (Node 0.12)  ││
│  │                      │  /setHAConfig │               ││
│  │  • orb UI            │  /setup       │  • voice fsm  ││
│  │  • TTS Audio.play()  │               │  • WS client  ││
│  │  • config screen     │               │  • OAuth srv  ││
│  │  • HA WS (auth only) │               │  • inputhook  ││
│  └──────────────────────┘               └───────┬───────┘│
│                                                 │        │
│  ┌───────────────────────────────┐              │        │
│  │  com.webos.service.voiceinput │◄─────────────┤        │
│  │  (Magic Remote mic)           │  startStreaming│       │
│  └───────────────────────────────┘  Unix socket │        │
│                                                 │        │
│  ┌───────────────────────────────┐              │        │
│  │  com.webos.service.voiceconductor│◄──────────┤        │
│  │  (LG ThinQ AI STT)            │  recognizeVoice│      │
│  └───────────────────────────────┘  interactor  │        │
└─────────────────────────────────────────────────┼────────┘
                                                  │ WebSocket
                                    ┌─────────────▼──────────┐
                                    │  Home Assistant        │
                                    │                        │
                                    │  assist_pipeline/run   │
                                    │  • STT (Whisper)       │
                                    │  • NLU / intent        │
                                    │  • TTS (Piper)         │
                                    └────────────────────────┘
```

### Key files

| Path | Description |
|---|---|
| `src/main.js` | Browser app entry point — UI wiring, state polling, voice controls |
| `src/ha-client.js` | HA WebSocket client with reconnect, OAuth token refresh |
| `src/audio.js` | Web Audio API recording (HA STT mode only) and TTS playback |
| `src/voice-pipeline.js` | Browser-side voice state machine (coordinates audio + HA client) |
| `service/index.js` | Luna service — all voice pipeline logic, OAuth server, inputhook setup |
| `service/setup.sh` | One-shot root setup script (writes inputhook keybind) |
| `scripts/build.sh` | Builds the IPK using esbuild + ares-package |
| `scripts/deploy.sh` | Builds and installs to the TV in one step |

### Luna service endpoints

| Endpoint | Description |
|---|---|
| `/setup` | Write inputhook keybind (requires root) |
| `/isSetupDone` | Returns `{ done: bool }` |
| `/setHAConfig` | Store HA credentials and pipeline config |
| `/startSetupServer` | Start OAuth HTTP server on port 8642, returns `{ url }` |
| `/stopSetupServer` | Shut down OAuth server |
| `/voice/start` | Begin voice interaction |
| `/voice/stop` | Stop recording, let pipeline finish STT → TTS |
| `/voice/abort` | Cancel immediately, return to idle |
| `/voice/state` | Returns `{ state, transcript, ttsUrl }` — `ttsUrl` is cleared after first read |

### Voice states

```
idle ──► listening ──► processing ──► speaking ──► idle
  ▲                                                  │
  └──────────────────── run-end ────────────────────┘

  Any state ──► error ──► (auto-recover after 3 s) ──► idle

  Any state ──► /voice/abort ──► idle
```

### Token storage

Config (URL, token, refresh token) is stored in two places:

- **Browser localStorage** (`ha_voice_config`) — used by the browser app to reconnect after WAM restarts.
- **`/tmp/ha-voice-ha-config.json`** — used by the Luna service so mic button works even when the browser app is not open.

Both are kept in sync: the browser app calls `/setHAConfig` on connect and whenever the token is refreshed.

---

## Development

```sh
# Install deps
npm install

# Run tests
npm test
npm run test:watch      # re-runs on file save

# Lint
npm run lint

# Build IPK
npm run build

# Build + install to TV
npm run deploy

# Regenerate icons (requires ImageMagick)
npm run icons
```

### Adding your TV to ares-cli

```sh
ares-setup-device
# follow prompts: name it "mytv", enter IP, username "prisoner"
```

### Logs

Service logs go to `/tmp/ha-voice-service.log` on the TV (capped at 512 KB, rotates in place). To tail live:

```sh
ssh root@<tv-ip> 'tail -f /tmp/ha-voice-service.log'
```

### Release

Tag a commit with `vX.Y.Z` and push — GitHub Actions builds the IPK and creates a GitHub release with the artifact attached.

```sh
git tag v1.2.0
git push origin v1.2.0
```

The workflow stamps the version into `appinfo.json` before packaging, so the IPK version matches the tag.

---

## Troubleshooting

### Mic button does nothing

1. Check that lginputhook is installed and running:
   ```sh
   ssh root@<tv-ip> 'ls /tmp/inputhook'
   ```
   If the flag file is missing, lginputhook isn't injected. Start it through Homebrew Channel.

2. Check that the keybind is configured:
   ```sh
   ssh root@<tv-ip> 'cat /home/root/.config/lginputhook/keybinds.json'
   ```
   You should see an entry for key `428` with `action: exec`. If not, run setup again.

3. Check the handler script exists and is executable:
   ```sh
   ssh root@<tv-ip> 'ls -la /home/root/.config/lginputhook/ha-voice-mic.sh'
   ```

4. Check service logs:
   ```sh
   ssh root@<tv-ip> 'tail -50 /tmp/ha-voice-service.log'
   ```

### "Something went wrong" immediately after pressing mic

- Check the service log for `voice error:` lines.
- Common causes: HA is unreachable, token expired (try re-entering credentials), pipeline not configured in HA.

### LG STT returns no text / wrong language

- LG ThinQ AI speech recognition uses the TV's configured language. Change it in **Settings → General → Language**.
- If `voiceconductor` is unavailable on your firmware, the service falls back to HA STT automatically. Check the log for `falling back to HA STT pipeline`.

### HA STT: audio is cut off / not recognized

- Make sure the Magic Remote is paired and the mic is not muted.
- Check that `com.webos.service.voiceinput` started successfully — look for `voiceinput socket path:` in the service log.
- Verify your HA Whisper add-on is running: in HA go to **Settings → Voice Assistants** and test the pipeline.

### TTS audio does not play

- The TTS URL is fetched from HA and played via `Audio` in the browser app. If the app is closed, TTS won't play (the service delivers the URL but nothing consumes it).
- Check that HA's TTS add-on (e.g. Piper) is configured. A pipeline without TTS will reach `run-end` without a `tts-start` event.
- Check browser console in the WAM inspector: `chrome://inspect` on a Chromium browser while the app is open.

### OAuth flow fails

- The TV's HTTP server (port 8642) must be reachable from the device running the browser. Both must be on the same network.
- HA must be reachable from the TV (not just from your phone). The token exchange is done TV → HA, not phone → HA.
- Check the service log for `token exchange status:` and `OAuth complete`.

### App shows stale UI after update

WebAppManager caches JavaScript aggressively. To force a reload:
```sh
ssh prisoner@<tv-ip> 'luna-send -n 1 luna://com.webos.applicationManager/close {"id":"com.homebrew.havoice"}'
```
Then reopen the app. If still stale, clear the WAM cache:
```sh
ssh root@<tv-ip> 'rm -rf /var/lib/wam/Default/Cache/ /var/lib/wam/Default/CodeCache/'
```
