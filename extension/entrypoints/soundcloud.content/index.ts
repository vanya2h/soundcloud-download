import type { Bucket, TabMessage, TrackInfo } from '../../utils/types';
import { sendToBackground } from '../../utils/messaging';
import './styles.css';

const DL_ATTR = 'data-sc-dl';
const DL_BTN_CLASS = 'sc-dl-btn';

let buckets: Bucket[] = [];
const activeDownloads = new Map<string, { btn: HTMLButtonElement }>();

export default defineContentScript({
  matches: ['https://soundcloud.com/*'],
  runAt: 'document_idle',
  async main() {
    await refreshBuckets();
    observeNavigation();
    tryInject();

    browser.runtime.onMessage.addListener((msg: TabMessage) => {
      if (msg.type === 'progress') onProgress(msg);
      if (msg.type === 'downloadDone') onDownloadDone(msg);
    });

    // Refresh buckets when page becomes visible (user may have added buckets in popup)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshBuckets();
    });
  },
});

async function refreshBuckets() {
  const res = await sendToBackground<{ buckets: Bucket[] }>({ action: 'getBuckets' });
  buckets = res?.buckets ?? [];
}

// --- Navigation observation (SPA) ---

function observeNavigation() {
  let lastUrl = location.href;

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(tryInject, 700);
    }
    tryInject();
  }).observe(document.body, { childList: true, subtree: true });
}

// --- Injection ---

function tryInject() {
  if (isTrackPage()) injectOnTrackPage();

  document
    .querySelectorAll<HTMLElement>(`article:not([${DL_ATTR}]), li.soundList__item:not([${DL_ATTR}])`)
    .forEach(injectOnStreamItem);
}

function isTrackPage() {
  const parts = location.pathname.split('/').filter(Boolean);
  const reserved = ['sets', 'albums', 'likes', 'reposts', 'followers', 'following', 'groups', 'tracks', 'popular-tracks', 'comments'];
  return parts.length === 2 && !reserved.includes(parts[1]);
}

function injectOnTrackPage() {
  const group = findButtonGroup(document);
  if (!group || group.hasAttribute(DL_ATTR)) return;
  group.setAttribute(DL_ATTR, '1');

  const url = location.href.split('?')[0];
  const info = scrapeTrackInfo(document);
  group.appendChild(makeDlButton(url, info));
}

function injectOnStreamItem(item: HTMLElement) {
  item.setAttribute(DL_ATTR, '1');
  const group = findButtonGroup(item);
  if (!group) return;
  const link = findTrackLink(item);
  if (!link) return;
  const url = new URL(link, 'https://soundcloud.com').href;
  const info = scrapeTrackInfo(item);
  group.appendChild(makeDlButton(url, info));
}

function findButtonGroup(root: Document | HTMLElement): HTMLElement | null {
  const groups = root.querySelectorAll<HTMLElement>('.sc-button-group');
  for (const g of groups) {
    if (g.querySelector('button[title^="Like"], button[aria-label^="Like"]')) return g;
  }
  return null;
}

function findTrackLink(item: HTMLElement): string | null {
  for (const a of item.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href')!;
    if (isTrackPath(href)) return href;
  }
  return null;
}

function isTrackPath(path: string) {
  if (path.startsWith('http')) return false;
  const parts = path.split('/').filter(Boolean);
  const reserved = ['sets', 'albums', 'tracks', 'likes', 'reposts', 'followers', 'following', 'groups', 'popular-tracks'];
  return parts.length === 2 && !reserved.includes(parts[1]) && !parts[0].startsWith('#');
}

function scrapeTrackInfo(root: Document | HTMLElement): TrackInfo {
  const title =
    (root as HTMLElement).querySelector?.('.soundTitle__title, .trackItem__trackTitle, h1')?.textContent?.trim() ??
    document.title.split(' | ')[0].trim();
  const artist =
    (root as HTMLElement).querySelector?.('.soundTitle__username, .trackItem__username, .sc-link-primary')?.textContent?.trim() ?? '';
  return { title, artist };
}

// --- Download button ---

