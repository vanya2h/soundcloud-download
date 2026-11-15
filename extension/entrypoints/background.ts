import { storage } from 'wxt/storage';
import type { Bucket, LikedTrack, LogEntry, Settings, SyncResult, TabMessage, Track } from '../utils/types';
import { BUCKET_COLORS } from '../utils/types';
import {
  fetchPlaylist,
  fetchLikedTracks,
  fetchMe,
  fetchMyPlaylists,
  resolveScUrl,
  fetchStreamUrl,
  updatePlaylistTracks,
  exchangeCodeForTokens,
  refreshAccessToken,
  type ScPlaylist,
} from '../utils/soundcloud-api';

const HOST_NAME = 'com.soundclouddl.host';

// ── Storage ──────────────────────────────────────────

const bucketsItem = storage.defineItem<Bucket[]>('local:buckets', { defaultValue: [] });
const logsItem = storage.defineItem<LogEntry[]>('local:logs', { defaultValue: [] });
// Global library registry: SC track URL → absolute file path in library folder
const libraryItem = storage.defineItem<Record<string, string>>('local:library', { defaultValue: {} });
// Dismissed track IDs (triage skip)
const dismissedItem = storage.defineItem<number[]>('local:dismissed', { defaultValue: [] });

async function addLog(level: LogEntry['level'], message: string) {
  const entry: LogEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, time: new Date().toISOString(), level, message };
  const logs = await logsItem.getValue();
  await logsItem.setValue([entry, ...logs].slice(0, 300));
}
const settingsItem = storage.defineItem<Settings>('local:settings', {
  defaultValue: { rootDir: '', format: 'mp3', quality: 'best', embedArt: true, sc: {} },
});
const pendingFolderPickItem = storage.defineItem<string>('local:pendingFolderPick', { defaultValue: '' });

// Per-bucket set of SC track IDs that have already been downloaded
function syncedTracksItem(bucketId: string) {
  return storage.defineItem<string[]>(`local:synced:${bucketId}`, { defaultValue: [] });
}

// Per-bucket map of SC track ID → permalink URL (used for bidirectional sync removal)
function syncedTrackUrlsItem(bucketId: string) {
  return storage.defineItem<Record<string, string>>(`local:syncedUrls:${bucketId}`, { defaultValue: {} });
}

// ── Native host ───────────────────────────────────────

let nativePort: browser.Runtime.Port | null = null;
let msgId = 0;
const pendingRequests = new Map<number, (val: unknown) => void>();
const activeDownloads = new Set<string>();
const downloadIdToUrl = new Map<string, string>(); // tracks original SC URL for library registry

function getPort(): browser.Runtime.Port {
  if (nativePort) return nativePort;

  nativePort = browser.runtime.connectNative(HOST_NAME);

  nativePort.onMessage.addListener((msg: Record<string, unknown>) => {
    if (msg['type'] === 'response' && pendingRequests.has(msg['id'] as number)) {
      pendingRequests.get(msg['id'] as number)!(msg);
      pendingRequests.delete(msg['id'] as number);
      return;
    }
    const type = msg['type'] as string;
    if (type === 'progress' || type === 'downloadDone') {
      if (type === 'downloadDone') {
        const downloadId = msg['downloadId'] as string;
        activeDownloads.delete(downloadId);
        const track = msg['track'] as Track | undefined;
        if (msg['success']) {
          addLog('success', `Downloaded: ${track?.title || downloadId}`);
          // Save to global library registry so other buckets can dedup
          const originalUrl = downloadIdToUrl.get(downloadId);
          downloadIdToUrl.delete(downloadId);
          if (originalUrl && track?.filename) {
            libraryItem.getValue().then((lib) => {
              libraryItem.setValue({ ...lib, [originalUrl]: track.filename });
            });
          }
        } else {
          downloadIdToUrl.delete(downloadId);
          addLog('error', `Download failed: ${msg['error'] as string}`);
        }
      }
      broadcastToScTabs(msg as unknown as TabMessage);
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const err = browser.runtime.lastError?.message ?? 'disconnected';
    nativePort = null;
    pendingRequests.forEach((resolve) => resolve({ error: err }));
    pendingRequests.clear();
  });

  return nativePort;
}

function sendToHost(message: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = ++msgId;
    pendingRequests.set(id, resolve as (v: unknown) => void);
    message['id'] = id;
    try {
      getPort().postMessage(message);
    } catch (e) {
      pendingRequests.delete(id);
      resolve({ error: (e as Error).message });
      return;
    }
    setTimeout(() => {
      if (pendingRequests.has(id)) { pendingRequests.delete(id); resolve({ error: 'timeout' }); }
    }, timeoutMs);
  });
}

