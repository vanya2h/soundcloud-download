#!/usr/bin/env node
// Native messaging host for SoundCloud DL extension
// Communicates with the extension via stdin/stdout using 4-byte LE length framing

import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, statSync, existsSync, mkdirSync, createWriteStream, renameSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import http from 'node:http';
import https from 'node:https';

const execFileAsync = promisify(execFile);

// ── Native messaging framing ─────────────────────────

function readMessage() {
  return new Promise((resolve, reject) => {
    const lenBuf = Buffer.alloc(4);
    let bytesRead = 0;

    function readLen() {
      const chunk = process.stdin.read(4 - bytesRead);
      if (chunk === null) {
        process.stdin.once('readable', readLen);
        return;
      }
      chunk.copy(lenBuf, bytesRead);
      bytesRead += chunk.length;
      if (bytesRead < 4) { readLen(); return; }

      const msgLen = lenBuf.readUInt32LE(0);
      if (msgLen === 0) { resolve(null); return; }

      let msgBuf = Buffer.alloc(0);
      function readBody() {
        const part = process.stdin.read(msgLen - msgBuf.length);
        if (part === null) { process.stdin.once('readable', readBody); return; }
        msgBuf = Buffer.concat([msgBuf, part]);
        if (msgBuf.length < msgLen) { readBody(); return; }
        try { resolve(JSON.parse(msgBuf.toString('utf8'))); }
        catch (e) { reject(e); }
      }
      readBody();
    }

    readLen();
  });
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(buf.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(buf);
}

function respond(id, data) {
  sendMessage({ type: 'response', id, ...data });
}

// ── Message loop ─────────────────────────────────────

process.stdin.resume();

async function main() {
  while (true) {
    const msg = await readMessage();
    if (!msg) break;
    handleMessage(msg).catch((err) => {
      respond(msg.id, { error: err.message });
    });
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});

// ── Handlers ─────────────────────────────────────────

async function handleMessage(msg) {
  switch (msg.action) {
    case 'download':         return handleDownload(msg);
    case 'downloadDirect':   return handleDownloadDirect(msg);
    case 'addToM3U':         return handleAddToM3U(msg);
    case 'removeFromM3U':  return handleRemoveFromM3U(msg);
    case 'listTracks':  return handleListTracks(msg);
    case 'openFinder':  return handleOpenFinder(msg);
    case 'pickFolder':  return handlePickFolder(msg);
    case 'checkDeps':   return handleCheckDeps(msg);
    case 'startOAuth':  return handleStartOAuth(msg);
    default: respond(msg.id, { error: `Unknown action: ${msg.action}` });
  }
}

// ── Download ──────────────────────────────────────────

const AUDIO_EXTENSIONS = new Set(['.mp3', '.aiff', '.aif', '.wav', '.flac', '.m4a', '.ogg', '.opus']);

// url → Array<{downloadId, m3uPath, trackInfo}> for requests waiting on the same download
const inflightDownloads = new Map();

// Locate an existing audio file for a track without calling yt-dlp.
// 1. Exact match: yt-dlp sanitizes "/" → "⧸" on macOS; that covers ~99% of cases.
// 2. Fuzzy match: strip all non-alphanumeric chars and compare — handles minor title/artist
//    differences between the SC API response and what yt-dlp originally wrote to disk.
function findExistingTrack(libraryDir, artist, title) {
  // Pass 1 — exact expected filename
  const san = (s) => s.replace(/\//g, '⧸').replace(/\0/g, '').trim();
  const base = `${san(artist)} - ${san(title)}`;
  for (const ext of AUDIO_EXTENSIONS) {
    const p = join(libraryDir, base + ext);
    if (existsSync(p)) return p;
  }

  // Pass 2 — normalize (strip punctuation/case) and scan the directory
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9À-ɏЀ-ӿ]/g, '');
  const expectedNorm = norm(artist) + norm(title);
  if (expectedNorm.length < 4) return null; // too short to match safely
  try {
    for (const f of readdirSync(libraryDir)) {
      const ext = extname(f).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;
      if (norm(basename(f, ext)) === expectedNorm) return join(libraryDir, f);
    }
  } catch {}

  return null;
}

