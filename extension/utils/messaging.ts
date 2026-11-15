import type { BgMessage } from './types';

// Typed wrapper around browser.runtime.sendMessage
export function sendToBackground<T = unknown>(msg: BgMessage): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}
