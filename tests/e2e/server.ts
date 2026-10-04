// End-to-end test server: the real Vite app + the real API handlers with
// REAL Firebase token verification (against the Firebase Auth emulator).
// Only Stripe is replaced, by an in-memory fake seeded with demo data.
//
//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 tsx tests/e2e/server.ts

import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createVite } from 'vite';
import { defaultVerifier } from '../../server/auth';
import { readConfig } from '../../server/env';
import {
  adminAccountsHandler,
  adminStatusHandler,
  fulfillmentHandler,
  meHandler,
  orderHandler,
  ordersHandler,
  type Deps,
} from '../../server/handlers';
import { _resetProductCache } from '../../server/orders';
import { demoSessions } from '../fixtures/demoSessions';
import { fakeStripe } from '../fixtures/fakeStripe';
import { session } from '../fixtures/stripe';

const PORT = Number(process.env.PORT || 5180);
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.VITE_FIREBASE_API_KEY = 'demo-api-key';
process.env.VITE_FIREBASE_AUTH_DOMAIN = 'localhost';
process.env.VITE_FIREBASE_PROJECT_ID = 'demo-paola';
process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;

const config = readConfig({
  STRIPE_SECRET_KEY: 'sk_test_e2e',
  FIREBASE_PROJECT_ID: 'demo-paola',
  DASHBOARD_USERS: 'paola@example.com, helper@example.com',
  DASHBOARD_SUPERADMINS: 'mckevitt.r@gmail.com',
});

let fake = fakeStripe(demoSessions());
const deps = (): Deps => ({ config, verify: defaultVerifier(config), stripe: () => fake.stripe });

const ROUTES: [RegExp, (req: Request, d: Deps, p: Record<string, string>) => Promise<Response>][] = [
  [/^\/api\/me$/, (r, d) => meHandler(r, d)],
  [/^\/api\/orders$/, (r, d) => ordersHandler(r, d)],
  [/^\/api\/orders\/(?<sessionId>[^/]+)\/fulfillment$/, (r, d, p) => fulfillmentHandler(r, d, p)],
  [/^\/api\/orders\/(?<sessionId>[^/]+)$/, (r, d, p) => orderHandler(r, d, p)],
  [/^\/api\/admin\/status$/, (r, d) => adminStatusHandler(r, d)],
  [/^\/api\/admin\/accounts$/, (r, d) => adminAccountsHandler(r, d)],
];

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
}

async function send(res: ServerResponse, r: Response) {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await r.arrayBuffer()));
}

const vite = await createVite({ server: { middlewareMode: true, hmr: false }, appType: 'spa', logLevel: 'warn' });

createHttp(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/__test/reset' && req.method === 'POST') {
    const url = new URL(req.url!, 'http://x');
    _resetProductCache();
    const many = Number(url.searchParams.get('many') || 0);
    const extra = Array.from({ length: many }, (_, i) =>
      session({
        id: `cs_test_bulk${String(i).padStart(4, '0')}`,
        created: 1700000000 + i,
        name: `Bulk Buyer ${i}`,
        metadata: { fulfillment_status: 'picked_up', fulfilled_at: '2026-09-28T00:00:00Z' },
      }),
    );
    fake = fakeStripe(url.searchParams.get('empty') ? [] : [...demoSessions(), ...extra]);
    res.end('ok');
    return;
  }
  if (path === '/__test/stripe-down' && req.method === 'POST') {
    fake = {
      ...fake,
      stripe: {
        checkout: {
          sessions: {
            list: async () => {
              throw Object.assign(new Error('down'), { type: 'StripeConnectionError' });
            },
          },
        },
        products: fake.stripe.products,
      } as never,
    };
    res.end('ok');
    return;
  }
  if (path === '/__test/metadata') {
    const id = new URL(req.url!, 'http://x').searchParams.get('id')!;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fake.sessions.get(id)?.metadata ?? null));
    return;
  }
  for (const [re, h] of ROUTES) {
    const m = re.exec(path);
    if (m) {
      await send(res, await h(await toRequest(req), deps(), { ...(m.groups || {}) }));
      return;
    }
  }
  vite.middlewares(req, res);
}).listen(PORT, () => console.log(`e2e server on http://localhost:${PORT}`));
