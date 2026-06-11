# Streaming engines: `v1` (per-track) vs `v2` (permanent / gapless)

Switch with `STREAM_ENGINE=v1|v2` in `.env`. Both expose the exact same dashboard
API and features; they differ only in *how* `ffmpeg` is driven.

## Why two engines?

A music radio needs, between every track, to update the "Now Playing" text and
keep the picture going. The naive way is to **restart `ffmpeg` for each track**
(engine **v1**). It's simple and robust, but each restart **reconnects to RTMP**,
which on a long 24/7 stream means hundreds of reconnects per day and small ingest
hiccups that YouTube may flag as buffering.

Engine **v2** keeps **one `ffmpeg` running forever** and solves the two problems
that restart used to solve:

1. **Gapless audio** — a named pipe (FIFO) is fed continuously: the controller
   decodes each mp3 to raw PCM and concatenates the byte streams into the pipe.
   `ffmpeg` reads one endless audio input → no gap, no reconnect between tracks.
2. **Live overlays** — `drawtext=textfile=...:reload=1` reads the on-screen text
   from a file that the controller rewrites on each track change. Text updates
   hot, no restart.

```
            ┌─────────── controller (Node) ───────────┐
 track1.mp3 │  ffmpeg -i trackN.mp3 -f s16le  ──┐      │   writes now.txt / msg.txt
 track2.mp3 │  (one decoder per track, chained) │      │            │
   ...      └───────────────────────────────────┘      │            ▼
                                   PCM │  (FIFO, gapless)     drawtext textfile reload=1
                                       ▼                              │
   bg.mp4 (looped) ─────► [ single permanent ffmpeg encoder ] ──► RTMP (YouTube)
                          scale + fps + drawtext + libx264 + aac
```

## Trade-offs

| | `v1` per-track | `v2` permanent |
|---|---|---|
| `ffmpeg` processes | restart each track | one, long-lived |
| RTMP reconnects | ~1 per track (hundreds/day) | **0 between tracks** |
| CPU, steady state | baseline | **same** baseline |
| CPU peaks | spike on every track (x264 re-init) | **smoothed away** |
| Now Playing / rotating message | ✅ | ✅ (textfile reload) |
| Hot-swap playlist without cut | ❌ (applies next track) | ✅ (swaps the feeder) |
| Hot-swap background / overlay layout | restart | controlled restart (rare) |
| Programs (TV-grid) | restart in/out | controlled restart in/out (rare) |
| Implementation complexity | low | moderate |

**Key point:** v2's win is **stability/continuity** (no per-track reconnects,
smoother ingest), *not* CPU — the encode work is identical. Pick v2 if YouTube
ingest health matters or you hot-swap a lot; v1 is perfectly fine for a simple setup.

## The hybrid model (how v2 behaves)

v2 is **permanent for MUSIC** (the 99% case) and only accepts a **single controlled
reconnect** at **program boundaries** (entering/leaving a scheduled video, which
carries its own audio) or when you change the background. Those events are rare,
so you remove the hundreds of per-track reconnects while avoiding the hardest part
(switching a live `ffmpeg`'s video input on the fly).

## Local validation (no YouTube needed)

`bin/v2-selftest.js` runs the real v2 pipeline to a **local file** and checks that
a single encoder survives several track boundaries with zero reconnects:

```bash
V2_TRACK_LIMIT_SEC=20 node bin/v2-selftest.js <playlist> <background.mp4> 75
```

## Known limitations / ideas

- Track boundaries are gapless to the ear but not sample-perfect (a few ms while
  the next decoder spawns). Pre-spawning the next decoder would make it exact.
- Switching the **background video** inside the permanent encoder is intentionally
  done with a brief controlled restart rather than live filter graph surgery.
