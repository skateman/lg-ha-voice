/**
 * Home Assistant WebSocket client.
 * Handles auth, reconnection, and the assist_pipeline/run protocol.
 */

const RECONNECT_DELAY_MS = 3000;
const RECONNECT_MAX_MS = 30000;

export class HAClient {
  /** @type {WebSocket|null} */
  #ws = null;
  #url = '';
  #httpUrl = '';
  #token = '';
  #refreshToken = '';
  #clientId = '';
  #onTokenRefreshed = null; // (newToken) => void  – so main.js can persist it
  #msgId = 1;
  #pendingMessages = new Map(); // id → { resolve, reject }
  #eventHandlers = new Map();   // eventType → handler[]
  #reconnectDelay = RECONNECT_DELAY_MS;
  #reconnectTimer = null;
  #intentionalClose = false;
  #authenticated = false;
  #refreshing = false;    // prevents concurrent token refresh attempts

  constructor({ url, token, refreshToken = '', clientId = '', onTokenRefreshed = null }) {
    this.#httpUrl = url.replace(/\/$/, '');
    this.#url = this.#httpUrl.replace(/^http/, 'ws') + '/api/websocket';
    this.#token = token;
    this.#refreshToken = refreshToken;
    this.#clientId = clientId;
    this.#onTokenRefreshed = onTokenRefreshed;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN && this.#authenticated;
  }

  connect() {
    this.#intentionalClose = false;
    this.#openSocket();
  }

  disconnect() {
    this.#intentionalClose = true;
    clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
  }

  on(event, handler) {
    if (!this.#eventHandlers.has(event)) this.#eventHandlers.set(event, []);
    this.#eventHandlers.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this.#eventHandlers.get(event) ?? [];
    this.#eventHandlers.set(event, handlers.filter(h => h !== handler));
  }

  /**
   * Run an assist_pipeline in stt-start mode (streaming audio).
   * Returns a controller object to stream chunks and stop recording.
   *
   * @param {object} opts
   * @param {string} [opts.pipelineId] - optional pipeline id, blank = default
   * @param {string} [opts.language]
   * @param {function} opts.onSttEnd       - called with transcript string
   * @param {function} opts.onTtsStart     - called with tts url/token
   * @param {function} opts.onIntentEnd    - called with intent result object
   * @param {function} opts.onError        - called with error string
   * @param {function} opts.onDone         - called when pipeline finishes
   * @returns {{ sendAudio: (base64: string) => void, stop: () => void }}
   */
  runVoicePipeline({ pipelineId, language, onSttEnd, onTtsStart, onIntentEnd, onError, onDone }) {
    if (!this.connected) throw new Error('Not connected to Home Assistant');

    const id = this.#nextId();
    let handlerId = null;
    const pendingAudio = [];
    let stopPending = false;

    const sendAudio = (base64Chunk) => {
      const raw = atob(base64Chunk);
      const frame = new Uint8Array(raw.length + 1);
      frame[0] = handlerId;
      for (let i = 0; i < raw.length; i++) frame[i + 1] = raw.charCodeAt(i);
      this.#ws?.send(frame.buffer);
    };

    const stopAudio = () => {
      this.#ws?.send(new Uint8Array([handlerId]).buffer);
    };

    const startMsg = {
      id,
      type: 'assist_pipeline/run',
      start_stage: 'stt',
      end_stage: 'tts',
      input: { sample_rate: 16000 },
    };
    if (pipelineId) startMsg.pipeline = pipelineId;
    if (language) startMsg.language = language;

    // Subscribe to pipeline events before sending
    this.#pendingMessages.set(id, {
      onEvent: (event) => {
        switch (event.type) {
          case 'run-start':
            handlerId = event.data?.runner_data?.stt_binary_handler_id;
            if (!Number.isInteger(handlerId)) {
              onError?.('Pipeline did not provide an STT binary handler');
              break;
            }
            pendingAudio.splice(0).forEach(sendAudio);
            if (stopPending) stopAudio();
            break;
          case 'stt-end':
            onSttEnd?.(event.data?.stt_output?.text ?? '');
            break;
          case 'tts-start':
          case 'tts-end':
            if (event.data?.tts_output?.url) onTtsStart?.(event.data);
            break;
          case 'intent-end':
            onIntentEnd?.(event.data?.intent_output);
            break;
          case 'error':
            onError?.(event.data?.message ?? 'Pipeline error');
            break;
          case 'run-end':
            this.#pendingMessages.delete(id);
            onDone?.();
            break;
        }
      },
      onResult: (result) => {
        if (!result.success) {
          onError?.(result.error?.message ?? 'Failed to start pipeline');
          this.#pendingMessages.delete(id);
        }
      },
    });

    this.#send(startMsg);

