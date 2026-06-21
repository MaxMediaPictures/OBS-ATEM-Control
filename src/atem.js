// src/atem.js — wraps atem-connection, exposes program-input changes + cut/auto
import { Atem } from 'atem-connection';
import { EventEmitter } from 'node:events';

export class AtemController extends EventEmitter {
  constructor() {
    super();
    this.atem = new Atem();
    this.connected = false;
    this.ip = null;           // current target IP (set via connect)
    this.programInput = null; // current ME0 program source id
    this.inputs = [];         // [{id, name}]

    this.atem.on('connected', () => {
      this.connected = true;
      this._refreshInputs();
      this._refreshProgram();
      this.emit('status');
    });

    this.atem.on('disconnected', () => {
      this.connected = false;
      this.emit('status');
    });

    // state changes (any) — we re-derive program input + input list
    this.atem.on('stateChanged', (_state, paths) => {
      let changed = false;
      for (const p of paths) {
        if (p.startsWith('video.mixEffects.0.programInput')) {
          this._refreshProgram();
          changed = true;
        }
        if (p.startsWith('inputs')) {
          this._refreshInputs();
          changed = true;
        }
      }
      if (changed) this.emit('status');
    });
  }

  async connect(ip) {
    if (!ip) return;
    // If already connected/connecting to a different IP, tear down first.
    if (this.ip && this.ip !== ip) {
      try { await this.atem.disconnect(); } catch { /* ignore */ }
      this.connected = false;
      this.programInput = null;
      this.inputs = [];
    }
    this.ip = ip;
    this.emit('status'); // reflect the new target immediately (shows "connecting")
    try {
      await this.atem.connect(ip);
    } catch (err) {
      this.connected = false;
      this.emit('status');
    }
  }

  _refreshProgram() {
    const me = this.atem.state?.video?.mixEffects?.[0];
    if (!me) return;
    const prev = this.programInput;
    this.programInput = me.programInput;
    if (prev !== null && prev !== this.programInput) {
      this.emit('programChanged', this.programInput, prev);
    }
  }

  _refreshInputs() {
    const inputs = this.atem.state?.inputs ?? {};
    this.inputs = Object.entries(inputs).map(([id, v]) => ({
      id: Number(id),
      name: v?.longName || v?.shortName || `Input ${id}`
    }));
  }

  // Perform a CUT transition on the ATEM (ME0)
  cut() {
    if (this.connected) this.atem.cut(0);
  }

  // Perform an AUTO (fade) transition on the ATEM (ME0)
  auto() {
    if (this.connected) this.atem.autoTransition(0);
  }

  status() {
    return {
      connected: this.connected,
      ip: this.ip,
      programInput: this.programInput,
      inputs: this.inputs
    };
  }
}
