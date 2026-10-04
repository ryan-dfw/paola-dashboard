import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Only VITE_* variables reach the browser bundle. Server secrets
  // (STRIPE_SECRET_KEY, FIREBASE_PRIVATE_KEY, …) must never be prefixed VITE_.
  envPrefix: 'VITE_',
  server: { port: 5174 },
  build: { outDir: 'dist' },
});