async function handleDownload(msg) {
  const { id, url, libraryDir, m3uPath, downloadId, format = 'mp3', quality = 'best', embedArt = true, trackInfo } = msg;

  if (!existsSync(libraryDir)) {
    mkdirSync(libraryDir, { recursive: true });
  }

  // If another bucket is already downloading this URL, piggyback: ack immediately and wait.
  if (inflightDownloads.has(url)) {
    respond(id, { downloadId, status: 'started' });
    inflightDownloads.get(url).push({ downloadId, m3uPath, trackInfo });
    return;
  }

  // Register as the primary download for this URL.
  inflightDownloads.set(url, []);

  // Notify the primary request + all registered waiters once the file path is known.
  function finish(filePath, success, error) {
    const waiters = inflightDownloads.get(url) ?? [];
    inflightDownloads.delete(url);
    const notify = (dId, mPath, tInfo) => {
      if (filePath && mPath) appendToM3U(mPath, filePath, { ...(tInfo ?? {}), url });
      if (success) {
        sendMessage({ type: 'downloadDone', downloadId: dId, success: true, track: {
          filename: filePath ?? '', url,
          title: tInfo?.title ?? '', artist: tInfo?.artist ?? '',
          duration: 0, downloadedAt: new Date().toISOString(),
        }});
      } else {
        sendMessage({ type: 'downloadDone', downloadId: dId, success: false, error });
      }
    };
    notify(downloadId, m3uPath, trackInfo);
    for (const w of waiters) notify(w.downloadId, w.m3uPath, w.trackInfo);
  }

  // Fast path: file already on disk — skip yt-dlp to avoid SC auth failures on re-sync.
  if (trackInfo?.artist && trackInfo?.title) {
    const found = findExistingTrack(libraryDir, trackInfo.artist, trackInfo.title);
    if (found) {
      respond(id, { downloadId, status: 'started' });
      finish(found, true, null);
      return;
    }
  }

  const qualityMap = { best: '0', '320': '320', '256': '256', '192': '192', '128': '128' };
  const q = qualityMap[quality] ?? '0';

  const args = [
    '--format', 'bestaudio/best',
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', q,
    '--newline',
    '--no-playlist',
    // Print the final file path after all post-processing (extraction, thumbnail embed, etc.)
    // This is more reliable than --write-info-json because it's race-condition-free and
    // always reflects the actual final path (after audio extraction changes the extension).
    '--print', 'after_move:filepath',
    '--no-overwrites',
    '--output', join(libraryDir, '%(uploader)s - %(title)s.%(ext)s'),
  ];

  if (embedArt) {
    args.push('--embed-thumbnail', '--add-metadata');
  }

  args.push(url);

  // Snapshot existing audio files so we can detect the newly created one as a fallback
  let existingAudioFiles;
  try {
    existingAudioFiles = new Set(
      readdirSync(libraryDir)
        .filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()))
        .map((f) => join(libraryDir, f))
    );
  } catch {
    existingAudioFiles = new Set();
  }

  // Acknowledge the request immediately so the SW doesn't time out
  respond(id, { downloadId, status: 'started' });

  const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let lastPercent = 0;
  let capturedFilepath = '';
  let stdoutBuf = '';

  function processLine(line) {
    // yt-dlp progress line: "[download]  42.3% of  5.23MiB at  1.20MiB/s ETA 00:03"
    const m = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\s*\S+)\s+ETA\s+(\S+)/);
    if (m) {
      const percent = parseFloat(m[1]);
      if (Math.abs(percent - lastPercent) >= 2 || percent >= 99) {
        lastPercent = percent;
        sendMessage({ type: 'progress', downloadId, percent, speed: m[2], eta: m[3] });
      }
    } else {
      const trimmed = line.trim();
      // --print after_move:filepath outputs an absolute file path with an audio extension
      if (trimmed && trimmed.startsWith('/') && AUDIO_EXTENSIONS.has(extname(trimmed).toLowerCase())) {
        capturedFilepath = trimmed;
      }
      // yt-dlp --no-overwrites skips existing files and prints this instead of firing after_move:
      // "[download] /absolute/path/artist - title.mp3 has already been downloaded"
      const skipMatch = trimmed.match(/^\[download\] (.+) has already been downloaded$/);
      if (skipMatch) {
        const p = skipMatch[1];
        if (p.startsWith('/') && AUDIO_EXTENSIONS.has(extname(p).toLowerCase())) {
          capturedFilepath = p;
        }
      }
    }
  }

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  });

  // yt-dlp routes some messages to stderr depending on version — mirror through processLine
  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  });

  proc.on('close', async (code) => {
    if (stdoutBuf.trim()) processLine(stdoutBuf.trim());
    if (stderrBuf.trim()) processLine(stderrBuf.trim());

    if (code !== 0) {
      finish(null, false, `yt-dlp exited with code ${code}`);
      return;
    }

    // Fallback: if --print after_move:filepath didn't fire (older yt-dlp without after_move support),
    // find the new audio file by diffing the directory snapshot taken before the download.
    if (!capturedFilepath) {
      try {
        const newFiles = readdirSync(libraryDir)
          .filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()))
          .map((f) => join(libraryDir, f))
          .filter((f) => !existingAudioFiles.has(f));
        if (newFiles.length === 1) capturedFilepath = newFiles[0];
      } catch {}
    }

    finish(capturedFilepath || null, true, null);
  });

  proc.on('error', (err) => {
    finish(null, false, err.message);
  });
}

