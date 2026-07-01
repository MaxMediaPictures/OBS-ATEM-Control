// src/obs.js — wraps obs-websocket-js, exposes studio mode, cut, scene set,
// and active-scene media tracking for end-of-clip detection.
import OBSWebSocket from 'obs-websocket-js';
import { EventEmitter } from 'node:events';

export class ObsController extends EventEmitter {
  constructor() {
    super();
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.address = null;
    this._password = undefined;
    this._reconnectTimer = null;
    this.studioMode = false;
    this.scenes = [];

    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
      this.emit('status');
      this._scheduleReconnect();
    });

    this.obs.on('StudioModeStateChanged', ({ studioModeEnabled }) => {
      this.studioMode = studioModeEnabled;
      this.emit('status');
    });

    this.obs.on('SceneListChanged', () => {
      this._refreshScenes().then(() => this.emit('status'));
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this.address) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(this.address, this._password).catch(() => {});
    }, 5000);
  }

  async connect(address, password) {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.address = address;
    this._password = password || undefined;
    try {
      await this.obs.connect(address, this._password);
      this.connected = true;
      const sm = await this.obs.call('GetStudioModeEnabled');
      this.studioMode = sm.studioModeEnabled;
      await this._refreshScenes();
      this.emit('status');
    } catch (err) {
      this._scheduleReconnect();
      throw err;
    }
  }

  async _refreshScenes() {
    try {
      const { scenes } = await this.obs.call('GetSceneList');
      this.scenes = scenes.map(s => s.sceneName);
    } catch { /* not connected */ }
  }

  // Cut preview -> program (studio mode transition with Cut).
  async cutPreviewToProgram() {
    if (!this.connected) return;
    // Force a Cut transition for this trigger, then fire the studio transition.
    try {
      await this.obs.call('SetCurrentSceneTransition', { transitionName: 'Cut' });
    } catch { /* transition may be named differently; ignore */ }
    await this.obs.call('TriggerStudioModeTransition');
  }

  // Set the PROGRAM scene directly (used for "OBS goes to scene X").
  async setProgramScene(sceneName) {
    if (!this.connected || !sceneName) return;
    await this.obs.call('SetCurrentProgramScene', { sceneName });
  }

  // Which scene is currently live (program).
  async getProgramScene() {
    const r = await this.obs.call('GetCurrentProgramScene');
    return r.currentProgramSceneName ?? r.sceneName;
  }

  // Inspect media sources in a scene: returns the longest non-looping clip's
  // remaining state. Returns { hasLooping, longest } where longest is
  // { inputName, durationMs, cursorMs, ended } or null.
  async getSceneMediaState(sceneName) {
    const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName });
    let hasLooping = false;
    let longest = null;

    for (const item of sceneItems) {
      const inputName = item.sourceName;
      // Only ffmpeg/vlc media sources have media status.
      let media;
      try {
        media = await this.obs.call('GetMediaInputStatus', { inputName });
      } catch {
        continue; // not a media source
      }
      // Detect loop flag from the source settings.
      let looping = false;
      try {
        const { inputSettings } = await this.obs.call('GetInputSettings', { inputName });
        looping = Boolean(inputSettings.looping || inputSettings.loop);
      } catch { /* ignore */ }

      if (looping) { hasLooping = true; continue; }

      const durationMs = media.mediaDuration ?? 0;
      const cursorMs = media.mediaCursor ?? 0;
      const state = media.mediaState; // OBS_MEDIA_STATE_PLAYING / ENDED / etc.

      if (!longest || durationMs > longest.durationMs) {
        longest = {
          inputName,
          durationMs,
          cursorMs,
          state,
          ended: state === 'OBS_MEDIA_STATE_ENDED'
        };
      }
    }
    return { hasLooping, longest };
  }

  status() {
    return {
      connected: this.connected,
      address: this.address,
      studioMode: this.studioMode,
      scenes: this.scenes
    };
  }
}
