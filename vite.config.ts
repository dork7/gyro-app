import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two pages: the game (index.html) and the phone controller (pad.html, served at /pad).
export default defineConfig({
  appType: 'mpa',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        pad: resolve(__dirname, 'pad.html'),
      },
    },
  },
});
