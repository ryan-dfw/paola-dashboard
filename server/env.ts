// Server-only configuration. Nothing in this file is ever bundled into the
// browser build (src/ never imports from server/).

import type { Role } from '../shared/types';

export interface Principal {
  value: string; // as written, lower-cased if an email
  kind: 'email' | 'uid';
  role: Role;
}

export interface ServerConfig {
  stripeSecretKey: string | null;
  firebaseProjectId: string | null;
  serviceAccount: { clientEmail: string; privateKey: string } | null;
  principals: Principal[];
}

/** "a@b.com, Xyz123 ,c@d.com" → entries. Emails are lower-cased; UIDs are case-sensitive. */
export function parsePrincipals(raw: string | undefined, role: Role): Principal[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) =>
      value.includes('@') ? { value: value.toLowerCase(), kind: 'email' as const, role } : { value, kind: 'uid' as const, role },
    );
}

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const superadmins = parsePrincipals(env.DASHBOARD_SUPERADMINS, 'superadmin');
  const users = parsePrincipals(env.DASHBOARD_USERS, 'user');
  // A superadmin listing wins over a plain user listing for the same person.
  const principals = [...superadmins, ...users.filter((u) => !superadmins.some((s) => s.value === u.value))];

  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim();
  // Netlify / .env files store the PEM with literal "\n" sequences.
  // Also tolerate the value being pasted with its surrounding quotes.
  const privateKey = env.FIREBASE_PRIVATE_KEY?.trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .replace(/\\n/g, '\n')
    .trim();

  return {
    stripeSecretKey: env.STRIPE_SECRET_KEY?.trim() || null,
    // The project ID isn't secret — fall back to the client one so it only has to be set once.
    firebaseProjectId: env.FIREBASE_PROJECT_ID?.trim() || env.VITE_FIREBASE_PROJECT_ID?.trim() || null,
    serviceAccount: clientEmail && privateKey ? { clientEmail, privateKey } : null,
    principals,
  };
}
