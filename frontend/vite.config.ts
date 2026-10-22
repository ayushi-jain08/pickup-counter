import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev (npm run dev) /api is proxied to the backend, mirroring nginx in Docker.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
