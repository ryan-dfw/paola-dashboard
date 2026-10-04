// Firebase web SDK — client-safe config only (VITE_FIREBASE_*). Firebase web
// config is public by design; what protects order data is the server-side
// token check + allowlist in every Netlify Function.

import { initializeApp } from 'firebase/app';
import { browserLocalPersistence, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth, type Auth } from 'firebase/auth';

const env = import.meta.env;

export const firebaseConfigMissing = [
  ['VITE_FIREBASE_API_KEY', env.VITE_FIREBASE_API_KEY],
  ['VITE_FIREBASE_AUTH_DOMAIN', env.VITE_FIREBASE_AUTH_DOMAIN],
  ['VITE_FIREBASE_PROJECT_ID', env.VITE_FIREBASE_PROJECT_ID],
]
  .filter(([, v]) => !v)
  .map(([k]) => k as string);

let authInstance: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (authInstance) return authInstance;
  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  });
  // Stay signed in across app restarts (incl. an iPhone home-screen bookmark).
  authInstance = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  if (env.VITE_FIREBASE_AUTH_EMULATOR_HOST) {
    connectAuthEmulator(authInstance, `http://${env.VITE_FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  }
  return authInstance;
}
