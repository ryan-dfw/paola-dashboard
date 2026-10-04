# paola_book_dashboard

Private order and fulfillment dashboard for Paola's book sales. It answers two questions:

1. **What do I need to do?** (the **Needs Action** tab, the default)
2. **What has already happened?** (the **Completed** and **All Orders** tabs)

It's a separate sibling of `paola_book_sales/` and uses the same Stripe account. The storefront is not changed.

```
React + Vite (src/)  ──Firebase ID token──▶  Netlify Functions (netlify/functions → server/)  ──secret key──▶  Stripe
        ▲                                         │ verifies the token (jose, Google's certs)
        └──── Firebase Auth (email/password) ─────┘ checks DASHBOARD_USERS / DASHBOARD_SUPERADMINS
```

---

## How the storefront records an order (what the dashboard reads)

From `paola_book_sales/netlify/functions/create-checkout-session.js` (local clone, last commit Sep 21):

| Fact | Where it lives in Stripe |
|---|---|
| Product | `line_items[].price.product` → Stripe Product. One Checkout Session per purchase, `quantity: 1` |
| Language | Product `metadata.lang` = `en` / `es` |
| Hardcover / paperback | Product `metadata.format` = `hardcover` / `softcover` (shown as "Paperback") |
| Signed | Session `metadata.signed` = `yes` / `no` (also `metadata.productId`) |
| Inscription name | Session `custom_fields[key=inscription_name].text.value` (only offered when signed) |
| Name / email / phone | `customer_details` |
| Tax / shipping / total | `total_details.amount_tax`, `total_details.amount_shipping`, `amount_total` |
| Refunds / disputes | `payment_intent.latest_charge.amount_refunded` / `.disputed` |

**Important:** that local clone collects **no shipping and no tax**. The deployed site has a "$6 shipping (continental US)" checkbox and charges tax, so production is newer than the copy on this Mac. The dashboard handles every shape Stripe uses for shipping. Run the inspection below to confirm against the real data.

### Pickup vs shipping

The dashboard classifies orders from what Stripe recorded at checkout, never from amounts:

1. **A shipping option was chosen** (`shipping_cost.shipping_rate`). The result is SHIPPING, or PICKUP if the rate is named or tagged as a pickup (`metadata.fulfillment_method = pickup`).
2. **A shipping line item** (a product tagged `metadata.kind = shipping`, or named "Shipping"). The result is SHIPPING.
3. **Storefront metadata** (`metadata.shipping = yes/no`). Used if the storefront sets it.
4. **None of the above, and checkout didn't ask for an address.** The result is PICKUP ("no shipping offered"). This covers the launch-event orders.
5. **Signals disagree, or an address was collected with no shipping charge.** The order is flagged **"Pickup or shipping?"** and Paola picks one. The dashboard never guesses.

The card billing address (`customer_details.address`) is **never** treated as a shipping address. It only appears as a hint on orders that are missing one.

## The fulfillment model (no extra database)

Four things are kept separate, so pickup and shipping can change after purchase without rewriting history.

| Concept | Values | Where it comes from |
|---|---|---|
| **Checkout choice** | pickup · shipping · unknown | Stripe's Checkout Session. Read-only; never rewritten |
| **Current method** | pickup · shipping | `fulfillment_method` metadata if Paola set it, else the checkout choice |
| **Fulfillment status** | waiting · completed | `fulfillment_status` (completed means picked up for pickup, shipped for shipping) |
| **Shipping payment** | not_applicable · unpaid · paid | `shipping_payment_status` if Paola recorded it; else *paid* if Stripe charged shipping; else *not applicable* |

A missing Stripe shipping charge never means *unpaid*, because free shipping is legitimate. *Unpaid* is only ever recorded by hand. *Mark shipping paid* records that Paola got the money somehow. It is not a Stripe payment, and the dashboard never claims Stripe processed it.

The **work-queue stage** is derived from those four and never stored:

```
Shipping unpaid → Ready to ship → Shipped
Waiting for pickup → Picked up
(+ Check with customer, Problems, Refunded)
```

