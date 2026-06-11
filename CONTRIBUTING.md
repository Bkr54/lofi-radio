# Contributing to lofi-radio

Thanks for your interest in improving lofi-radio! Contributions of all sizes are
welcome — bug reports, docs, features, and engine improvements.

## Ground rules

- **Never commit secrets or media.** `.env`, real stream keys, passwords, and any
  audio/video must stay out of the repo (`.gitignore` already covers them).
- Keep the project **dependency-light** and **GPU-free** — it must run on a small VPS.
- Match the existing code style (plain Node, CommonJS, no framework churn).
- Both engines (`v1` per-track, `v2` permanent) must keep the **same public API**
  and events so they stay interchangeable via `STREAM_ENGINE`.

## Dev setup

```bash
git clone https://github.com/Bkr54/lofi-radio.git
cd lofi-radio
npm install

cp .env.example .env
npm run set-password -- "devpassword"   # paste hash into .env
# set COOKIE_SECURE=0 for local HTTP, pick a free PORT
cp config/stream.example.json config/stream.json
cp config/schedule.example.json config/schedule.json

# add a couple of mp3s under media/mp3/<playlist>/ and a media/mp4/bg/*.mp4
npm start
```

Open `http://localhost:PORT`, log in, and you're running.

### Testing the V2 engine without YouTube

```bash
V2_TRACK_LIMIT_SEC=20 node bin/v2-selftest.js <playlist> <background.mp4> 75
```

This renders the real permanent-engine pipeline to a local file and asserts a
single ffmpeg process survives several track changes with zero reconnects.

## Before opening a PR

Please make sure these pass (the CI runs them too):

```bash
# JavaScript syntax
for f in src/*.js bin/*.js; do node --check "$f"; done
# Shell syntax
for f in deploy/*.sh; do bash -n "$f"; done
```

- Keep PRs focused; describe **what** and **why**.
- If you change behavior, update the relevant doc in `docs/` and the `README.md`.
- New user-facing strings should be in **English**.

## Reporting bugs

Open an issue with: your OS, Node and ffmpeg versions, the engine in use
(`v1`/`v2`), relevant `journalctl`/console logs (with secrets redacted), and clear
reproduction steps.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/ENGINES.md`](docs/ENGINES.md) to understand the server, the two engines,
and the scheduler before diving in.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
