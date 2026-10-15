import { defineConfig } from 'vite';

// Cross-origin isolation enables SharedArrayBuffer snapshot transport.
// Without these headers the app falls back to transferable buffers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: true },
});
