import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ObsController } from '../src/obs.js';

// ── Mock OBSWebSocket ──────────────────────────────────────────────────────────
// ObsController creates `this.obs = new OBSWebSocket()` internally.
// We swap it out after construction to control what `obs.call()` returns.

class MockOBSWS extends EventEmitter {
  constructor(calls) {
    super();
    this._calls = calls;
  }
  async call(method, params) {
    const handler = this._calls[method];
    if (typeof handler === 'function') return handler(params);
    if (handler !== undefined) return handler;
    throw new Error(`unexpected OBS call: ${method}(${JSON.stringify(params)})`);
  }
}

function makeObs(calls) {
  const ctrl = new ObsController();
  ctrl.obs = new MockOBSWS(calls);
  return ctrl;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function mediaStatus(state, durationMs, cursorMs) {
  return { mediaState: state, mediaDuration: durationMs, mediaCursor: cursorMs };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('ObsController.getSceneMediaState', () => {

  it('returns hasLooping=true when the only item is looping', async () => {
    const obs = makeObs({
      GetSceneItemList: () => ({ sceneItems: [{ sourceName: 'bg' }] }),
      GetMediaInputStatus: () => mediaStatus('OBS_MEDIA_STATE_PLAYING', 0, 0),
      GetInputSettings: () => ({ inputSettings: { looping: true } }),
    });

    const result = await obs.getSceneMediaState('Scene A');
    assert.equal(result.hasLooping, true);
    assert.equal(result.longest, null);
  });

  it('returns hasLooping=true when one of multiple items is looping', async () => {
    const obs = makeObs({
      GetSceneItemList: () => ({ sceneItems: [{ sourceName: 'bg-loop' }, { sourceName: 'clip' }] }),
      GetMediaInputStatus: ({ inputName }) => ({
        'bg-loop': mediaStatus('OBS_MEDIA_STATE_PLAYING', 0, 0),
        clip:      mediaStatus('OBS_MEDIA_STATE_PLAYING', 60_000, 10_000),
      }[inputName]),
      GetInputSettings: ({ inputName }) => ({
        inputSettings: { looping: inputName === 'bg-loop' },
      }),
    });

    const result = await obs.getSceneMediaState('Scene A');
    assert.equal(result.hasLooping, true);
    // non-looping clip is still tracked in longest even when hasLooping is set
    assert.equal(result.longest?.inputName, 'clip');
  });

  it('picks the longest non-looping clip from multiple items', async () => {
    const obs = makeObs({
      GetSceneItemList: () => ({ sceneItems: [{ sourceName: 'short' }, { sourceName: 'long' }] }),
      GetMediaInputStatus: ({ inputName }) => ({
        short: mediaStatus('OBS_MEDIA_STATE_PLAYING', 30_000, 0),
        long:  mediaStatus('OBS_MEDIA_STATE_PLAYING', 120_000, 0),
      }[inputName]),
      GetInputSettings: () => ({ inputSettings: {} }),
    });

    const result = await obs.getSceneMediaState('Scene A');
    assert.equal(result.hasLooping, false);
    assert.equal(result.longest?.inputName, 'long');
    assert.equal(result.longest?.durationMs, 120_000);
  });

  it('skips non-media items (images, text, etc.) that throw on GetMediaInputStatus', async () => {
    const obs = makeObs({
      GetSceneItemList: () => ({ sceneItems: [{ sourceName: 'image' }, { sourceName: 'clip' }] }),
      GetMediaInputStatus: ({ inputName }) => {
        if (inputName === 'image') throw new Error('not a media source');
        return mediaStatus('OBS_MEDIA_STATE_PLAYING', 60_000, 0);
      },
      GetInputSettings: () => ({ inputSettings: {} }),
    });

    const result = await obs.getSceneMediaState('Scene A');
    assert.equal(result.hasLooping, false);
    assert.equal(result.longest?.inputName, 'clip');
  });

  it('returns hasLooping=false and longest=null for a scene with no media items', async () => {
    const obs = makeObs({
      GetSceneItemList: () => ({ sceneItems: [{ sourceName: 'image' }] }),
      GetMediaInputStatus: () => { throw new Error('not a media source'); },
    });

    const result = await obs.getSceneMediaState('Scene A');
    assert.equal(result.hasLooping, false);
    assert.equal(result.longest, null);
  });

  it('correctly detects ended state on the longest clip', async () => {
    const obs = makeObs({
      GetSceneItemList: () => ({ sceneItems: [{ sourceName: 'clip' }] }),
      GetMediaInputStatus: () => mediaStatus('OBS_MEDIA_STATE_ENDED', 10_000, 10_000),
      GetInputSettings: () => ({ inputSettings: {} }),
    });

    const result = await obs.getSceneMediaState('Scene A');
    assert.equal(result.longest?.ended, true);
  });
});

describe('Orchestrator: scene with mixed looping and non-looping items', () => {
  // When hasLooping=true the orchestrator must not fire even if longest is ended.
  // This is tested at the orchestrator level using the mock sceneMedia directly.
  // (Covered by the obs.test.js cases above + orchestrator.test.js "never fires for looping".)
});

// ── Reconnect helpers ──────────────────────────────────────────────────────────
// These tests verify that ObsController retries the OBS WebSocket connection
// automatically after a disconnect or a failed initial connect attempt.

const GOOD_CALLS = {
  GetStudioModeEnabled: () => ({ studioModeEnabled: false }),
  GetSceneList: () => ({ scenes: [] }),
};

// Build a controller whose underlying OBSWebSocket is replaced with a fake.
// Returns { ctrl, originalObs } — emit events on originalObs to trigger the
// listeners bound in the constructor (they're attached to the original instance,
// not to whatever ctrl.obs points to later).
function makeReconnectObs(connectFn = async () => {}, callHandlers = {}) {
  const ctrl = new ObsController();
  const originalObs = ctrl.obs; // constructor bound 'ConnectionClosed' here
  const fakeWs = new EventEmitter();
  fakeWs.connect = connectFn;
  fakeWs.call = async (method, params) => {
    const h = callHandlers[method];
    if (typeof h === 'function') return h(params);
    if (h !== undefined) return h;
    throw new Error(`unexpected OBS call: ${method}`);
  };
  ctrl.obs = fakeWs; // future ctrl.connect() / getSceneMediaState() use this
  return { ctrl, originalObs };
}

describe('ObsController reconnect', () => {

  it('schedules reconnect timer after ConnectionClosed', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { ctrl, originalObs } = makeReconnectObs();
    ctrl.address = 'ws://localhost:4455';

    originalObs.emit('ConnectionClosed');

    assert.ok(ctrl._reconnectTimer !== null, 'reconnect timer should be set');
  });

  it('does not schedule reconnect if address is unknown', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { ctrl, originalObs } = makeReconnectObs();
    // ctrl.address is null — connect() was never called

    originalObs.emit('ConnectionClosed');

    assert.equal(ctrl._reconnectTimer, null, 'no timer without a known address');
  });

  it('does not replace an already-pending reconnect timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { ctrl, originalObs } = makeReconnectObs();
    ctrl.address = 'ws://localhost:4455';

    originalObs.emit('ConnectionClosed');
    const first = ctrl._reconnectTimer;
    originalObs.emit('ConnectionClosed'); // second event before timer fires

    assert.strictEqual(ctrl._reconnectTimer, first, 'same timer, not replaced');
  });

  it('retries connect() when the reconnect timer fires', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let connectCalls = 0;
    const { ctrl, originalObs } = makeReconnectObs(
      async () => { connectCalls++; }, GOOD_CALLS
    );
    ctrl.address = 'ws://localhost:4455';

    originalObs.emit('ConnectionClosed');
    t.mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve)); // flush async chain

    assert.equal(connectCalls, 1, 'connect should be retried once');
  });

  it('schedules reconnect when connect() throws', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { ctrl } = makeReconnectObs(async () => { throw new Error('refused'); });

    await assert.rejects(() => ctrl.connect('ws://localhost:4455', ''));

    assert.ok(ctrl._reconnectTimer !== null, 'timer set after failed connect');
  });

  it('clears pending reconnect timer when connect() succeeds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { ctrl, originalObs } = makeReconnectObs(async () => {}, GOOD_CALLS);
    ctrl.address = 'ws://localhost:4455';

    originalObs.emit('ConnectionClosed');
    assert.ok(ctrl._reconnectTimer !== null, 'timer pending before manual connect');

    await ctrl.connect('ws://localhost:4455', '');

    assert.equal(ctrl._reconnectTimer, null, 'timer cleared after successful connect');
  });
});
