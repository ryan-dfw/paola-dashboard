import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../server/normalize';
import { DALLAS, lineItem, productLookup, session } from '../fixtures/stripe';

const norm = (o: Parameters<typeof session>[0] = {}) => normalizeSession(session(o), productLookup);
const codes = (o: ReturnType<typeof norm>) => o.issues.map((i) => i.code);

describe('event-era pickup orders (no shipping offered)', () => {
  it('classifies as pickup from the absence of any shipping in checkout', () => {
    const o = norm({ name: 'Sara Laffy', tax: 206 });
    expect(o.fulfillment.method).toBe('pickup');
    expect(o.checkout.choiceSource).toBe('no_shipping_offered');
    expect(o.stage).toBe('waiting_for_pickup');
    expect(o.bucket).toBe('needs_action');
    expect(o.issues.filter((i) => i.severity === 'problem')).toEqual([]);
  });

  it('treats a pre-dashboard order as pending with no status recorded', () => {
    const o = norm();
    expect(o.fulfillment.status).toBe('waiting');
    expect(o.fulfillment.noStatusRecorded).toBe(true);
  });

  it('reads paperback / English from product metadata (softcover → paperback)', () => {
    const o = norm();
    expect(o.book).toMatchObject({ language: 'en', format: 'paperback', quantity: 1, mixed: false });
  });

  it('reads hardcover', () => {
    expect(norm({ items: [lineItem('prod_en_hard', { amount: 3999 })] }).book.format).toBe('hardcover');
  });

  it('reads Spanish', () => {
    expect(norm({ items: [lineItem('prod_es_soft')] }).book.language).toBe('es');
  });

  it('never infers the product from the amount', () => {
    // Same product, wildly different amount → still paperback/English.
    const o = norm({ items: [lineItem('prod_en_soft', { amount: 4388 })] });
    expect(o.book.format).toBe('paperback');
    // Unknown product with a "paperback-looking" amount → not guessed.
    const u = norm({ items: [lineItem('prod_untagged', { amount: 2705 })] });
    expect(u.book.format).toBeNull();
    expect(codes(u)).toContain('unknown_product');
  });
});

describe('signed copies', () => {
  it('signed + inscription', () => {
    const o = norm({ signed: 'yes', inscription: 'For Maria' });
    expect(o.signed).toBe(true);
    expect(o.inscriptionName).toBe('For Maria');
  });
  it('signed without inscription', () => {
    const o = norm({ signed: 'yes' });
    expect(o.signed).toBe(true);
    expect(o.inscriptionName).toBeNull();
  });
  it('unsigned', () => {
    expect(norm({ signed: 'no' }).signed).toBe(false);
  });
  it('missing signed metadata is unknown (warning), not false', () => {
    const o = norm({ signed: null });
    expect(o.signed).toBeNull();
    expect(o.issues.find((i) => i.code === 'signed_unknown')?.severity).toBe('warning');
  });
});