async function broadcastToScTabs(msg: TabMessage) {
  const tabs = await browser.tabs.query({ url: 'https://soundcloud.com/*' });
  tabs.forEach((tab) => { if (tab.id) browser.tabs.sendMessage(tab.id, msg).catch(() => {}); });
}

// ── Keepalive ─────────────────────────────────────────

browser.alarms.create('keepalive', { periodInMinutes: 0.4 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && activeDownloads.size > 0) {
    bucketsItem.getValue();
  }
});

// ── Main entry ────────────────────────────────────────

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg as Record<string, unknown>)
      .then(sendResponse)
      .catch((err: Error) => sendResponse({ error: err.message }));
    return true;
  });
});

// ── Message router ────────────────────────────────────

async function handleMessage(msg: Record<string, unknown>): Promise<unknown> {
  switch (msg['action']) {

    // ── Buckets ─────────────────────────────────────
    case 'getBuckets': {
      const [buckets, settings] = await Promise.all([bucketsItem.getValue(), settingsItem.getValue()]);
      // Migrate buckets created before the M3U model (they lack m3uPath)
      const migrated = buckets.map((b) => ({
        ...b,
        m3uPath: b.m3uPath ?? (settings.rootDir ? `${settings.rootDir}/${b.name}.m3u` : ''),
      }));
      if (migrated.some((b, i) => b.m3uPath !== buckets[i].m3uPath)) {
        await bucketsItem.setValue(migrated);
      }
      return { buckets: migrated };
    }

    case 'addBucket': {
      const [buckets, settings] = await Promise.all([bucketsItem.getValue(), settingsItem.getValue()]);
      if (!settings.rootDir) throw new Error('Root directory is not set. Configure it in Settings first.');
      const name = msg['name'] as string;
      const bucket: Bucket = {
        id: Date.now().toString(),
        name,
        m3uPath: `${settings.rootDir}/${name}.m3u`,
        color: (msg['color'] as string) || BUCKET_COLORS[buckets.length % BUCKET_COLORS.length],
      };
      await bucketsItem.setValue([...buckets, bucket]);
      return { bucket };
    }

    case 'removeBucket': {
      const buckets = await bucketsItem.getValue();
      await bucketsItem.setValue(buckets.filter((b) => b.id !== msg['id']));
      // Clean up synced track IDs
      await syncedTracksItem(msg['id'] as string).setValue([]);
      return { success: true };
    }

    case 'updateBucket': {
      const buckets = await bucketsItem.getValue();
      const updated = buckets.map((b) =>
        b.id === msg['id'] ? { ...b, ...(msg['updates'] as Partial<Bucket>) } : b
      );
      await bucketsItem.setValue(updated);
      return { success: true };
    }

    // ── Downloads ───────────────────────────────────
    case 'download': {
      const [buckets, settings, library] = await Promise.all([
        bucketsItem.getValue(), settingsItem.getValue(), libraryItem.getValue(),
      ]);
      const bucket = buckets.find((b) => b.id === msg['bucketId']);
      if (!bucket) throw new Error('Bucket not found');
      if (!settings.rootDir) throw new Error('Root directory not set');

      const url = msg['url'] as string;
      const trackInfo = msg['trackInfo'] as { title?: string; artist?: string };
      const libraryDir = `${settings.rootDir}/library`;
      const downloadId = Date.now().toString();
      activeDownloads.add(downloadId);

      const trackInfoWithUrl = { ...trackInfo, url }; // include SC URL for #SCURL: in M3U

      const existingPath = library[url];
      if (existingPath) {
        // Already in library — just append to M3U, no re-download
        addLog('info', `Already in library: ${trackInfo.title || url}`);
        sendToHost({ action: 'addToM3U', m3uPath: bucket.m3uPath, filePath: existingPath, trackInfo: trackInfoWithUrl })
          .then(() => {
            activeDownloads.delete(downloadId);
            broadcastToScTabs({ type: 'downloadDone', downloadId, success: true,
              track: { filename: existingPath, url, title: trackInfo.title ?? '', artist: trackInfo.artist ?? '', duration: 0, downloadedAt: new Date().toISOString() } });
          });
      } else {
        addLog('info', `Queued: ${trackInfo.title || url}`);
        downloadIdToUrl.set(downloadId, url);
        sendToHost({
          action: 'download', url, trackInfo: trackInfoWithUrl, libraryDir, m3uPath: bucket.m3uPath,
          downloadId, format: settings.format, quality: settings.quality, embedArt: settings.embedArt,
        }).then(() => activeDownloads.delete(downloadId));
      }

      return { downloadId };
    }

    case 'listTracks':
      return sendToHost({ action: 'listTracks', m3uPath: msg['m3uPath'] });

    case 'openFinder':
      return sendToHost({ action: 'openFinder', path: msg['path'] });

    case 'pickFolder': {
      const result = await sendToHost({ action: 'pickFolder' });
      if (result['path']) await pendingFolderPickItem.setValue(result['path'] as string);
      return result;
    }

    case 'consumePendingFolderPick': {
      const path = await pendingFolderPickItem.getValue();
      if (path) await pendingFolderPickItem.setValue('');
      return { path: path || null };
    }

    case 'checkDeps':
      return sendToHost({ action: 'checkDeps' });

    // ── Settings ─────────────────────────────────────
    case 'getSettings':
      return { settings: await settingsItem.getValue() };

    case 'saveSettings':
      await settingsItem.setValue(msg['settings'] as Settings);
      return { success: true };

    // ── SoundCloud OAuth ─────────────────────────────
    // Uses a loopback HTTP server in the native host to avoid the Chrome
    // identity API bug ("Only one web auth flow at a time") which persists
    // across extension reloads and can only be cleared by restarting the browser.
    case 'connectSoundCloud': {
      const settings = await settingsItem.getValue();
      const { clientId, clientSecret } = settings.sc ?? {};
      if (!clientId || !clientSecret) throw new Error('Enter client ID and secret first');

      // The host starts a local HTTP server, opens the SC auth page in the
      // system browser, waits for the redirect, and returns the code.
      const result = await sendToHost({ action: 'startOAuth', clientId, scope: '*' }, 310_000);
      if (result['error']) throw new Error(result['error'] as string);

      const code = result['code'] as string;
      const redirectUri = result['redirectUri'] as string;

      const tokens = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);
      const me = await fetchMe(tokens.accessToken);

      const updated: Settings = {
        ...settings,
        sc: { ...settings.sc, ...tokens, username: me.username },
      };
      await settingsItem.setValue(updated);
      return { username: me.username };
    }

    case 'disconnectSoundCloud': {
      const settings = await settingsItem.getValue();
      await settingsItem.setValue({
        ...settings,
        sc: { clientId: settings.sc?.clientId, clientSecret: settings.sc?.clientSecret },
      });
      return { success: true };
    }

    // ── SC Playlists ─────────────────────────────────
    case 'fetchScPlaylists': {
      const token = await getValidToken();
      const playlists = await fetchMyPlaylists(token);
      return { playlists };
    }

    case 'resolveScUrl': {
      const settings = await settingsItem.getValue();
      const clientId = settings.sc?.clientId;
      if (!clientId) throw new Error('SoundCloud client ID not configured');
      const result = await resolveScUrl(msg['url'] as string, clientId);
      return { result };
    }

    case 'linkPlaylist': {
      const buckets = await bucketsItem.getValue();
      const updated = buckets.map((b) =>
        b.id === msg['bucketId']
          ? { ...b, playlistId: msg['playlistId'] as string, playlistName: msg['playlistName'] as string, playlistUrl: msg['playlistUrl'] as string }
          : b
      );
      await bucketsItem.setValue(updated);
      return { success: true };
    }

    case 'unlinkPlaylist': {
      const buckets = await bucketsItem.getValue();
      const updated = buckets.map((b) => {
        if (b.id !== msg['bucketId']) return b;
        const { playlistId: _, playlistName: __, playlistUrl: ___, lastSyncedAt: ____, ...rest } = b;
        return rest;
      });
      await bucketsItem.setValue(updated);
      // Clear synced track history for this bucket
      await syncedTracksItem(msg['bucketId'] as string).setValue([]);
      return { success: true };
    }

    // ── Sync ─────────────────────────────────────────
    case 'syncBucket':
      return syncBucket(msg['bucketId'] as string);

    case 'resetBucketSync': {
      await syncedTracksItem(msg['bucketId'] as string).setValue([]);
      addLog('info', `Sync history cleared — next sync will re-download all tracks`);
      return syncBucket(msg['bucketId'] as string);
    }

    case 'getLogs':
      return { logs: await logsItem.getValue() };

    case 'clearLogs':
      await logsItem.setValue([]);
      return { success: true };

    // ── Triage ───────────────────────────────────────
    case 'fetchLikedTracks': {
      const token = await getValidToken();
      const page = await fetchLikedTracks(token, msg['nextHref'] as string | undefined);
      const [library, dismissed] = await Promise.all([libraryItem.getValue(), dismissedItem.getValue()]);
      const dismissedSet = new Set(dismissed);
      const tracks: LikedTrack[] = page.collection
        .filter((t) => !library[t.permalink_url] && !dismissedSet.has(t.id))
        .map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.user.username,
          url: t.permalink_url,
          duration: t.duration,
          genre: t.genre ?? '',
          tags: parseTagList(t.tag_list),
        }));
      return { tracks, nextHref: page.next_href };
    }

    case 'dismissTrack': {
      const dismissed = await dismissedItem.getValue();
      const id = msg['trackId'] as number;
      if (!dismissed.includes(id)) await dismissedItem.setValue([...dismissed, id]);
      return { success: true };
    }

    case 'getStreamUrl': {
      const token = await getValidToken();
      try {
        const streamUrl = await fetchStreamUrl(msg['trackId'] as number, token);
        return { url: streamUrl };
      } catch (e) {
        addLog('error', `Preview failed: ${(e as Error).message}`);
        return { error: (e as Error).message };
      }
    }

    case 'removeTrack': {
      const { bucketId, track } = msg as { bucketId: string; track: import('../utils/types').Track };
      const [buckets, settings] = await Promise.all([bucketsItem.getValue(), settingsItem.getValue()]);
      const bucket = buckets.find((b) => b.id === bucketId);
      if (!bucket) throw new Error('Bucket not found');

      await sendToHost({ action: 'removeFromM3U', m3uPath: bucket.m3uPath, filePath: track.filename });

      // If linked to a SC playlist and the track has a SC URL, remove it from the playlist too
      if (bucket.playlistId && track.url) {
        try {
          const clientId = settings.sc?.clientId;
          if (clientId) {
            const token = await getValidToken();
            const playlist = await fetchPlaylist(bucket.playlistId, clientId, token);
            const updatedTracks = (playlist.tracks ?? []).filter((t) => t.permalink_url !== track.url);
            if (updatedTracks.length !== (playlist.tracks?.length ?? 0)) {
              await updatePlaylistTracks(bucket.playlistId, updatedTracks.map((t) => t.id), token);
              addLog('info', `Removed "${track.title}" from SC playlist "${bucket.playlistName}"`);
            }
          }
        } catch (e) {
          addLog('error', `SC playlist update failed: ${(e as Error).message}`);
        }
      }

      // Remove from the synced URL map so future sync doesn't re-add it
      if (track.url) {
        const syncedUrlsItem = syncedTrackUrlsItem(bucketId);
        const urlMap = await syncedUrlsItem.getValue();
        const cleaned = Object.fromEntries(Object.entries(urlMap).filter(([, u]) => u !== track.url));
        await syncedUrlsItem.setValue(cleaned);
      }

      return { success: true };
    }

    default:
      throw new Error(`Unknown action: ${msg['action']}`);
  }
}

