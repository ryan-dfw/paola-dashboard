import type { Address, Issue, IssueCode, Order, Stage } from '../../shared/types';

const TZ = 'America/Chicago';

export function money(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
    timeZoneName: 'short',
  });
}

export const LANGUAGE_LABEL = { en: 'English', es: 'Spanish' } as const;
export const FORMAT_LABEL = { hardcover: 'Hardcover', paperback: 'Paperback' } as const;

/** "Hardcover · Spanish · Signed" */
export function editionLine(o: Order): string {
  const parts: string[] = [];
  if (o.book.mixed) parts.push('Mixed editions');
  else {
    parts.push(o.book.format ? FORMAT_LABEL[o.book.format] : 'Format unknown');
    parts.push(o.book.language ? LANGUAGE_LABEL[o.book.language] : 'Language unknown');
  }
  if (o.signed) parts.push('Signed');
  return parts.join(' · ');
}

const PROBLEM_LABEL: Partial<Record<IssueCode, string>> = {
  missing_address: 'Missing shipping address',
  incomplete_address: 'Address incomplete',
  unknown_method: 'Pickup or shipping?',
  payment_incomplete: 'Payment not completed',
  payment_processing: 'Payment processing',
  session_not_complete: 'Checkout not finished',
  no_line_items: "Can't tell what was bought",
  invalid_fulfillment_metadata: 'Status unreadable',
  disputed: 'Payment disputed',
};

// Calm, plain wording on purpose: these are read by someone who worries.
export const STAGE_LABEL: Record<Stage, string> = {
  shipping_unpaid: 'Shipping unpaid',
  ready_to_ship: 'Ready to ship',
  waiting_for_pickup: 'Waiting for pickup',
  check_customer: 'Check with customer',
  problem: 'Problem',
  shipped: 'Shipped',
  picked_up: 'Picked up',
  refunded: 'Refunded',
};

export const METHOD_LABEL = { pickup: 'Pickup', shipping: 'Shipping', unknown: 'Not chosen' } as const;

export function problems(o: Order): Issue[] {
  return o.issues.filter((i) => i.severity === 'problem');
}

/** Customer-side things worth confirming — not problems. */
export function checks(o: Order): Issue[] {
  return o.issues.filter((i) => i.severity === 'check');
}

/**
 * A ready-to-send, friendly email for the "check with customer" case — in
 * Spanish for Spanish-edition orders. Opens in Paola's own mail app.
 */
export function customerEmailLink(o: Order): string | null {
  if (!o.customer.email) return null;
  const first = (o.customer.name || '').trim().split(/\s+/)[0] || '';
  const codes = new Set(checks(o).map((i) => i.code));
  const needsAddress = codes.has('missing_address') || codes.has('incomplete_address');
  const es = o.book.language === 'es';
  let subject: string;
  let body: string;
  if (es) {
    subject = 'Tu pedido de The Narcissist Love of My Life';
    body = needsAddress
      ? `Hola${first ? ` ${first}` : ''}:\n\n¡Gracias por tu pedido! ¿A qué dirección te lo enviamos? Solo necesito tu dirección completa (calle, ciudad, estado y código postal).\n\nUn abrazo,\nPaola`
      : `Hola${first ? ` ${first}` : ''}:\n\n¡Gracias por tu pedido! Quería confirmar cómo prefieres recibir tu libro: ¿lo recoges en persona o prefieres que te lo enviemos por correo?\n\nUn abrazo,\nPaola`;
  } else {
    subject = 'Your order of The Narcissist Love of My Life';
    body = needsAddress
      ? `Hi${first ? ` ${first}` : ''},\n\nThank you so much for your order! Where should I mail your copy? I just need your full mailing address (street, city, state and ZIP).\n\nWarmly,\nPaola`
      : `Hi${first ? ` ${first}` : ''},\n\nThank you so much for your order! I wanted to check how you'd like to get your book: will you pick it up in person, or would you prefer I mail it to you?\n\nWarmly,\nPaola`;
  }
  return `mailto:${encodeURIComponent(o.customer.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The single loudest label for the order's state. */
export function stageLabel(o: Order): string {
  if (o.stage === 'problem') {
    const p = problems(o)[0];
    return (p && PROBLEM_LABEL[p.code]) || 'Needs attention';
  }
  return STAGE_LABEL[o.stage];
}

export function addressLines(a: Address): string[] {
  const cityLine = [a.city, [a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.name, a.line1, a.line2, cityLine, a.country && a.country !== 'US' ? a.country : null].filter((x): x is string => Boolean(x));
}

export function trackingUrl(carrier: string | null, number: string | null): string | null {
  if (!number) return null;
  const n = encodeURIComponent(number.replace(/\s+/g, ''));
  switch ((carrier || '').toLowerCase()) {
    case 'usps':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
    case 'ups':
      return `https://www.ups.com/track?tracknum=${n}`;
    case 'fedex':
      return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
    case 'dhl':
      return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${n}`;
    default:
      return null;
  }
}

export function stripeDashboardUrl(o: Order): string | null {
  const base = `https://dashboard.stripe.com${o.livemode ? '' : '/test'}`;
  if (o.technical.paymentIntentId) return `${base}/payments/${o.technical.paymentIntentId}`;
  return null;
}
