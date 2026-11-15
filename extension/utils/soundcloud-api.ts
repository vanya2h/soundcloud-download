const SC_API = 'https://api.soundcloud.com';

export interface ScPlaylist {
  id: number;
  title: string;
  permalink_url: string;
  track_count: number;
  tracks?: ScTrack[];
}

export interface ScTrack {
  id: number;
  title: string;
  permalink_url: string;
  user: { username: string };
  duration: number; // ms
  streamable: boolean;
  policy?: string;
  genre?: string;
  tag_list?: string; // space-separated, quoted multi-word tags e.g. "deep house" techno
}

export interface ScUser {
  id: number;
  username: string;
  permalink_url: string;
}

async function scFetch<T>(path: string, params: Record<string, string> = {}, accessToken?: string): Promise<T> {
  const url = new URL(`${SC_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = { Accept: 'application/json; charset=utf-8' };
  if (accessToken) headers['Authorization'] = `OAuth ${accessToken}`;

  // Follow redirects manually so the Authorization header is preserved.
  // fetch()'s default redirect:'follow' drops it on cross-origin hops.
  let res = await fetch(url.toString(), { headers, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? '';
    res = await fetch(location, { headers, redirect: 'follow' });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SC API ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }
  return res.json() as Promise<T>;
}

// Resolve any soundcloud.com URL (playlist or track) to its API object
export function resolveScUrl(url: string, clientId: string): Promise<ScPlaylist | ScTrack> {
  return scFetch('/resolve', { url, client_id: clientId });
}

// Fetch a single playlist with its full track list
export async function fetchPlaylist(playlistId: string, clientId: string, accessToken?: string): Promise<ScPlaylist> {
  // When authenticated, omit client_id — SC rejects requests that include both
  const params = accessToken ? {} : { client_id: clientId };
  return scFetch<ScPlaylist>(`/playlists/${playlistId}`, params, accessToken);
}

// Fetch authenticated user's playlists (requires access token)
export function fetchMyPlaylists(accessToken: string): Promise<ScPlaylist[]> {
  return scFetch<ScPlaylist[]>('/me/playlists', {}, accessToken);
}

// Fetch a page of liked tracks. Pass nextHref for subsequent pages.
export async function fetchLikedTracks(
  accessToken: string,
  nextHref?: string,
): Promise<{ collection: ScTrack[]; next_href?: string }> {
  if (nextHref) {
    // next_href is a full URL — fetch it directly with auth headers
    const headers: Record<string, string> = {
      Accept: 'application/json; charset=utf-8',
      Authorization: `OAuth ${accessToken}`,
    };
    let res = await fetch(nextHref, { headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? '';
      res = await fetch(loc, { headers });
    }
    if (!res.ok) throw new Error(`SC API ${res.status}`);
    return res.json();
  }
  return scFetch<{ collection: ScTrack[]; next_href?: string }>(
    '/me/likes/tracks',
    { limit: '50', linked_partitioning: '1' },
    accessToken,
  );
}

// Fetch the CDN stream URL for a track.
// The /stream endpoint only ever returns a 302 → CDN URL with a signed token in the query string.
// In an MV3 service worker, redirect:'manual' returns an opaque response (status 0, no headers),
// so we must use redirect:'follow' and read res.url for the final CDN URL.
export async function fetchStreamUrl(trackId: number, accessToken: string): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `OAuth ${accessToken}`,
  };
  const res = await fetch(`${SC_API}/tracks/${trackId}/stream`, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Stream unavailable (${res.status})`);
  return res.url;
}

// Replace a playlist's track list (used to remove a track from a playlist)
export async function updatePlaylistTracks(playlistId: string, trackIds: number[], accessToken: string): Promise<void> {
  const res = await fetch(`${SC_API}/playlists/${playlistId}`, {
    method: 'PUT',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ playlist: { tracks: trackIds.map((id) => ({ id })) } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SC API ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }
}

// Verify token and get user info
export function fetchMe(accessToken: string): Promise<ScUser> {
  return scFetch<ScUser>('/me', {}, accessToken);
}

// Exchange OAuth authorization code for tokens
export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; tokenExpiry: number }> {
  const res = await fetch(`${SC_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status}`);
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenExpiry: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; tokenExpiry: number }> {
  const res = await fetch(`${SC_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    tokenExpiry: Date.now() + data.expires_in * 1000,
  };
}