// ── Sync logic ────────────────────────────────────────

async function syncBucket(bucketId: string): Promise<SyncResult> {
  const buckets = await bucketsItem.getValue();
  const bucket = buckets.find((b) => b.id === bucketId);
  if (!bucket) throw new Error('Bucket not found');
  if (!bucket.playlistId) throw new Error('Bucket has no linked playlist');

  const settings = await settingsItem.getValue();
  const clientId = settings.sc?.clientId;
  if (!clientId) throw new Error('SoundCloud client ID not configured');
  if (!settings.rootDir) throw new Error('Root directory not set');

  const token = await getValidToken();

  addLog('info', `Syncing "${bucket.name}"…`);

  const playlist = await fetchPlaylist(bucket.playlistId, clientId, token);
  const tracks = playlist.tracks ?? [];

  const syncedItem = syncedTracksItem(bucketId);
  const syncedIds = new Set(await syncedItem.getValue());
  const syncedUrlsItem = syncedTrackUrlsItem(bucketId);
  const syncedUrlMap = await syncedUrlsItem.getValue(); // trackId → permalink_url
  const library = await libraryItem.getValue();
  const libraryDir = `${settings.rootDir}/library`;

  // ── Bidirectional removal: remove M3U entries that were synced but are no longer in the playlist ──
  const scUrlSet = new Set(tracks.map((t) => t.permalink_url));
  const syncedUrlSet = new Set(Object.values(syncedUrlMap));
  const m3uResult = await sendToHost({ action: 'listTracks', m3uPath: bucket.m3uPath }) as { tracks?: Array<{ filename: string; url: string; title: string }> };
  const m3uTracks = m3uResult?.tracks ?? [];
  const toRemove = m3uTracks.filter((t) => t.url && syncedUrlSet.has(t.url) && !scUrlSet.has(t.url));
  for (const t of toRemove) {
    await sendToHost({ action: 'removeFromM3U', m3uPath: bucket.m3uPath, filePath: t.filename });
    addLog('info', `Removed from M3U (no longer in SC playlist): ${t.title || t.filename}`);
  }
  // Clean up removed entries from syncedUrlMap
  if (toRemove.length > 0) {
    const removedUrls = new Set(toRemove.map((t) => t.url));
    const cleanedUrlMap = Object.fromEntries(Object.entries(syncedUrlMap).filter(([, u]) => !removedUrls.has(u)));
    await syncedUrlsItem.setValue(cleanedUrlMap);
  }

  const newTracks = tracks.filter((t) => t.streamable && !syncedIds.has(String(t.id)));

  // Mark as synced immediately to prevent re-queuing on rapid re-sync
  await syncedItem.setValue([...syncedIds, ...newTracks.map((t) => String(t.id))]);

  // Store URL mapping for new tracks (needed for future bidirectional removal)
  if (newTracks.length > 0) {
    const newUrlEntries = Object.fromEntries(newTracks.map((t) => [String(t.id), t.permalink_url]));
    await syncedUrlsItem.setValue({ ...(toRemove.length > 0 ? Object.fromEntries(Object.entries(syncedUrlMap).filter(([, u]) => !new Set(toRemove.map((t) => t.url)).has(u))) : syncedUrlMap), ...newUrlEntries });
  }

  for (const track of newTracks) {
    const downloadId = `sync-${bucket.id}-${track.id}`;
    activeDownloads.add(downloadId);

    const existingPath = library[track.permalink_url];
    if (existingPath) {
      // Already downloaded to library by another bucket — just add to this M3U
      addLog('info', `Already in library: ${track.title}`);
      sendToHost({
        action: 'addToM3U', m3uPath: bucket.m3uPath, filePath: existingPath,
        trackInfo: { title: track.title, artist: track.user.username, url: track.permalink_url },
      }).then(() => activeDownloads.delete(downloadId));
    } else {
      downloadIdToUrl.set(downloadId, track.permalink_url);
      sendToHost({
        action: 'download',
        url: track.permalink_url,
        trackInfo: { title: track.title, artist: track.user.username, url: track.permalink_url },
        libraryDir, m3uPath: bucket.m3uPath, downloadId,
        format: settings.format, quality: settings.quality, embedArt: settings.embedArt,
      }).then(() => activeDownloads.delete(downloadId));
    }
  }

  // Update lastSyncedAt on the bucket
  const updatedBuckets = buckets.map((b) =>
    b.id === bucketId ? { ...b, lastSyncedAt: new Date().toISOString() } : b
  );
  await bucketsItem.setValue(updatedBuckets);

  if (newTracks.length > 0 || toRemove.length > 0) {
    addLog('success', `Sync "${bucket.name}": +${newTracks.length} queued, ${toRemove.length > 0 ? `-${toRemove.length} removed, ` : ''}${syncedIds.size} already synced`);
  } else {
    addLog('info', `Sync "${bucket.name}": up to date (${syncedIds.size} tracks)`);
  }

  return { bucketId, queued: newTracks.length, skipped: syncedIds.size };
}

// ── Helpers ───────────────────────────────────────────

function parseTagList(tagList?: string): string[] {
  if (!tagList) return [];
  const tags: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagList)) !== null) {
    const tag = (m[1] ?? m[2]).trim();
    if (tag) tags.push(tag);
  }
  return tags;
}

// ── Token management ──────────────────────────────────

async function getValidToken(): Promise<string> {
  const settings = await settingsItem.getValue();
  const sc = settings.sc ?? {};

  if (!sc.accessToken) throw new Error('Not connected to SoundCloud');

  // Refresh if expired (with 5 min buffer)
  if (sc.tokenExpiry && Date.now() > sc.tokenExpiry - 300_000) {
    if (!sc.refreshToken || !sc.clientId || !sc.clientSecret) {
      throw new Error('Token expired — reconnect SoundCloud');
    }
    const { accessToken, tokenExpiry } = await refreshAccessToken(
      sc.refreshToken,
      sc.clientId,
      sc.clientSecret,
    );
    await settingsItem.setValue({ ...settings, sc: { ...sc, accessToken, tokenExpiry } });
    return accessToken;
  }

  return sc.accessToken;
}
