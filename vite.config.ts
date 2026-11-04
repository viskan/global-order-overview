import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  // No inlining: otherwise every flag SVG ends up inside the CSS bundle.
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, assetsInlineLimit: 0 },
});
