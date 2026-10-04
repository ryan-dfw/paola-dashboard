// Realistic demo data for end-to-end tests and screenshots: ~30 launch-event
// pickups (no shipping offered, no dashboard status yet) plus later orders
// covering every state the dashboard has to show.

import type Stripe from 'stripe';
import { DALLAS, lineItem, session } from './stripe';

const EVENT = Date.UTC(2026, 8, 27, 23, 0, 0) / 1000; // Sep 27 2026, evening CT
const tax = (cents: number) => Math.round(cents * 0.0825);

const EVENT_BUYERS: [string, 'prod_en_soft' | 'prod_en_hard' | 'prod_es_soft', string | null][] = [
  ['Maria Gonzalez', 'prod_es_soft', 'Mamá'],
  ['Tom Becker', 'prod_en_soft', null],
  ['Lisa Nguyen', 'prod_en_hard', 'Lisa'],
  ['Carlos Ruiz', 'prod_es_soft', null],
  ['Dana Whitfield', 'prod_en_soft', 'Dana & Mike'],
  ['Priya Shah', 'prod_en_soft', null],
  ['Rosa Delgado', 'prod_es_soft', 'Rosa'],
  ['Kevin O’Brien', 'prod_en_hard', null],
  ['Alicia Moreno', 'prod_es_soft', null],
  ['Brenda Cole', 'prod_en_soft', null],
  ['Hector Salinas', 'prod_es_soft', 'Hector'],
  ['Jasmine Patel', 'prod_en_soft', null],
  ['Gloria Ramos', 'prod_es_soft', null],
  ['Nate Fischer', 'prod_en_soft', null],
  ['Yolanda Pérez', 'prod_es_soft', 'Yoli'],
  ['Erin Walsh', 'prod_en_hard', 'Erin'],
  ['Sofia Castillo', 'prod_en_soft', null],
  ['Derek Huang', 'prod_en_soft', null],
  ['Claudia Vega', 'prod_es_soft', null],
  ['Megan Price', 'prod_en_soft', 'Megan'],
  ['Luis Ortega', 'prod_es_soft', null],
  ['Heather Kim', 'prod_en_hard', null],
  ['Rachel Stone', 'prod_en_soft', null],
];

const PRICE = { prod_en_soft: 2499, prod_en_hard: 3499, prod_es_soft: 2499 } as const;

