import { describe, expect, it } from 'vitest';
import { decodeJwt, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { defaultVerifier } from '../../server/auth';
import { readConfig } from '../../server/env';
import { firebaseAdmin, FirebaseAdminError } from '../../server/firebaseAdmin';

describe('firebaseAdmin (Identity Toolkit REST)', () => {
  it('is unavailable without service-account credentials or the emulator', () => {
    expect(firebaseAdmin(readConfig({ FIREBASE_PROJECT_ID: 'p' }))).toBeNull();
  });

  it('signs a service-account assertion, exchanges it, then calls Identity Toolkit', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const config = readConfig({
      FIREBASE_PROJECT_ID: 'demo-p',
      FIREBASE_CLIENT_EMAIL: 'svc@demo-p.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: pem.replace(/\n/g, '\\n'), // as stored in .env / Netlify
    });

    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') {
        const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
        const claims = decodeJwt(assertion);
        expect(claims.iss).toBe('svc@demo-p.iam.gserviceaccount.com');
        expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
        return new Response(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }));
      }
      if (url.endsWith('/accounts:lookup')) {
        const body = JSON.parse(String(init.body));
        if (body.email?.[0] === 'nobody@example.com') return new Response(JSON.stringify({ kind: 'x' }));
        return new Response(
          JSON.stringify({ users: [{ localId: 'u1', email: 'paola@example.com', emailVerified: true, lastLoginAt: '1790000000000', validSince: '1789000000' }] }),
        );
      }
      if (url.endsWith('/accounts')) return new Response(JSON.stringify({ error: { message: 'EMAIL_EXISTS' } }), { status: 400 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const admin = firebaseAdmin(config, fakeFetch)!;
    const u = await admin.getUserByEmail('paola@example.com');
    expect(u).toMatchObject({ uid: 'u1', emailVerified: true, disabled: false, validSince: 1789000000 });
    expect(u.lastSignIn).toBe(new Date(1790000000000).toISOString());

    const lookup = calls.find((c) => c.url.endsWith('/accounts:lookup'))!;
    expect(lookup.url).toBe('https://identitytoolkit.googleapis.com/v1/projects/demo-p/accounts:lookup');
    expect((lookup.init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.fake');

    await expect(admin.getUserByEmail('nobody@example.com')).rejects.toMatchObject({ code: 'user-not-found' });
    await expect(admin.createUser({ email: 'paola@example.com', emailVerified: true })).rejects.toBeInstanceOf(FirebaseAdminError);
    await expect(admin.createUser({ email: 'paola@example.com', emailVerified: true })).rejects.toMatchObject({ code: 'email-exists' });

    // The OAuth token is cached, not re-minted per call.
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
  });
});

describe('service-account key handling', () => {
  it('accepts the key quoted, with literal \\n, as .env / Netlify store it', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const c = readConfig({ FIREBASE_CLIENT_EMAIL: 'a@b', FIREBASE_PRIVATE_KEY: `"${pem.replace(/\n/g, '\\n')}"` });
    expect(c.serviceAccount?.privateKey).toBe(pem.trim());
  });

  it('explains a key that was pasted unquoted across lines (only the first line survives)', async () => {
    const config = readConfig({ FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'a@b', FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' });
    await expect(firebaseAdmin(config)!.getUser('u')).rejects.toThrow(/only contains its first line/);
  });

  it('a broken Admin key does not lock anyone out — the signature-verified token still passes', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const config = readConfig({ FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'a@b', FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' });
    const nowS = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ aud: 'p', iss: 'https://securetoken.google.com/p', sub: 'u1', iat: nowS - 5, exp: nowS + 600, auth_time: nowS - 5, email: 'x@y', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .sign(privateKey);
    const verify = defaultVerifier(config, { keySource: async (kid) => (kid === 'k' ? publicKey : null) });
    await expect(verify(token)).resolves.toMatchObject({ uid: 'u1' });
  });
});
