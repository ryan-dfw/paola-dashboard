// Application-level shapes shared by the Netlify Functions (server/) and the
// React app (src/). These are deliberately NOT Stripe objects: the server
// turns each Stripe Checkout Session into one of these, and the browser
// never sees a raw Stripe object.

export type Language = 'en' | 'es';
export type BookFormat = 'hardcover' | 'paperback';

/**
 * The fulfillment model keeps three things independent:
 *   - what the customer chose AT CHECKOUT (Stripe's record — never rewritten)
 *   - the CURRENT fulfillment method (pickup ⇄ shipping; Paola can change it)
 *   - fulfillment status (waiting | completed) and shipping payment
 * The headline state shown in the UI is derived from those, never stored.
 */
export type CheckoutChoice = 'pickup' | 'shipping' | 'unknown';
export type FulfillmentMethod = 'pickup' | 'shipping';
/** For shipping, completed = shipped. For pickup, completed = picked up. */
export type FulfillmentStatus = 'waiting' | 'completed';

/** Where the pickup/shipping decision came from — shown in technical details and the data audit. */
export type MethodSource =
  | 'shipping_rate' // the customer picked a Stripe shipping rate at checkout
  | 'shipping_line_item' // a "shipping" product was a line item
  | 'session_metadata' // the storefront tagged the session when it created it
  | 'no_shipping_offered' // checkout neither offered nor charged shipping
  | 'conflict' // signals disagree
  | 'unknown';

/**
 * paid               — money has been collected
 * processing         — an async method (e.g. bank debit) hasn't cleared yet
 * unpaid             — checkout finished but payment did not complete
 * no_payment_required — e.g. a 100%-off promo code
 */
export type PaymentState = 'paid' | 'processing' | 'unpaid' | 'no_payment_required';
export type RefundState = 'none' | 'partial' | 'full';

/**
 * Shipping payment, meaningful only while the current method is shipping.
 *   not_applicable — pickup, or shipping with nothing owed (e.g. free shipping).
 *                    A missing Stripe shipping charge NEVER means "unpaid".
 *   unpaid         — recorded by Paola: the customer still owes shipping
 *   paid           — paid at checkout (Stripe charged it) or recorded by Paola
 */
export type ShippingPayment = 'not_applicable' | 'unpaid' | 'paid';
/** Where the shipping-payment fact comes from: Stripe's checkout charge, or Paola's record (not a Stripe payment). */
export type ShippingPaymentSource = 'checkout' | 'dashboard' | 'none';

/** Derived work-queue state: "what's next for this order?" */
export type Stage =
  | 'shipping_unpaid' // collect shipping, then ship
  | 'ready_to_ship' // mail it
  | 'waiting_for_pickup' // hand it over
  | 'check_customer' // ask the customer something first
  | 'problem' // something genuinely went wrong
  | 'shipped'
  | 'picked_up'
  | 'refunded';

export type Bucket = 'needs_action' | 'completed';

export type IssueCode =
  | 'payment_incomplete'
  | 'payment_processing'
  | 'unknown_method'
  | 'missing_address'
  | 'incomplete_address'
  | 'no_line_items'
  | 'unknown_product'
  | 'invalid_fulfillment_metadata'
  | 'method_conflict'
  | 'disputed'
  | 'partial_refund'
  | 'address_without_shipping'
  | 'signed_unknown'
  | 'missing_email'
  | 'session_not_complete'
  | 'pickup_far_away'
  | 'customer_check';

export interface Issue {
  code: IssueCode;
  /** "problem" keeps an unfulfilled order in Needs Action as a Problem; "warning" is informational. */
  /**
   * problem — something is genuinely wrong (payment failed, dispute, unreadable data). Red.
   * check   — nothing wrong on Paola's side; the customer probably made a choice
   *           worth confirming (e.g. picked "pickup" from out of state). Calm.
   * warning — informational only.
   */
  severity: 'problem' | 'check' | 'warning';
  message: string;
}

export interface Address {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface OrderItem {
  kind: 'book' | 'shipping' | 'other';
  description: string;
  productId: string | null;
  productName: string | null;
  priceId: string | null;
  language: Language | null;
  format: BookFormat | null;
  quantity: number;
  amountTotal: number;
}

export interface Order {
  id: string; // Checkout Session ID
  createdAt: string; // ISO
  livemode: boolean;

  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };

  items: OrderItem[];
  /** Book line items rolled up for the list view. */
  book: {
    title: string | null;
    language: Language | null;
    format: BookFormat | null;
    quantity: number;
    mixed: boolean; // more than one distinct book product in the order
  };
  signed: boolean | null; // null = the session never said
  inscriptionName: string | null;

  amounts: {
    currency: string;
    subtotal: number;
    tax: number;
    shipping: number;
    discount: number;
    total: number;
    refunded: number;
  };

  payment: {
    state: PaymentState;
    refund: RefundState;
    disputed: boolean;
  };