describe('shipping orders', () => {
  it('a chosen shipping rate with an address → needs shipping', () => {
    const o = norm({ shippingRate: { name: 'Shipping (continental US)', amount: 600 }, shippingAddress: DALLAS, tax: 206 });
    expect(o.fulfillment.method).toBe('shipping');
    expect(o.checkout.choiceSource).toBe('shipping_rate');
    expect(o.checkout.shippingRateName).toBe('Shipping (continental US)');
    expect(o.fulfillment.address).toMatchObject({ line1: '123 Main St', city: 'Dallas', state: 'TX', postalCode: '75201' });
    expect(o.amounts.shipping).toBe(600);
    expect(o.amounts.tax).toBe(206);
    expect(o.stage).toBe('ready_to_ship');
  });

  it('reads the legacy top-level shipping_details shape too', () => {
    const o = norm({ shippingRate: { name: 'Shipping', amount: 600 }, shippingAddress: DALLAS, shippingAddressShape: 'legacy' });
    expect(o.fulfillment.address?.city).toBe('Dallas');
  });

  it('shipping purchased but no address → check with customer, not ready to ship', () => {
    const o = norm({ shippingRate: { name: 'Shipping', amount: 600 } });
    expect(o.fulfillment.method).toBe('shipping');
    expect(o.stage).toBe('check_customer') // customer-side, not a problem;
    expect(codes(o)).toContain('missing_address');
  });

  it('does not use the card billing address as a shipping address', () => {
    const o = norm({ shippingRate: { name: 'Shipping', amount: 600 }, billingAddress: DALLAS });
    expect(o.fulfillment.address).toBeNull();
    expect(o.fulfillment.billingAddress?.city).toBe('Dallas');
    expect(codes(o)).toContain('missing_address');
  });

  it('incomplete address → check with customer', () => {
    const o = norm({
      shippingRate: { name: 'Shipping', amount: 600 },
      shippingAddress: { line1: '1 Elm', city: null, postal_code: null, country: 'US' },
    });
    expect(codes(o)).toContain('incomplete_address');
    expect(o.stage).toBe('check_customer') // customer-side, not a problem;
  });

  it('shipping as a separate line item counts as shipping purchased', () => {
    const o = norm({ items: [lineItem('prod_en_soft'), lineItem('prod_ship', { amount: 600 })], shippingAddress: DALLAS });
    expect(o.fulfillment.method).toBe('shipping');
    expect(o.checkout.choiceSource).toBe('shipping_line_item');
    expect(o.book.quantity).toBe(1);
  });

  it('a $0 rate named "Pickup" is pickup, not shipping', () => {
    const o = norm({ shippingRate: { name: 'Pick up at the event', amount: 0 } });
    expect(o.fulfillment.method).toBe('pickup');
    expect(o.stage).toBe('waiting_for_pickup');
  });

  it('a rate tagged metadata.fulfillment_method wins over its name', () => {
    const o = norm({ shippingRate: { name: 'Standard', amount: 0, metadata: { fulfillment_method: 'pickup' } } });
    expect(o.fulfillment.method).toBe('pickup');
  });

  it('an address alone does not make it a shipping order', () => {
    const o = norm({ shippingAddress: DALLAS, metadata: { shipping: 'no' } });
    expect(o.fulfillment.method).toBe('pickup');
    expect(codes(o)).toContain('address_without_shipping');
  });

  it('address collected with no shipping signal → flagged unknown, not guessed', () => {
    const o = norm({ collectsAddress: true, shippingAddress: DALLAS });
    expect(o.fulfillment.method).toBeNull();
    expect(o.checkout.choice).toBe('unknown');
    expect(o.stage).toBe('check_customer') // customer-side, not a problem;
    expect(codes(o)).toContain('unknown_method');
  });

  it('conflicting signals are flagged, not guessed', () => {
    const o = norm({ shippingRate: { name: 'Shipping', amount: 600 }, shippingAddress: DALLAS, metadata: { shipping: 'no' } });
    expect(o.fulfillment.method).toBeNull();
    expect(o.checkout.choice).toBe('unknown');
    expect(o.checkout.choiceSource).toBe('conflict');
    expect(o.stage).toBe('check_customer') // customer-side, not a problem;
  });

  it('a hand-resolved unknown order uses the dashboard decision; checkout still says unknown', () => {
    const o = norm({ collectsAddress: true, shippingAddress: DALLAS, metadata: { fulfillment_method: 'shipping' } });
    expect(o.fulfillment.method).toBe('shipping');
    expect(o.checkout.choice).toBe('unknown');
    expect(o.fulfillment.changedFromCheckout).toBe(false);
    expect(o.stage).toBe('ready_to_ship');
  });
});

