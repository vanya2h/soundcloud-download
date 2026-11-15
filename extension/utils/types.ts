export interface ScCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number; // unix ms
  username: string;
}

export interface Bucket {
  id: string;
  name: string;
  color: string;
  m3uPath: string;      // e.g. /rootDir/Trance.m3u
  // SC playlist link (optional)
  playlistId?: string;
  playlistName?: string;
  playlistUrl?: string;
  lastSyncedAt?: string;
}

export interface Track {
  filename: string;
  url: string;
  title: string;
  artist: string;
  duration: number;
  downloadedAt: string;
}

export interface Settings {
  rootDir: string;
  format: 'mp3' | 'aiff' | 'wav' | 'flac' | 'm4a';
  quality: 'best' | '320' | '256' | '192' | '128';
  embedArt: boolean;
  sc: Partial<ScCredentials>;
}

export interface TrackInfo {
  title: string;
  artist: string;
  url?: string; // SC permalink URL — written as #SCURL: in M3U for bidirectional sync
}

export interface SyncResult {
  bucketId: string;
  queued: number;    // new tracks queued for download
  skipped: number;   // already downloaded
  error?: string;
}

// Normalised track returned to the triage UI
export interface LikedTrack {
  id: number;
  title: string;
  artist: string;
  url: string;
  duration: number; // ms
  genre: string;
  tags: string[];   // parsed from SC tag_list
}

export interface LogEntry {
  id: string;
  time: string; // ISO
  level: 'info' | 'success' | 'error';
  message: string;
}

// Messages sent from content/popup → background
export type BgMessage =
  | { action: 'getBuckets' }
  | { action: 'addBucket'; name: string; color: string }
  | { action: 'removeBucket'; id: string }
  | { action: 'updateBucket'; id: string; updates: Partial<Bucket> }
  | { action: 'download'; url: string; trackInfo: TrackInfo; bucketId: string }
  | { action: 'listTracks'; m3uPath: string }
  | { action: 'openFinder'; path: string }
  | { action: 'pickFolder' }
  | { action: 'consumePendingFolderPick' }
  | { action: 'checkDeps' }
  | { action: 'getSettings' }
  | { action: 'saveSettings'; settings: Settings }
  // SoundCloud
  | { action: 'connectSoundCloud' }
  | { action: 'disconnectSoundCloud' }
  | { action: 'fetchScPlaylists' }
  | { action: 'resolveScUrl'; url: string }
  | { action: 'linkPlaylist'; bucketId: string; playlistId: string; playlistName: string; playlistUrl: string }
  | { action: 'unlinkPlaylist'; bucketId: string }
  | { action: 'syncBucket'; bucketId: string }
  | { action: 'resetBucketSync'; bucketId: string }
  | { action: 'getLogs' }
  | { action: 'clearLogs' }
  | { action: 'fetchLikedTracks'; nextHref?: string }
  | { action: 'dismissTrack'; trackId: number }
  | { action: 'getStreamUrl'; trackId: number }
  | { action: 'removeTrack'; bucketId: string; track: Track };

// Messages sent from background → content tabs (broadcast)
export type TabMessage =
  | { type: 'progress'; downloadId: string; percent: number; speed: string; eta: string }
  | { type: 'downloadDone'; downloadId: string; success: boolean; error?: string; track?: Track }
  | { type: 'syncProgress'; bucketId: string; queued: number; total: number };

export const BUCKET_COLORS = [
  '#ff5500', '#ff9900', '#00bfff', '#ff4466',
  '#44ff88', '#bb44ff', '#ffcc00', '#00ffcc',
];
