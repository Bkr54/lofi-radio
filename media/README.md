# Media library

This folder holds **your** audio and video. Nothing here is shipped with the
project — add your own files. The `.gitkeep` files only preserve the structure.

```
media/
├── mp3/                  # Music. Each SUB-FOLDER = one selectable playlist.
│   ├── lofi/             #   -> playlist "lofi"
│   │   ├── track1.mp3
│   │   └── track2.mp3
│   └── focus/            #   -> playlist "focus"
│       └── ...
├── mp4/
│   ├── bg/               # Looping background videos (MUSIC mode).
│   │   └── background.mp4
│   └── video/            # Full programs for the TV-grid scheduler (PROGRAM mode).
│       └── show.mp4
```

## Rules

- **One level only.** A playlist is a direct sub-folder of `media/mp3/` that
  contains `.mp3` files. Sub-sub-folders are **not** scanned recursively.
  - ✅ `media/mp3/jazz/song.mp3`  → playlist `jazz`
  - ❌ `media/mp3/jazz/2024/song.mp3` → ignored
- Only `.mp3` (audio) and `.mp4` (video) are picked up.
- New playlists/videos appear in the dashboard after you **refresh the page**
  (the lists are read when the dashboard loads).
- Make sure files are **readable by the service user** (see deploy docs):
  `chown -R <service-user>:<service-user> media/`

## Background video tip (lower CPU)

A 24/7 stream re-encodes the background continuously. Prefer a **short H.264**
clip at your target resolution/fps (e.g. 1280x720@24) — it loops seamlessly and
keeps CPU low. Heavy 1080p/HEVC backgrounds cost much more to decode.
Example normalize command:

```bash
ffmpeg -i source.mp4 -vf "scale=1280:720,fps=24" -c:v libx264 -preset veryfast \
       -crf 23 -an media/mp4/bg/background.mp4
```