describe('fulfillment state from metadata', () => {
  it('picked up → completed', () => {
    const o = norm({ metadata: { fulfillment_status: 'picked_up', fulfilled_at: '2026-10-02T15:00:00Z' } });
    expect(o.stage).toBe('picked_up');
    expect(o.bucket).toBe('completed');
    expect(o.fulfillment.completedAt).toBe('2026-10-02T15:00:00Z');
    expect(o.fulfillment.noStatusRecorded).toBe(false);
  });

  it('shipped with tracking → completed', () => {
    const o = norm({
      shippingRate: { name: 'Shipping', amount: 600 },
      shippingAddress: DALLAS,
      metadata: { fulfillment_status: 'shipped', carrier: 'USPS', tracking_number: '9400111', fulfilled_at: '2026-10-03T00:00:00Z' },
    });
    expect(o.stage).toBe('shipped');
    expect(o.fulfillment.trackingNumber).toBe('9400111');
    expect(o.fulfillment.carrier).toBe('USPS');
  });

  it('undone (pending) is back in needs action', () => {
    const o = norm({ metadata: { fulfillment_status: 'pending', fulfillment_updated_at: '2026-10-03T00:00:00Z' } });
    expect(o.stage).toBe('waiting_for_pickup');
    expect(o.fulfillment.noStatusRecorded).toBe(false);
  });

  it('garbage status is a problem, never completed', () => {
    const o = norm({ metadata: { fulfillment_status: 'done-ish' } });
    expect(o.stage).toBe('problem');
    expect(o.bucket).toBe('needs_action');
    expect(codes(o)).toContain('invalid_fulfillment_metadata');
  });

  it('falls back to PaymentIntent metadata when it is newer', () => {
    const o = norm({
      metadata: { fulfillment_status: 'pending', fulfillment_updated_at: '2026-10-01T00:00:00Z' },
      piMetadata: { fulfillment_status: 'picked_up', fulfillment_updated_at: '2026-10-02T00:00:00Z', fulfilled_at: '2026-10-02T00:00:00Z' },
    });
    expect(o.stage).toBe('picked_up');
  });

  it('keeps unrelated storefront metadata intact in technical details', () => {
    const o = norm({ signed: 'yes' });
    expect(o.technical.metadata).toMatchObject({ productId: 'prod_en_soft', signed: 'yes' });
  });
});

describe('payment and refunds', () => {
  it('fully refunded → completed (refunded) even if never fulfilled', () => {
    const o = norm({ refunded: 2499 });
    expect(o.payment.refund).toBe('full');
    expect(o.stage).toBe('refunded');
    expect(o.bucket).toBe('completed');
    expect(o.amounts.refunded).toBe(2499);
  });

  it('partial refund stays actionable with a warning', () => {
    const o = norm({ refunded: 500 });
    expect(o.payment.refund).toBe('partial');
    expect(o.stage).toBe('waiting_for_pickup');
    expect(codes(o)).toContain('partial_refund');
  });

  it('unpaid is a problem and can never show as completed', () => {
    const o = norm({ paymentStatus: 'unpaid', metadata: { fulfillment_status: 'picked_up' } });
    expect(o.payment.state).toBe('unpaid');
    expect(o.stage).toBe('problem');
    expect(codes(o)).toContain('payment_incomplete');
  });

  it('processing payment is distinguished from failed', () => {
    const o = norm({ paymentStatus: 'unpaid', piStatus: 'processing' });
    expect(o.payment.state).toBe('processing');
    expect(codes(o)).toContain('payment_processing');
  });

  it('disputed payment is a problem', () => {
    const o = norm({ disputed: true });
    expect(o.stage).toBe('problem');
    expect(codes(o)).toContain('disputed');
  });
});

describe('malformed historical data', () => {
  it('no readable line items → problem', () => {
    const o = norm({ items: null });
    expect(o.stage).toBe('problem');
    expect(codes(o)).toContain('no_line_items');
  });

  it('missing email is a warning', () => {
    expect(codes(norm({ email: null }))).toContain('missing_email');
  });

  it('quantity > 1 and mixed editions roll up', () => {
    const o = norm({ items: [lineItem('prod_en_soft', { quantity: 2 }), lineItem('prod_es_soft')] });
    expect(o.book.quantity).toBe(3);
    expect(o.book.mixed).toBe(true);
    expect(o.book.language).toBeNull();
  });
});

const ENTERED = { ship_to_name: 'Ann Lee', ship_to_line1: '9 Elm St', ship_to_city: 'Austin', ship_to_state: 'TX', ship_to_postal_code: '78701' };