function appendToM3U(m3uPath, filePath, track) {
  mkdirSync(dirname(m3uPath), { recursive: true });
  const displayName = track.artist ? `${track.artist} - ${track.title}` : (track.title || basename(filePath));
  const duration = Math.round(track.duration ?? 0);
  const scLine = track.url ? `#SCURL:${track.url}\n` : '';
  const entry = `#EXTINF:${duration},${displayName}\n${scLine}${filePath}\n`;

  if (!existsSync(m3uPath)) {
    writeFileSync(m3uPath, '#EXTM3U\n' + entry, 'utf8');
  } else {
    const existing = readFileSync(m3uPath, 'utf8');
    if (!existing.includes(filePath)) appendFileSync(m3uPath, entry, 'utf8');
  }
}

// ── SC API direct download (fallback when yt-dlp fails) ──

async function handleDownloadDirect(msg) {
  const { id, url, downloadId, m3uPath, trackInfo, libraryDir } = msg;

  if (!existsSync(libraryDir)) mkdirSync(libraryDir, { recursive: true });

  // Check if file already exists under expected name
  if (trackInfo?.artist && trackInfo?.title) {
    const found = findExistingTrack(libraryDir, trackInfo.artist, trackInfo.title);
    if (found) {
      respond(id, { downloadId, status: 'started' });
      if (m3uPath) appendToM3U(m3uPath, found, { ...(trackInfo ?? {}), url: trackInfo?.url ?? url });
      sendMessage({ type: 'downloadDone', downloadId, success: true, track: {
        filename: found, url: trackInfo?.url ?? url,
        title: trackInfo?.title ?? '', artist: trackInfo?.artist ?? '',
        duration: 0, downloadedAt: new Date().toISOString(),
      }});
      return;
    }
  }

  const san = (s) => s.replace(/[/\\:*?"<>|]/g, '_').replace(/\0/g, '').trim();
  const artist = san(trackInfo?.artist ?? 'Unknown');
  const title = san(trackInfo?.title ?? 'Unknown');
  const filePath = join(libraryDir, `${artist} - ${title}.mp3`);
  const tempPath = filePath + '.part';

  respond(id, { downloadId, status: 'started' });

  try {
    await new Promise((resolve, reject) => {
      const file = createWriteStream(tempPath);
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          file.destroy();
          try { unlinkSync(tempPath); } catch {}
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(undefined)));
        file.on('error', (err) => { try { unlinkSync(tempPath); } catch {} reject(err); });
      }).on('error', (err) => { try { unlinkSync(tempPath); } catch {} reject(err); });
    });

    renameSync(tempPath, filePath);
    if (m3uPath) appendToM3U(m3uPath, filePath, { ...(trackInfo ?? {}), url: trackInfo?.url ?? url });
    sendMessage({ type: 'downloadDone', downloadId, success: true, track: {
      filename: filePath, url: trackInfo?.url ?? url,
      title: trackInfo?.title ?? '', artist: trackInfo?.artist ?? '',
      duration: 0, downloadedAt: new Date().toISOString(),
    }});
  } catch (err) {
    sendMessage({ type: 'downloadDone', downloadId, success: false, error: `SC API fallback: ${err.message}` });
  }
}

function removeFromM3U(m3uPath, filePath) {
  if (!existsSync(m3uPath)) return;
  const lines = readFileSync(m3uPath, 'utf8').split('\n');
  const result = [];
  let pending = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '#EXTM3U') {
      if (pending.length) { result.push(...pending); pending = []; }
      result.push(line);
    } else if (trimmed.startsWith('#')) {
      pending.push(line);
    } else {
      if (trimmed !== filePath) result.push(...pending, line);
      pending = [];
    }
  }
  if (pending.length) result.push(...pending);
  writeFileSync(m3uPath, result.join('\n'), 'utf8');
}

// ── List tracks (parses M3U) ──────────────────────────

