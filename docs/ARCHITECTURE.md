# Architecture

```
            Browser (dashboard)
                  │  HTTPS + WebSocket
                  ▼
            nginx reverse proxy  ──►  Node app (Express + ws)  :PORT
                                          │
        ┌─────────────────────────────────┼───────────────────────────┐
        │                                 │                           │
   StreamEngine (v1|v2)            BroadcastScheduler            REST API + auth
   drives ffmpeg                   weekly grid / one-off         scrypt login,
        │                          triggers PROGRAM mode         status, hot-swap
        ▼
   ffmpeg ──► RTMP (YouTube Live)
```

## Components

- **`src/server.js`** — Express HTTP server + WebSocket broadcaster + REST API.
  Handles auth (scrypt, timing-safe), serves the dashboard, exposes `/healthz`,
  and relays engine/scheduler events to connected clients over WebSocket.
  Selects the engine at boot from `STREAM_ENGINE`.

- **`src/streamManager.js`** (engine **v1**) — restarts `ffmpeg` per track.

- **`src/streamEngineV2.js`** (engine **v2**) — one permanent `ffmpeg`, gapless
  audio via FIFO, overlays via `drawtext textfile reload`. See
  [`ENGINES.md`](ENGINES.md). Drop-in: same public methods and events as v1.

- **`src/broadcastScheduler.js`** — weekly grid + one-off events; switches the
  engine into PROGRAM mode (a full video with its own audio) and back to MUSIC.

- **`src/config.js`** — loads non-secret settings from `config/stream.json` and
  injects secrets (`STREAM_KEY`, `DASHBOARD_PASSWORD_HASH`) from the environment.
  Never writes secrets back to disk.

- **`src/logger.js`** — winston logger (console + rotating files).

## Modes

- **MUSIC** — playlist audio over a looping background video (default).
- **PROGRAM** — a scheduled full video takes over (its own audio), then auto-returns
  to MUSIC. Triggered by the scheduler or "play now".

## Data flow for "Now Playing"

`engine → trackChange event → WebSocket → dashboard`, and in parallel the engine
writes the on-screen text (overlay) so the burned-in video matches the dashboard.

## Security model

- Unprivileged, sandboxed systemd service (`ProtectSystem=strict`, `NoNewPrivileges`,
  restricted address families, `ReadWritePaths` limited to the app dir).
- Secrets only in `.env` (chmod 600). Password stored as a scrypt hash.
- Designed to sit behind nginx with HTTPS and `secure` cookies.
- `ffmpeg` detection in the optional monitor is scoped to the service user, so
  multiple instances on one host never interfere.
