// Stripe Checkout Session  →  application-level Order.
//
// Pure functions only (no network), so every classification rule here is
// unit-tested against fixture sessions. Classification is driven by what
// Stripe actually recorded — line items, the chosen shipping rate, shipping
// details, metadata — never by amounts ("$27.05 means paperback").

import type Stripe from 'stripe';
import type {
  Address,
  BookFormat,
  CheckoutChoice,
  FulfillmentMethod,
  FulfillmentStatus,
  Issue,
  IssueCode,
  Language,
  MethodSource,
  Order,
  OrderItem,
  PaymentState,
  RefundState,
  ShippingPayment,
  ShippingPaymentSource,
  Stage,
} from '../shared/types';

/** Metadata keys this dashboard owns. Everything else on the session is left alone. */
export const DASHBOARD_KEYS = [
  'fulfillment_status', // waiting | completed   (legacy: pending | shipped | picked_up)
  'fulfillment_method', // pickup | shipping — current method; absent = as chosen at checkout
  'fulfilled_at',
  'carrier',
  'tracking_number',
  'fulfillment_updated_at',
  'fulfillment_updated_by',
  // Shipping payment — a separate concept from fulfillment status.
  'shipping_payment_status', // unpaid | paid  (set by hand only)
  'shipping_paid_at',
  'method_changed_at',
  // Mailing address entered in the dashboard (Stripe's checkout address is never changed).
  'ship_to_name',
  'ship_to_line1',
  'ship_to_line2',
  'ship_to_city',
  'ship_to_state',
  'ship_to_postal_code',
  'ship_to_country',
  // "Check with customer" — likely customer mix-ups, not problems.
  'customer_check', // open (flagged by hand) | dismissed (sorted)
  'customer_check_note',
  'customer_contacted_at',
] as const;
export type DashboardKey = (typeof DASHBOARD_KEYS)[number];

const PICKUP_RE = /pick\s*-?\s*up|recog(er|ida)|in[-\s]?person|en persona|at the event|en el evento/i;
const SHIPPING_NAME_RE = /\bshipping\b|\bpostage\b|\benv[ií]o\b/i;

export type ProductLookup = (id: string) => Stripe.Product | undefined;

// ---------- small helpers ----------

function idOf(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === 'string' ? x : x.id;
}

function obj<T extends { id: string }>(x: string | T | null | undefined): T | null {
  return x && typeof x === 'object' ? x : null;
}

export function parseLanguage(raw: string | null | undefined): Language | null {
  const v = (raw || '').trim().toLowerCase();
  if (['en', 'eng', 'english', 'inglés', 'ingles'].includes(v)) return 'en';
  if (['es', 'spa', 'spanish', 'español', 'espanol'].includes(v)) return 'es';
  return null;
}

export function parseFormat(raw: string | null | undefined): BookFormat | null {
  const v = (raw || '').trim().toLowerCase();
  if (['hardcover', 'hardback', 'hard cover', 'tapa dura'].includes(v)) return 'hardcover';
  if (['softcover', 'paperback', 'soft cover', 'paper', 'tapa blanda'].includes(v)) return 'paperback';
  return null;
}

function languageFromName(name: string): Language | null {
  if (/espa[ñn]ol|spanish/i.test(name)) return 'es';
  if (/english|ingl[eé]s/i.test(name)) return 'en';
  return null;
}

function formatFromName(name: string): BookFormat | null {
  if (/hard\s*cover|hardback|tapa dura/i.test(name)) return 'hardcover';
  if (/soft\s*cover|paperback|tapa blanda/i.test(name)) return 'paperback';
  return null;
}

function toAddress(name: string | null | undefined, a: Stripe.Address | null | undefined): Address | null {
  if (!a) return null;
  const out: Address = {
    name: name || null,
    line1: a.line1 || null,
    line2: a.line2 || null,
    city: a.city || null,
    state: a.state || null,
    postalCode: a.postal_code || null,
    country: a.country || null,
  };
  return out.line1 || out.city || out.postalCode ? out : null;
}

/**
 * A gentle hint only (never a classification): is the card's billing address
 * clearly outside Texas? Uses the state if Stripe has it, otherwise the US ZIP
 * (Texas ZIPs are 750xx–799xx and 885xx). Returns a short place name, or null
 * when it's in Texas or there isn't enough to tell.
 */