function makeDlButton(url: string, trackInfo: TrackInfo): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `${DL_BTN_CLASS} sc-button sc-button-medium sc-button-responsive`;
  btn.title = 'Download to bucket';
  btn.dataset.url = url;
  btn.innerHTML = svgIcon('download');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDlClick(btn, url, trackInfo);
  });
  return btn;
}

function handleDlClick(btn: HTMLButtonElement, url: string, trackInfo: TrackInfo) {
  if (buckets.length === 0) {
    showToast('No buckets configured — open the extension popup to add one');
    return;
  }
  if (buckets.length === 1) {
    startDownload(btn, url, trackInfo, buckets[0].id);
    return;
  }
  showBucketPicker(btn, url, trackInfo);
}

function showBucketPicker(btn: HTMLButtonElement, url: string, trackInfo: TrackInfo) {
  closePicker();

  const picker = document.createElement('div');
  picker.className = 'sc-dl-picker';
  picker.id = 'sc-dl-picker';

  buckets.forEach((bucket) => {
    const item = document.createElement('button');
    item.className = 'sc-dl-picker__item';
    item.innerHTML = `<span class="sc-dl-picker__dot" style="background:${bucket.color}"></span>${escHtml(bucket.name)}`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closePicker();
      startDownload(btn, url, trackInfo, bucket.id);
    });
    picker.appendChild(item);
  });

  const rect = btn.getBoundingClientRect();
  picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
  picker.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(picker);

  setTimeout(() => document.addEventListener('click', closePicker, { once: true }), 0);
}

function closePicker() {
  document.getElementById('sc-dl-picker')?.remove();
}

function startDownload(btn: HTMLButtonElement, url: string, trackInfo: TrackInfo, bucketId: string) {
  setBtnState(btn, 'loading', '0%');

  sendToBackground<{ downloadId?: string; error?: string }>({
    action: 'download',
    url,
    trackInfo,
    bucketId,
  }).then((res) => {
    if (res?.error) {
      setBtnState(btn, 'error');
      showToast(`Download failed: ${res.error}`);
      return;
    }
    if (res?.downloadId) activeDownloads.set(res.downloadId, { btn });
  });
}

// --- Progress & completion ---

function onProgress(msg: Extract<TabMessage, { type: 'progress' }>) {
  const entry = activeDownloads.get(msg.downloadId);
  if (!entry) return;
  setBtnState(entry.btn, 'loading', `${Math.round(msg.percent ?? 0)}%`);
}

function onDownloadDone(msg: Extract<TabMessage, { type: 'downloadDone' }>) {
  const entry = activeDownloads.get(msg.downloadId);
  activeDownloads.delete(msg.downloadId);
  if (!entry) return;

  if (msg.success) {
    setBtnState(entry.btn, 'done');
    setTimeout(() => setBtnState(entry.btn, 'idle'), 2500);
  } else {
    setBtnState(entry.btn, 'error');
    showToast(`Download failed: ${msg.error ?? 'unknown error'}`);
    setTimeout(() => setBtnState(entry.btn, 'idle'), 3000);
  }
}

type BtnState = 'idle' | 'loading' | 'done' | 'error';

function setBtnState(btn: HTMLButtonElement, state: BtnState, label = '') {
  btn.dataset.state = state;
  switch (state) {
    case 'idle':    btn.innerHTML = svgIcon('download'); btn.title = 'Download to bucket'; break;
    case 'loading': btn.innerHTML = `${svgIcon('spinner')}<span class="sc-dl-btn__pct">${label}</span>`; break;
    case 'done':    btn.innerHTML = svgIcon('check'); btn.title = 'Downloaded!'; break;
    case 'error':   btn.innerHTML = svgIcon('x'); btn.title = 'Download failed'; break;
  }
}

function showToast(msg: string) {
  const t = document.createElement('div');
  t.className = 'sc-dl-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function escHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgIcon(name: string): string {
  const icons: Record<string, string> = {
    download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    spinner:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="sc-dl-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>`,
    check:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#44ff88" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    x:        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff4466" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  };
  return icons[name] ?? '';
}
