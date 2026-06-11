# 🎵 lofi-radio

A self-hosted **24/7 music radio** that livestreams to **YouTube** (or any RTMP
target) from your own VPS — with a clean web dashboard, a live **"Now Playing"**
overlay, **hot-swappable** playlists/backgrounds, a **TV-grid scheduler** for
programmed videos, and two interchangeable streaming engines.

No GPU required. Runs comfortably on a small VPS (≈0.5–0.6 CPU core at 720p24).

> ⚠️ You bring your own music and video. None is shipped with this project.
> Make sure you have the rights to broadcast whatever you stream.

---

## ✨ Features

- **24/7 unattended streaming** to YouTube Live / any RTMP endpoint via `ffmpeg`.
- **Web dashboard** (Express + WebSocket) — start/stop, status, uptime, now playing, progress.
- **Live text overlays** — "Now Playing" + a rotating message, burned into the video.
- **Hot-swap** the playlist or background **without cutting** the stream (V2 engine).
- **Two streaming engines**, selectable with one env var:
  - **`v2` — permanent / gapless** (recommended): a single long-lived `ffmpeg`
    fed by a gapless audio pipe → **0 RTMP reconnects between tracks**, smooth ingest.
  - **`v1` — per-track**: restarts `ffmpeg` on each track (simplest, ~1 reconnect/track).
- **TV-grid scheduler** — drop full video "programs" into the stream on a weekly grid
  or one-off, then auto-return to music.
- **Secure by default** — scrypt-hashed dashboard password, secrets in `.env`,
  unprivileged systemd service with full sandboxing, nginx + HTTPS templates.
- **Optional push monitoring** via [ntfy.sh](https://ntfy.sh) (stream up/down/stall/disk).

---

## 🧱 Requirements

- A Linux VPS (Debian/Ubuntu tested), **Node.js ≥ 18**, **ffmpeg** (with `ffprobe`).
- A YouTube (or other) **RTMP stream key**.
- Optional: a domain + nginx + certbot for HTTPS.

```bash
sudo apt update && sudo apt install -y ffmpeg
# install Node 18+ via nodesource or nvm
```

---

## 🚀 Quick start

### Option A — guided installer

```bash
git clone https://github.com/YOUR_USERNAME/lofi-radio.git
cd lofi-radio
sudo bash deploy/install.sh
```

The installer checks dependencies, creates an unprivileged user, installs
dependencies, generates your `.env` (random session secret + scrypt password
hash), and installs the systemd service. Then add media and start it.

### Option B — manual

```bash
git clone https://github.com/YOUR_USERNAME/lofi-radio.git
cd lofi-radio
npm install --omit=dev

cp .env.example .env
npm run set-password -- "YourStrongPassword"   # paste the printed hash into .env
nano .env                                       # set STREAM_KEY, SESSION_SECRET, PORT...

cp config/stream.example.json config/stream.json
cp config/schedule.example.json config/schedule.json

# add your media (see media/README.md), then:
npm start
```

Open `http://localhost:PORT` (or your domain behind nginx), log in, choose a
playlist + background, and click **Start**.

---

## 🎚️ Configuration

All secrets live in **`.env`** (never in code or tracked JSON). See `.env.example`
for the full list. Key settings:

| Variable | Meaning |
|---|---|
| `PORT` | Local port the dashboard listens on |
| `STREAM_URL` | RTMP base (default: YouTube Live) |
| `STREAM_KEY` | Your stream key (secret) |
| `SESSION_SECRET` | Random session signing secret |
| `DASHBOARD_PASSWORD_HASH` | scrypt hash from `npm run set-password` |
| `COOKIE_SECURE` | `1` behind HTTPS, `0` for local HTTP |
| `STREAM_ENGINE` | `v2` (permanent/gapless) or `v1` (per-track) |

Non-secret encoding settings (resolution, fps, bitrates) live in
`config/stream.json` (copy from `config/stream.example.json`). 720p@24 is a good
low-CPU default.

---

## 🎶 Adding music & video

A **playlist** is simply a sub-folder of `media/mp3/` containing `.mp3` files:

```
media/mp3/lofi/*.mp3      ->  playlist "lofi"
media/mp3/focus/*.mp3     ->  playlist "focus"
media/mp4/bg/*.mp4        ->  background loops
media/mp4/video/*.mp4     ->  scheduler "programs"
```

One level only (no recursive sub-folders). Refresh the dashboard to see new ones.
Full details and a CPU-saving background tip: [`media/README.md`](media/README.md).

---

## 🔁 Streaming engines

This project ships **two** engines; switch with `STREAM_ENGINE` in `.env`.
The trade-off and the design of the permanent engine are documented in
[`docs/ENGINES.md`](docs/ENGINES.md). TL;DR:

| | `v1` per-track | `v2` permanent (gapless) |
|---|---|---|
| ffmpeg processes | restarts each track | one, long-lived |
| RTMP reconnects | ~1 per track | **0 between tracks** |
| Now Playing / overlays | ✅ | ✅ (textfile reload) |
| Hot-swap without cut | ❌ | ✅ |
| CPU (steady state) | same | same (peaks smoothed) |

You can validate v2 locally **without YouTube** (renders to a file):

```bash
V2_TRACK_LIMIT_SEC=20 node bin/v2-selftest.js <playlist> <background.mp4> 75
```

---

## 🔒 Security & operations

- Dashboard password is **scrypt-hashed** and verified timing-safe.
- Run behind **nginx + HTTPS** (templates in `deploy/`) and keep `COOKIE_SECURE=1`.
- The systemd unit runs as an **unprivileged, sandboxed** user.
- Optional alerts: wire `deploy/monitor-stream.sh` to cron with your own ntfy topic.
- A `/healthz` endpoint exposes non-sensitive status for monitoring.

---

## 📁 Project structure

```
src/                 application (Express server, engines, scheduler, config)
  server.js          HTTP/WebSocket server + REST API + auth
  streamManager.js   engine v1 (per-track)
  streamEngineV2.js  engine v2 (permanent / gapless)
  broadcastScheduler.js  TV-grid / program scheduler
public/ , views/     dashboard UI
config/              non-secret runtime config (*.example.json)
deploy/              systemd + nginx templates, installer, monitor
bin/                 set-password, v2 selftest
docs/                engine & architecture notes
```

---

## 📜 License

MIT — see [LICENSE](LICENSE). Provided as-is; you are responsible for the content
you broadcast and for complying with YouTube's and your rights holders' terms.
