# OBS-ATEM Control — codebase guide for Claude

## What this project does

HyperDeck-style live production automation. When a video operator cuts the ATEM switcher's program bus to the input that OBS feeds (e.g. input 1), this tool:
1. Instructs OBS to cut its **preview scene to program** (so the "next" clip goes live).
2. Polls OBS to detect when the clip finishes.
3. At end-of-clip, fires a configurable action — typically instructing the ATEM to **cut to its preview bus** (the next camera), completing the automated playout cycle.

The operator controls playback through the **ATEM** (not OBS directly). OBS is used for video clip playback; the ATEM handles live switching. The tool bridges the two.

---

## Runtime architecture

```
Terminal (CLI)              Browser dock (OBS custom dock)
     │                            │
     ▼                            ▼
src/index.js  ─────────  HTTP + WebSocket server (port 7790)
     │                            │
     ├── AtemController   ◄───────┤  atem-connection UDP
     ├── ObsController    ◄───────┤  obs-websocket-js WS
     └── Orchestrator     ────────┘  state machine wiring both
```

**`src/index.js`** — entry point. On start: runs CLI setup wizard (see below), then creates controllers, wires them up, starts HTTP + WebSocket server. Broadcasts `{ type: 'status', status }` to all connected dock clients whenever state changes.

**`src/atem.js` (`AtemController`)** — wraps `atem-connection`. Tracks ME0 program input. Emits `'programChanged'` when the program source changes. Provides `cut()` and `auto()` (fade transition).

**`src/obs.js` (`ObsController`)** — wraps `obs-websocket-js`. Connects to OBS WebSocket, monitors Studio Mode, fetches scene list. Key method: `getSceneMediaState(sceneName)` — iterates all scene items, returns `{ hasLooping, longest }` for end-of-clip polling. Auto-reconnects every 5 s after disconnect or failed connect.

**`src/orchestrator.js` (`Orchestrator`)** — the state machine. Listens to ATEM program changes; polls OBS on an interval.

**`src/index.html`** — the OBS dock UI (served as a string via `--loader:.html=text` at build time). Plain HTML/JS, WebSocket client. Reconnects to the server every 3 s on disconnect.

---

## Orchestrator state machine (the core logic)

### Internal state variables

| Variable | Meaning |
|---|---|
| `_playing` | ATEM is currently on the OBS input (clip playback active) |
| `_playingScene` | Which OBS scene we armed on (null = not yet recorded for this session) |
| `_seenPlaying` | True once we've observed `OBS_MEDIA_STATE_PLAYING` in the current armed session |
| `_endHandled` | Debounce: ensures the end action fires only once |
| `_hasLooping` | Current scene has at least one looping source |
| `_lastMedia` | `{ durationMs, cursorMs, earlyMs }` — forwarded to dock for countdown |

### ATEM program change → OBS cut

When ATEM cuts **to** the OBS input (`_onAtemProgramChanged`):
- Calls `obs.cutPreviewToProgram()` — forces a Cut transition and triggers Studio Mode transition.
- Sets `_playing = true`, clears `_playingScene`, `_seenPlaying`, `_endHandled`.

When ATEM cuts **away** from OBS:
- Sets `_playing = false`, clears all tracking state. End action will not fire.

### Tick loop (polling)

Runs every `pollIntervalMs` (default 200 ms) while `_playing` is true.

1. **Scene change detection**: if `programScene !== _playingScene`, re-arm on the new scene (reset `_seenPlaying`, `_endHandled`, `_hasLooping`, `_lastMedia`) without firing. This handles manual OBS cuts between scenes while ATEM is on OBS.
2. **Get media state**: calls `obs.getSceneMediaState(programScene)`.
3. **Looping guard**: if `hasLooping`, skip end detection entirely (never auto-advance looping scenes).
4. **`_seenPlaying` gate**: only set to true once `state === 'OBS_MEDIA_STATE_PLAYING'`. Prevents stale `ENDED` state on the first tick after a scene change from falsely triggering the end action.
5. **Early cue**: `parseEarlyCueMs(sceneName)` parses `(-Xs)` suffix — fires `earlyMs` milliseconds before clip end. `remaining = durationMs - cursorMs; shouldFire = remaining <= earlyMs`.
6. **Fire**: if `shouldFire && _seenPlaying && !_endHandled` → set `_endHandled = true`, clear state, call `_fireEndAction()`.

### End actions

- `atem_cut_to_preview` — calls `atem.auto()` (fade transition on ME0). Only fires if ATEM is still on the OBS input.
- `obs_cut_to_preview` — calls `obs.cutPreviewToProgram()`.
- `nothing` — no-op.

---

## `ObsController.getSceneMediaState(sceneName)`

Returns `{ hasLooping: bool, longest: MediaItem | null }`.

Iterates all `sceneItems` in the scene:
- Calls `GetMediaInputStatus` — skips item (continue) if it throws (not a media source).
- Calls `GetInputSettings` to read `looping` or `loop` flag.
- If looping: sets `hasLooping = true`, does **not** add to `longest`.
- Otherwise: tracks the item with the highest `durationMs` as `longest`.

`longest` shape: `{ inputName, durationMs, cursorMs, state, ended }`.

**Key rule**: `hasLooping` always wins — orchestrator skips end detection even if `longest` is also present and ended.

---

## Early cue naming convention

