import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Orchestrator } from '../src/orchestrator.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

class MockAtem extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.ip = '192.168.1.1';
    this.programInput = 2; // starts on a different input
    this.inputs = [];
    this.autoCalled = 0;
  }
  status() { return { connected: this.connected, ip: this.ip, programInput: this.programInput, inputs: this.inputs }; }
  auto() { this.autoCalled++; }
  cut() {}
}

class MockObs extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.studioMode = true;
    this.address = 'ws://127.0.0.1:4455';
    this.programScene = 'Scene A';
    this.sceneMedia = noMedia();
    this.cutCount = 0;
  }
  status() { return { connected: this.connected, address: this.address, studioMode: this.studioMode, scenes: [] }; }
  async cutPreviewToProgram() { this.cutCount++; }
  async getProgramScene() { return this.programScene; }
  async getSceneMediaState(_scene) { return this.sceneMedia; }
}

// ── Media state helpers ─────────────────────────────────────────────────────────

function noMedia() {
  return { hasLooping: false, longest: null };
}
function playing(durationMs, cursorMs) {
  return { hasLooping: false, longest: { state: 'OBS_MEDIA_STATE_PLAYING', durationMs, cursorMs, ended: false } };
}
function ended(durationMs) {
  return { hasLooping: false, longest: { state: 'OBS_MEDIA_STATE_ENDED', durationMs, cursorMs: durationMs, ended: true } };
}
function looping() {
  return { hasLooping: true, longest: null };
}

// ── Test setup factory ──────────────────────────────────────────────────────────

const OBS_INPUT = 1;

function setup() {
  const atem = new MockAtem();
  const obs = new MockObs();
  const orch = new Orchestrator(atem, obs, { pollIntervalMs: 200 });
  orch.setObsAtemInput(OBS_INPUT);

  const events = [];
  orch.on('event', e => events.push(e));

  async function atemCutToObs() {
    atem.programInput = OBS_INPUT;
    await orch._onAtemProgramChanged(OBS_INPUT);
  }
  async function atemCutAway() {
    atem.programInput = 2;
    await orch._onAtemProgramChanged(2);
  }

  const endActions = () => events.filter(e => e.type === 'end_action');

  return { atem, obs, orch, events, endActions, atemCutToObs, atemCutAway };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('Orchestrator end-of-clip detection', () => {

  it('fires end action when video naturally ends', async () => {
    const { atem, obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    obs.sceneMedia = playing(10_000, 0);
    await orch._tick();

    obs.sceneMedia = ended(10_000);
    await orch._tick();

    assert.equal(endActions().length, 1);
    assert.equal(atem.autoCalled, 1); // default action is ATEM auto
  });

  it('fires only once even if ended state persists across multiple ticks', async () => {
    const { obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    obs.sceneMedia = playing(10_000, 9_000);
    await orch._tick();

    obs.sceneMedia = ended(10_000);
    for (let i = 0; i < 4; i++) await orch._tick();

    assert.equal(endActions().length, 1);
  });

  it('does not fire when ATEM cuts away before video ends', async () => {
    const { obs, orch, endActions, atemCutToObs, atemCutAway } = setup();
    await atemCutToObs();

    obs.sceneMedia = playing(10_000, 5_000);
    await orch._tick();

    await atemCutAway();

    obs.sceneMedia = ended(10_000);
    await orch._tick();

    assert.equal(endActions().length, 0);
  });

  it('does not fire on manual OBS cut to a scene with already-ended media', async () => {
    const { obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    obs.programScene = 'Scene A';
    obs.sceneMedia = playing(10_000, 5_000);
    await orch._tick(); // _seenPlaying = true for Scene A

    // User cuts OBS to Scene B — its media is already ended
    obs.programScene = 'Scene B';
    obs.sceneMedia = ended(8_000);
    await orch._tick(); // scene change detected → _seenPlaying reset to false
    await orch._tick(); // still ended, never seen playing on Scene B

    assert.equal(endActions().length, 0);
  });

  it('re-arms and fires after manual OBS cut from looping to non-looping scene', async () => {
    const { obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    obs.programScene = 'Scene A';
    obs.sceneMedia = looping();
    await orch._tick();
    await orch._tick();

    // User cuts OBS to a non-looping scene
    obs.programScene = 'Scene B';
    obs.sceneMedia = playing(8_000, 0);
    await orch._tick(); // re-arms, _seenPlaying = true

    obs.sceneMedia = ended(8_000);
    await orch._tick(); // fires

    assert.equal(endActions().length, 1);
  });

  it('fires early when scene name contains (-Xs) and remaining time reaches cue point', async () => {
    const { obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    // 10s clip, 7s elapsed → 3s remaining, which equals the 3s early cue
    obs.programScene = 'Interview (-3s)';
    obs.sceneMedia = playing(10_000, 7_000);
    await orch._tick(); // _seenPlaying = true, remaining 3000 <= earlyMs 3000 → fires

    assert.equal(endActions().length, 1);
  });

  it('does not fire early when remaining time is still above the cue offset', async () => {
    const { obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    obs.programScene = 'Interview (-3s)';
    obs.sceneMedia = playing(10_000, 5_000); // 5s remaining > 3s cue
    await orch._tick();

    assert.equal(endActions().length, 0);
  });

  it('does not fire when scene has both looping and non-looping items (hasLooping wins)', async () => {
    const { obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    // getSceneMediaState returns hasLooping=true even though longest is also present
    obs.sceneMedia = { hasLooping: true, longest: ended(10_000) };
    await orch._tick();
    await orch._tick();

    assert.equal(endActions().length, 0);
  });

  it('never fires for a looping scene', async () => {
    const { obs, orch, endActions, atemCutToObs } = setup();
    await atemCutToObs();

    obs.sceneMedia = looping();
    for (let i = 0; i < 5; i++) await orch._tick();

    assert.equal(endActions().length, 0);
  });
});
