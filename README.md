# OBS-ATEM-Control

HyperDeck-style automation: when the ATEM cuts to OBS's HDMI input, OBS cuts its
preview live; when the scene's longest non-looping clip ends, a configurable
action fires (e.g. ATEM cuts to preview).

## Setup

1. **OBS**: enable obs-websocket (Tools > WebSocket Server Settings). Note the
   port (default 4455) and password.
2. Create a `config.js` based on `config.js.example` — set `obs.password`.
3. Install + run:
   ```
   npm install
   npm start
   ```
4. In OBS: **Docks > Custom Browser Docks**, add
   `http://127.0.0.1:7790` with any name. The panel appears inside OBS.
5. In the dock, type the ATEM's IP and click **Connect**. The IP is saved to
   `settings.json` and reused on the next start.

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
