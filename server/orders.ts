// Stripe access for orders. Server-side only.

import Stripe from 'stripe';
import type { FulfillmentRequest, Order, OrdersPage } from '../shared/types';
import type { AuthedUser } from './auth';
import type { ServerConfig } from './env';
import { HttpError } from './http';
import { DASHBOARD_KEYS, normalizeSession, type DashboardKey } from './normalize';

export function stripeFor(config: ServerConfig): Stripe {
  if (!config.stripeSecretKey) {
    throw new HttpError(500, 'config_missing', 'STRIPE_SECRET_KEY is not set on the server.');
  }
  return new Stripe(config.stripeSecretKey, { maxNetworkRetries: 2, timeout: 8000 });
}

// Expansions that give us everything needed for an Order in one request per
// page: line items, the PaymentIntent + its charge (refunds/disputes), and the
// shipping rate the customer chose. (Stripe's expand depth limit is 4 — the
// product behind each line-item price would be 5 deep, so products are looked
// up separately and cached.)
const LIST_EXPAND = ['data.line_items', 'data.payment_intent', 'data.payment_intent.latest_charge', 'data.shipping_cost.shipping_rate'];
const ONE_EXPAND = ['line_items', 'payment_intent', 'payment_intent.latest_charge', 'shipping_cost.shipping_rate'];

// ---------- products (cached per warm function instance) ----------

let productCache: { at: number; byId: Map<string, Stripe.Product> } | null = null;
const PRODUCT_TTL_MS = 5 * 60 * 1000;

export async function loadProducts(stripe: Stripe, force = false): Promise<Map<string, Stripe.Product>> {
  if (!force && productCache && Date.now() - productCache.at < PRODUCT_TTL_MS) return productCache.byId;
  const byId = new Map<string, Stripe.Product>();
  // Active AND archived — an old order may reference a product that's since been archived.
  for await (const p of stripe.products.list({ limit: 100 })) byId.set(p.id, p);
  productCache = { at: Date.now(), byId };
  return byId;
}

export function _resetProductCache(): void {
  productCache = null;
}

async function withAllLineItems(stripe: Stripe, session: Stripe.Checkout.Session): Promise<Stripe.Checkout.Session> {
  // Expanded line_items is itself a list; page through the rest if Stripe truncated it.
  if (session.line_items?.has_more) {
    const all: Stripe.LineItem[] = [];
    for await (const li of stripe.checkout.sessions.listLineItems(session.id, { limit: 100 })) all.push(li);
    session.line_items = { ...session.line_items, data: all, has_more: false };
  }
  return session;
}

async function lookupFn(stripe: Stripe) {
  const products = await loadProducts(stripe);
  return (id: string) => products.get(id);
}

// ---------- reads ----------

export const MAX_PAGE = 100;

/**
 * One page of completed Checkout Sessions, newest first, using Stripe's own
 * cursor pagination (starting_after). The cursor we hand back is the last
 * Stripe session ID on this page — the client keeps asking until it's null.
 */
export async function listOrders(stripe: Stripe, opts: { cursor?: string | null; limit?: number }): Promise<OrdersPage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
  const page = await stripe.checkout.sessions.list({
    limit,
    status: 'complete',
    expand: LIST_EXPAND,
    ...(opts.cursor ? { starting_after: opts.cursor } : {}),
  });
  const lookup = await lookupFn(stripe);
  const sessions = await Promise.all(page.data.map((s) => withAllLineItems(stripe, s)));
  const orders = sessions.map((s) => normalizeSession(s, lookup));
  const last = page.data[page.data.length - 1];
  return { orders, nextCursor: page.has_more && last ? last.id : null };
}

export async function getSession(stripe: Stripe, sessionId: string): Promise<Stripe.Checkout.Session> {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    throw new HttpError(400, 'bad_id', 'That is not a valid order ID.');
  }
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ONE_EXPAND });
    return withAllLineItems(stripe, s);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, 'not_found', 'No order with that ID.');
    }
    throw err;
  }
}

export async function getOrder(stripe: Stripe, sessionId: string): Promise<Order> {
  const s = await getSession(stripe, sessionId);
  return normalizeSession(s, await lookupFn(stripe));
}

// ---------- fulfillment writes ----------

const MAX_FIELD = 120;

function cleanText(v: unknown, label: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'bad_input', `${label} must be text.`);
  const t = v.trim();
  if (t.length > MAX_FIELD) throw new HttpError(400, 'bad_input', `${label} is too long.`);
  return t;
}