export function demoSessions(): Stripe.Checkout.Session[] {
  const out: Stripe.Checkout.Session[] = [];
  EVENT_BUYERS.forEach(([name, product, inscription], i) => {
    out.push(
      session({
        id: `cs_test_event${String(i).padStart(2, '0')}`,
        created: EVENT - i * 240,
        name,
        email: `${name
          .split(' ')[0]
          .toLowerCase()
          .replace(/[^a-z]/g, '')}@example.com`,
        items: [lineItem(product, { amount: PRICE[product] })],
        tax: tax(PRICE[product]),
        signed: inscription ? 'yes' : 'no',
        inscription: inscription ?? null,
        metadata: { productId: product },
      }),
    );
  });

  // One launch-event order Paola already handled with the dashboard.
  out.push(
    session({
      id: 'cs_test_doneevent',
      created: EVENT - 30 * 240,
      name: 'Grace Lin',
      items: [lineItem('prod_en_soft')],
      tax: tax(2499),
      metadata: {
        fulfillment_status: 'picked_up',
        fulfillment_method: 'pickup',
        fulfilled_at: '2026-09-28T01:10:00.000Z',
        fulfillment_updated_at: '2026-09-28T01:10:00.000Z',
        fulfillment_updated_by: 'paola@example.com',
      },
    }),
  );

  // Sara — pickup after the event.
  out.push(
    session({
      id: 'cs_test_sara',
      created: Date.UTC(2026, 8, 30, 18) / 1000,
      name: 'Sara Laffy',
      email: 'sara@example.com',
      items: [lineItem('prod_en_soft')],
      tax: 206,
    }),
  );

  // Shipped with tracking.
  out.push(
    session({
      id: 'cs_test_shipped',
      created: Date.UTC(2026, 9, 1, 15) / 1000,
      name: 'Ana Torres',
      email: 'ana.torres@example.com',
      phone: '+1 214 555 0142',
      items: [lineItem('prod_es_soft')],
      tax: tax(2499),
      shippingRate: { name: 'Shipping (continental US)', amount: 600 },
      shippingAddress: { line1: '4410 Bryan St', line2: 'Apt 3', city: 'Dallas', state: 'TX', postal_code: '75204', country: 'US' },
      metadata: {
        fulfillment_status: 'shipped',
        fulfillment_method: 'shipping',
        fulfilled_at: '2026-10-02T16:00:00.000Z',
        carrier: 'USPS',
        tracking_number: '9400111899223344556677',
        fulfillment_updated_at: '2026-10-02T16:00:00.000Z',
        fulfillment_updated_by: 'paola@example.com',
      },
    }),
  );

  // Refunded.
  out.push(
    session({
      id: 'cs_test_refund',
      created: Date.UTC(2026, 9, 2, 20) / 1000,
      name: 'Paul Grant',
      items: [lineItem('prod_en_hard', { amount: 3499 })],
      tax: tax(3499),
      refunded: 3499 + tax(3499),
    }),
  );

  // Shipping purchased, but no address.
  out.push(
    session({
      id: 'cs_test_noaddr',
      created: Date.UTC(2026, 9, 3, 14) / 1000,
      name: 'Marcus Lee',
      email: 'marcus@example.com',
      items: [lineItem('prod_en_soft')],
      tax: tax(2499),
      shippingRate: { name: 'Shipping (continental US)', amount: 600 },
      billingAddress: { line1: '88 Elm St', city: 'Plano', state: 'TX', postal_code: '75074' },
    }),
  );

  // Jane — signed hardcover to ship, inscription.
  out.push(
    session({
      id: 'cs_test_jane',
      created: Date.UTC(2026, 9, 4, 16, 20) / 1000,
      name: 'Jane Smith',
      email: 'jane.smith@example.com',
      phone: '+1 469 555 0199',
      items: [lineItem('prod_en_hard', { amount: 3499 })],
      tax: 289,
      signed: 'yes',
      inscription: 'For Jane, with love',
      shippingRate: { name: 'Shipping (continental US)', amount: 600 },
      shippingAddress: DALLAS,
    }),
  );

  // Two Spanish paperbacks, shipping, unsigned.
  out.push(
    session({
      id: 'cs_test_twobooks',
      created: Date.UTC(2026, 9, 4, 18) / 1000,
      name: 'Lucía Fernández',
      email: 'lucia@example.com',
      items: [lineItem('prod_es_soft', { quantity: 2, amount: 4998 })],
      tax: tax(4998),
      shippingRate: { name: 'Shipping (continental US)', amount: 600 },
      shippingAddress: { line1: '1200 Main St', city: 'Houston', state: 'TX', postal_code: '77002', country: 'US' },
    }),
  );

  // Intentionally free shipping (no charge) — must NOT be treated as "shipping unpaid".
  out.push(
    session({
      id: 'cs_test_freeship',
      created: Date.UTC(2026, 9, 4, 17) / 1000,
      name: 'Diego Alvarez',
      email: 'diego@example.com',
      items: [lineItem('prod_en_soft')],
      tax: tax(2499),
      shippingRate: { name: 'Free shipping (friends & family)', amount: 0 },
      shippingAddress: { line1: '77 Oak Lawn Ave', city: 'Dallas', state: 'TX', postal_code: '75219', country: 'US' },
    }),
  );

  // Chose pickup, but the card is from California — probably expected it mailed. A "check", not a problem.
  out.push(
    session({
      id: 'cs_test_far',
      created: Date.UTC(2026, 9, 3, 20) / 1000,
      name: 'Mia Chen',
      email: 'mia@example.com',
      items: [lineItem('prod_en_soft')],
      tax: tax(2499),
      billingAddress: { postal_code: '94110', state: 'CA', country: 'US' },
    }),
  );

  // Bought for pickup; later asked Paola to mail it and hasn't paid shipping yet.
  out.push(
    session({
      id: 'cs_test_converted',
      created: Date.UTC(2026, 8, 29, 18) / 1000,
      name: 'Elena Ruiz',
      email: 'elena@example.com',
      items: [lineItem('prod_es_soft')],
      tax: tax(2499),
      metadata: {
        fulfillment_method: 'shipping',
        shipping_payment_status: 'unpaid',
        method_changed_at: '2026-10-02T15:00:00.000Z',
        fulfillment_updated_at: '2026-10-02T15:00:00.000Z',
        fulfillment_updated_by: 'paola@example.com',
      },
    }),
  );

  // Payment still processing.
  out.push(
    session({
      id: 'cs_test_processing',
      created: Date.UTC(2026, 9, 4, 19) / 1000,
      name: 'Owen Park',
      items: [lineItem('prod_en_soft')],
      tax: tax(2499),
      paymentStatus: 'unpaid',
      piStatus: 'processing',
    }),
  );

  return out;
}
