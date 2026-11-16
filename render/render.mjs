import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { bratVid } from 'brat-canvas/video';

// Runs in a GitHub Actions job (7 GB RAM). Renders the BRAT video with brat-canvas,
// takes the literal last frame as the photo post, uploads both to Supabase Storage,
// and writes the result back to the meme row.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SECRET_KEY || '';
const MEME_ID = env.MEME_ID || '';
const OWNER_ID = env.OWNER_ID || '';
const W = 720;
const H = 1280;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

function requireEnv() {
  for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'MEME_ID', 'OWNER_ID', 'TEXT']) {
    if (!env[k]) throw new Error(`Missing ${k}`);
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${err.slice(-1500)}`))));
  });
}

async function patchMeme(patch) {
  const url = `${SUPABASE_URL}/rest/v1/memes?id=eq.${encodeURIComponent(MEME_ID)}&owner_id=eq.${encodeURIComponent(OWNER_ID)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Database update failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

async function upload(objectPath, bytes, contentType) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/meme-assets/${objectPath}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!r.ok) throw new Error(`Storage upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/meme-assets/${objectPath}`;
}

function audioAllowed(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.host === new URL(SUPABASE_URL).host && u.pathname.includes('/storage/v1/object/sign/song-library/');
  } catch {
    return false;
  }
}

async function main() {
  requireEnv();
  const text = env.TEXT.trim();
  const freeze = Math.max(0, Math.min(5, Number(env.FREEZE_SECONDS || 2)));
  const audioUrl = env.AUDIO_URL || '';
  const songId = env.SONG_ID || null;
  const dir = await mkdtemp(path.join(tmpdir(), 'memeos-'));
  try {
    const source = path.join(dir, 'bratext-source.mp4');
    const finalVideo = path.join(dir, 'reel.mp4');
    const finalFrame = path.join(dir, 'final-frame.png');
    const poster = path.join(dir, 'poster.png');

    const generated = await bratVid(text, {
      outputFormat: 'mp4',
      fast_progress: false,
      theme: 'brat',
      lyric: { maxWordPerLayer: 999, frameDuration: 0.24, lastFrameDuration: 0.001 },
      brat: { W, H, BOX_W: 640, BOX_H: 1120, BOX_PAD: 40, C_BG: '#b7ff3c', C_TEXT: '#111111', FONT_NAME: 'Arimo', FONT_WEIGHT: 700, fontPaths: [path.join(__dirname, 'fonts', 'Arimo-Bold.ttf')] },
    });
    await writeFile(source, generated);

    let audioPath = '';
    if (audioUrl) {
      if (!audioAllowed(audioUrl)) throw new Error('Audio URL must be a signed URL from this MemeOS Supabase song library.');
      const res = await fetch(audioUrl);
      if (!res.ok) throw new Error(`Could not fetch selected song (${res.status}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('Selected song exceeds 30 MB.');
      audioPath = path.join(dir, 'track.audio');
      await writeFile(audioPath, bytes);
    }

    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', source];
    if (audioPath) args.push('-stream_loop', '-1', '-i', audioPath);
    args.push('-vf', `tpad=stop_mode=clone:stop_duration=${freeze},scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-map', '0:v:0');
    if (audioPath) args.push('-map', '1:a:0');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (audioPath) args.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
    args.push(finalVideo);
    await run(args);

    // Photo post = the literal last frame of the finished MP4.
    // Decode the last second and keep overwriting one file; the file left behind is the true last frame.
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-sseof', '-1', '-i', finalVideo, '-update', '1', '-q:v', '1', finalFrame]);
    if (!(await stat(finalFrame).catch(() => null))) throw new Error('Could not extract the last frame from the rendered video.');
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', finalFrame, '-vf', 'scale=500:900:force_original_aspect_ratio=decrease,pad=720:900:(ow-iw)/2:(oh-ih)/2:color=0xB7FF3C,format=rgb24', '-frames:v', '1', poster]);

    const videoBytes = await readFile(finalVideo);
    const posterBytes = await readFile(poster);
    const base = `${OWNER_ID}/reels/${MEME_ID}`;
    const videoPath = `${base}.mp4`;
    const posterPath = `${base}-poster.png`;
    const videoUrl = await upload(videoPath, videoBytes, 'video/mp4');
    const posterUrl = await upload(posterPath, posterBytes, 'image/png');

    await patchMeme({
      reel_asset_path: videoPath,
      reel_asset_url: videoUrl,
      reel_status: songId ? 'generated' : 'waiting_for_song',
      reel_song_id: songId,
      asset_path: posterPath,
      asset_url: posterUrl,
      processing_status: 'generated',
      processing_error: null,
      processing_locked_until: null,
      reel_render_locked_until: null,
      reel_render_next_retry_at: null,
    });
    console.log('Render complete', { videoPath, posterPath, freeze, hasAudio: !!audioPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(async (e) => {
  console.error(e);
  try {
    if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY && env.MEME_ID && env.OWNER_ID) {
      await patchMeme({
        reel_status: 'render_failed',
        processing_error: String(e?.message || e).slice(0, 500),
        reel_render_locked_until: null,
        reel_render_next_retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        processing_locked_until: null,
      });
    }
  } catch (err) {
    console.error('Could not record failure', err);
  }
  process.exit(1);
});
