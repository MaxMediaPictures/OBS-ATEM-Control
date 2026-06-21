// src/index.js — entry point. Connects ATEM + OBS, serves the dock UI,
// and bridges settings/status over WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import config from '../config.js';
import { AtemController } from './atem.js';
import { ObsController } from './obs.js';
import { Orchestrator } from './orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = __dirname;
const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

// Persisted runtime settings (currently just the ATEM IP). Falls back to config.js.
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2)); }
  catch (err) { console.error('Could not save settings:', err.message); }
}

const settings = loadSettings();

const atem = new AtemController();
const obs = new ObsController();
const orch = new Orchestrator(atem, obs, config);

// Persist whatever the orchestrator asks to (e.g. the ATEM IP from the dock).
orch.on('persist', (patch) => saveSettings(patch));

// --- connect to hardware/software ---
const initialAtemIp = settings.atemIp || config.atem.ip;
if (initialAtemIp) atem.connect(initialAtemIp);
obs.connect(config.obs.address, config.obs.password)
  .catch(err => console.error('OBS connect failed (will keep UI alive):', err.message));
orch.start();

// --- static file server for the dock ---
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url;
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full);
    const type = ext === '.html' ? 'text/html'
      : ext === '.js' ? 'text/javascript'
      : ext === '.css' ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

// --- websocket: push status, receive setting changes ---
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

orch.on('status', () => broadcast({ type: 'status', status: orch.status() }));
orch.on('event', (e) => broadcast({ type: 'event', event: e }));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', status: orch.status() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.action) {
      case 'setFollowing':      orch.setFollowing(msg.value); break;
      case 'setObsAtemInput':   orch.setObsAtemInput(msg.value); break;
      case 'setEndAction':      orch.setEndAction(msg.value); break;
      case 'setEndActionScene': orch.setEndActionScene(msg.value); break;
      case 'setAtemIp':         orch.setAtemIp(msg.value); break;
    }
  });
});

server.listen(config.server.port, () => {
  console.log(`Dock UI:  http://127.0.0.1:${config.server.port}`);
  console.log(`Add this URL as a Custom Browser Dock in OBS (Docks > Custom Browser Docks).`);
});
