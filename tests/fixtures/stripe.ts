// Fixture Stripe objects shaped like what the storefront's Checkout Sessions
// actually contain (see paola_book_sales/netlify/functions/create-checkout-session.js):
//   metadata: { productId, signed: 'yes' | 'no' }
//   custom_fields: [{ key: 'inscription_name', text: { value } }] for signed copies
// plus the shipping shapes Stripe uses when a shipping option is offered.

import type Stripe from 'stripe';

export const PRODUCTS: Record<string, Partial<Stripe.Product>> = {
  prod_en_soft: { id: 'prod_en_soft', name: 'NLOML — English Softcover', metadata: { lang: 'en', format: 'softcover' }, active: true },
  prod_en_hard: { id: 'prod_en_hard', name: 'NLOML — English Hardcover', metadata: { lang: 'en', format: 'hardcover' }, active: true },
  prod_es_soft: { id: 'prod_es_soft', name: 'NLOML — Español', metadata: { lang: 'es', format: 'softcover' }, active: true },
  prod_untagged: { id: 'prod_untagged', name: 'Mystery book', metadata: {}, active: false },
  prod_ship: { id: 'prod_ship', name: 'Shipping (continental US)', metadata: {}, active: true },
};

export function productLookup(id: string): Stripe.Product | undefined {
  return PRODUCTS[id] as Stripe.Product | undefined;
}

let seq = 0;

export function lineItem(productId: string, opts: { quantity?: number; amount?: number } = {}): Stripe.LineItem {
  seq += 1;
  const p = PRODUCTS[productId];
  return {
    id: `li_${seq}`,
    object: 'item',
    amount_discount: 0,
    amount_subtotal: opts.amount ?? 2499,
    amount_tax: 0,
    amount_total: opts.amount ?? 2499,
    currency: 'usd',
    description: p?.name ?? productId,
    quantity: opts.quantity ?? 1,
    price: {
      id: `price_${productId}`,
      object: 'price',
      product: productId,
      metadata: {},
      unit_amount: opts.amount ?? 2499,
    } as unknown as Stripe.Price,
  } as Stripe.LineItem;
}

export interface SessionOpts {
  id?: string;
  created?: number;
  items?: Stripe.LineItem[] | null;
  signed?: 'yes' | 'no' | null;
  inscription?: string | null;
  metadata?: Record<string, string>;
  shippingRate?: { name: string; amount: number; metadata?: Record<string, string> } | null;
  shippingAddress?: Partial<Stripe.Address> | null;
  shippingAddressShape?: 'collected_information' | 'legacy';
  collectsAddress?: boolean;
  billingAddress?: Partial<Stripe.Address> | null;
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required';
  piStatus?: string;
  refunded?: number; // cents
  disputed?: boolean;
  piMetadata?: Record<string, string>;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  tax?: number;
}

export const DALLAS: Partial<Stripe.Address> = {
  line1: '123 Main St',
  line2: null,
  city: 'Dallas',
  state: 'TX',
  postal_code: '75201',
  country: 'US',
};

export function session(o: SessionOpts = {}): Stripe.Checkout.Session {
  seq += 1;
  const id = o.id ?? `cs_test_fixture${seq}`;
  const items = o.items === undefined ? [lineItem('prod_en_soft')] : o.items;
  const itemsTotal = (items ?? []).reduce((n, li) => n + li.amount_total, 0);
  const shipping = o.shippingRate?.amount ?? 0;
  const tax = o.tax ?? 0;
  const total = itemsTotal + shipping + tax;
  const metadata: Record<string, string> = {
    productId: 'prod_en_soft',
    ...(o.signed === null ? {} : { signed: o.signed ?? 'no' }),
    ...(o.metadata ?? {}),
  };

  const addr = o.shippingAddress
    ? {
        name: o.name ?? 'Jane Smith',
        address: { line1: null, line2: null, city: null, state: null, postal_code: null, country: null, ...o.shippingAddress },
      }
    : null;
  const piId = `pi_${seq}`;
  const charge = {
    id: `ch_${seq}`,
    object: 'charge',
    amount: total,
    amount_refunded: o.refunded ?? 0,
    refunded: (o.refunded ?? 0) >= total && (o.refunded ?? 0) > 0,
    disputed: o.disputed ?? false,
  };

  return {
    id,
    object: 'checkout.session',
    created: o.created ?? 1790000000 + seq,
    livemode: false,
    mode: 'payment',
    status: 'complete',
    currency: 'usd',
    payment_status: o.paymentStatus ?? 'paid',
    amount_subtotal: itemsTotal,
    amount_total: total,
    total_details: { amount_discount: 0, amount_shipping: shipping, amount_tax: tax },
    metadata,
    custom_fields:
      o.inscription !== undefined && o.inscription !== null
        ? [
            {
              key: 'inscription_name',
              type: 'text',
              optional: true,
              label: { type: 'custom', custom: 'Name' },
              text: { value: o.inscription },
            },
          ]
        : [],
    customer_details: {
      name: o.name === undefined ? 'Jane Smith' : o.name,
      email: o.email === undefined ? 'jane@example.com' : o.email,
      phone: o.phone ?? null,
      address: o.billingAddress
        ? { line1: null, line2: null, city: null, state: null, postal_code: null, country: 'US', ...o.billingAddress }
        : null,
      tax_exempt: 'none',
      tax_ids: [],
    },
    customer_email: null,
    shipping_address_collection: o.collectsAddress ? { allowed_countries: ['US'] } : null,
    shipping_cost: o.shippingRate
      ? {
          amount_subtotal: o.shippingRate.amount,
          amount_tax: 0,
          amount_total: o.shippingRate.amount,
          shipping_rate: {
            id: `shr_${seq}`,
            object: 'shipping_rate',
            display_name: o.shippingRate.name,
            metadata: o.shippingRate.metadata ?? {},
          },
        }
      : null,
    shipping_details: o.shippingAddressShape === 'legacy' ? addr : null,
    collected_information: o.shippingAddressShape === 'legacy' ? null : { shipping_details: addr },
    line_items: items === null ? undefined : { object: 'list', data: items, has_more: false, url: '' },
    payment_intent: {
      id: piId,
      object: 'payment_intent',
      status: o.piStatus ?? (o.paymentStatus === 'unpaid' ? 'requires_payment_method' : 'succeeded'),
      metadata: o.piMetadata ?? {},
      latest_charge: charge,
    },
  } as unknown as Stripe.Checkout.Session;
}
