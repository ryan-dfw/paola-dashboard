// READ-ONLY inspection of the real Checkout Sessions.
//
//   npm run inspect               (uses STRIPE_SECRET_KEY from .env)
//   npm run inspect -- --limit 20
//
// Lists every Checkout Session in the account (all statuses), then for each
// completed one prints exactly which Stripe fields exist (line items,
// product metadata, shipping rate, shipping details, custom fields, tax,
// refunds) and how the dashboard classifies it. Makes NO writes: only
// list/retrieve calls. Output with customer details goes to
// inspect-output/ (gitignored) — don't commit or share it.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import type Stripe from 'stripe';
import { readConfig } from '../server/env';
import { normalizeSession } from '../server/normalize';
import { loadProducts, stripeFor } from '../server/orders';

const argLimit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;

function money(n: number | null | undefined) {
  return typeof n === 'number' ? `$${(n / 100).toFixed(2)}` : '—';
}

async function main() {
  const config = readConfig();
  const stripe = stripeFor(config);
  console.log(`Key: ${config.stripeSecretKey?.slice(0, 8)}… (read-only calls only)\n`);

  const products = await loadProducts(stripe, true);
  console.log(`PRODUCTS (${products.size}, incl. archived)`);
  for (const p of products.values()) {
    const price = typeof p.default_price === 'string' ? p.default_price : p.default_price?.id;
    console.log(`  ${p.id}  active=${p.active}  "${p.name}"  metadata=${JSON.stringify(p.metadata)}  default_price=${price ?? '—'}`);
  }

  const rates: Stripe.ShippingRate[] = [];
  try {
    for await (const r of stripe.shippingRates.list({ limit: 100 })) rates.push(r);
  } catch (err) {
    console.log(`\n(could not list shipping rates: ${(err as Error).message})`);
  }
  console.log(`\nSHIPPING RATES (${rates.length})`);
  for (const r of rates) {
    console.log(
      `  ${r.id}  active=${r.active}  "${r.display_name}"  ${money(r.fixed_amount?.amount)}  metadata=${JSON.stringify(r.metadata)}`,
    );
  }

  const statusCounts: Record<string, number> = {};
  const complete: Stripe.Checkout.Session[] = [];
  for await (const s of stripe.checkout.sessions.list({
    limit: 100,
    expand: ['data.line_items', 'data.payment_intent', 'data.payment_intent.latest_charge', 'data.shipping_cost.shipping_rate'],
  })) {
    statusCounts[`${s.status}/${s.payment_status}`] = (statusCounts[`${s.status}/${s.payment_status}`] || 0) + 1;
    if (s.status === 'complete') complete.push(s);
    if (complete.length >= argLimit) break;
  }
  console.log(`\nCHECKOUT SESSIONS by status/payment_status: ${JSON.stringify(statusCounts)}`);

  const lookup = (id: string) => products.get(id);
  const rows: unknown[] = [];
  const fieldPresence: Record<string, number> = {};
  const note = (k: string, present: unknown) => {
    if (present) fieldPresence[k] = (fieldPresence[k] || 0) + 1;
  };

  console.log(`\nCOMPLETED SESSIONS (${complete.length}), newest first:\n`);
  for (const s of complete) {
    const o = normalizeSession(s, lookup);
    const ci = (s as unknown as { collected_information?: { shipping_details?: unknown } }).collected_information;
    note('line_items', s.line_items?.data.length);
    note('metadata.productId', s.metadata?.productId);
    note('metadata.signed', s.metadata?.signed);
    note(
      'custom_fields.inscription_name',
      s.custom_fields?.some((f) => f.key === 'inscription_name'),
    );
    note('shipping_address_collection', s.shipping_address_collection);
    note('shipping_cost', s.shipping_cost);
    note('collected_information.shipping_details', ci?.shipping_details);
    note('shipping_details (legacy)', s.shipping_details);
    note('customer_details.address (billing)', s.customer_details?.address);
    note('customer_details.phone', s.customer_details?.phone);
    note('total_details.amount_tax>0', (s.total_details?.amount_tax ?? 0) > 0);
    note('total_details.amount_shipping>0', (s.total_details?.amount_shipping ?? 0) > 0);
    note('automatic_tax.enabled', s.automatic_tax?.enabled);
    note('dashboard fulfillment_status', s.metadata?.fulfillment_status);

    console.log(
      [
        new Date(s.created * 1000).toISOString().slice(0, 16).replace('T', ' '),
        s.id,
        `${s.payment_status}`,
        (o.customer.name || '—').padEnd(22).slice(0, 22),
        o.items
          .map(
            (i) =>
              `${i.quantity}× ${i.productName ?? i.description} [${i.kind}${i.language ? ' ' + i.language : ''}${i.format ? ' ' + i.format : ''}]`,
          )
          .join(' + '),
        `signed=${o.signed}${o.inscriptionName ? ` "${o.inscriptionName}"` : ''}`,
        `sub ${money(o.amounts.subtotal)} tax ${money(o.amounts.tax)} ship ${money(o.amounts.shipping)} total ${money(o.amounts.total)}`,
        `checkout: ${o.checkout.choice.toUpperCase()} (${o.checkout.choiceSource}) → now ${o.fulfillment.method ?? 'undecided'} / ${o.stage}`,
        o.issues.length ? `issues: ${o.issues.map((i) => `${i.severity}:${i.code}`).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('  |  '),
    );
    for (const sig of o.checkout.signals) console.log(`      · ${sig}`);

    rows.push({
      normalized: o,
      stripeFields: {
        id: s.id,
        created: s.created,
        status: s.status,
        payment_status: s.payment_status,
        metadata: s.metadata,
        custom_fields: s.custom_fields,
        shipping_address_collection: s.shipping_address_collection,
        shipping_options: s.shipping_options,
        shipping_cost: s.shipping_cost,
        shipping_details: s.shipping_details,
        collected_information: ci ?? null,
        customer_details: s.customer_details,
        total_details: s.total_details,
        automatic_tax: s.automatic_tax,
        amount_subtotal: s.amount_subtotal,
        amount_total: s.amount_total,
        line_items: s.line_items?.data.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          amount_total: li.amount_total,
          price: li.price?.id,
          product: li.price?.product,
        })),
      },
    });
  }

  console.log(`\nFIELD PRESENCE across ${complete.length} completed sessions:`);
  for (const [k, v] of Object.entries(fieldPresence)) console.log(`  ${String(v).padStart(4)}  ${k}`);

  mkdirSync('inspect-output', { recursive: true });
  const file = `inspect-output/sessions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ statusCounts, fieldPresence, rows }, null, 2));
  console.log(`\nFull detail written to ${file} (contains customer data — gitignored, don't share).`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