describe('the fulfillment model: checkout choice vs. current method vs. status vs. shipping payment', () => {
  it('free shipping at checkout is not "unpaid" — shipping payment is not applicable', () => {
    const o = norm({ shippingRate: { name: 'Free shipping', amount: 0 }, shippingAddress: DALLAS });
    expect(o.checkout.choice).toBe('shipping');
    expect(o.shippingPayment).toMatchObject({ status: 'not_applicable', source: 'none' });
    expect(o.stage).toBe('ready_to_ship');
  });

  it('a pickup order has no shipping payment at all', () => {
    expect(norm().shippingPayment.status).toBe('not_applicable');
  });

  it('shipping charged at checkout → paid (source: checkout)', () => {
    expect(norm({ shippingRate: { name: 'Shipping', amount: 600 }, shippingAddress: DALLAS }).shippingPayment).toMatchObject({
      status: 'paid',
      source: 'checkout',
    });
    expect(norm({ items: [lineItem('prod_en_soft'), lineItem('prod_ship', { amount: 600 })], shippingAddress: DALLAS }).checkout.shippingCharged).toBe(600);
  });

  it('pickup changed to shipping, unpaid: checkout truth is preserved', () => {
    const o = norm({
      metadata: { fulfillment_method: 'shipping', shipping_payment_status: 'unpaid', method_changed_at: '2026-10-05T00:00:00Z' },
    });
    expect(o.checkout.choice).toBe('pickup'); // what Stripe recorded
    expect(o.fulfillment.method).toBe('shipping'); // what Paola is doing now
    expect(o.fulfillment.changedFromCheckout).toBe(true);
    expect(o.fulfillment.methodChangedAt).toBe('2026-10-05T00:00:00Z');
    expect(o.shippingPayment).toMatchObject({ status: 'unpaid', source: 'dashboard' });
    expect(o.stage).toBe('shipping_unpaid');
    expect(o.issues.map((i) => i.code)).not.toContain('method_conflict');
    expect(o.checkout.signals.join(' ')).toContain('Changed in the dashboard after checkout');
  });

  it('…then shipping paid → ready to ship → shipped', () => {
    const base = {
      fulfillment_method: 'shipping',
      shipping_payment_status: 'paid',
      shipping_paid_at: '2026-10-06T00:00:00Z',
      ...ENTERED,
    };
    const ready = norm({ metadata: base });
    expect(ready.fulfillment.addressSource).toBe('dashboard');
    expect(ready.fulfillment.address).toMatchObject({ line1: '9 Elm St', city: 'Austin', state: 'TX', postalCode: '78701' });
    expect(ready.fulfillment.checkoutAddress).toBeNull();
    expect(ready.stage).toBe('ready_to_ship');
    expect(ready.shippingPayment).toMatchObject({ status: 'paid', source: 'dashboard', paidAt: '2026-10-06T00:00:00Z' });
    const shipped = norm({ metadata: { ...base, fulfillment_status: 'completed' } });
    expect(shipped.stage).toBe('shipped');
    expect(shipped.bucket).toBe('completed');
    expect(shipped.checkout.choice).toBe('pickup');
  });

  it('a converted order never uses the card billing address as the shipping address', () => {
    const o = norm({ billingAddress: DALLAS, metadata: { fulfillment_method: 'shipping', shipping_payment_status: 'paid' } });
    expect(o.fulfillment.address).toBeNull();
    expect(o.stage).toBe('check_customer');
    expect(o.issues.find((i) => i.code === 'missing_address')?.severity).toBe('check');
  });

  it('shipping unpaid outranks "need their address" — collect the money first', () => {
    const o = norm({ metadata: { fulfillment_method: 'shipping', shipping_payment_status: 'unpaid' } });
    expect(o.stage).toBe('shipping_unpaid');
    expect(o.issues.map((i) => i.code)).toContain('missing_address');
  });

  it('a shipping order can become pickup; payment becomes not applicable', () => {
    const o = norm({ shippingRate: { name: 'Shipping', amount: 600 }, shippingAddress: DALLAS, metadata: { fulfillment_method: 'pickup' } });
    expect(o.checkout.choice).toBe('shipping');
    expect(o.fulfillment.method).toBe('pickup');
    expect(o.fulfillment.changedFromCheckout).toBe(true);
    expect(o.shippingPayment.status).toBe('not_applicable');
    expect(o.stage).toBe('waiting_for_pickup');
  });

  it('completed means picked up for pickup and shipped for shipping', () => {
    expect(norm({ metadata: { fulfillment_status: 'completed' } }).stage).toBe('picked_up');
    expect(norm({ shippingRate: { name: 'S', amount: 600 }, shippingAddress: DALLAS, metadata: { fulfillment_status: 'completed' } }).stage).toBe(
      'shipped',
    );
  });

  it('reads status values written by earlier dashboard versions', () => {
    expect(norm({ metadata: { fulfillment_status: 'picked_up' } }).fulfillment.status).toBe('completed');
    expect(norm({ metadata: { fulfillment_status: 'pending' } }).stage).toBe('waiting_for_pickup');
    // old "shipped" implies shipping even with no stored method
    const o = norm({ shippingAddress: DALLAS, metadata: { fulfillment_status: 'shipped' } });
    expect(o.fulfillment.method).toBe('shipping');
    expect(o.stage).toBe('shipped');
    // old shipping-payment flag without a method meant "ships"
    expect(norm({ metadata: { shipping_payment_status: 'unpaid' } }).fulfillment.method).toBe('shipping');
  });

  it('legacy orders with no metadata: waiting, never completed or paid', () => {
    const o = norm({ shippingRate: { name: 'Free', amount: 0 }, shippingAddress: DALLAS });
    expect(o.fulfillment.status).toBe('waiting');
    expect(o.fulfillment.noStatusRecorded).toBe(true);
    expect(o.shippingPayment.status).toBe('not_applicable');
  });

  it('garbage values are problems, not silently ignored', () => {
    expect(norm({ metadata: { shipping_payment_status: 'maybe' } }).stage).toBe('problem');
    expect(norm({ metadata: { fulfillment_method: 'drone' } }).stage).toBe('problem');
  });

  it('a refunded order is refunded regardless of other state', () => {
    expect(norm({ refunded: 2499, metadata: { fulfillment_method: 'shipping', shipping_payment_status: 'unpaid' } }).stage).toBe('refunded');
  });
});