Append `(-Xs)` to any OBS scene name to fire the end action X seconds early:

| Scene name | Cue fires |
|---|---|
| `Interview` | at clip end |
| `Interview (-3s)` | 3 s before clip end |
| `B-Roll (-0.5s)` | 0.5 s before clip end |

Regex: `/\(-(\d+(?:\.\d+)?)s\)\s*$/`

The countdown in the dock counts down to the cue time (not the video end). `earlyMs` is stored in `_lastMedia` and forwarded in status messages.

---

## CLI setup wizard (`runSetup` in `src/index.js`)

Runs on every launch before the server starts. Both connections must verify before setup completes.

1. **OBS loop**: test existing saved address → ask keep or re-enter → loop until `testObsConnect` succeeds (5 s timeout).
2. **ATEM loop**: test existing saved IP → ask keep or re-enter → loop until `testAtemConnect` succeeds (5 s timeout). Uses a temporary `Atem` instance (`disableMultithreaded: true`), disconnects in `finally`.
3. **OBS input**: ask which ATEM input number OBS is on (no connection test, just a number).

Settings saved to `~/.obs-atem-control/settings.json`. Press Enter at every prompt to reuse saved values.

---

## Auto-reconnect behavior

**OBS**: `ObsController._scheduleReconnect()` — sets a 5 s `setTimeout` to retry `connect()`. Called on `ConnectionClosed` event and on failed `connect()`. Guard prevents double-scheduling. Calling `connect()` manually cancels any pending timer first.

**Dock WebSocket**: `wsConnect()` in `index.html` — on `onclose`, waits 3 s then creates a new `WebSocket`. Shows "Reconnecting…" in the status row and hides the countdown while disconnected.

---

## Project structure

```
src/
  index.js      entry point, CLI wizard, HTTP/WS server
  atem.js       AtemController
  obs.js        ObsController
  orchestrator.js  Orchestrator (state machine)
  index.html    dock UI (inlined at build time)
tests/
  orchestrator.test.js  9 tests — end-of-clip state machine scenarios
  obs.test.js           12 tests — getSceneMediaState + reconnect behavior
config.js       port (7790), pollIntervalMs (200), default OBS address
shims/          esbuild alias shims for pkg-incompatible native modules
dist/           build output (binary + start.command)
```

---

## Build system

- **Runtime**: Node.js ESM (`"type": "module"`)
- **Build**: esbuild bundles `src/index.js` to `dist/bundle.cjs` (CJS, node20 target)
  - `--loader:.html=text` inlines `index.html` as a string
  - `--alias` shims for `@julusian/freetype2` and `threadedclass` (pkg-incompatible)
  - `--external:bufferutil --external:utf-8-validate` (optional native deps)
- **Package**: `@yao-pkg/pkg` wraps the CJS bundle into a standalone binary
  - Mac arm64: `package:mac` → `dist/obs-atem-control`
  - Mac x64: `package:mac-x64` → `dist/obs-atem-control-x64` (use this under Rosetta)
  - Windows x64: `package:win` → `dist/obs-atem-control.exe`
- `dist:mac` = build + package:mac-x64 + copy start.command into dist/

**Important**: use `package:mac-x64` (not arm64) when building under Rosetta — x64 Node under Rosetta cannot spawn an arm64 pkg base binary (EBADARCH / errno -86).

---

## Tests

```bash
npm test   # node --test tests/*.test.js
```

Uses `node:test` built-in — no extra test dependencies.

**`tests/orchestrator.test.js`**: MockAtem + MockObs (both EventEmitter subclasses). `MockObs.getSceneMediaState` returns a fixed `sceneMedia` object. Tests drive state by calling `_onAtemProgramChanged()` and `_tick()` directly.

**`tests/obs.test.js`**: MockOBSWS replaces `ctrl.obs` after construction (swap pattern). For reconnect tests, `originalObs` reference is kept to emit `ConnectionClosed` on the instance the constructor bound its listener to. Timer mocking via `t.mock.timers.enable({ apis: ['setTimeout'] })`.

---

## Known implementation details / gotchas

- **`disableMultithreaded: true`** required on `Atem` inside a pkg binary — threadedclass spawns child processes by file path, which fails when files are in a virtual snapshot filesystem.
- **`_seenPlaying` guard**: without this, landing on a scene that already has stale `ENDED` state fires the end action immediately. The flag ensures we wait for at least one `PLAYING` observation.
- **Re-arm on manual OBS cut**: when `_playingScene` changes, we reset tracking state but keep `_playing = true`. This allows the operator to manually switch OBS scenes while ATEM is on OBS, and still get end-of-clip detection on the new scene.
- **`hasLooping` always blocks end action**: a scene with both looping and non-looping items still blocks — the looping item is providing ambient content and the clip length is irrelevant.
- **End action "ATEM cuts to preview"** checks `atem.programInput === obsAtemInput` before firing to avoid spurious cuts if the ATEM has already moved away by the time the action runs.
- **OBS `SetCurrentSceneTransition`** is called before `TriggerStudioModeTransition` to force a Cut (not whatever transition was last selected in OBS). This may fail silently if the transition is named differently — the `catch` is intentional.
- **`[atem]` debug logs** in `src/atem.js` (`console.log('[atem] event: connected')`, etc.) are still present and appear in the terminal — intentional for now.
