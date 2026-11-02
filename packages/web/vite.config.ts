import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative URLs: the build works at any path, such as https://<user>.github.io/<repo>/.
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173, host: '127.0.0.1', strictPort: true },
  build: { chunkSizeWarningLimit: 1200, rollupOptions: { output: { manualChunks: { maplibre: ['maplibre-gl'] } } } },
});
