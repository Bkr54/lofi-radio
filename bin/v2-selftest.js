#!/usr/bin/env node
/**
 * Local self-test of the V2 permanent engine — NO YouTube, NO stream key.
 * Renders to a local FLV file to prove: a SINGLE permanent ffmpeg encoder,
 * gapless audio across SEVERAL track changes, live "Now Playing" overlay reload.
 *
 * Usage:
 *   V2_TRACK_LIMIT_SEC=20 node bin/v2-selftest.js <playlist> <background.mp4> [seconds]
 *
 * Example (after adding media):
 *   V2_TRACK_LIMIT_SEC=20 node bin/v2-selftest.js lofi background.mp4 75
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const StreamEngineV2 = require('../src/streamEngineV2');

const playlist = process.argv[2];
const bg = process.argv[3];
const runSec = parseInt(process.argv[4], 10) || 75;

if (!playlist || !bg) {
  console.error('Usage: V2_TRACK_LIMIT_SEC=20 node bin/v2-selftest.js <playlist> <background.mp4> [seconds]');
  process.exit(1);
}

const runDir = path.join(__dirname, '../run');
fs.mkdirSync(runDir, { recursive: true });
const outFile = path.join(runDir, 'selftest.flv');
try { fs.unlinkSync(outFile); } catch (e) {}

const config = {
  streamUrl: 'unused',
  streamKey: 'unused',
  outputOverride: outFile,      // local sink, never RTMP
  videoBitrate: '2500k',
  audioBitrate: '128k',
  resolution: '1280x720',
  fps: 24
};

const engine = new StreamEngineV2(config);
let boundaries = 0;
engine.on('trackChange', (d) => { boundaries++; console.log(`[trackChange #${boundaries}] ${d.name}`); });
engine.on('error', (e) => console.log('[error]', e));

(async () => {
  console.log(`Selftest V2: playlist=${playlist} bg=${bg} duration=${runSec}s limit=${process.env.V2_TRACK_LIMIT_SEC || 'none'}`);
  await engine.startStream(playlist, bg);

  setTimeout(() => {
    const enc = spawnSync('bash', ['-c', "ps -C ffmpeg -o args= 2>/dev/null | grep -c 'selftest.flv'"]);
    console.log('Permanent encoders running (should be 1):', (enc.stdout || '').toString().trim());
  }, Math.floor(runSec * 1000 / 2));

  setTimeout(async () => {
    engine.stopStream();
    await new Promise(r => setTimeout(r, 800));
    console.log(`\n=== Results ===`);
    console.log(`Track changes crossed : ${boundaries}`);
    console.log(`Encoder reconnections (should be 0) : ${engine.restartCount}`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,sample_rate,width,height',
      '-of', 'default=noprint_wrappers=1', outFile]);
    console.log('--- ffprobe local output ---');
    console.log((probe.stdout || '').toString().trim());
    try { console.log(`File size: ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB`); }
    catch (e) { console.log('No output file produced!'); }
    process.exit(0);
  }, runSec * 1000);
})().catch(e => { console.error('SELFTEST FAILED:', e); process.exit(1); });
