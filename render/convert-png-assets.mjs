import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = 'meme-assets';
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };

if (!URL_BASE || !KEY) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.');

function encoded(pathname) {
  return pathname.split('/').map(encodeURIComponent).join('/');
}

async function listPrefix(prefix = '') {
  const found = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${URL_BASE}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!response.ok) throw new Error(`Storage listing failed (${response.status}): ${await response.text()}`);
    const page = await response.json();
    found.push(...page);
    if (page.length < 1000) break;
  }
  return found;
}

async function walk(prefix = '', seen = new Set()) {
  if (seen.has(prefix)) return [];
  seen.add(prefix);
  const entries = await listPrefix(prefix);
  const files = [];
  for (const entry of entries) {
    const name = String(entry.name || '');
    if (!name) continue;
    const full = prefix ? `${prefix.replace(/\/$/, '')}/${name}` : name;
    if (entry.metadata && typeof entry.metadata === 'object') {
      if (/\.png$/i.test(name)) files.push(full);
    } else {
      files.push(...await walk(`${full.replace(/\/$/, '')}/`, seen));
    }
  }
  return files;
}

async function convertPngToJpg(bytes, directory, index) {
  const input = path.join(directory, `${index}.png`);
  const output = path.join(directory, `${index}.jpg`);
  await writeFile(input, bytes);
  await execFileAsync(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-frames:v', '1', '-q:v', '2', '-vf', 'format=yuvj420p', output
  ], { maxBuffer: 4 * 1024 * 1024 });
  return await readFile(output);
}

async function storageRequest(pathname, init = {}) {
  const response = await fetch(`${URL_BASE}${pathname}`, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`Storage request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return response;
}

async function getMemes() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${URL_BASE}/rest/v1/memes?select=id,owner_id,asset_path,asset_url,source_asset_path,source_asset_url,reel_asset_path,reel_asset_url&limit=1000&offset=${offset}`, { headers: HEADERS });
    if (!response.ok) throw new Error(`Meme lookup failed (${response.status}): ${await response.text()}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function updateReferences(rows, oldPath, newPath, newUrl) {
  let changed = 0;
  for (const row of rows) {
    const patch = {};
    for (const field of ['asset_path', 'source_asset_path', 'reel_asset_path']) {
      if (row[field] === oldPath) patch[field] = newPath;
    }
    for (const field of ['asset_url', 'source_asset_url', 'reel_asset_url']) {
      if (row[field] && (row[field] === `${URL_BASE}/storage/v1/object/public/${BUCKET}/${encoded(oldPath)}` || row[field].endsWith(`/${encoded(oldPath)}`))) {
        patch[field] = newUrl;
      }
    }
    if (!Object.keys(patch).length) continue;
    const response = await fetch(`${URL_BASE}/rest/v1/memes?id=eq.${encodeURIComponent(row.id)}&owner_id=eq.${encodeURIComponent(row.owner_id)}`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch)
    });
    if (!response.ok) throw new Error(`Could not update meme ${row.id}: ${(await response.text()).slice(0, 500)}`);
    changed++;
  }
  return changed;
}

const pngPaths = [...new Set(await walk())].sort();
const memes = await getMemes();
console.log(`Found ${pngPaths.length} PNG objects and ${memes.length} meme rows.`);
let converted = 0, referencesUpdated = 0, deleted = 0;
const failures = [];
for (let i = 0; i < pngPaths.length; i++) {
  const oldPath = pngPaths[i];
  const newPath = oldPath.replace(/\.png$/i, '.jpg');
  const directory = await mkdtemp(path.join(tmpdir(), 'meme-png-convert-'));
  try {
    const source = await storageRequest(`/storage/v1/object/authenticated/${BUCKET}/${encoded(oldPath)}`);
    const sourceBytes = new Uint8Array(await source.arrayBuffer());
    const jpgBytes = await convertPngToJpg(sourceBytes, directory, i);
    await storageRequest(`/storage/v1/object/${BUCKET}/${encoded(newPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: jpgBytes
    });
    const newUrl = `${URL_BASE}/storage/v1/object/public/${BUCKET}/${encoded(newPath)}`;
    referencesUpdated += await updateReferences(memes, oldPath, newPath, newUrl);
    await storageRequest(`/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [oldPath] })
    });
    converted++;
    deleted++;
    console.log(`[${i + 1}/${pngPaths.length}] converted ${oldPath}`);
  } catch (error) {
    failures.push({ path: oldPath, error: String(error?.message || error) });
    console.error(`FAILED ${oldPath}: ${String(error?.message || error)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ totalPngs: pngPaths.length, converted, referencesUpdated, deleted, failures }, null, 2));
if (failures.length) process.exitCode = 1;
