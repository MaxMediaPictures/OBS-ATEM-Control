import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

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

async function promptObsCredentials(defaultAddress) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const addr = (await ask(rl, `  OBS WebSocket address [${defaultAddress}]: `)).trim() || defaultAddress;
  const pass = (await ask(rl, '  OBS WebSocket password (leave blank if none): ')).trim();
  rl.close();
  return { addr, pass };
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

  if (settings.obsAddress === undefined) {
    console.log('First run — enter your OBS WebSocket settings:');
    const { addr, pass } = await promptObsCredentials(config.obs.address);
    saveSettings({ obsAddress: addr, obsPassword: pass });
    settings = loadSettings();
    console.log(`\nSettings saved to ${SETTINGS_FILE}\n`);
  }

  // Load the dock HTML: esbuild inlines it as a string at build time (--loader:.html=text).
  // When running in dev with `node src/index.js`, the dynamic import fails (Node.js can't
  // parse HTML as a module) and we fall back to reading from disk.
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
  const initialAtemIp = settings.atemIp || config.atem.ip;

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
        case 'setObsAtemInput':   orch.setObsAtemInput(msg.value); break;
        case 'setEndAction':      orch.setEndAction(msg.value); break;
        case 'setEndActionScene': orch.setEndActionScene(msg.value); break;
        case 'setAtemIp':         orch.setAtemIp(msg.value); break;
      }
    });
  });

  server.listen(config.server.port, () => {
    console.log(`Dock UI:  http://127.0.0.1:${config.server.port}`);
    console.log('Add this URL as a Custom Browser Dock in OBS (Docks → Custom Browser Docks)');
    console.log('Find your ATEM\'s IP address in the ATEM Setup software, then enter it in the dock.\n');
    console.log('Running. Close this window to stop.\n');
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
