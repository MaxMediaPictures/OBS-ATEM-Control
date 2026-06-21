# OBS-ATEM-Control

HyperDeck-style automation: when the ATEM cuts to OBS's HDMI input, OBS cuts its
preview live; when the scene's longest non-looping clip ends, a configurable
action fires (e.g. ATEM cuts to preview).

## Running the standalone executable

Pre-built binaries live in `dist/`. Double-click to launch:

- **Mac (Apple Silicon)**: `dist/obs-atem-control`
- **Mac (Intel)**: `dist/obs-atem-control-x64`  
- **Windows**: `dist/obs-atem-control.exe`

On Mac, double-clicking a raw binary in Finder won't open a terminal. Use
`start.command` instead — double-click it and it opens in Terminal.app automatically.

Each launch opens a short setup wizard in the terminal:

1. **OBS** — tests your existing OBS WebSocket connection (or walks you through
   enabling it for the first time: Tools → obs-websocket Settings in OBS).
2. **ATEM IP** — reuse the saved IP or enter a new one. Find it in the
   **ATEM Setup** software (connect the ATEM via USB; the IP is on the main screen).
3. **OBS input** — which ATEM input number your OBS machine is plugged into
   (1, 2, 3…).

Settings are saved to `~/.obs-atem-control/settings.json`. On subsequent
launches just press Enter to keep all existing settings.

Once running, add the dock URL in OBS: **Docks > Custom Browser Docks →
`http://127.0.0.1:7790`**. Click the status row in the dock to expand it and
see live connection details (OBS address, ATEM IP, input assignment).

Close the terminal window to stop the app.

## Building from source

**Prerequisites**: Node.js 20+, then `npm install`.

```bash
# Mac (Apple Silicon)
npm run dist:mac

# Mac (Intel)
npm run build && npm run package:mac-x64

# Windows (cross-compile or run on Windows)
npm run dist:win
```

Output lands in `dist/`. The first build downloads a ~80 MB Node.js binary for
the target platform (one-time, cached by pkg).

## Development mode

```bash
npm start
```

Runs `node src/index.js` directly — no build step needed. Same first-run prompt
for OBS credentials. The dock UI is served live from `src/index.html` so you can
edit it and reload the browser without rebuilding.

## Configuration

- **OBS, ATEM IP, OBS input** — configured via the terminal wizard on each launch.
  Settings are saved to `~/.obs-atem-control/settings.json`. Press Enter to
  reuse saved values.
- **Port / poll interval** — edit `config.js` (default port 7790, poll 200 ms).

## How it maps to the spec

1. Status card shows ATEM connection (with an IP field + Connect button),
   OBS connection, Studio Mode (#1).
2. "OBS is ATEM input" dropdown selects the HDMI port OBS feeds (#2).
3. READY badge lights when all conditions hold; Follow toggle pauses/resumes (#3).
4. When ATEM program changes to the selected input, OBS forces a Cut transition
   and sends preview live (#4).
5. Polls the live scene's media sources; if none loop and the longest clip ends,
   fires the chosen end action (#5):
   - **ATEM cuts to preview** — ATEM auto (fade) to its preview bus.
   - **OBS goes to scene X** — sets a chosen OBS scene as program.
   - **Nothing**.

## Notes / things to tune

- End-action "ATEM cuts to preview" uses `autoTransition` (fade). Swap to
  `atem.cut()` in `orchestrator.js` if you want a hard cut.
- Loop detection reads the source's `looping`/`loop` setting; the field name
  varies between the ffmpeg and VLC source types — verify against your sources.
- `pollIntervalMs` (200ms) trades responsiveness vs. WebSocket chatter.