  /** What Stripe recorded at checkout. Never rewritten by the dashboard. */
  checkout: {
    choice: CheckoutChoice;
    choiceSource: MethodSource;
    /** Human-readable evidence used to classify — for the data audit. */
    signals: string[];
    shippingRateName: string | null;
    /** Shipping Stripe charged at checkout (shipping option + any shipping line item), in cents. */
    shippingCharged: number;
  };

  /** Paola's operational state, stored in Stripe metadata by this dashboard. */
  fulfillment: {
    /** Current method; null only when checkout was ambiguous and nobody has decided yet. */
    method: FulfillmentMethod | null;
    /** True when the current method differs from what was chosen at checkout. */
    changedFromCheckout: boolean;
    methodChangedAt: string | null;
    status: FulfillmentStatus;
    /** True when the dashboard has never recorded a status (orders from before the dashboard). */
    noStatusRecorded: boolean;
    completedAt: string | null;
    carrier: string | null;
    trackingNumber: string | null;
    /** Where to mail it: the address Paola entered, else the one collected at checkout. */
    address: Address | null;
    addressSource: 'dashboard' | 'checkout' | null;
    /** The shipping address Stripe collected at checkout, if any (unchanged). */
    checkoutAddress: Address | null;
    /** Card billing address. Never treated as a shipping address — shown only as a hint. */
    billingAddress: Address | null;
    updatedBy: string | null;
    updatedAt: string | null;
  };

  shippingPayment: {
    status: ShippingPayment;
    source: ShippingPaymentSource;
    /** When Paola recorded the shipping payment as received (dashboard source only). */
    paidAt: string | null;
  };

  /** "Check with customer": auto-detected reasons and/or a manual flag. */
  customerCheck: {
    open: boolean;
    manual: boolean;
    note: string | null;
    /** Paola dismissed the auto-detected reasons ("sorted, nothing to do"). */
    dismissed: boolean;
    contactedAt: string | null;
  };

  stage: Stage;
  bucket: Bucket;
  issues: Issue[];

  technical: {
    sessionId: string;
    paymentIntentId: string | null;
    chargeId: string | null;
    productIds: string[];
    priceIds: string[];
    shippingRateId: string | null;
    sessionStatus: string | null;
    paymentStatus: string | null;
    metadata: Record<string, string>;
    paymentIntentMetadata: Record<string, string>;
    customFields: { key: string; value: string | null }[];
  };
}

export interface OrdersPage {
  orders: Order[];
  /** Pass back as ?cursor= to get the next page. Null when there are no more. */
  nextCursor: string | null;
}

export type Role = 'user' | 'superadmin';

export interface Me {
  uid: string;
  email: string | null;
  role: Role;
}

export type FulfillmentAction =
  | { action: 'mark_picked_up' }
  | { action: 'mark_shipped'; carrier?: string; trackingNumber?: string }
  | { action: 'update_tracking'; carrier?: string; trackingNumber?: string }
  /** Undo "picked up" / "shipped". */
  | { action: 'mark_waiting' }
  /** Pickup (or undecided) → shipping. Ask whether shipping is already paid when it wasn't charged at checkout. */
  | { action: 'change_to_shipping'; shippingPaid?: boolean }
  | { action: 'change_to_pickup' }
  /** Records that Paola received/resolved the shipping payment. Not a Stripe payment. */
  | { action: 'mark_shipping_paid' }
  | { action: 'mark_shipping_unpaid' }
  /** Mailing address Paola got from the customer (e.g. for a pickup changed to shipping). Empty clears it. */
  | { action: 'set_shipping_address'; address: AddressInput | null }
  | { action: 'flag_customer_check'; note?: string }
  | { action: 'mark_customer_contacted' }
  | { action: 'resolve_customer_check' };

export interface AddressInput {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
}

export type FulfillmentRequest = FulfillmentAction & {
  /** Optimistic concurrency: the state the client last saw. */
  expectedStatus?: FulfillmentStatus;
  expectedMethod?: FulfillmentMethod | null;
  expectedShippingPayment?: ShippingPayment;
};

export interface ApiErrorBody {
  error: string;
  code: string;
}

// ---- superadmin ----

export interface AdminStatus {
  env: { name: string; present: boolean; note?: string }[];
  stripe: { ok: boolean; mode: 'live' | 'test' | 'unknown'; keyType: 'secret' | 'restricted' | 'unknown'; detail: string };
  firebase: { projectId: string | null; adminCredentials: boolean };
  allowlist: AllowlistEntry[];
}

export interface AllowlistEntry {
  value: string; // email or uid as written in the env var
  kind: 'email' | 'uid';
  role: Role;
  account:
    | { checked: false; reason: string }
    | { checked: true; exists: false }
    | {
        checked: true;
        exists: true;
        uid: string;
        email: string | null;
        disabled: boolean;
        lastSignIn: string | null;
      };
}
