// src/orchestrator.js — the state machine wiring ATEM + OBS together.
import { EventEmitter } from 'node:events';

// Parse "(-Xs)" suffix from a scene name → milliseconds early cue (0 if absent).
// e.g. "Interview (-3s)" → 3000, "B-Roll (-0.5s)" → 500, "Intro" → 0
function parseEarlyCueMs(sceneName) {
  const m = sceneName?.match(/\(-(\d+(?:\.\d+)?)s\)\s*$/);
  return m ? parseFloat(m[1]) * 1000 : 0;
}

// End-of-video action choices exposed in the dock dropdown.
export const END_ACTIONS = {
  ATEM_CUT_TO_PREVIEW: 'atem_cut_to_preview',
  OBS_CUT_TO_PREVIEW: 'obs_cut_to_preview',
  NOTHING: 'nothing'
};

export class Orchestrator extends EventEmitter {
  constructor(atem, obs, config) {
    super();
    this.atem = atem;
    this.obs = obs;
    this.config = config;

    // user-controlled settings (driven from the dock)
    this.following = true;            // follow/pause toggle (#3)
    this.obsAtemInput = null;        // which ATEM input is OBS (#2)
    this.endAction = END_ACTIONS.ATEM_CUT_TO_PREVIEW;
    this.endActionScene = null;      // scene X for OBS_GO_TO_SCENE

    // internal runtime state
    this._playing = false;           // OBS clip currently driving program
    this._playingScene = null;       // scene we're currently tracking (null = not yet set)
    this._seenPlaying = false;       // have we seen the clip in PLAYING state this session?
    this._endHandled = false;        // debounce so we only fire the end action once
    this._poll = null;
    this._lastMedia = null;          // { durationMs, cursorMs } from last tick
    this._hasLooping = false;        // current program scene contains a looping source

    // #4: ATEM cut to OBS's input => OBS cuts preview to program.
    this.atem.on('programChanged', (input) => this._onAtemProgramChanged(input));

    this.atem.on('status', () => this.emit('status'));
    this.obs.on('status', () => this.emit('status'));
  }

  // ---- settings setters (called from the HTTP/WS API) ----
  setFollowing(v) { this.following = Boolean(v); this.emit('status'); }
  setObsAtemInput(id) { this.obsAtemInput = Number(id); this.emit('status'); }
  setEndAction(action) { this.endAction = action; this.emit('status'); }
  setEndActionScene(scene) { this.endActionScene = scene; this.emit('status'); }
  setAtemIp(ip) {
    const clean = String(ip || '').trim();
    if (!clean) return;
    this.emit('persist', { atemIp: clean });
    this.atem.connect(clean); // async; fires 'status' as it progresses
  }

  // ---- readiness (#1, #3) ----
  isReady() {
    return (
      this.atem.connected &&
      this.obs.connected &&
      this.obs.studioMode &&
      this.obsAtemInput != null
    );
  }

  start() {
    if (this._poll) return;
    this._poll = setInterval(() => this._tick().catch(() => {}), this.config.pollIntervalMs);
  }

  stop() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
  }

  async _onAtemProgramChanged(input) {
    if (!this.following || !this.isReady()) return;
    if (input === this.obsAtemInput) {
      // ATEM cut TO OBS — perform the OBS cut, send preview live, arm end-detection.
      await this.obs.cutPreviewToProgram();
      this._playing = true;
      this._playingScene = null;
      this._seenPlaying = false;
      this._endHandled = false;
      this.emit('event', { type: 'atem_cut_to_obs', input });
    } else {
      // ATEM moved away from OBS — clip playback no longer owns program.
      this._playing = false;
      this._playingScene = null;
      this._seenPlaying = false;
      this._hasLooping = false;
      this._lastMedia = null;
    }
  }

  // #5: poll active scene; when longest non-looping clip ends, fire end action.
  async _tick() {
    if (!this.following || !this.isReady() || !this._playing) return;

    const programScene = await this.obs.getProgramScene();

    // If OBS manually cut to a different scene, re-arm on the new scene without firing.
    if (this._playingScene !== null && programScene !== this._playingScene) {
      this._playingScene = null;
      this._seenPlaying = false;
      this._endHandled = false;
      this._hasLooping = false;
      this._lastMedia = null;
      this.emit('status');
    }
    if (this._playingScene === null) this._playingScene = programScene;

    const { hasLooping, longest } = await this.obs.getSceneMediaState(programScene);

    if (hasLooping !== this._hasLooping) {
      this._hasLooping = hasLooping;
      this.emit('status');
    }

    // If the scene contains a looping video, never auto-advance.
    if (hasLooping) return;
    if (!longest) return;

    // Track that we've seen the clip actually playing (guards against stale ENDED state
    // on first tick after a scene change).
    if (longest.state === 'OBS_MEDIA_STATE_PLAYING') this._seenPlaying = true;

    const earlyMs = parseEarlyCueMs(programScene);
    this._lastMedia = { durationMs: longest.durationMs, cursorMs: longest.cursorMs, earlyMs };
    this.emit('status');

    const remaining = longest.durationMs - longest.cursorMs;
    const shouldFire = this._seenPlaying && (
      longest.ended || (earlyMs > 0 && longest.durationMs > 0 && remaining <= earlyMs)
    );

    if (shouldFire && !this._endHandled) {
      this._endHandled = true;
      this._playing = false;
      this._playingScene = null;
      this._seenPlaying = false;
      this._lastMedia = null;
      this._hasLooping = false;
      this.emit('status');
      await this._fireEndAction();
    }
  }

  async _fireEndAction() {
    switch (this.endAction) {
      case END_ACTIONS.ATEM_CUT_TO_PREVIEW:
        if (this.atem.programInput !== this.obsAtemInput) break;
        this.atem.auto();
        this.emit('event', { type: 'end_action', action: 'atem_cut_to_preview' });
        break;
      case END_ACTIONS.OBS_CUT_TO_PREVIEW:
        await this.obs.cutPreviewToProgram();
        this.emit('event', { type: 'end_action', action: 'obs_cut_to_preview' });
        break;
      case END_ACTIONS.NOTHING:
      default:
        this.emit('event', { type: 'end_action', action: 'nothing' });
        break;
    }
  }

  status() {
    return {
      ready: this.isReady(),
      following: this.following,
      obsAtemInput: this.obsAtemInput,
      endAction: this.endAction,
      endActionScene: this.endActionScene,
      playing: this._playing,
      hasLooping: this._hasLooping,
      media: this._lastMedia,
      atem: this.atem.status(),
      obs: this.obs.status()
    };
  }
}