async function handleListTracks(msg) {
  const { id, m3uPath } = msg;

  if (!m3uPath || !existsSync(m3uPath)) {
    respond(id, { tracks: [] });
    return;
  }

  const lines = readFileSync(m3uPath, 'utf8').split('\n');
  const tracks = [];
  let extinf = null;
  let scUrl = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      const m = trimmed.match(/#EXTINF:(-?\d+),(.*)/);
      if (m) extinf = { duration: parseInt(m[1], 10), displayName: m[2] };
      scUrl = '';
    } else if (trimmed.startsWith('#SCURL:')) {
      scUrl = trimmed.slice(7);
    } else if (trimmed && !trimmed.startsWith('#')) {
      const name = extinf?.displayName || basename(trimmed);
      const dash = name.indexOf(' - ');
      tracks.push({
        filename: trimmed,
        url: scUrl,
        title: dash >= 0 ? name.slice(dash + 3) : name,
        artist: dash >= 0 ? name.slice(0, dash) : '',
        duration: (extinf?.duration ?? 0) * 1000,
        downloadedAt: '',
      });
      extinf = null;
      scUrl = '';
    }
  }

  respond(id, { tracks });
}

async function handleRemoveFromM3U(msg) {
  const { id, m3uPath, filePath } = msg;
  try {
    if (!m3uPath || !filePath) throw new Error('m3uPath and filePath required');
    removeFromM3U(m3uPath, filePath);
    respond(id, { success: true });
  } catch (err) {
    respond(id, { error: err.message });
  }
}

// ── Add track to M3U without downloading ─────────────

async function handleAddToM3U(msg) {
  const { id, m3uPath, filePath, trackInfo } = msg;
  try {
    if (!m3uPath || !filePath) throw new Error('m3uPath and filePath required');
    appendToM3U(m3uPath, filePath, trackInfo ?? {});
    respond(id, { success: true });
  } catch (err) {
    respond(id, { error: err.message });
  }
}

// ── Open in Finder ────────────────────────────────────

async function handleOpenFinder(msg) {
  const { id, path } = msg;
  try {
    await execFileAsync('open', [path]);
    respond(id, { success: true });
  } catch (err) {
    respond(id, { error: err.message });
  }
}

// ── Pick folder (AppleScript dialog) ─────────────────

async function handlePickFolder(msg) {
  const { id } = msg;
  try {
    const script = 'tell application "Finder" to set f to choose folder\nreturn POSIX path of f';
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    respond(id, { path: stdout.trim() });
  } catch (err) {
    // User cancelled
    respond(id, { path: null });
  }
}

// ── Check dependencies ────────────────────────────────

async function handleCheckDeps(msg) {
  const { id } = msg;

  async function which(cmd) {
    try { await execFileAsync('which', [cmd]); return true; }
    catch { return false; }
  }

  const [ytdlp, ffmpeg] = await Promise.all([which('yt-dlp'), which('ffmpeg')]);
  respond(id, { ytdlp, ffmpeg });
}

// ── OAuth loopback server ─────────────────────────────
// Starts a temporary HTTP server on a random local port, opens the SC auth
// page in the system browser, waits for the redirect, and returns the code.
// This avoids chrome.identity.launchWebAuthFlow which has a Chrome-level
// "only one flow at a time" bug that persists across extension reloads.

async function handleStartOAuth(msg) {
  const { id, clientId, scope = '*' } = msg;

  const OAUTH_PORT = 8765;
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${OAUTH_PORT} is already in use. Close whatever is using it and try again.`));
      } else {
        reject(err);
      }
    });
    server.listen(OAUTH_PORT, '127.0.0.1', resolve);
  });
  const port = OAUTH_PORT;
  const redirectUri = `http://127.0.0.1:${port}/`;

  const authUrl = new URL('https://api.soundcloud.com/connect');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scope);

  try {
    await execFileAsync('open', [authUrl.toString()]);
  } catch (err) {
    server.close();
    respond(id, { error: `Could not open browser: ${err.message}` });
    return;
  }

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.close();
      resolve({ error: 'OAuth timed out — no response after 5 minutes' });
    }, 300_000);

    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:3rem"><h2>&#10003; Connected to SoundCloud</h2><p>You can close this tab and return to the extension.</p></body></html>');

      clearTimeout(timer);
      server.close();

      if (code) resolve({ code, redirectUri });
      else resolve({ error: error || 'OAuth failed: no authorization code received' });
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: `Server error: ${err.message}` });
    });
  });

  respond(id, result);
}