    return {
      sendAudio: (base64Chunk) => {
        if (handlerId == null) pendingAudio.push(base64Chunk);
        else sendAudio(base64Chunk);
      },
      stop: () => {
        if (handlerId == null) stopPending = true;
        else stopAudio();
      },
    };
  }

  /** Fetch available voice pipelines */
  async listPipelines() {
    return this.#call({ type: 'assist_pipeline/pipeline/list' });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  #nextId() {
    return this.#msgId++;
  }

  #send(msg) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  #call(msg) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId();
      this.#pendingMessages.set(id, { resolve, reject });
      const msgWithId = Object.assign({}, msg, { id });
      this.#send(msgWithId);
    });
  }

  #openSocket() {
    this.#authenticated = false;
    this.#emit('connecting');

    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.onopen = () => {
      // HA sends auth_required first, we wait for it
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      this.#handleMessage(msg);
    };

    ws.onerror = (err) => {
      console.error('[HAClient] WebSocket error', err);
      // Emit a specific error if the URL is HTTPS — likely a certificate problem
      if (this.#url.startsWith('wss://') && !this.#authenticated) {
        this.#emit('auth_error', 'SSL certificate error — try http:// instead of https:// for local HA');
        this.#intentionalClose = true;
      }
    };

    ws.onclose = () => {
      this.#authenticated = false;
      this.#emit('disconnected');
      // Only reconnect if this socket is still current (guards against stale
      // onclose from a socket replaced during auth_invalid token refresh).
      if (!this.#intentionalClose && this.#ws === ws) this.#scheduleReconnect();
    };
  }

  #handleMessage(msg) {
    switch (msg.type) {
      case 'auth_required':
        this.#send({ type: 'auth', access_token: this.#token });
        break;

      case 'auth_ok':
        this.#authenticated = true;
        this.#reconnectDelay = RECONNECT_DELAY_MS;
        this.#emit('connected');
        break;

      case 'auth_invalid':
        this.#authenticated = false;
        if (this.#refreshToken && this.#clientId && !this.#refreshing) {
          // Try refreshing before giving up – token may have expired.
          // Keep intentionalClose=true while the old socket winds down so its
          // onclose does not trigger a reconnect.  this.#ws is set to null so
          // the ws===this.#ws guard also prevents a spurious scheduleReconnect.
          this.#intentionalClose = true;
          this.#refreshing = true;
          const expiredWs = this.#ws;
          this.#ws = null; // detach so its onclose won't trigger scheduleReconnect
          try { expiredWs?.close(); } catch (_) {}
          this.#refreshAccessToken()
            .then(newToken => {
              this.#refreshing = false;
              this.#token = newToken;
              this.#onTokenRefreshed?.(newToken, this.#refreshToken);
              this.#intentionalClose = false;
              this.#openSocket(); // reconnect with fresh token
            })
            .catch(err => {
              this.#refreshing = false;
              console.warn('[HAClient] Token refresh after auth_invalid failed:', err.message);
              this.#emit('auth_error', msg.message);
            });
        } else {
          this.#emit('auth_error', msg.message);
          this.#intentionalClose = true;
          this.#ws?.close();
        }
        break;

      case 'result': {
        const pending = this.#pendingMessages.get(msg.id);
        if (pending?.resolve) {
          if (msg.success) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error?.message ?? 'HA error'));
          this.#pendingMessages.delete(msg.id);
        } else if (pending?.onResult) {
          pending.onResult(msg);
        }
        break;
      }

      case 'event': {
        const pending = this.#pendingMessages.get(msg.id);
        pending?.onEvent?.(msg.event);
        break;
      }
    }
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#emit('reconnecting', this.#reconnectDelay);
    this.#reconnectTimer = setTimeout(async () => {
      // Refresh access token before reconnecting if we have a refresh token
      // and no refresh is already in flight (e.g. from auth_invalid handler).
      if (this.#refreshToken && this.#clientId && !this.#refreshing) {
        this.#refreshing = true;
        try {
          const newToken = await this.#refreshAccessToken();
          this.#token = newToken;
          this.#onTokenRefreshed?.(newToken, this.#refreshToken);
        } catch (err) {
          console.warn('[HAClient] Token refresh failed:', err.message);
          // Proceed anyway — maybe the existing token is still valid
        } finally {
          this.#refreshing = false;
        }
      }
      this.#openSocket();
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 1.5, RECONNECT_MAX_MS);
    }, this.#reconnectDelay);
  }

  async #refreshAccessToken() {
    // URLSearchParams({object}) is not supported on webOS WebKit — encode manually.
    const body = 'grant_type=refresh_token'
      + '&refresh_token=' + encodeURIComponent(this.#refreshToken)
      + '&client_id='     + encodeURIComponent(this.#clientId);
    const res = await fetch(this.#httpUrl + '/auth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('Refresh failed: HTTP ' + res.status);
    const data = await res.json();
    if (!data.access_token) throw new Error('No access_token in refresh response');
    // HA doesn't rotate refresh tokens by default, but update it if returned.
    if (data.refresh_token) this.#refreshToken = data.refresh_token;
    return data.access_token;
  }

  #emit(event, data) {
    const handlers = this.#eventHandlers.get(event) ?? [];
    handlers.forEach(h => h(data));
  }
}
