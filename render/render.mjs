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
// Attempt token from the Worker. When set, every write must still match the job's processing_token.
const ATTEMPT_TOKEN = env.ATTEMPT_TOKEN || '';
const W = 1080;
const H = 1080; // 1:1 BRAT square
const REEL_W = 1080;
const REEL_H = 1920; // Reels are 9:16; the square sits in the middle on black
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

// Finds the BRAT box and the text inside it. Returns the box rectangle, its colour, and the shift that centres the text.
async function centreOffset(frame) {
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', frame, '-vf', `scale=${W}:${H}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Could not read frame pixels (${code}).`))));
  });
  if (raw.length !== W * H * 3) return { mode: 'none' };
  const TOL = 60;
  const bbox = (x0, y0, x1, y1, R, G, B) => {
    let mnX = W, mnY = H, mxX = -1, mxY = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 3;
        if (Math.abs(raw[i] - R) + Math.abs(raw[i + 1] - G) + Math.abs(raw[i + 2] - B) > TOL) {
          if (x < mnX) mnX = x;
          if (x > mxX) mxX = x;
          if (y < mnY) mnY = y;
          if (y > mxY) mxY = y;
        }
      }
    }
    return mxX < 0 ? null : { x: mnX, y: mnY, w: mxX - mnX + 1, h: mxY - mnY + 1 };
  };
  // 1) The BRAT box: anything that differs from the outer background (the corner colour).
  // Outer colour: the most common colour along the frame's edges (robust to a single odd corner pixel).
  const counts = new Map();
  const edge = (x, y) => {
    const i = (y * W + x) * 3;
    const key = `${raw[i] >> 3},${raw[i + 1] >> 3},${raw[i + 2] >> 3}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < W; x += 4) { edge(x, 0); edge(x, H - 1); }
  for (let y = 0; y < H; y += 4) { edge(0, y); edge(W - 1, y); }
  const [key] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const [qr, qg, qb] = key.split(',').map((v) => Number(v) * 8 + 4);
  const outer = bbox(0, 0, W - 1, H - 1, qr, qg, qb);
  console.log('Centre outer', { edgeColour: [qr, qg, qb], bbox: outer });
  if (!outer) return { mode: 'none' };
  if (outer.w * outer.h < W * H * 0.5) return { mode: 'none' };
  // 2) The text inside the box: sample the box colour inside its border, then measure what differs from it.
  const IN = 16;
  const k = (outer.y + IN) * W * 3 + (outer.x + IN) * 3;
  const box = { x: outer.x, y: outer.y, w: outer.w, h: outer.h, colour: [raw[k], raw[k + 1], raw[k + 2]] };
  const text = bbox(outer.x + IN, outer.y + IN, outer.x + outer.w - 1 - IN, outer.y + outer.h - 1 - IN, ...box.colour);
  if (!text) return { mode: 'box', ...box, ox: 0, oy: 0 };
  // Text centre relative to the box, then where the box must go so that centre lands on the square's centre.
  const tcx = (text.x - box.x) + text.w / 2;
  const tcy = (text.y - box.y) + text.h / 2;
  const ox = Math.round(W / 2 - tcx);
  const oy = Math.round(H / 2 - tcy);
  console.log('Centre measure', { box: { x: box.x, y: box.y, w: box.w, h: box.h, colour: box.colour }, text: { w: text.w, h: text.h }, box_position: { ox, oy } });
  return { mode: 'box', ...box, ox, oy };
}

// The render job signs the song itself with its server-side key, so no signed URL is passed through workflow inputs.
async function signSongUrl(songId) {
  if (!songId) return '';
  const rows = await fetch(`${SUPABASE_URL}/rest/v1/song_library?id=eq.${encodeURIComponent(songId)}&select=storage_path`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  }).then((r) => r.json());
  const storagePath = rows?.[0]?.storage_path;
  if (!storagePath) throw new Error('Selected song was not found.');
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/song-library/${storagePath}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  const data = await r.json();
  if (!r.ok || !data.signedURL) throw new Error(`Could not sign the selected song (${r.status}).`);
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

async function patchMeme(patch) {
  const url = `${SUPABASE_URL}/rest/v1/memes?id=eq.${encodeURIComponent(MEME_ID)}&owner_id=eq.${encodeURIComponent(OWNER_ID)}${ATTEMPT_TOKEN ? `&processing_token=eq.${encodeURIComponent(ATTEMPT_TOKEN)}` : ''}`;
  const r = await fetch(url, {
    method: 'PATCH',
    // With a token, return the row so a write that matched nothing (ownership lost) is detected.
    headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: ATTEMPT_TOKEN ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Database update failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  if (ATTEMPT_TOKEN) {
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Ownership lost: this render no longer owns the job; its result was discarded.');
  }
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
  const songId = env.SONG_ID || null;
  const audioUrl = await signSongUrl(songId);
  const dir = await mkdtemp(path.join(tmpdir(), 'memeos-'));
  try {
    const source = path.join(dir, 'bratext-source.mp4');
    const finalVideo = path.join(dir, 'reel.mp4');
    const finalFrame = path.join(dir, 'final-frame.png');
    const poster = path.join(dir, 'poster.jpg');

    const generated = await bratVid(text, {
      outputFormat: 'mp4',
      fast_progress: false,
      theme: 'brat',
      lyric: { maxWordPerLayer: 999, frameDuration: 0.24, lastFrameDuration: 0.001 },
      brat: { W, H, BOX_W: 960, BOX_H: 960, BOX_PAD: 60, C_BG: '#b7ff3c', C_TEXT: '#111111', FONT_NAME: 'Arimo', FONT_WEIGHT: 700, fontPaths: [path.join(__dirname, 'fonts', 'Arimo-Bold.ttf')] },
    });
    await writeFile(source, generated);
    // Measure the BRAT box once from the final square frame; the reel and the photo use the same crop.
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-sseof', '-1', '-i', source, '-update', '1', '-q:v', '1', path.join(dir, 'measure.png')]);
    const measured = await centreOffset(path.join(dir, 'measure.png'));
    const squareFilter = measured.mode === 'box'
      ? (() => {
          const P = Math.max(Math.abs(measured.ox), Math.abs(measured.oy));
          const hex = measured.colour.map((v) => v.toString(16).padStart(2, '0')).join('');
          return `scale=${W}:${H}:flags=lanczos,crop=${measured.w}:${measured.h}:${measured.x}:${measured.y},pad=${W + 2 * P}:${H + 2 * P}:${P + measured.ox}:${P + measured.oy}:color=0x${hex},crop=${W}:${H}:${P}:${P},scale=${REEL_W}:${REEL_W}:flags=lanczos`;
        })()
      : `scale=${REEL_W}:${REEL_W}:flags=lanczos`;

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
    args.push('-vf', `tpad=stop_mode=clone:stop_duration=${freeze},${squareFilter},pad=${REEL_W}:${REEL_H}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`, '-map', '0:v:0');
    if (audioPath) args.push('-map', '1:a:0');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (audioPath) args.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
    args.push(finalVideo);
    await run(args);

    // Photo post = the literal last frame of the finished MP4.
    // Decode the last second and keep overwriting one file; the file left behind is the true last frame.
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-sseof', '-1', '-i', source, '-update', '1', '-q:v', '1', finalFrame]);
    if (!(await stat(finalFrame).catch(() => null))) throw new Error('Could not extract the last frame from the rendered video.');
    // Photo = the last frame, shifted so the text sits in the exact centre of the square, on the same green.
    // Photo: the same 1:1 frame, uniform box colour, text exactly centred. No outline and no resize.
    const c = await centreOffset(finalFrame);
    if (c.mode === 'box') {
      const P = Math.max(Math.abs(c.ox), Math.abs(c.oy), 0);
      const hex = c.colour.map((v) => v.toString(16).padStart(2, '0')).join('');
      const vf = `scale=${W}:${H}:flags=lanczos,crop=${c.w}:${c.h}:${c.x}:${c.y},pad=${W + 2 * P}:${H + 2 * P}:${P + c.ox}:${P + c.oy}:color=0x${hex},crop=${W}:${H}:${P}:${P},format=yuvj420p`;
      await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', finalFrame, '-vf', vf, '-frames:v', '1', '-q:v', '2', poster]);
    } else {
      // Even when centering detection cannot identify the BRAT box, transcode the PNG
      // frame to a real JPEG. Renaming/copying a PNG to .jpg is not sufficient.
      await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', finalFrame, '-frames:v', '1', '-q:v', '2', '-pix_fmt', 'yuvj420p', poster]);
    }

    const videoBytes = await readFile(finalVideo);
    const posterBytes = await readFile(poster);
    const base = `${OWNER_ID}/reels/${MEME_ID}`;
    const videoPath = `${base}.mp4`;
    const posterPath = `${base}-poster.jpg`;
    const videoUrl = await upload(videoPath, videoBytes, 'video/mp4');
    const posterUrl = await upload(posterPath, posterBytes, 'image/jpeg');

    await patchMeme({
      reel_asset_path: videoPath,
      reel_asset_url: videoUrl,
      reel_status: songId ? 'generated' : 'waiting_for_song',
      reel_song_id: songId,
      asset_path: posterPath,
      asset_url: posterUrl,
      processing_status: 'generated',
      processing_error: null,
      processing_consecutive_errors: 0,
      processing_same_error_count: 0,
      processing_last_error_key: null,
      processing_next_retry_at: null,
      processing_locked_until: null,
      reel_render_locked_until: null,
      reel_render_next_retry_at: null,
      processing_token: null,
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
      const error = String(e?.message || e || 'Unknown render error').trim().replace(/\\s+/g, ' ').slice(0, 500);
      const key = error.toLowerCase();
      const consecutive = Number((await fetch(`${SUPABASE_URL}/rest/v1/memes?id=eq.${encodeURIComponent(MEME_ID)}&owner_id=eq.${encodeURIComponent(OWNER_ID)}&select=processing_consecutive_errors,processing_same_error_count,processing_last_error_key`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then(r => r.json()).then(rows => rows?.[0]))?.processing_consecutive_errors || 0) + 1;
      const prior = await fetch(`${SUPABASE_URL}/rest/v1/memes?id=eq.${encodeURIComponent(MEME_ID)}&owner_id=eq.${encodeURIComponent(OWNER_ID)}&select=processing_same_error_count,processing_last_error_key`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then(r => r.json()).then(rows => rows?.[0] || {});
      const same = prior.processing_last_error_key === key ? Number(prior.processing_same_error_count || 0) + 1 : 1;
      const terminal = same >= 3 || consecutive >= 5;
      const retryAt = new Date(Date.now() + Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, consecutive - 1)))).toISOString();
      await patchMeme({
        reel_status: terminal ? 'discarded' : 'render_failed',
        processing_status: terminal ? 'discarded' : undefined,
        processing_error: error,
        processing_consecutive_errors: consecutive,
        processing_same_error_count: same,
        processing_last_error_key: key,
        processing_failed_at: terminal ? new Date().toISOString() : null,
        processing_next_retry_at: terminal ? null : retryAt,
        reel_render_locked_until: null,
        reel_render_next_retry_at: terminal ? null : retryAt,
        processing_locked_until: null,
        processing_token: null,
      });
    }
  } catch (err) {
    console.error('Could not record failure', err);
  }
  process.exit(1);
});