Typical change: *Waiting for pickup* → **Change to shipping** (asks "already paid for shipping?"). That gives *Shipping unpaid* or *Ready to ship*. Then **Mark shipping paid**, then **Mark as shipped**. Corrections: *Change back to pickup*, *Mark shipping unpaid* (only when Stripe didn't charge shipping), and *Undo: mark as not shipped / picked up*. Every row action also offers Undo in the toast.

A changed order keeps both facts: "Ordered as: Pickup" (Stripe) and "Now: Shipping" (dashboard, with the date changed).

Metadata keys the dashboard owns (Checkout Session, mirrored to the PaymentIntent; storefront keys untouched):

```
fulfillment_method        pickup | shipping
fulfillment_status        waiting | completed     (older values pending|shipped|picked_up are still read)
fulfilled_at, carrier, tracking_number
shipping_payment_status   unpaid | paid           (set by hand only)
shipping_paid_at, method_changed_at
ship_to_name, ship_to_line1, ship_to_line2, ship_to_city, ship_to_state, ship_to_postal_code, ship_to_country
                          mailing address Paola entered (Stripe's checkout address is never changed)
customer_check            open | dismissed;  customer_check_note, customer_contacted_at
fulfillment_updated_at, fulfillment_updated_by
```

**Legacy orders** (no dashboard metadata) start as *waiting* and are never assumed completed or shipping-paid. Their method comes from checkout. Ambiguous checkouts land in *Check with customer* until someone picks pickup or shipping. Pre-dashboard pickups can be cleared with **Review & mark picked up**.

**Problems vs. "Check with customer".** Red is only for things that have actually gone wrong: payment failed or still processing, a dispute, or unreadable data. Customer-side questions are a calm **Check with customer** state instead: no mailing address yet, unclear pickup vs mail, or pickup with an out-of-state card billing address (a soft hint only). Each comes with a pre-written email (Spanish for Spanish editions), *I've emailed them*, and *Sorted*.

---

## Environment variables

See `.env.example`. **Server-only** variables are never prefixed `VITE_`.

| Name | Where | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | server | Same account as the storefront. A **restricted key** is recommended: Checkout Sessions *write*, PaymentIntents *write*, Charges *read*, Products *read*, Shipping rates *read* |
| `FIREBASE_PROJECT_ID` | server | Optional. Falls back to `VITE_FIREBASE_PROJECT_ID` |
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | server | Optional. Enables the Setup screen's account tools and revoked-token checks |
| `DASHBOARD_USERS` | server | Comma-separated emails or Firebase UIDs, e.g. Paola's |
| `DASHBOARD_SUPERADMINS` | server | `mckevitt.r@gmail.com` |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | client | Firebase web config. Public by design |

### Roles

- **user** (Paola): everything about orders.
- **superadmin** (Ryan): everything a user has, plus **Account menu → Setup & data audit**. That screen has an env/Stripe health check, the allowlist with each account's status, account creation, and a table showing how every order was classified, with copy-as-JSON. The server enforces this role on every `/api/admin/*` call.

### Security model

- **No firebase-admin.** ID tokens are verified with [`jose`](https://github.com/panva/jose) exactly as Firebase documents for third-party JWT libraries (RS256, Google's securetoken certs, `aud`/`iss` = the project, `exp`/`iat`/`auth_time`, non-empty `sub`). The superadmin account tools call the Identity Toolkit REST API with the service account. (firebase-admin pulls in `jwks-rsa`, which `require()`s the ESM-only `jose@6` and crashes Netlify Functions with `ERR_REQUIRE_ESM`.) With service-account credentials set, disabled accounts and revoked sessions are also refused.
- The Auth emulator's unsigned tokens are accepted **only** when `FIREBASE_AUTH_EMULATOR_HOST` is set and the Netlify `CONTEXT` is unset or `dev` — never in a deployed site.

- Every `/api/*` function verifies the Firebase ID token server-side **before** touching Stripe. A missing, forged or expired token gets 401. A valid Firebase user who isn't on the allowlist gets 403.
- Allowlist entries match by email (case-insensitive) or UID. There's no email-verification step, so **turning off self sign-up in Firebase is what keeps this safe** (step 1 below): then only accounts you create exist.
- Responses are `no-store` and `noindex`. The browser only ever gets normalized `Order` objects, never raw Stripe objects.

---

## First-time setup

1. **Firebase:** create a project (or reuse one) and add a Web app to get the `VITE_FIREBASE_*` values.
   - Authentication → Sign-in method → enable **Email/Password**.
   - Authentication → Settings → User actions → **turn off "Enable create (sign-up)"**, so nobody can self-register.
   - Authentication → Settings → Authorized domains → add the Netlify domain.
   - Optional: Project settings → Service accounts → generate a key, for `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`.
2. **Your superadmin account:** Authentication → Users → Add user (your email). Sign in with it, and you're in.
3. **Netlify:** new site from this folder or repo, then set the env vars. The build command and functions are already in `netlify.toml`.
4. **Paola:** add her email to `DASHBOARD_USERS`, then in **Setup** tap *Create & email setup link*. She gets a "set your password" email, and only her inbox can complete it.
5. On her iPhone, open the site in Safari → Share → **Add to Home Screen**. It opens full-screen and stays signed in.

## Look at the real data first (read-only)

```
cp .env.example .env    # fill in STRIPE_SECRET_KEY at least
npm install
npm run inspect
```

This lists products, shipping rates and every Checkout Session, shows which fields each one has and how the dashboard classifies it, and writes the full detail to `inspect-output/`. That folder is gitignored and contains customer data. The script only makes list calls and never writes to Stripe.

## Develop

```
npm run dev            # UI only
netlify dev            # UI + functions on http://localhost:8889 (reads .env)
```

## Tests

```
npm test               # 78 unit/API tests: classification, token verification, auth, pagination, metadata merges (fake Stripe)
npm run test:e2e       # 52 Playwright tests, iPhone + desktop: real Firebase Auth emulator + real handlers + fake Stripe
```

The e2e suite starts the Firebase Auth emulator (`firebase.json`) and `tests/e2e/server.ts` itself. To use a local Chromium, set `PW_CHROMIUM=/path/to/chrome`.

---

## Storefront: recommended minimal changes (not applied)

Not required: the dashboard already reads the shapes Stripe produces. These would make future orders unambiguous:

1. When the shipping box is ticked, add `metadata.shipping = 'yes'` (and `'no'` otherwise) to the Checkout Session. If shipping is a Stripe Shipping Rate, also give the rate `metadata.fulfillment_method = 'shipping'`.
2. Keep using `shipping_address_collection` for shipped orders, so the address lands in `collected_information.shipping_details` rather than only the billing address.
