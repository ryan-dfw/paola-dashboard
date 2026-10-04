import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, importPKCS8, SignJWT, UnsecuredJWT } from 'jose';
import {
  _resetCertCache,
  emulatorAllowed,
  googleKeySource,
  TokenError,
  verifyFirebaseIdToken,
  type KeySource,
} from '../../server/firebaseToken';

const PROJECT = 'demo-paola';
const NOW = 1_790_000_000; // s
const now = () => NOW * 1000;

let good: CryptoKey;
let other: CryptoKey;
let keySource: KeySource;

beforeAll(async () => {
  const a = await generateKeyPair('RS256');
  const b = await generateKeyPair('RS256');
  good = a.privateKey;
  other = b.privateKey;
  keySource = async (kid) => (kid === 'kid-1' ? a.publicKey : null);
});

function sign(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: CryptoKey; alg?: string } = {}) {
  const base = {
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: 'uid_paola',
    iat: NOW - 60,
    exp: NOW + 3000,
    auth_time: NOW - 120,
    email: 'paola@example.com',
    email_verified: true,
    ...claims,
  };
  return new SignJWT(base)
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', ...(opts.kid === '' ? {} : { kid: opts.kid ?? 'kid-1' }) })
    .sign(opts.key ?? good);
}

const verify = (t: string, emulator = false) => verifyFirebaseIdToken(t, PROJECT, { keySource, now, emulator });

async function rejects(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(TokenError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('verifyFirebaseIdToken', () => {
  it('accepts a correctly signed Firebase token', async () => {
    const d = await verify(await sign());
    expect(d).toMatchObject({ uid: 'uid_paola', email: 'paola@example.com', email_verified: true });
  });

  it('rejects a token signed by a different key', async () => {
    await rejects(verify(await sign({}, { key: other })), 'auth/argument-error');
  });

  it('rejects an unknown kid and a missing kid', async () => {
    await rejects(verify(await sign({}, { kid: 'kid-unknown' })), 'auth/argument-error');
    await rejects(verify(await sign({}, { kid: '' })), 'auth/argument-error');
  });

  it('rejects the wrong audience / issuer (another Firebase project)', async () => {
    await rejects(verify(await sign({ aud: 'someone-else' })), 'auth/argument-error');
    await rejects(verify(await sign({ iss: 'https://securetoken.google.com/someone-else' })), 'auth/argument-error');
  });

  it('reports expiry distinctly', async () => {
    await rejects(verify(await sign({ exp: NOW - 60, iat: NOW - 4000, auth_time: NOW - 4000 })), 'auth/id-token-expired');
  });

  it('rejects future iat / auth_time and an empty subject', async () => {
    await rejects(verify(await sign({ iat: NOW + 600 })), 'auth/argument-error');
    await rejects(verify(await sign({ auth_time: NOW + 600 })), 'auth/argument-error');
    await rejects(verify(await sign({ sub: '' })), 'auth/argument-error');
  });

  it('rejects unsigned (alg none) tokens outside emulator mode', async () => {
    const unsigned = new UnsecuredJWT({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'x', iat: NOW, exp: NOW + 60, auth_time: NOW }).encode() + 'x';
    await rejects(verify(unsigned), 'auth/argument-error');
  });

  it('accepts unsigned emulator tokens only in emulator mode, still checking claims', async () => {
    const t = new UnsecuredJWT({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'u1', iat: NOW, exp: NOW + 60, auth_time: NOW }).encode() + 'sig';
    expect((await verify(t, true)).uid).toBe('u1');
    const wrong = new UnsecuredJWT({ aud: 'nope', iss: 'x', sub: 'u1', iat: NOW, exp: NOW + 60, auth_time: NOW }).encode() + 'sig';
    await rejects(verify(wrong, true), 'auth/argument-error');
  });

  it('rejects garbage', async () => {
    await rejects(verify('not-a-jwt'), 'auth/argument-error');
    await rejects(verify('a.b.c'), 'auth/argument-error');
  });
});

describe('emulatorAllowed', () => {
  it('never allows emulator (unsigned) tokens in a deployed Netlify context', () => {
    expect(emulatorAllowed({})).toBe(false);
    expect(emulatorAllowed({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toBe(true);
    expect(emulatorAllowed({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', CONTEXT: 'dev' })).toBe(true);
    expect(emulatorAllowed({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', CONTEXT: 'production' })).toBe(false);
    expect(emulatorAllowed({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', CONTEXT: 'deploy-preview' })).toBe(false);
  });
});

describe('googleKeySource (X.509 certs from Google)', () => {
  // Generates a throwaway key + self-signed cert at test time (needs openssl).
  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version']);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasOpenssl)('fetches certs, verifies a real RS256 token, caches, and throttles unknown kids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbcert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=test'], { stdio: 'ignore' });
    const key = await importPKCS8(readFileSync(join(dir, 'k.pem'), 'utf8').replace('BEGIN RSA PRIVATE KEY', 'BEGIN PRIVATE KEY').replace('END RSA PRIVATE KEY', 'END PRIVATE KEY'), 'RS256');
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');

    let fetches = 0;
    const fakeFetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ 'kid-real': cert }), { headers: { 'cache-control': 'public, max-age=3600' } });
    }) as unknown as typeof fetch;

    _resetCertCache();
    const ks = googleKeySource(fakeFetch);
    const realNow = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'u9', iat: realNow - 10, exp: realNow + 600, auth_time: realNow - 10 })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-real' })
      .sign(key);

    expect((await verifyFirebaseIdToken(token, PROJECT, { keySource: ks })).uid).toBe('u9');
    expect((await verifyFirebaseIdToken(token, PROJECT, { keySource: ks })).uid).toBe('u9');
    expect(fetches).toBe(1); // cached

    expect(await ks('kid-junk')).toBeNull();
    expect(await ks('kid-junk2')).toBeNull();
    expect(fetches).toBe(1); // unknown kids don't hammer Google
  });
});
