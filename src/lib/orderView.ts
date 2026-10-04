// Pure view logic: which orders go in which tab, filters, search, counts.

import type { Order } from '../../shared/types';
import { editionLine } from './format';

export type View = 'needs_action' | 'completed' | 'all';

export type FilterKey =
  'shipping' | 'pickup' | 'changed' | 'check_customer' | 'shipping_unpaid' | 'missing_address' | 'signed' | 'en' | 'es' | 'hardcover' | 'paperback' | 'refunded' | 'no_status';

export const FILTERS: { key: FilterKey; label: string; group: string }[] = [
  { key: 'shipping', label: 'Shipping', group: 'method' },
  { key: 'pickup', label: 'Pickup', group: 'method' },
  { key: 'changed', label: 'Changed after checkout', group: 'changed' },
  { key: 'check_customer', label: 'Check with customer', group: 'checkcustomer' },
  { key: 'shipping_unpaid', label: 'Shipping unpaid', group: 'shipunpaid' },
  { key: 'missing_address', label: 'Missing address', group: 'missing' },
  { key: 'signed', label: 'Signed', group: 'signed' },
  { key: 'en', label: 'English', group: 'lang' },
  { key: 'es', label: 'Spanish', group: 'lang' },
  { key: 'hardcover', label: 'Hardcover', group: 'format' },
  { key: 'paperback', label: 'Paperback', group: 'format' },
  { key: 'refunded', label: 'Refunded', group: 'refunded' },
  { key: 'no_status', label: 'No status yet', group: 'nostatus' },
];

function hasLanguage(o: Order, l: 'en' | 'es') {
  return o.items.some((i) => i.kind === 'book' && i.language === l);
}
function hasFormat(o: Order, f: 'hardcover' | 'paperback') {
  return o.items.some((i) => i.kind === 'book' && i.format === f);
}

const MATCH: Record<FilterKey, (o: Order) => boolean> = {
  shipping: (o) => o.fulfillment.method === 'shipping',
  pickup: (o) => o.fulfillment.method === 'pickup',
  changed: (o) => o.fulfillment.changedFromCheckout,
  check_customer: (o) => o.customerCheck.open,
  shipping_unpaid: (o) => o.shippingPayment.status === 'unpaid',
  missing_address: (o) => o.issues.some((i) => i.code === 'missing_address' || i.code === 'incomplete_address'),
  signed: (o) => o.signed === true,
  en: (o) => hasLanguage(o, 'en'),
  es: (o) => hasLanguage(o, 'es'),
  hardcover: (o) => hasFormat(o, 'hardcover'),
  paperback: (o) => hasFormat(o, 'paperback'),
  refunded: (o) => o.payment.refund !== 'none',
  no_status: (o) => o.fulfillment.noStatusRecorded && o.bucket === 'needs_action',
};

/** OR within a group (English or Spanish), AND across groups (Shipping AND Signed). */
export function applyFilters(orders: Order[], active: Set<FilterKey>): Order[] {
  if (!active.size) return orders;
  const groups = new Map<string, FilterKey[]>();
  for (const f of FILTERS) if (active.has(f.key)) groups.set(f.group, [...(groups.get(f.group) || []), f.key]);
  return orders.filter((o) => [...groups.values()].every((keys) => keys.some((k) => MATCH[k](o))));
}

function norm(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function search(orders: Order[], q: string): Order[] {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return orders;
  return orders.filter((o) => {
    const hay = norm(
      [
        o.customer.name,
        o.customer.email,
        o.customer.phone,
        o.id,
        o.technical.paymentIntentId,
        o.book.title,
        editionLine(o),
        ...o.items.map((i) => `${i.productName ?? ''} ${i.description}`),
        o.inscriptionName,
        o.fulfillment.trackingNumber,
      ]
        .filter(Boolean)
        .join(' '),
    );
    return terms.every((t) => hay.includes(t));
  });
}

const byNewest = (a: Order, b: Order) => b.createdAt.localeCompare(a.createdAt);

export function inView(orders: Order[], view: View): Order[] {
  if (view === 'all') return [...orders].sort(byNewest);
  if (view === 'completed') {
    const when = (o: Order) => o.fulfillment.completedAt || o.createdAt;
    return orders.filter((o) => o.bucket === 'completed').sort((a, b) => when(b).localeCompare(when(a)));
  }
  return orders.filter((o) => o.bucket === 'needs_action').sort(byNewest);
}

/**
 * The work queue: Needs Action grouped by the next thing Paola does.
 * Order matters — collect money, then mail, then hand over, then ask, then fix.
 */
export const QUEUE: { stage: Order['stage']; title: string; hint: string }[] = [
  { stage: 'shipping_unpaid', title: 'Shipping unpaid', hint: 'Collect shipping, then mail it' },
  { stage: 'ready_to_ship', title: 'Ready to ship', hint: 'Package and mail these' },
  { stage: 'waiting_for_pickup', title: 'Waiting for pickup', hint: 'Hand these over when the customer comes by' },
  { stage: 'check_customer', title: 'Check with customer', hint: 'Nothing wrong on your end — a quick email sorts these out' },
  { stage: 'problem', title: 'Problems', hint: 'Something went wrong that needs sorting out' },
];

export function queueSections(orders: Order[]) {
  return QUEUE.map((q) => ({ ...q, orders: orders.filter((o) => o.stage === q.stage) })).filter((s) => s.orders.length);
}