describe('check with customer (calm, not a problem)', () => {
  const codes = (o: ReturnType<typeof norm>) => o.issues.map((i) => i.code);

  it('pickup with an out-of-state billing address → gentle check, not a problem', () => {
    const o = norm({ billingAddress: { line1: '1 Main', city: 'Los Angeles', state: 'CA', postal_code: '90001' } });
    expect(o.fulfillment.method).toBe('pickup'); // NOT reclassified as shipping
    expect(o.stage).toBe('check_customer');
    expect(o.issues.find((i) => i.code === 'pickup_far_away')).toMatchObject({ severity: 'check' });
    expect(o.issues.find((i) => i.code === 'pickup_far_away')?.message).toContain('CA');
    expect(o.issues.some((i) => i.severity === 'problem')).toBe(false);
    expect(o.customerCheck.open).toBe(true);
  });

  it('uses the ZIP when Stripe only has a postal code', () => {
    expect(codes(norm({ billingAddress: { postal_code: '10001', country: 'US' } }))).toContain('pickup_far_away');
    expect(codes(norm({ billingAddress: { postal_code: '75201', country: 'US' } }))).not.toContain('pickup_far_away');
    expect(codes(norm({ billingAddress: { postal_code: '78701', country: 'US' } }))).not.toContain('pickup_far_away');
  });

  it('Texas billing (or none) stays a plain pickup', () => {
    expect(norm({ billingAddress: DALLAS }).stage).toBe('waiting_for_pickup');
    expect(norm().stage).toBe('waiting_for_pickup');
  });

  it('"Sorted" dismisses the auto hints', () => {
    const o = norm({ billingAddress: { state: 'CA', postal_code: '90001' }, metadata: { customer_check: 'dismissed' } });
    expect(o.stage).toBe('waiting_for_pickup');
    expect(o.customerCheck.dismissed).toBe(true);
    const m = norm({ shippingRate: { name: 'Shipping', amount: 600 }, metadata: { customer_check: 'dismissed' } });
    expect(m.stage).toBe('ready_to_ship'); // she has the address from the customer
  });

  it('cannot dismiss "pickup or mail?" — that needs an actual choice', () => {
    const o = norm({ collectsAddress: true, shippingAddress: DALLAS, metadata: { customer_check: 'dismissed' } });
    expect(o.stage).toBe('check_customer');
    expect(codes(o)).toContain('unknown_method');
  });

  it('a manual flag with a note', () => {
    const o = norm({ metadata: { customer_check: 'open', customer_check_note: 'lives in Austin?' } });
    expect(o.stage).toBe('check_customer');
    expect(o.customerCheck).toMatchObject({ manual: true, note: 'lives in Austin?' });
    expect(o.issues.find((i) => i.code === 'customer_check')?.message).toContain('lives in Austin?');
  });

  it('real problems still outrank it', () => {
    const o = norm({ paymentStatus: 'unpaid', billingAddress: { state: 'CA' } });
    expect(o.stage).toBe('problem');
  });

  it('once picked up, the hint no longer matters', () => {
    const o = norm({ billingAddress: { state: 'CA' }, metadata: { fulfillment_status: 'picked_up' } });
    expect(o.stage).toBe('picked_up');
    expect(o.customerCheck.open).toBe(false);
  });
});
