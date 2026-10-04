import { beforeEach, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import type { Order, OrdersPage } from '../../shared/types';
import { readConfig } from '../../server/env';
import { adminStatusHandler, fulfillmentHandler, meHandler, orderHandler, ordersHandler, type Deps } from '../../server/handlers';
import { _resetProductCache } from '../../server/orders';
import { fakeStripe } from '../fixtures/fakeStripe';
import { DALLAS, session } from '../fixtures/stripe';

const config = readConfig({
  STRIPE_SECRET_KEY: 'sk_test_fake',
  FIREBASE_PROJECT_ID: 'demo-project',
  DASHBOARD_USERS: 'paola@example.com, uid_helper',
  DASHBOARD_SUPERADMINS: 'mckevitt.r@gmail.com',
});

const TOKENS: Record<string, { uid: string; email?: string; email_verified?: boolean }> = {
  paola: { uid: 'u_paola', email: 'Paola@Example.com', email_verified: true },
  ryan: { uid: 'u_ryan', email: 'mckevitt.r@gmail.com', email_verified: true },
  helper: { uid: 'uid_helper', email: 'helper@example.com', email_verified: false },
  stranger: { uid: 'u_x', email: 'someone@example.com', email_verified: true },
  imposter: { uid: 'u_imp', email: 'paola@example.com', email_verified: false },
};

const verify = async (token: string) => {
  if (token === 'expired') throw Object.assign(new Error('expired'), { code: 'auth/id-token-expired' });
  const t = TOKENS[token];
  if (!t) throw Object.assign(new Error('bad'), { code: 'auth/argument-error' });
  return t as never;
};

let fake: ReturnType<typeof fakeStripe>;
let deps: Deps;

function seed(sessions: Stripe.Checkout.Session[], opts = {}) {
  fake = fakeStripe(sessions, opts);
  deps = { config, verify, stripe: () => fake.stripe };
}

const req = (path: string, token?: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const post = (id: string, token: string, body: unknown) =>
  fulfillmentHandler(req(`/api/orders/${id}/fulfillment`, token, { method: 'POST', body: JSON.stringify(body) }), deps, { sessionId: id });

beforeEach(() => {
  _resetProductCache();
  seed([
    session({ id: 'cs_test_pickup', created: 1000, signed: 'yes', inscription: 'Ana' }),
    session({ id: 'cs_test_ship', created: 2000, shippingRate: { name: 'Shipping', amount: 600 }, shippingAddress: DALLAS }),
    session({ id: 'cs_test_unpaid', created: 3000, paymentStatus: 'unpaid' }),
  ]);
});

describe('authentication & authorisation (server-side)', () => {
  it('rejects a request with no token and never touches Stripe', async () => {
    const res = await ordersHandler(req('/api/orders'), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('missing_token');
    expect(fake.calls).toEqual([]);
  });

  it('rejects an invalid token and never touches Stripe', async () => {
    const res = await ordersHandler(req('/api/orders', 'forged'), deps);
    expect(res.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it('reports an expired token distinctly', async () => {
    const res = await ordersHandler(req('/api/orders', 'expired'), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('token_expired');
  });

  it('a valid Firebase user who is not on the allowlist gets 403 and no data', async () => {
    const res = await ordersHandler(req('/api/orders', 'stranger'), deps);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('not_authorized');
    expect(fake.calls).toEqual([]);
  });

  it('an allowlisted email gets in without email verification', async () => {
    const res = await meHandler(req('/api/me', 'imposter'), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('user');
  });

  it('UID allowlist entries work too', async () => {
    const res = await meHandler(req('/api/me', 'helper'), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('user');
  });

  it('email match is case-insensitive; roles are reported', async () => {
    expect((await (await meHandler(req('/api/me', 'paola'), deps)).json()).role).toBe('user');
    expect((await (await meHandler(req('/api/me', 'ryan'), deps)).json()).role).toBe('superadmin');
  });

  it('superadmin-only endpoints refuse ordinary users', async () => {
    const res = await adminStatusHandler(req('/api/admin/status', 'paola'), deps);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('superadmin_only');
  });

  it('superadmin gets the setup status', async () => {
    const res = await adminStatusHandler(req('/api/admin/status', 'ryan'), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stripe).toMatchObject({ ok: true, mode: 'test', keyType: 'secret' });
    expect(body.allowlist.map((a: { value: string }) => a.value)).toContain('mckevitt.r@gmail.com');
  });

  it('responses are never cacheable', async () => {
    const res = await ordersHandler(req('/api/orders', 'paola'), deps);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('GET /api/orders', () => {
  it('returns normalized orders newest first — no raw Stripe objects', async () => {
    const res = await ordersHandler(req('/api/orders', 'paola'), deps);
    expect(res.status).toBe(200);
    const page = (await res.json()) as OrdersPage;
    expect(page.orders.map((o) => o.id)).toEqual(['cs_test_unpaid', 'cs_test_ship', 'cs_test_pickup']);
    expect(page.nextCursor).toBeNull();
    const raw = JSON.stringify(page);
    expect(raw).not.toContain('"object":"checkout.session"');
    expect(raw).not.toContain('payment_intent');
  });

  it('paginates with Stripe cursors, independent of how many orders exist', async () => {
    const many = Array.from({ length: 23 }, (_, i) => session({ id: `cs_test_p${String(i).padStart(2, '0')}`, created: 10000 + i }));
    seed([...many, session({ id: 'cs_test_open', created: 99999 })]);
    fake.sessions.get('cs_test_open')!.status = 'open'; // abandoned checkout — not an order

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await ordersHandler(req(`/api/orders?limit=5${cursor ? `&cursor=${cursor}` : ''}`, 'paola'), deps);
      const page = (await r.json()) as OrdersPage;
      seen.push(...page.orders.map((o) => o.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(pages).toBe(5);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(seen).not.toContain('cs_test_open');
    expect(seen[0]).toBe('cs_test_p22');
    const listCalls = fake.calls.filter((c) => c.method === 'sessions.list');
    expect((listCalls[1].args[0] as { starting_after: string }).starting_after).toBe(seen[4]);
  });

  it('rejects a junk cursor', async () => {
    const res = await ordersHandler(req('/api/orders?cursor=../../etc', 'paola'), deps);
    expect(res.status).toBe(400);
  });

  it('Stripe outage → 502 with a distinct code', async () => {
    deps = {
      ...deps,
      stripe: () =>
        ({
          checkout: {
            sessions: {
              list: async () => {
                throw Object.assign(new Error('down'), { type: 'StripeConnectionError' });
              },
            },
          },
          products: { list: () => ({ async *[Symbol.asyncIterator]() {} }) },
        }) as never,
    };
    const res = await ordersHandler(req('/api/orders', 'paola'), deps);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('stripe_unavailable');
  });
});

describe('GET /api/orders/:id', () => {
  it('returns one order', async () => {
    const res = await orderHandler(req('/api/orders/cs_test_pickup', 'paola'), deps, { sessionId: 'cs_test_pickup' });
    const o = (await res.json()) as Order;
    expect(o.inscriptionName).toBe('Ana');
  });
  it('404 for an unknown id, 400 for a malformed one', async () => {
    expect((await orderHandler(req('/x', 'paola'), deps, { sessionId: 'cs_test_nope' })).status).toBe(404);
    expect((await orderHandler(req('/x', 'paola'), deps, { sessionId: 'pi_123' })).status).toBe(400);
  });
});

describe('POST /api/orders/:id/fulfillment', () => {
  it('requires auth', async () => {
    const res = await fulfillmentHandler(req('/x', undefined, { method: 'POST', body: '{"action":"mark_picked_up"}' }), deps, {
      sessionId: 'cs_test_pickup',
    });
    expect(res.status).toBe(401);
    expect(fake.calls.filter((c) => c.method.endsWith('update'))).toEqual([]);
  });

  it('mark picked up → merges only dashboard keys, mirrors to the PaymentIntent', async () => {
    const res = await post('cs_test_pickup', 'paola', { action: 'mark_picked_up', expectedStatus: 'waiting' });
    expect(res.status).toBe(200);
    const o = (await res.json()) as Order;
    expect(o.stage).toBe('picked_up');
    expect(o.bucket).toBe('completed');
    expect(o.fulfillment.updatedBy).toBe('Paola@Example.com');

    const md = fake.sessions.get('cs_test_pickup')!.metadata!;
    expect(md.productId).toBe('prod_en_soft'); // storefront keys untouched
    expect(md.signed).toBe('yes');
    expect(md.fulfillment_status).toBe('completed');
    expect(md.fulfillment_method).toBe('pickup');
    expect(md.fulfilled_at).toMatch(/^\d{4}-\d\d-\d\dT/);

    const pi = fake.sessions.get('cs_test_pickup')!.payment_intent as Stripe.PaymentIntent;
    expect(pi.metadata.fulfillment_status).toBe('completed');

    const sent = fake.calls.find((c) => c.method === 'sessions.update')!.args[1] as { metadata: Record<string, string> };
    expect(Object.keys(sent.metadata).every((k) => k.startsWith('fulfill') || ['carrier', 'tracking_number'].includes(k))).toBe(true);
  });

  it('undo picked up → back to waiting for pickup, timestamp cleared', async () => {
    await post('cs_test_pickup', 'paola', { action: 'mark_picked_up' });
    const res = await post('cs_test_pickup', 'paola', { action: 'mark_waiting', expectedStatus: 'completed' });
    const o = (await res.json()) as Order;
    expect(o.stage).toBe('waiting_for_pickup');
    expect(o.fulfillment.completedAt).toBeNull();
    expect(fake.sessions.get('cs_test_pickup')!.metadata!.fulfilled_at).toBeUndefined();
  });

  it('mark shipped with carrier + tracking, then undo', async () => {
    let o = (await (
      await post('cs_test_ship', 'paola', { action: 'mark_shipped', carrier: 'USPS', trackingNumber: ' 9400 1000 ' })
    ).json()) as Order;
    expect(o.stage).toBe('shipped');
    expect(o.fulfillment.carrier).toBe('USPS');
    expect(o.fulfillment.trackingNumber).toBe('9400 1000');

    o = (await (
      await post('cs_test_ship', 'paola', { action: 'update_tracking', carrier: 'UPS', trackingNumber: '1Z999' })
    ).json()) as Order;
    expect(o.fulfillment.trackingNumber).toBe('1Z999');
    expect(o.stage).toBe('shipped');

    o = (await (await post('cs_test_ship', 'paola', { action: 'mark_waiting' })).json()) as Order;
    expect(o.stage).toBe('ready_to_ship');
    expect(o.fulfillment.trackingNumber).toBeNull();
  });

  it('mark shipped without tracking is fine', async () => {
    const o = (await (await post('cs_test_ship', 'paola', { action: 'mark_shipped' })).json()) as Order;
    expect(o.stage).toBe('shipped');
    expect(o.fulfillment.trackingNumber).toBeNull();
  });

  it('refuses the wrong action for the order type', async () => {
    const r1 = await post('cs_test_pickup', 'paola', { action: 'mark_shipped' });
    expect(r1.status).toBe(409);
    expect((await r1.json()).code).toBe('wrong_method');
    const r2 = await post('cs_test_ship', 'paola', { action: 'mark_picked_up' });
    expect(r2.status).toBe(409);
  });

  it('refuses to complete an unpaid order', async () => {
    const res = await post('cs_test_unpaid', 'paola', { action: 'mark_picked_up' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('payment_incomplete');
  });

  it('detects concurrent edits', async () => {
    await post('cs_test_pickup', 'ryan', { action: 'mark_picked_up' });
    const res = await post('cs_test_pickup', 'paola', { action: 'mark_picked_up', expectedStatus: 'waiting' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('conflict');
  });

  it('falls back to PaymentIntent metadata if Stripe refuses the session update', async () => {
    seed([session({ id: 'cs_test_pickup', created: 1 })], { refuseSessionUpdate: true });
    const o = (await (await post('cs_test_pickup', 'paola', { action: 'mark_picked_up' })).json()) as Order;
    expect(o.stage).toBe('picked_up');
    expect(fake.sessions.get('cs_test_pickup')!.metadata!.fulfillment_status).toBeUndefined();
  });

  it('an ambiguous legacy order gets decided by a person (pickup or shipping)', async () => {
    seed([session({ id: 'cs_test_amb', created: 1, collectsAddress: true, shippingAddress: DALLAS })]);
    let o = (await (await post('cs_test_amb', 'paola', { action: 'change_to_pickup' })).json()) as Order;
    expect(o.fulfillment.method).toBe('pickup');
    expect(o.checkout.choice).toBe('unknown');
    expect(o.stage).toBe('waiting_for_pickup');
    o = (await (await post('cs_test_amb', 'paola', { action: 'change_to_shipping', shippingPaid: true })).json()) as Order;
    expect(o.stage).toBe('ready_to_ship');
    o = (await (await post('cs_test_amb', 'paola', { action: 'mark_shipped' })).json()) as Order;
    expect(o.stage).toBe('shipped');
  });

  it('validates input', async () => {
    expect((await post('cs_test_ship', 'paola', { action: 'mark_shipped', trackingNumber: 'x'.repeat(500) })).status).toBe(400);
    expect((await post('cs_test_ship', 'paola', { action: 'nuke' })).status).toBe(400);
    const bad = await fulfillmentHandler(req('/x', 'paola', { method: 'POST', body: 'not json' }), deps, { sessionId: 'cs_test_ship' });
    expect(bad.status).toBe(400);
  });

  it('rejects GET', async () => {
    const res = await fulfillmentHandler(req('/x', 'paola'), deps, { sessionId: 'cs_test_ship' });
    expect(res.status).toBe(405);
  });
});

describe('Stripe error reporting', () => {
  it('redacts keys and distinguishes a permission problem from an outage', async () => {
    const { errorResponse } = await import('../../server/http');
    const r = errorResponse(
      Object.assign(new Error("The provided key 'rk_live_****abcd' does not have access to checkout sessions"), { type: 'StripePermissionError' }),
    );
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.code).toBe('stripe_permission');
    expect(body.error).not.toContain('rk_live');
  });
});

describe('pickup ⇄ shipping and shipping payment (operational state)', () => {
  beforeEach(() => {
    seed([
      session({ id: 'cs_test_event', created: 1, billingAddress: DALLAS }), // event pickup, no shipping offered
      session({ id: 'cs_test_free', created: 2, shippingRate: { name: 'Free shipping', amount: 0 }, shippingAddress: DALLAS }),
      session({ id: 'cs_test_paidship', created: 3, shippingRate: { name: 'Shipping', amount: 600 }, shippingAddress: DALLAS }),
    ]);
  });
  const ADDR = { name: 'Ann Lee', line1: '9 Elm St', city: 'Austin', state: 'tx', postalCode: '78701' };
  const md = (id: string) => fake.sessions.get(id)!.metadata!;

  it('the full converted flow: waiting for pickup → shipping unpaid → ready to ship → shipped', async () => {
    let o = (await (await post('cs_test_event', 'paola', { action: 'change_to_shipping', shippingPaid: false, expectedMethod: 'pickup' })).json()) as Order;
    expect(o.stage).toBe('shipping_unpaid');
    expect(o.checkout.choice).toBe('pickup'); // Stripe's record untouched
    expect(o.fulfillment.method).toBe('shipping');
    expect(o.fulfillment.changedFromCheckout).toBe(true);
    expect(md('cs_test_event')).toMatchObject({ fulfillment_method: 'shipping', shipping_payment_status: 'unpaid', productId: 'prod_en_soft' });
    expect(md('cs_test_event').method_changed_at).toMatch(/^\d{4}-/);

    // Can't ship until shipping is paid.
    expect((await post('cs_test_event', 'paola', { action: 'mark_shipped' })).status).toBe(409);

    o = (await (await post('cs_test_event', 'paola', { action: 'mark_shipping_paid', expectedShippingPayment: 'unpaid' })).json()) as Order;
    expect(o.shippingPayment).toMatchObject({ status: 'paid', source: 'dashboard' });
    // No address yet (the card billing address is NOT used) → ask the customer.
    expect(o.fulfillment.address).toBeNull();
    expect(o.stage).toBe('check_customer');

    o = (await (await post('cs_test_event', 'paola', { action: 'set_shipping_address', address: ADDR })).json()) as Order;
    expect(o.stage).toBe('ready_to_ship');
    expect(o.fulfillment).toMatchObject({ addressSource: 'dashboard', checkoutAddress: null });
    expect(o.fulfillment.address).toMatchObject({ line1: '9 Elm St', state: 'TX', country: 'US' });

    o = (await (await post('cs_test_event', 'paola', { action: 'mark_shipped', carrier: 'USPS' })).json()) as Order;
    expect(o.stage).toBe('shipped');
    expect(o.checkout.choice).toBe('pickup');
    expect(md('cs_test_event')).toMatchObject({ fulfillment_status: 'completed', fulfillment_method: 'shipping', shipping_payment_status: 'paid' });
  });

  it('pickup → shipping already paid → straight to ready to ship', async () => {
    await post('cs_test_event', 'paola', { action: 'set_shipping_address', address: ADDR });
    const o = (await (await post('cs_test_event', 'paola', { action: 'change_to_shipping', shippingPaid: true })).json()) as Order;
    expect(o.stage).toBe('ready_to_ship');
    expect(md('cs_test_event').shipping_paid_at).toMatch(/^\d{4}-/);
  });

  it('must say whether shipping is paid when converting a pickup', async () => {
    const r = await post('cs_test_event', 'paola', { action: 'change_to_shipping' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('need_shipping_paid');
  });

  it('change back to pickup clears the shipping-payment record and restores checkout state', async () => {
    await post('cs_test_event', 'paola', { action: 'change_to_shipping', shippingPaid: false });
    const o = (await (await post('cs_test_event', 'paola', { action: 'change_to_pickup' })).json()) as Order;
    expect(o.stage).toBe('waiting_for_pickup');
    expect(o.fulfillment.changedFromCheckout).toBe(false);
    expect(o.shippingPayment.status).toBe('not_applicable');
    expect(md('cs_test_event').shipping_payment_status).toBeUndefined();
    expect(md('cs_test_event').method_changed_at).toBeUndefined();
  });

  it('a shipping order (paid at checkout) can become pickup and back without asking about payment', async () => {
    let o = (await (await post('cs_test_paidship', 'paola', { action: 'change_to_pickup' })).json()) as Order;
    expect(o.stage).toBe('waiting_for_pickup');
    expect(o.fulfillment.changedFromCheckout).toBe(true);
    o = (await (await post('cs_test_paidship', 'paola', { action: 'change_to_shipping' })).json()) as Order;
    expect(o.stage).toBe('ready_to_ship');
    expect(o.shippingPayment).toMatchObject({ status: 'paid', source: 'checkout' });
    expect(o.fulfillment.changedFromCheckout).toBe(false);
  });

  it('mark shipping unpaid is a correction for free/recorded shipping, never for Stripe-paid shipping', async () => {
    let o = (await (await post('cs_test_free', 'paola', { action: 'mark_shipping_unpaid' })).json()) as Order;
    expect(o.stage).toBe('shipping_unpaid');
    o = (await (await post('cs_test_free', 'paola', { action: 'mark_shipping_paid' })).json()) as Order;
    expect(o.stage).toBe('ready_to_ship');
    const r = await post('cs_test_paidship', 'paola', { action: 'mark_shipping_unpaid' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('shipping_paid_at_checkout');
  });

  it('refuses transitions that make no sense', async () => {
    expect((await post('cs_test_free', 'paola', { action: 'mark_shipping_paid' })).status).toBe(409); // nothing owed
    expect((await post('cs_test_event', 'paola', { action: 'change_to_pickup' })).status).toBe(409); // already pickup
    expect((await post('cs_test_free', 'paola', { action: 'change_to_shipping' })).status).toBe(409); // already shipping
    await post('cs_test_event', 'paola', { action: 'mark_picked_up' });
    expect((await post('cs_test_event', 'paola', { action: 'change_to_shipping', shippingPaid: true })).status).toBe(409); // done
    expect((await post('cs_test_event', 'paola', { action: 'mark_waiting' })).status).toBe(200); // undo works
  });

  it('address input is validated, and can be cleared', async () => {
    expect((await post('cs_test_event', 'paola', { action: 'set_shipping_address', address: { line1: '', city: 'x', state: 'TX', postalCode: '1' } })).status).toBe(400);
    await post('cs_test_event', 'paola', { action: 'set_shipping_address', address: ADDR });
    await post('cs_test_event', 'paola', { action: 'set_shipping_address', address: null });
    expect(md('cs_test_event').ship_to_line1).toBeUndefined();
  });

  it('detects concurrent edits on method and shipping payment', async () => {
    await post('cs_test_event', 'ryan', { action: 'change_to_shipping', shippingPaid: false });
    let r = await post('cs_test_event', 'paola', { action: 'change_to_shipping', shippingPaid: true, expectedMethod: 'pickup' });
    expect(r.status).toBe(409);
    r = await post('cs_test_event', 'paola', { action: 'mark_shipping_paid', expectedShippingPayment: 'paid' });
    expect(r.status).toBe(409);
  });
});

describe('check-with-customer actions', () => {
  beforeEach(() => {
    seed([session({ id: 'cs_test_far', created: 1, billingAddress: { line1: '1 Main', city: 'Austin', state: 'CA', postal_code: '90001' } })]);
  });

  it('record contact, then mark sorted; the order goes back to a plain pickup', async () => {
    let o = (await (await post('cs_test_far', 'paola', { action: 'mark_customer_contacted' })).json()) as Order;
    expect(o.stage).toBe('check_customer');
    expect(o.customerCheck.contactedAt).toMatch(/^\d{4}-/);
    o = (await (await post('cs_test_far', 'paola', { action: 'resolve_customer_check' })).json()) as Order;
    expect(o.stage).toBe('waiting_for_pickup');
    const md = fake.sessions.get('cs_test_far')!.metadata!;
    expect(md.customer_check).toBe('dismissed');
    expect(md.productId).toBe('prod_en_soft');
  });

  it('flag by hand with a note; it does not block handing the book over', async () => {
    let o = (await (await post('cs_test_far', 'paola', { action: 'flag_customer_check', note: 'asked to mail it?' })).json()) as Order;
    expect(o.customerCheck).toMatchObject({ manual: true, note: 'asked to mail it?' });
    o = (await (await post('cs_test_far', 'paola', { action: 'mark_picked_up' })).json()) as Order;
    expect(o.stage).toBe('picked_up');
  });
});
