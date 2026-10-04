import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HAClient } from '../src/ha-client.js';

// ── FakeWebSocket ─────────────────────────────────────────────────────────────

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  // ── Test helpers – simulate server actions ──────────────────────────────────

  /** Simulate the TCP connection being established. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate the server sending a message. */
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** Simulate the server closing the connection. */
  serverClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // ── WebSocket API ───────────────────────────────────────────────────────────

  send(data) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : new Uint8Array(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  get lastSent() {
    return this.sent[this.sent.length - 1];
  }

  sentOfType(type) {
    return this.sent.filter(m => m.type === type);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient(overrides = {}) {
  return new HAClient({
    url:          'http://ha.local:8123',
    token:        'test-token',
    refreshToken: '',
    clientId:     '',
    ...overrides,
  });
}

/** Simulate a full successful auth handshake. */
function doAuth(ws) {
  ws.open();
  ws.receive({ type: 'auth_required' });
  ws.receive({ type: 'auth_ok' });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('URL construction', () => {
  it('converts http:// to ws://', () => {
    makeClient({ url: 'http://ha.local:8123' }).connect();
    expect(FakeWebSocket.last.url).toBe('ws://ha.local:8123/api/websocket');
  });

  it('converts https:// to wss://', () => {
    makeClient({ url: 'https://ha.example.com' }).connect();
    expect(FakeWebSocket.last.url).toBe('wss://ha.example.com/api/websocket');
  });

  it('strips trailing slash from base URL', () => {
    makeClient({ url: 'http://ha.local:8123/' }).connect();
    expect(FakeWebSocket.last.url).toBe('ws://ha.local:8123/api/websocket');
  });
});

describe('event emitter', () => {
  it('calls registered handler', () => {
    const client = makeClient();
    const spy = vi.fn();
    client.on('connecting', spy);
    client.connect();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('calls multiple handlers for the same event', () => {
    const client = makeClient();
    const a = vi.fn(), b = vi.fn();
    client.on('connecting', a);
    client.on('connecting', b);
    client.connect();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('unsubscribes via the function returned from on()', () => {
    const client = makeClient();
    const spy = vi.fn();
    const off = client.on('connecting', spy);
    off();
    client.connect();
    expect(spy).not.toHaveBeenCalled();
  });

  it('unsubscribes via off()', () => {
    const client = makeClient();
    const spy = vi.fn();
    client.on('connecting', spy);
    client.off('connecting', spy);
    client.connect();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('auth flow', () => {
  it('replies to auth_required with the access token', () => {
    const client = makeClient({ token: 'my-token' });
    client.connect();
    const ws = FakeWebSocket.last;
    ws.open();
    ws.receive({ type: 'auth_required' });
    expect(ws.sentOfType('auth')).toEqual([{ type: 'auth', access_token: 'my-token' }]);
  });

  it('emits connected and sets connected=true after auth_ok', () => {
    const client = makeClient();
    const spy = vi.fn();
    client.on('connected', spy);
    client.connect();
    doAuth(FakeWebSocket.last);
    expect(spy).toHaveBeenCalledOnce();
    expect(client.connected).toBe(true);
  });

  it('connected is false before auth_ok', () => {
    const client = makeClient();
    client.connect();
    FakeWebSocket.last.open();
    expect(client.connected).toBe(false);
  });

  it('connected becomes false after disconnect', () => {
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    client.disconnect();
    expect(client.connected).toBe(false);
  });

  it('emits auth_error on auth_invalid with no refresh token', () => {
    const client = makeClient();
    const spy = vi.fn();
    client.on('auth_error', spy);
    client.connect();
    const ws = FakeWebSocket.last;
    ws.open();
    ws.receive({ type: 'auth_required' });
    ws.receive({ type: 'auth_invalid', message: 'Invalid token' });
    expect(spy).toHaveBeenCalledWith('Invalid token');
  });
});

describe('token refresh on auth_invalid', () => {
  it('refreshes token and reconnects with the new token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'fresh-token' }),
    }));

    // Resolve a promise the moment onTokenRefreshed is invoked so we don't
    // race against vi.waitFor's polling interval vs microtask scheduling.
    let resolveRefreshed;
    const refreshedPromise = new Promise(r => { resolveRefreshed = r; });
    const client = makeClient({
      refreshToken: 'rtoken',
      clientId:     'client123',
      onTokenRefreshed: t => resolveRefreshed(t),
    });
    client.connect();

    const ws1 = FakeWebSocket.last;
    ws1.open();
    ws1.receive({ type: 'auth_required' });
    ws1.receive({ type: 'auth_invalid', message: 'expired' });

    // onTokenRefreshed is called synchronously right before #openSocket() in
    // the same .then() block, so by the time this resolves, ws2 already exists
    // and this.#token is already 'fresh-token'.
    const newToken = await refreshedPromise;
    expect(newToken).toBe('fresh-token');

    const ws2 = FakeWebSocket.last;
    expect(ws2).not.toBe(ws1);
    ws2.open();
    ws2.receive({ type: 'auth_required' });
    expect(ws2.sentOfType('auth')).toEqual([{ type: 'auth', access_token: 'fresh-token' }]);
  });

  it('emits auth_error if the refresh request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    let resolveAuthError;
    const authErrorPromise = new Promise(r => { resolveAuthError = r; });
    const client = makeClient({ refreshToken: 'rtoken', clientId: 'client123' });
    client.on('auth_error', resolveAuthError);
    client.connect();

    const ws = FakeWebSocket.last;
    ws.open();
    ws.receive({ type: 'auth_required' });
    ws.receive({ type: 'auth_invalid', message: 'expired' });

    const errMsg = await authErrorPromise;
    expect(errMsg).toBe('expired');
  });

  it('does not start a second refresh if one is already in flight', async () => {
    let resolveFirst;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise(resolve => { resolveFirst = resolve; })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient({ refreshToken: 'rtoken', clientId: 'client123' });
    client.connect();

    const ws = FakeWebSocket.last;
    ws.open();
    ws.receive({ type: 'auth_required' });
    ws.receive({ type: 'auth_invalid', message: 'expired' });
    // Second auth_invalid while first refresh is still in flight
    ws.receive({ type: 'auth_invalid', message: 'expired' });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve so the test doesn't hang
    resolveFirst({ ok: true, json: () => Promise.resolve({ access_token: 'tok' }) });
  });
});

describe('reconnect backoff', () => {
  it('schedules reconnect after unexpected server close', () => {
    vi.useFakeTimers();
    const client = makeClient();
    const reconnecting = vi.fn();
    client.on('reconnecting', reconnecting);
    client.connect();
    doAuth(FakeWebSocket.last);
    FakeWebSocket.last.serverClose();
    expect(reconnecting).toHaveBeenCalledOnce();
  });

  it('does not reconnect after intentional disconnect', () => {
    vi.useFakeTimers();
    const client = makeClient();
    const reconnecting = vi.fn();
    client.on('reconnecting', reconnecting);
    client.connect();
    doAuth(FakeWebSocket.last);
    client.disconnect();
    vi.runAllTimers();
    expect(reconnecting).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('increases delay by 1.5x on each failure', () => {
    vi.useFakeTimers();
    const client = makeClient();
    const delays = [];
    client.on('reconnecting', d => delays.push(d));

    client.connect();
    FakeWebSocket.last.serverClose();           // 3000
    vi.advanceTimersByTime(3000);
    FakeWebSocket.last.serverClose();           // 4500
    vi.advanceTimersByTime(4500);
    FakeWebSocket.last.serverClose();           // 6750
    vi.advanceTimersByTime(6750);

    expect(delays).toEqual([3000, 4500, 6750]);
  });

  it('caps delay at 30 000 ms', () => {
    vi.useFakeTimers();
    const client = makeClient();
    const delays = [];
    client.on('reconnecting', d => delays.push(d));

    client.connect();
    for (let i = 0; i < 15; i++) {
      FakeWebSocket.last.serverClose();
      vi.advanceTimersByTime(delays[delays.length - 1] ?? 3000);
    }
    expect(Math.max(...delays)).toBe(30000);
  });

  it('resets delay to initial value after a successful auth_ok', () => {
    vi.useFakeTimers();
    const client = makeClient();
    const delays = [];
    client.on('reconnecting', d => delays.push(d));

    client.connect();
    FakeWebSocket.last.serverClose();           // 3000
    vi.advanceTimersByTime(3000);
    FakeWebSocket.last.serverClose();           // 4500
    vi.advanceTimersByTime(4500);
    doAuth(FakeWebSocket.last);                 // successful auth resets delay
    FakeWebSocket.last.serverClose();           // should be 3000 again

    expect(delays[delays.length - 1]).toBe(3000);
  });
});

describe('message ID sequencing', () => {
  it('assigns unique, monotonically increasing IDs', () => {
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    const ws = FakeWebSocket.last;

    client.runVoicePipeline({ onSttEnd: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    client.listPipelines();

    const ids = ws.sent.map(m => m.id).filter(id => id != null);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('runVoicePipeline', () => {
  it('throws if not connected', () => {
    const client = makeClient();
    expect(() => client.runVoicePipeline({ onDone: vi.fn(), onError: vi.fn() }))
      .toThrow('Not connected');
  });

  it('sends assist_pipeline/run with pipelineId when provided', () => {
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    client.runVoicePipeline({ pipelineId: 'pipe1', onDone: vi.fn(), onError: vi.fn(), onSttEnd: vi.fn() });
    const msg = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run');
    expect(msg.pipeline).toBe('pipe1');
  });

  it('omits pipeline field when pipelineId is blank', () => {
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    client.runVoicePipeline({ pipelineId: '', onDone: vi.fn(), onError: vi.fn(), onSttEnd: vi.fn() });
    const msg = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run');
    expect(msg.pipeline).toBeUndefined();
  });

  it('calls onSttEnd with the transcript on stt-end', () => {
    const onSttEnd = vi.fn();
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    client.runVoicePipeline({ onSttEnd, onDone: vi.fn(), onError: vi.fn() });

    const runId = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run').id;
    FakeWebSocket.last.receive({ type: 'result', id: runId, success: true, result: {} });
    FakeWebSocket.last.receive({
      type: 'event', id: runId,
      event: { type: 'stt-end', data: { stt_output: { text: 'hello world' } } },
    });
    expect(onSttEnd).toHaveBeenCalledWith('hello world');
  });

  it('calls onError on pipeline error event', () => {
    const onError = vi.fn();
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    client.runVoicePipeline({ onError, onDone: vi.fn(), onSttEnd: vi.fn() });

    const runId = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run').id;
    FakeWebSocket.last.receive({ type: 'result', id: runId, success: true, result: {} });
    FakeWebSocket.last.receive({
      type: 'event', id: runId,
      event: { type: 'error', data: { message: 'STT failed' } },
    });
    expect(onError).toHaveBeenCalledWith('STT failed');
  });

  it('calls onDone on run-end', () => {
    const onDone = vi.fn();
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    client.runVoicePipeline({ onDone, onError: vi.fn(), onSttEnd: vi.fn() });

    const runId = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run').id;
    FakeWebSocket.last.receive({ type: 'result', id: runId, success: true, result: {} });
    FakeWebSocket.last.receive({ type: 'event', id: runId, event: { type: 'run-end' } });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('delivers the TTS URL from tts-end', () => {
    const onTtsStart = vi.fn();
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    client.runVoicePipeline({ onTtsStart, onDone: vi.fn(), onError: vi.fn(), onSttEnd: vi.fn() });

    const runId = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run').id;
    FakeWebSocket.last.receive({
      type: 'event', id: runId,
      event: { type: 'tts-end', data: { tts_output: { url: '/api/tts_proxy/test' } } },
    });
    expect(onTtsStart).toHaveBeenCalledWith({
      tts_output: { url: '/api/tts_proxy/test' },
    });
  });

  it('sendAudio sends binary PCM prefixed by the handler id', () => {
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    const ctrl = client.runVoicePipeline({ onDone: vi.fn(), onError: vi.fn(), onSttEnd: vi.fn() });
    const runId = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run').id;
    FakeWebSocket.last.receive({
      type: 'event', id: runId,
      event: { type: 'run-start', data: { runner_data: { stt_binary_handler_id: 7 } } },
    });
    ctrl.sendAudio('AQID');
    expect(Array.from(FakeWebSocket.last.lastSent)).toEqual([7, 1, 2, 3]);
  });

  it('queues audio until the handler id arrives', () => {
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    const ctrl = client.runVoicePipeline({ onDone: vi.fn(), onError: vi.fn(), onSttEnd: vi.fn() });
    ctrl.sendAudio('AQI=');
    const runId = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run').id;
    FakeWebSocket.last.receive({
      type: 'event', id: runId,
      event: { type: 'run-start', data: { runner_data: { stt_binary_handler_id: 9 } } },
    });
    expect(Array.from(FakeWebSocket.last.lastSent)).toEqual([9, 1, 2]);
  });

  it('stop() sends an empty binary frame for the handler id', () => {
    const client = makeClient();
    client.connect();
    doAuth(FakeWebSocket.last);
    const ctrl = client.runVoicePipeline({ onDone: vi.fn(), onError: vi.fn(), onSttEnd: vi.fn() });
    const runId = FakeWebSocket.last.sent.find(m => m.type === 'assist_pipeline/run').id;
    FakeWebSocket.last.receive({
      type: 'event', id: runId,
      event: { type: 'run-start', data: { runner_data: { stt_binary_handler_id: 5 } } },
    });
    ctrl.stop();
    expect(Array.from(FakeWebSocket.last.lastSent)).toEqual([5]);
  });
});
