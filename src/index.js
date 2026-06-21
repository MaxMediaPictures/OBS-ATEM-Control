import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';
import OBSWebSocket from 'obs-websocket-js';

import config from '../config.js';
import { AtemController } from './atem.js';
import { ObsController } from './obs.js';
import { Orchestrator } from './orchestrator.js';

const SETTINGS_DIR = path.join(os.homedir(), '.obs-atem-control');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  }
  catch (err) { console.error('Could not save settings:', err.message); }
}

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, resolve));
}

async function askYesNo(rl, prompt) {
  const ans = (await ask(rl, prompt)).trim().toLowerCase();
  return ans === '' || ans === 'y' || ans === 'yes';
}

async function testObsConnect(address, password) {
  const obs = new OBSWebSocket();
  await Promise.race([
    obs.connect(address, password || undefined),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000))
  ]);
  try { obs.disconnect(); } catch {}
}

async function runSetup(rl, settings) {
  const out = { ...settings };

  // ── OBS ──────────────────────────────────────────────────────────────────
  let obsConfigured = false;
  if (settings.obsAddress) {
    process.stdout.write(`\nOBS: ${settings.obsAddress}\n  Testing connection... `);
    try {
      await testObsConnect(settings.obsAddress, settings.obsPassword);
      process.stdout.write('connected.\n');
    } catch (err) {
      process.stdout.write(`failed (${err.message}).\n`);
    }
    const keep = await askYesNo(rl, '  Keep this? [Y/n] ');
    if (keep) obsConfigured = true;
  }

  if (!obsConfigured) {
    console.log([
      '',
      'To enable the OBS WebSocket server:',
      '  1. In OBS, open Tools → obs-websocket Settings',
      '  2. Check "Enable WebSocket server"',
      '  3. Set a password (recommended) and note the port (default: 4455)',
    ].join('\n'));
    const def = config.obs.address;
    const addr = (await ask(rl, `\n  OBS WebSocket address [${def}]: `)).trim() || def;
    const pass = (await ask(rl, '  Password (blank if none): ')).trim();
    out.obsAddress = addr;
    out.obsPassword = pass;
  }

  // ── ATEM IP ───────────────────────────────────────────────────────────────
  let atemIp = null;
  if (settings.atemIp) {
    console.log(`\nATEM: ${settings.atemIp}`);
    const keep = await askYesNo(rl, '  Keep this? [Y/n] ');
    if (keep) atemIp = settings.atemIp;
  }

  if (!atemIp) {
    console.log([
      '',
      'To find your ATEM\'s IP address:',
      '  Connect the ATEM via USB and open the ATEM Setup software.',
      '  The IP is shown on the main screen.',
    ].join('\n'));
    const ip = (await ask(rl, '\n  ATEM IP address: ')).trim();
    if (ip) { atemIp = ip; out.atemIp = ip; }
  }

  // ── OBS HDMI input ────────────────────────────────────────────────────────
  let obsInput = null;
  if (settings.obsAtemInput != null) {
    console.log(`\nOBS is on ATEM input: ${settings.obsAtemInput}`);
    const keep = await askYesNo(rl, '  Keep this? [Y/n] ');
    if (keep) obsInput = settings.obsAtemInput;
  }

  if (obsInput == null) {
    console.log([
      '',
      'Which ATEM input number is your OBS machine connected to?',
      '  (Usually 1, 2, 3... — check the physical cabling on your ATEM)',
    ].join('\n'));
    const num = (await ask(rl, '  Input number: ')).trim();
    const n = parseInt(num, 10);
    if (!isNaN(n)) { obsInput = n; out.obsAtemInput = n; }
  }

  return out;
}

function stamp(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function main() {
  console.log([
    '',
    '##########################',
    '####    welcome to    ####',
    '#### OBS-ATEM CONTROL ####',
    '##########################',
    '',
  ].join('\n'));

  let settings = loadSettings();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const newSettings = await runSetup(rl, settings);
  rl.close();
  saveSettings(newSettings);
  settings = newSettings;

  console.log('\nStarting server...\n');

  // HTML: esbuild inlines as a string at build time (--loader:.html=text).
  // Dev fallback: read from disk next to the entry point.
  let indexHtml;
  try {
    indexHtml = (await import('./index.html')).default;
  } catch {
    indexHtml = fs.readFileSync(path.join(path.dirname(process.argv[1]), 'index.html'), 'utf8');
  }

  const atem = new AtemController();
  const obs = new ObsController();
  const orch = new Orchestrator(atem, obs, config);

  orch.on('persist', patch => saveSettings(patch));

  const obsAddr = settings.obsAddress || config.obs.address;
  const obsPass = settings.obsPassword ?? '';
  const initialAtemIp = settings.atemIp;

  if (settings.obsAtemInput != null) orch.setObsAtemInput(settings.obsAtemInput);
  if (initialAtemIp) atem.connect(initialAtemIp);
  obs.connect(obsAddr, obsPass).catch(() => {});
  orch.start();

  let prevObs = false, prevAtem = false;
  orch.on('status', () => {
    const s = orch.status();
    if (s.obs.connected !== prevObs) {
      prevObs = s.obs.connected;
      stamp(s.obs.connected ? 'OBS connected' : 'OBS disconnected');
    }
    if (s.atem.connected !== prevAtem) {
      prevAtem = s.atem.connected;
      stamp(s.atem.connected ? `ATEM connected (${s.atem.ip})` : 'ATEM disconnected');
    }
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(indexHtml);
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  const wss = new WebSocketServer({ server });

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  }

  orch.on('status', () => broadcast({ type: 'status', status: orch.status() }));
  orch.on('event', e => broadcast({ type: 'event', event: e }));

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'status', status: orch.status() }));
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.action) {
        case 'setFollowing':      orch.setFollowing(msg.value); break;
        case 'setEndAction':      orch.setEndAction(msg.value); break;
        case 'setEndActionScene': orch.setEndActionScene(msg.value); break;
      }
    });
  });

  server.listen(config.server.port, () => {
    console.log(`Dock UI:  http://127.0.0.1:${config.server.port}`);
    console.log('Add this URL as a Custom Browser Dock in OBS (Docks → Custom Browser Docks)\n');
    console.log('Running. Close this window to stop.\n');
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