/**
 * Build the metadata patch for an action. Only dashboard-owned keys are ever
 * written; Stripe merges metadata key-by-key, so the storefront's own keys
 * (productId, signed, …) are untouched. An empty string unsets a key.
 *
 * Transitions (the "→" side is the derived stage):
 *   waiting_for_pickup ─ mark_picked_up ─────────────→ picked_up
 *   waiting_for_pickup ─ change_to_shipping(paid?) ──→ shipping_unpaid | ready_to_ship
 *   shipping_unpaid ──── mark_shipping_paid ─────────→ ready_to_ship
 *   ready_to_ship ────── mark_shipped ───────────────→ shipped
 *   corrections: mark_waiting (undo completed), change_to_pickup, mark_shipping_unpaid
 */
export function buildPatch(
  order: Order,
  req: FulfillmentRequest,
  user: Pick<AuthedUser, 'email' | 'uid'>,
  now: Date,
): Partial<Record<DashboardKey, string>> {
  const f = order.fulfillment;
  const changed = 'This order was changed somewhere else. It has been refreshed — please check it and try again.';
  if (req.expectedStatus && req.expectedStatus !== f.status) throw new HttpError(409, 'conflict', changed);
  if (req.expectedMethod !== undefined && req.expectedMethod !== f.method) throw new HttpError(409, 'conflict', changed);
  if (req.expectedShippingPayment && req.expectedShippingPayment !== order.shippingPayment.status) throw new HttpError(409, 'conflict', changed);

  const iso = now.toISOString();
  const stamp = { fulfillment_updated_at: iso, fulfillment_updated_by: user.email || user.uid };
  const blockers = order.issues.filter((i) => ['payment_incomplete', 'payment_processing', 'session_not_complete'].includes(i.code));
  const requireWaiting = (what: string) => {
    if (f.status !== 'waiting') throw new HttpError(409, 'already_completed', `This order is already marked done. Undo that first to ${what}.`);
  };
  const requirePaidOrder = () => {
    if (blockers.length) throw new HttpError(409, 'payment_incomplete', blockers[0].message);
  };
  const checkoutShippingFree = order.checkout.shippingCharged === 0;

  switch (req.action) {
    case 'mark_picked_up': {
      requirePaidOrder();
      requireWaiting('change it');
      if (f.method !== 'pickup') throw new HttpError(409, 'wrong_method', 'This order is set to be shipped, not picked up.');
      return { fulfillment_status: 'completed', fulfillment_method: 'pickup', fulfilled_at: iso, carrier: '', tracking_number: '', ...stamp };
    }
    case 'mark_shipped': {
      requirePaidOrder();
      requireWaiting('change it');
      if (f.method !== 'shipping') throw new HttpError(409, 'wrong_method', 'This order is set for pickup. Change it to shipping first.');
      if (order.shippingPayment.status === 'unpaid') {
        throw new HttpError(409, 'shipping_unpaid', 'Shipping hasn’t been paid yet. Mark shipping paid first.');
      }
      return {
        fulfillment_status: 'completed',
        fulfillment_method: 'shipping',
        fulfilled_at: iso,
        carrier: cleanText(req.carrier, 'Carrier'),
        tracking_number: cleanText(req.trackingNumber, 'Tracking number'),
        ...stamp,
      };
    }
    case 'update_tracking': {
      if (f.status !== 'completed' || f.method !== 'shipping') throw new HttpError(409, 'not_shipped', 'Only shipped orders have tracking.');
      return { carrier: cleanText(req.carrier, 'Carrier'), tracking_number: cleanText(req.trackingNumber, 'Tracking number'), ...stamp };
    }
    case 'mark_waiting': {
      if (f.status !== 'completed') throw new HttpError(409, 'not_completed', 'This order isn’t marked done.');
      // Keep the method explicit so undoing never silently flips pickup/shipping.
      return { fulfillment_status: 'waiting', fulfillment_method: f.method ?? '', fulfilled_at: '', carrier: '', tracking_number: '', ...stamp };
    }
    case 'change_to_shipping': {
      requireWaiting('change how it’s delivered');
      if (f.method === 'shipping') throw new HttpError(409, 'already', 'This order is already set to ship.');
      const patch: Partial<Record<DashboardKey, string>> = { fulfillment_method: 'shipping', ...stamp };
      patch.method_changed_at = order.checkout.choice === 'shipping' ? '' : iso;
      if (!checkoutShippingFree) {
        // Stripe charged shipping at checkout — that charge covers it.
        patch.shipping_payment_status = '';
        patch.shipping_paid_at = '';
      } else if (order.checkout.choice === 'shipping') {
        patch.shipping_payment_status = req.shippingPaid === false ? 'unpaid' : '';
        patch.shipping_paid_at = '';
      } else {
        if (typeof req.shippingPaid !== 'boolean') {
          throw new HttpError(400, 'need_shipping_paid', 'Say whether the customer has already paid for shipping.');
        }
        patch.shipping_payment_status = req.shippingPaid ? 'paid' : 'unpaid';
        patch.shipping_paid_at = req.shippingPaid ? iso : '';
      }
      return patch;
    }
    case 'change_to_pickup': {
      requireWaiting('change how it’s delivered');
      if (f.method === 'pickup') throw new HttpError(409, 'already', 'This order is already set for pickup.');
      return {
        fulfillment_method: 'pickup',
        method_changed_at: order.checkout.choice === 'pickup' ? '' : iso,
        shipping_payment_status: '',
        shipping_paid_at: '',
        ...stamp,
      };
    }
    case 'mark_shipping_paid': {
      if (f.method !== 'shipping' || order.shippingPayment.status !== 'unpaid') {
        throw new HttpError(409, 'not_unpaid', 'Shipping isn’t marked unpaid.');
      }
      return { shipping_payment_status: 'paid', shipping_paid_at: iso, ...stamp };
    }
    case 'mark_shipping_unpaid': {
      requireWaiting('change the shipping payment');
      if (f.method !== 'shipping') throw new HttpError(409, 'wrong_method', 'This order isn’t set to ship.');
      if (order.shippingPayment.status === 'unpaid') throw new HttpError(409, 'already', 'Shipping is already marked unpaid.');
      if (order.shippingPayment.source === 'checkout') {
        throw new HttpError(409, 'shipping_paid_at_checkout', 'Stripe shows shipping was paid at checkout.');
      }
      return { shipping_payment_status: 'unpaid', shipping_paid_at: '', ...stamp };
    }
    case 'set_shipping_address': {
      const a = req.address;
      const keys = {
        ship_to_name: '',
        ship_to_line1: '',
        ship_to_line2: '',
        ship_to_city: '',
        ship_to_state: '',
        ship_to_postal_code: '',
        ship_to_country: '',
      };
      if (!a) return { ...keys, ...stamp };
      const line1 = cleanText(a.line1, 'Street address');
      const city = cleanText(a.city, 'City');
      const state = cleanText(a.state, 'State');
      const postal = cleanText(a.postalCode, 'ZIP code');
      if (!line1 || !city || !postal) throw new HttpError(400, 'bad_input', 'Street, city and ZIP code are needed.');
      return {
        ship_to_name: cleanText(a.name, 'Name'),
        ship_to_line1: line1,
        ship_to_line2: cleanText(a.line2, 'Address line 2'),
        ship_to_city: city,
        ship_to_state: state.toUpperCase(),
        ship_to_postal_code: postal,
        ship_to_country: (cleanText(a.country, 'Country') || 'US').toUpperCase(),
        ...stamp,
      };
    }
    // ---- "check with customer" ----
    case 'flag_customer_check': {
      return { customer_check: 'open', customer_check_note: cleanText(req.note, 'Note'), ...stamp };
    }
    case 'mark_customer_contacted': {
      return { customer_contacted_at: iso, ...stamp };
    }
    case 'resolve_customer_check': {
      return { customer_check: 'dismissed', customer_check_note: '', ...stamp };
    }
    default:
      throw new HttpError(400, 'bad_action', 'Unknown action.');
  }
}