export function outOfAreaBilling(a: Address | null): string | null {
  if (!a) return null;
  if (a.country && a.country !== 'US') return a.country;
  if (a.state) return a.state.toUpperCase() === 'TX' ? null : a.state.toUpperCase();
  const zip = (a.postalCode || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  const n = Number(zip.slice(0, 3));
  const texas = (n >= 750 && n <= 799) || n === 885;
  return texas ? null : `ZIP ${zip}`;
}

export function addressIsComplete(a: Address | null): boolean {
  if (!a) return false;
  if (!a.line1 || !a.city || !a.postalCode) return false;
  if ((a.country || 'US') === 'US' && !a.state) return false;
  return true;
}

function money(n: number | null | undefined): number {
  return typeof n === 'number' ? n : 0;
}

// ---------- line items ----------

export function normalizeItem(li: Stripe.LineItem, lookup: ProductLookup): OrderItem & { unclassified: boolean } {
  const price = li.price;
  const productId = idOf(price?.product as string | Stripe.Product | null | undefined);
  const product = obj(price?.product as Stripe.Product | string | null | undefined) ?? (productId ? lookup(productId) : undefined) ?? null;
  const meta: Record<string, string> = { ...(price?.metadata || {}), ...(product?.metadata || {}) };
  const name = product?.name || li.description || '';

  const declaredKind = (meta.kind || meta.type || meta.item_type || '').toLowerCase();
  const isShipping = declaredKind === 'shipping' || (declaredKind !== 'book' && !meta.lang && !meta.format && SHIPPING_NAME_RE.test(name));

  const language = isShipping ? null : (parseLanguage(meta.lang || meta.language) ?? languageFromName(name));
  const format = isShipping ? null : (parseFormat(meta.format) ?? formatFromName(name));

  return {
    kind: isShipping ? 'shipping' : 'book',
    description: li.description || name,
    productId,
    productName: product?.name ?? null,
    priceId: price?.id ?? null,
    language,
    format,
    quantity: li.quantity ?? 1,
    amountTotal: li.amount_total ?? 0,
    unclassified: !isShipping && (!language || !format),
  };
}

// ---------- fulfillment method ----------

interface MethodResult {
  method: CheckoutChoice;
  source: MethodSource;
  signals: string[];
  rateName: string | null;
  rateId: string | null;
}

function fmtCents(n: number, currency: string): string {
  return `${(n / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export function deriveMethod(session: Stripe.Checkout.Session, items: OrderItem[], address: Address | null): MethodResult {
  const signals: string[] = [];
  const votes: { method: 'pickup' | 'shipping'; source: MethodSource }[] = [];
  const currency = session.currency || 'usd';

  // 1. The shipping rate the customer chose at checkout — the most direct record of what they bought.
  let rateName: string | null = null;
  let rateId: string | null = null;
  if (session.shipping_cost) {
    const rate = obj(session.shipping_cost.shipping_rate as Stripe.ShippingRate | string | null);
    rateId = idOf(session.shipping_cost.shipping_rate as string | Stripe.ShippingRate | null);
    rateName = rate?.display_name ?? null;
    const declared = (rate?.metadata?.fulfillment_method || rate?.metadata?.method || '').toLowerCase();
    let m: 'pickup' | 'shipping';
    if (declared === 'pickup' || declared === 'shipping') m = declared;
    else if (rateName && PICKUP_RE.test(rateName)) m = 'pickup';
    else m = 'shipping';
    votes.push({ method: m, source: 'shipping_rate' });
    signals.push(
      `Shipping option chosen at checkout: "${rateName ?? rateId ?? 'unnamed'}" (${fmtCents(session.shipping_cost.amount_total, currency)}) → ${m}`,
    );
  }

  // 2. Shipping sold as its own line item.
  const shipItems = items.filter((i) => i.kind === 'shipping');
  if (shipItems.length) {
    votes.push({ method: 'shipping', source: 'shipping_line_item' });
    signals.push(`Line item "${shipItems[0].description}" is a shipping charge → shipping`);
  }

  // 3. Metadata the storefront set when it created the session (storefront-owned keys only).
  const md = session.metadata || {};
  const declared = (md.shipping ?? md.delivery ?? md.fulfillment ?? '').toString().trim().toLowerCase();
  if (declared) {
    const m = ['yes', 'true', 'ship', 'shipping', '1'].includes(declared)
      ? 'shipping'
      : ['no', 'false', 'pickup', 'pick_up', 'in_person', '0'].includes(declared)
        ? 'pickup'
        : null;
    if (m) {
      votes.push({ method: m, source: 'session_metadata' });
      signals.push(`Storefront metadata says "${declared}" → ${m}`);
    } else {
      signals.push(`Storefront metadata has an unrecognised shipping value "${declared}"`);
    }
  }

  const distinct = [...new Set(votes.map((v) => v.method))];
  if (distinct.length === 1) {
    return { method: distinct[0], source: votes[0].source, signals, rateName, rateId };
  }
  if (distinct.length > 1) {
    signals.push('These signals disagree — needs a human decision.');
    return { method: 'unknown', source: 'conflict', signals, rateName, rateId };
  }

  // No positive signal either way.
  const collectedAddress = Boolean(session.shipping_address_collection);
  if (collectedAddress || address) {
    signals.push(
      collectedAddress
        ? 'Checkout asked for a shipping address but no shipping option or charge was recorded'
        : 'A shipping address is on file but no shipping option or charge was recorded',
    );
    signals.push('Cannot tell pickup from shipping — needs a human decision.');
    return { method: 'unknown', source: 'unknown', signals, rateName, rateId };
  }

  signals.push('Checkout offered no shipping: no shipping option, no shipping charge, no address requested → pickup');
  return { method: 'pickup', source: 'no_shipping_offered', signals, rateName, rateId };
}

// ---------- dashboard-owned fulfillment state ----------

export interface StoredFulfillment {
  values: Partial<Record<DashboardKey, string>>;
  store: 'session' | 'payment_intent' | null;
}

function pickDashboardKeys(md: Record<string, string> | null | undefined): Partial<Record<DashboardKey, string>> {
  const out: Partial<Record<DashboardKey, string>> = {};
  for (const k of DASHBOARD_KEYS) {
    const v = md?.[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/**
 * The session's metadata is the primary store. The PaymentIntent copy is a
 * mirror (visible on the Stripe payment page) and a fallback if a session
 * update is ever refused. Whichever was written most recently wins.
 */
export function readStoredFulfillment(session: Stripe.Checkout.Session): StoredFulfillment {
  const s = pickDashboardKeys(session.metadata);
  const pi = obj(session.payment_intent as Stripe.PaymentIntent | string | null);
  const p = pickDashboardKeys(pi?.metadata);
  const hasS = Object.keys(s).length > 0;
  const hasP = Object.keys(p).length > 0;
  if (!hasS && !hasP) return { values: {}, store: null };
  if (hasS && !hasP) return { values: s, store: 'session' };
  if (!hasS && hasP) return { values: p, store: 'payment_intent' };
  return (p.fulfillment_updated_at || '') > (s.fulfillment_updated_at || '')
    ? { values: p, store: 'payment_intent' }
    : { values: s, store: 'session' };
}

// ---------- the whole order ----------

export function normalizeSession(session: Stripe.Checkout.Session, lookup: ProductLookup): Order {
  const issues: Issue[] = [];
  const currency = session.currency || 'usd';

  // Items
  const rawItems = session.line_items?.data ?? null;
  const normalizedItems = (rawItems ?? []).map((li) => normalizeItem(li, lookup));
  const items: OrderItem[] = normalizedItems.map(({ unclassified: _u, ...rest }) => rest);
  const books = items.filter((i) => i.kind === 'book');
  if (!rawItems || books.length === 0) {
    issues.push({
      code: 'no_line_items',
      severity: 'problem',
      message: rawItems ? 'No book in this order — check what was bought.' : 'Could not read what was bought.',
    });
  }
  if (normalizedItems.some((i) => i.unclassified)) {
    issues.push({
      code: 'unknown_product',
      severity: 'warning',
      message: 'Edition or format is not tagged on the Stripe product.',
    });
  }
  const distinctBooks = new Set(books.map((b) => b.productId ?? b.description));
  const same = <K extends 'language' | 'format'>(k: K) => (books.length && books.every((b) => b[k] === books[0][k]) ? books[0][k] : null);

  // Addresses
  const sd =
    (
      session as Stripe.Checkout.Session & {
        collected_information?: { shipping_details?: { name?: string; address?: Stripe.Address } | null } | null;
      }
    ).collected_information?.shipping_details ??
    session.shipping_details ??
    null;
  const address = toAddress(sd?.name, sd?.address);
  const billingAddress = toAddress(session.customer_details?.name, session.customer_details?.address);

  // ---- What happened at checkout (Stripe's record; never rewritten) ----
  const checkout = deriveMethod(session, items, address);
  const stored = readStoredFulfillment(session);
  const v = stored.values;
  const shippingCharged =
    money(session.total_details?.amount_shipping) + items.filter((i) => i.kind === 'shipping').reduce((n, i) => n + i.amountTotal, 0);

  // ---- Paola's operational state (dashboard metadata) ----
  const enteredAddress: Address | null = v.ship_to_line1
    ? {
        name: v.ship_to_name || null,
        line1: v.ship_to_line1,
        line2: v.ship_to_line2 || null,
        city: v.ship_to_city || null,
        state: v.ship_to_state || null,
        postalCode: v.ship_to_postal_code || null,
        country: v.ship_to_country || 'US',
      }
    : null;
  const shipTo = enteredAddress ?? address;
  const badValue = (field: string, value: string) =>
    issues.push({ code: 'invalid_fulfillment_metadata', severity: 'problem', message: `Unrecognised ${field} "${value}" in Stripe metadata.` });

  // Fulfillment status. Legacy values from earlier dashboard versions are still read.
  const rawStatus = v.fulfillment_status;
  let status: FulfillmentStatus = 'waiting';
  let legacyImpliedMethod: FulfillmentMethod | null = null;
  if (rawStatus === 'completed') status = 'completed';
  else if (rawStatus === 'waiting' || rawStatus === 'pending') status = 'waiting';
  else if (rawStatus === 'shipped' || rawStatus === 'picked_up') {
    status = 'completed';
    legacyImpliedMethod = rawStatus === 'shipped' ? 'shipping' : 'pickup';
  } else if (rawStatus) badValue('fulfillment status', rawStatus);

  // Current method: what Paola set, else what checkout said.
  const rawMethod = v.fulfillment_method;
  const rawShipPay = v.shipping_payment_status;
  let method: FulfillmentMethod | null = checkout.method === 'unknown' ? null : checkout.method;
  if (rawMethod === 'pickup' || rawMethod === 'shipping') method = rawMethod;
  else if (rawMethod) badValue('fulfillment method', rawMethod);
  else if (legacyImpliedMethod) method = legacyImpliedMethod;
  else if (rawShipPay === 'unpaid' || rawShipPay === 'paid') method = 'shipping'; // older dashboard: the flag alone meant "ships"
  const changedFromCheckout = method !== null && checkout.method !== 'unknown' && method !== checkout.method;
  if (changedFromCheckout) {
    checkout.signals.push(`Changed in the dashboard after checkout → ${method}${v.method_changed_at ? ` (${v.method_changed_at})` : ''}`);
  } else if (method && checkout.method === 'unknown') {
    checkout.signals.push(`Decided in the dashboard → ${method}`);
  }

  // Shipping payment — never inferred "unpaid" from a missing charge.
  let shippingPayment: ShippingPayment = 'not_applicable';
  let shippingPaymentSource: ShippingPaymentSource = 'none';
  if (rawShipPay && rawShipPay !== 'unpaid' && rawShipPay !== 'paid') badValue('shipping payment status', rawShipPay);
  if (method === 'shipping') {
    if (rawShipPay === 'unpaid' || rawShipPay === 'paid') {
      shippingPayment = rawShipPay;
      shippingPaymentSource = 'dashboard';
    } else if (shippingCharged > 0) {
      shippingPayment = 'paid';
      shippingPaymentSource = 'checkout';
    }
  }

  // ---- "Check with customer": customer-side questions, not problems ----
  const rawCheck = v.customer_check;
  const checkDismissed = rawCheck === 'dismissed';
  const checkManual = rawCheck === 'open';
  const checkNote = v.customer_check_note || null;
  const autoCheck = (code: IssueCode, message: string) => {
    if (!checkDismissed) issues.push({ code, severity: 'check', message });
  };
  if (method === null) {
    // Can't be dismissed — someone has to pick pickup or shipping.
    issues.push({
      code: 'unknown_method',
      severity: 'check',
      message: 'The order doesn’t say whether they’re picking up or want it mailed. Ask them, then choose below.',
    });
  }
  if (method === 'shipping' && status === 'waiting') {
    if (!shipTo) autoCheck('missing_address', 'No mailing address yet. Ask the customer where to send it, then add it here.');
    else if (!addressIsComplete(shipTo)) autoCheck('incomplete_address', 'Their mailing address looks incomplete. Worth double-checking.');
  }
  // Hints about pickup only make sense while nobody has deliberately chosen pickup in the dashboard.
  const methodChosenByHand = rawMethod === 'pickup' || rawMethod === 'shipping';
  if (method === 'pickup' && status === 'waiting' && !methodChosenByHand) {
    if (address) {
      autoCheck('address_without_shipping', 'They chose pickup but also gave a mailing address. They may have expected it mailed.');
    } else {
      const where = outOfAreaBilling(billingAddress);
      if (where) {
        autoCheck(
          'pickup_far_away',
          `They chose pickup, but their card’s billing address is in ${where}. They may have expected it to be mailed.`,
        );
      }
    }
  }
  if (checkManual) {
    issues.push({
      code: 'customer_check',
      severity: 'check',
      message: checkNote ? `You flagged this to check with the customer: “${checkNote}”` : 'You flagged this to check with the customer.',
    });
  }

  // Payment
  const pi = obj(session.payment_intent as Stripe.PaymentIntent | string | null);
  const charge = obj(pi?.latest_charge as Stripe.Charge | string | null | undefined);
  let paymentState: PaymentState;
  if (session.payment_status === 'paid') paymentState = 'paid';
  else if (session.payment_status === 'no_payment_required') paymentState = 'no_payment_required';
  else paymentState = pi?.status === 'processing' ? 'processing' : 'unpaid';

  if (session.status && session.status !== 'complete') {
    issues.push({ code: 'session_not_complete', severity: 'problem', message: 'Checkout was never finished.' });
  }
  if (paymentState === 'unpaid') {
    issues.push({
      code: 'payment_incomplete',
      severity: 'problem',
      message: 'Payment did not go through. Do not hand over or ship.',
    });
  } else if (paymentState === 'processing') {
    issues.push({
      code: 'payment_processing',
      severity: 'problem',
      message: 'Payment is still processing. Wait before handing over or shipping.',
    });
  }

  const refunded = money(charge?.amount_refunded);
  const total = money(session.amount_total);
  let refund: RefundState = 'none';
  if (charge?.refunded || (refunded > 0 && refunded >= (charge?.amount ?? total))) refund = 'full';
  else if (refunded > 0) refund = 'partial';
  if (refund === 'partial') {
    issues.push({ code: 'partial_refund', severity: 'warning', message: 'Part of this payment was refunded.' });
  }
  const disputed = Boolean(charge?.disputed);
  if (disputed) {
    issues.push({ code: 'disputed', severity: 'problem', message: 'The customer disputed this payment with their bank.' });
  }

  // Signed copy
  const customFields = (session.custom_fields || []).map((f) => ({
    key: f.key,
    value: f.text?.value ?? f.numeric?.value ?? f.dropdown?.value ?? null,
  }));
  const inscriptionName = customFields.find((f) => f.key === 'inscription_name')?.value?.trim() || null;
  const signedRaw = (session.metadata?.signed || '').toLowerCase();
  let signed: boolean | null = ['yes', 'true', '1'].includes(signedRaw) ? true : ['no', 'false', '0'].includes(signedRaw) ? false : null;
  if (signed === null && inscriptionName) signed = true;
  if (signed === null) {
    issues.push({ code: 'signed_unknown', severity: 'warning', message: 'The order does not say whether it should be signed.' });
  }

  // Customer
  const email = session.customer_details?.email || session.customer_email || null;
  if (!email) issues.push({ code: 'missing_email', severity: 'warning', message: 'No customer email on this order.' });

  // ---- Derived work-queue stage ----
  const paymentBlocked = issues.some((i) => ['payment_incomplete', 'payment_processing', 'session_not_complete'].includes(i.code));
  const invalidMeta = issues.some((i) => i.code === 'invalid_fulfillment_metadata');
  let stage: Stage;
  if (refund === 'full') stage = 'refunded';
  else if (status === 'completed' && method && !paymentBlocked && !invalidMeta && shippingPayment !== 'unpaid') {
    stage = method === 'shipping' ? 'shipped' : 'picked_up';
  } else if (issues.some((i) => i.severity === 'problem')) stage = 'problem';
  else if (method === 'shipping' && shippingPayment === 'unpaid') stage = 'shipping_unpaid';
  else if (issues.some((i) => i.severity === 'check')) stage = 'check_customer';
  else stage = method === 'shipping' ? 'ready_to_ship' : 'waiting_for_pickup';

  const completed = stage === 'shipped' || stage === 'picked_up' || stage === 'refunded';
  if (completed) {
    // Pre-fulfillment questions don't matter once the book is out the door (or refunded).
    for (const i of issues) {
      if (i.code === 'no_line_items' || i.severity === 'check') i.severity = 'warning';
      if (i.code === 'disputed' && refund === 'full') i.severity = 'warning';
    }
  }

  const sessionMeta = { ...(session.metadata || {}) };

  return {
    id: session.id,
    createdAt: new Date(session.created * 1000).toISOString(),
    livemode: session.livemode,
    customer: {
      name: session.customer_details?.name || sd?.name || null,
      email,
      phone: session.customer_details?.phone || null,
    },
    items,
    book: {
      title: books[0]?.productName ?? books[0]?.description ?? null,
      language: same('language') as Language | null,
      format: same('format') as BookFormat | null,
      quantity: books.reduce((n, b) => n + b.quantity, 0),
      mixed: distinctBooks.size > 1,
    },
    signed,
    inscriptionName,
    amounts: {
      currency,
      subtotal: money(session.amount_subtotal),
      tax: money(session.total_details?.amount_tax),
      shipping: money(session.total_details?.amount_shipping),
      discount: money(session.total_details?.amount_discount),
      total,
      refunded,
    },
    payment: { state: paymentState, refund, disputed },
    checkout: {
      choice: checkout.method,
      choiceSource: checkout.source,
      signals: checkout.signals,
      shippingRateName: checkout.rateName,
      shippingCharged,
    },
    fulfillment: {
      method,
      changedFromCheckout,
      methodChangedAt: changedFromCheckout ? v.method_changed_at || null : null,
      status,
      noStatusRecorded: !rawStatus,
      completedAt: status === 'completed' ? v.fulfilled_at || null : null,
      carrier: v.carrier || null,
      trackingNumber: v.tracking_number || null,
      address: shipTo,
      addressSource: enteredAddress ? 'dashboard' : address ? 'checkout' : null,
      checkoutAddress: address,
      billingAddress,
      updatedBy: v.fulfillment_updated_by || null,
      updatedAt: v.fulfillment_updated_at || null,
    },
    shippingPayment: {
      status: shippingPayment,
      source: shippingPaymentSource,
      paidAt: shippingPayment === 'paid' && shippingPaymentSource === 'dashboard' ? v.shipping_paid_at || null : null,
    },
    customerCheck: {
      open: !completed && issues.some((i) => i.severity === 'check'),
      manual: checkManual,
      note: checkNote,
      dismissed: checkDismissed,
      contactedAt: v.customer_contacted_at || null,
    },
    stage,
    bucket: completed ? 'completed' : 'needs_action',
    issues,
    technical: {
      sessionId: session.id,
      paymentIntentId: idOf(session.payment_intent as string | Stripe.PaymentIntent | null),
      chargeId: idOf(pi?.latest_charge as string | Stripe.Charge | null | undefined),
      productIds: [...new Set(items.map((i) => i.productId).filter((x): x is string => Boolean(x)))],
      priceIds: [...new Set(items.map((i) => i.priceId).filter((x): x is string => Boolean(x)))],
      shippingRateId: checkout.rateId,
      sessionStatus: session.status ?? null,
      paymentStatus: session.payment_status ?? null,
      metadata: sessionMeta,
      paymentIntentMetadata: pickDashboardKeys(pi?.metadata) as Record<string, string>,
      customFields,
    },
  };
}
