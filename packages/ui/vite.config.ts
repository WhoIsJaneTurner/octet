import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm --filter @octet/ui dev` proxies the API to a running daemon (pnpm daemon --fake).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4747' } },
});