export async function applyFulfillment(
  stripe: Stripe,
  sessionId: string,
  req: FulfillmentRequest,
  user: AuthedUser,
  now = new Date(),
): Promise<Order> {
  const session = await getSession(stripe, sessionId);
  const lookup = await lookupFn(stripe);
  const order = normalizeSession(session, lookup);
  const patch = buildPatch(order, req, user, now);

  // Guard: never send a key we don't own.
  for (const k of Object.keys(patch)) {
    if (!(DASHBOARD_KEYS as readonly string[]).includes(k)) throw new Error(`refusing to write metadata key ${k}`);
  }

  const piId = order.technical.paymentIntentId;
  let wroteSession = false;
  try {
    await stripe.checkout.sessions.update(sessionId, { metadata: patch });
    wroteSession = true;
  } catch (err) {
    // If Stripe ever refuses metadata updates on a finished session, fall
    // back to the PaymentIntent (always updatable) rather than losing the change.
    const e = err as { type?: string; message?: string };
    if (e.type !== 'StripeInvalidRequestError' || !piId) throw err;
    console.warn(`Session metadata update refused for ${sessionId} (${e.message}); writing to PaymentIntent instead.`);
  }

  if (piId) {
    try {
      await stripe.paymentIntents.update(piId, { metadata: patch });
    } catch (err) {
      // The mirror is best-effort when the session write succeeded.
      if (!wroteSession) throw err;
      console.warn(`PaymentIntent mirror update failed for ${piId}:`, (err as Error).message);
    }
  }

  return getOrder(stripe, sessionId);
}
