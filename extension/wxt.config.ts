import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  outDir: 'output',
  extensionEntrypoints: 'entrypoints',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SoundCloud DL',
    description: 'Download SoundCloud tracks to DJ buckets',
    permissions: ['storage', 'nativeMessaging', 'alarms'],
    host_permissions: ['https://soundcloud.com/*'],
    action: {
      default_title: 'SoundCloud DL',
    },
  },
  vite: () => ({
    build: {
      target: 'esnext',
    },
  }),
});
