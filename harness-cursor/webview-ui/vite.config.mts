import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = fileURLToPath(new URL('.', import.meta.url));
const DEV_PORT = 5173;
const DEV_ORIGIN = `http://localhost:${DEV_PORT}`;

export default defineConfig({
  root,
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
    },
  },
  server: {
    port: DEV_PORT,
    // launch.json points the webview at this exact port; silently moving to 5174 would give a blank page.
    strictPort: true,
    // Makes url(...) in CSS absolute; otherwise it resolves against the vscode-webview:// origin.
    origin: DEV_ORIGIN,
    // Module scripts are cross-origin from the webview; Vite only allows localhost origins by default.
    cors: { origin: /^vscode-webview:\/\// },
    hmr: { protocol: 'ws', host: 'localhost', port: DEV_PORT },
    // @shared and the mock host import files outside webview-ui/.
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/webview', import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    // elkjs alone is ~1.5 MB; the bundle is loaded from disk, so size is not a concern.
    chunkSizeWarningLimit: 3000,
    // The extension host loads these by fixed name when building the webview HTML.
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: 'index.[ext]',
      },
    },
  },
});
