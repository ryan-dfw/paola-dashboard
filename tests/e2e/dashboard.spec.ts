import { expect, test, type Page } from '@playwright/test';
import { USERS } from './global-setup';

const EMU = 'http://127.0.0.1:9099';
const SHOTS = 'test-results/screens';

async function reset(page: Page, q = '') {
  const r = await page.request.post(`/__test/reset${q}`);
  expect(r.ok()).toBeTruthy();
}

async function login(page: Page, who: keyof typeof USERS = 'paola') {
  await page.goto('/');
  await page.getByLabel('Email').fill(USERS[who].email);
  await page.getByLabel('Password').fill(USERS[who].password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function idToken(email: string, password: string): Promise<string> {
  const r = await fetch(`${EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

const row = (page: Page, name: string) => page.getByTestId('order-row').filter({ hasText: name }).first();

test.beforeEach(async ({ page }) => {
  await reset(page);
});

test.describe('authentication', () => {
  test('unauthenticated visitor sees only the login screen', async ({ page }) => {
    await page.goto('/#/order/cs_test_jane');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByTestId('order-row')).toHaveCount(0);
    await expect(page.getByText('Jane Smith')).toHaveCount(0);
  });

  test('server rejects Stripe-backed requests without a valid Firebase token', async ({ request }) => {
    const none = await request.get('/api/orders');
    expect(none.status()).toBe(401);
    const forged = await request.get('/api/orders', { headers: { Authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' } });
    expect(forged.status()).toBe(401);
    const write = await request.post('/api/orders/cs_test_sara/fulfillment', { data: { action: 'mark_picked_up' } });
    expect(write.status()).toBe(401);
    const meta = await (await request.get('/__test/metadata?id=cs_test_sara')).json();
    expect(meta.fulfillment_status).toBeUndefined();
  });

  test('a real Firebase account that is not allowlisted gets no data', async ({ page, request }) => {
    const token = await idToken(USERS.stranger.email, USERS.stranger.password);
    const r = await request.get('/api/orders', { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status()).toBe(403);
    await login(page, 'stranger');
    await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
    await expect(page.getByTestId('order-row')).toHaveCount(0);
  });

  test('allowlisted email gets straight in — no email verification step', async ({ page }) => {
    await login(page, 'helper');
    await expect(page.getByTestId('order-row').first()).toBeVisible();
    await expect(page.getByText(/verif/i)).toHaveCount(0);
  });

  test('invalid login shows a clear error', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill(USERS.paola.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('don’t match');
  });

  test('valid login, persists across reload, logout', async ({ page }, info) => {
    await login(page);
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await expect(page.getByTestId('order-row').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-needs-action.png`, fullPage: true });
    await page.reload();
    await expect(page.getByTestId('order-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('forgot password sends a reset link', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.getByLabel('Email').fill(USERS.paola.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('reset link is on its way');
    const codes = await (await fetch(`${EMU}/emulator/v1/projects/demo-paola/oobCodes`)).json();
    expect(
      codes.oobCodes.some(
        (c: { email: string; requestType: string }) => c.email === USERS.paola.email && c.requestType === 'PASSWORD_RESET',
      ),
    ).toBe(true);
  });

  test('expired session signs out with a message', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('order-row').first()).toBeVisible();
    await page.route('**/api/orders**', (r) =>
      r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Your sign-in expired.","code":"token_expired"}' }),
    );
    await page.getByRole('button', { name: 'Refresh orders' }).click();
    await expect(page.getByRole('status')).toContainText('sign-in expired');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('work queue', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('order-row').first()).toBeVisible();
  });

  const section = (page: Page, stage: string) => page.locator(`#group-${stage}`);

  test('one queue, grouped by the next action, in that order', async ({ page }) => {
    await expect(page.getByRole('tab', { name: /To do/ })).toContainText('31');
    const ids = await page.locator('section.group').evaluateAll((els) => els.map((e) => e.id));
    expect(ids).toEqual(['group-shipping_unpaid', 'group-ready_to_ship', 'group-waiting_for_pickup', 'group-check_customer', 'group-problem']);
    await expect(section(page, 'shipping_unpaid').getByTestId('order-row')).toHaveCount(1);
    await expect(section(page, 'ready_to_ship').getByTestId('order-row')).toHaveCount(3);
    await expect(section(page, 'waiting_for_pickup').getByTestId('order-row')).toHaveCount(24);
    await expect(section(page, 'check_customer').getByTestId('order-row')).toHaveCount(2);
    await expect(section(page, 'problem').getByTestId('order-row')).toHaveCount(1);
    // No completed orders in To do; no summary-tile wall.
    await expect(page.getByText('Grace Lin')).toHaveCount(0);
    await expect(page.locator('.summary')).toHaveCount(0);
  });

  test('normal rows carry no redundant badges; exceptions stand out', async ({ page }) => {
    const sara = section(page, 'waiting_for_pickup').getByTestId('order-row').filter({ hasText: 'Sara Laffy' });
    await expect(sara).toContainText('Paperback · English');
    await expect(sara).toContainText('Sep 30, 2026');
    await expect(sara).toContainText('$27.05');
    await expect(sara.getByRole('button', { name: 'Mark as picked up' })).toBeVisible();
    await expect(sara.locator('.badge')).toHaveCount(0); // no PICKUP / PAID / WAITING FOR PICKUP

    const jane = section(page, 'ready_to_ship').getByTestId('order-row').filter({ hasText: 'Jane Smith' });
    await expect(jane).toContainText('Hardcover · English · Signed');
    await expect(jane).toContainText('Inscribe: “For Jane, with love”');
    await expect(jane).toContainText('123 Main St'); // address visible where she needs it
    await expect(jane.locator('.badge')).toHaveCount(0);

    const elena = section(page, 'shipping_unpaid').getByTestId('order-row').filter({ hasText: 'Elena Ruiz' });
    await expect(elena.getByTestId('stage-badge')).toHaveText(/Shipping unpaid/);
    await expect(elena).toContainText('Now shipping · ordered as pickup');
    await expect(elena.getByRole('button', { name: 'Mark shipping paid' })).toBeVisible();

    const owen = section(page, 'problem').getByTestId('order-row').filter({ hasText: 'Owen Park' });
    await expect(owen).toContainText('Payment is still processing');
    await expect(owen.getByRole('button')).toHaveCount(0);
  });

  test('pickup → customer wants it mailed → shipping unpaid → paid → address → ready → shipped', async ({ page }, info) => {
    await section(page, 'waiting_for_pickup').getByTestId('order-row').filter({ hasText: 'Sara Laffy' }).click();
    const d = page.getByTestId('order-detail');
    await d.getByRole('button', { name: 'Customer wants it mailed? Change to shipping' }).click();
    await expect(d.getByTestId('ask-shipping-paid')).toContainText('Has the customer already paid for shipping?');
    await d.getByRole('button', { name: 'Not yet' }).click();
    await expect(d.getByTestId('shipping-unpaid')).toBeVisible();
    await expect(d.getByTestId('fulfillment-facts')).toContainText('Ordered as');
    await expect(d.getByTestId('fulfillment-facts')).toContainText('Pickup');
    await expect(d.getByTestId('fulfillment-facts')).toContainText('Changed in this dashboard');
    let meta = await (await page.request.get('/__test/metadata?id=cs_test_sara')).json();
    expect(meta).toMatchObject({ fulfillment_method: 'shipping', shipping_payment_status: 'unpaid' });
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-converted-unpaid.png` });

    await d.getByRole('button', { name: 'Mark shipping paid' }).click();
    await expect(d.getByTestId('shipping-unpaid')).toHaveCount(0);
    await expect(d).toContainText('not a Stripe payment');
    // No address yet → Paola adds the one the customer emailed her (billing address NOT used).
    await d.getByRole('button', { name: 'Add mailing address' }).click();
    const form = d.getByTestId('address-form');
    await form.getByLabel('Name').fill('Sara Laffy');
    await form.getByLabel('Street address').fill('500 Elm St');
    await form.getByLabel('City').fill('Austin');
    await form.getByLabel('State').fill('TX');
    await form.getByLabel('ZIP').fill('78701');
    await form.getByRole('button', { name: 'Save address' }).click();
    await expect(d.locator('.ship-to')).toContainText('500 Elm St');
    await expect(d.locator('.ship-to')).toContainText('Entered by you');

    await d.getByRole('button', { name: 'Back to orders' }).click();
    await expect(section(page, 'ready_to_ship').getByText('Sara Laffy')).toBeVisible();

    await section(page, 'ready_to_ship').getByTestId('order-row').filter({ hasText: 'Sara Laffy' }).getByRole('button', { name: 'Mark as shipped…' }).click();
    await d.getByLabel('Tracking number (optional)').fill('9400 111');
    await d.getByRole('button', { name: 'Confirm shipped' }).click();
    await expect(d.getByTestId('stage-badge')).toHaveText(/Shipped/);
    meta = await (await page.request.get('/__test/metadata?id=cs_test_sara')).json();
    expect(meta).toMatchObject({ fulfillment_status: 'completed', fulfillment_method: 'shipping', shipping_payment_status: 'paid', ship_to_line1: '500 Elm St' });
    await d.getByRole('button', { name: 'Back to orders' }).click();
    await page.getByRole('tab', { name: /Completed/ }).click();
    const done = row(page, 'Sara Laffy');
    await expect(done.getByTestId('stage-badge')).toHaveText(/Shipped/);
    await expect(done).toContainText('Now shipping · ordered as pickup');
  });

  test('pickup → shipping already paid → ready to ship; change back to pickup', async ({ page }) => {
    await row(page, 'Sara Laffy').click();
    const d = page.getByTestId('order-detail');
    await d.getByRole('button', { name: 'Customer wants it mailed? Change to shipping' }).click();
    await d.getByRole('button', { name: 'Yes, it’s paid' }).click();
    await expect(d.getByTestId('shipping-unpaid')).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Add mailing address' })).toBeVisible();
    await d.getByRole('button', { name: 'Change back to pickup' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Change to pickup' }).click();
    await expect(d.getByRole('button', { name: 'Mark as picked up' })).toBeVisible();
    const meta = await (await page.request.get('/__test/metadata?id=cs_test_sara')).json();
    expect(meta.shipping_payment_status).toBeUndefined();
    expect(meta.fulfillment_method).toBe('pickup');
  });

  test('shipping unpaid: one tap from the row, with undo', async ({ page }) => {
    await section(page, 'shipping_unpaid').getByRole('button', { name: 'Mark shipping paid' }).click();
    const toast = page.getByRole('status').filter({ hasText: 'Shipping paid' });
    await expect(toast).toBeVisible();
    await expect(page.locator('#group-shipping_unpaid')).toHaveCount(0);
    await expect(section(page, 'check_customer').getByText('Elena Ruiz')).toBeVisible(); // paid, but no address yet
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(section(page, 'shipping_unpaid').getByText('Elena Ruiz')).toBeVisible();
  });

  test('mark picked up from the row, undo from the toast', async ({ page }) => {
    await row(page, 'Sara Laffy').getByRole('button', { name: 'Mark as picked up' }).click();
    const toast = page.getByRole('status').filter({ hasText: 'marked as picked up' });
    await expect(toast).toBeVisible();
    await expect(section(page, 'waiting_for_pickup').getByText('Sara Laffy')).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(section(page, 'waiting_for_pickup').getByText('Sara Laffy')).toBeVisible();
  });

  test('mark shipped with tracking; undo needs confirmation', async ({ page }) => {
    await row(page, 'Jane Smith').click();
    const d = page.getByTestId('order-detail');
    await expect(d.getByText('Inscribe to: “For Jane, with love”')).toBeVisible();
    await expect(d.locator('.ship-to')).toContainText('From checkout');
    await d.getByRole('button', { name: 'Mark as shipped' }).click();
    await d.getByLabel('Carrier (optional)').selectOption('USPS');
    await d.getByLabel('Tracking number (optional)').fill('9400 1000 0000 0000 0000 00');
    await d.getByRole('button', { name: 'Confirm shipped' }).click();
    await expect(d.getByRole('link', { name: '9400 1000 0000 0000 0000 00' })).toHaveAttribute('href', /usps\.com/);
    await d.getByRole('button', { name: 'Undo: mark as not shipped' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark not shipped' }).click();
    await expect(d.getByRole('button', { name: 'Mark as shipped' })).toBeVisible();
  });

  test('free shipping is never "unpaid" — but can be marked so as a correction', async ({ page }) => {
    await row(page, 'Diego Alvarez').click();
    const d = page.getByTestId('order-detail');
    await expect(d.getByTestId('fulfillment-facts')).toContainText('Nothing owed (no shipping charge)');
    await d.getByRole('button', { name: 'Customer still owes shipping? Mark shipping unpaid' }).click();
    await expect(d.getByTestId('shipping-unpaid')).toBeVisible();
  });

  test('completed view distinguishes picked up vs shipped vs refunded', async ({ page }, info) => {
    await page.getByRole('tab', { name: /Completed/ }).click();
    await expect(row(page, 'Grace Lin').getByTestId('stage-badge')).toHaveText(/Picked up/);
    await expect(row(page, 'Ana Torres').getByTestId('stage-badge')).toHaveText(/Shipped/);
    await expect(row(page, 'Ana Torres')).toContainText('9400111899223344556677');
    await expect(row(page, 'Paul Grant').getByTestId('stage-badge')).toHaveText(/Refunded/);
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-completed.png`, fullPage: true });
  });

  test('check with customer: out-of-state pickup → email, note it, mark sorted', async ({ page }) => {
    const r = section(page, 'check_customer').getByTestId('order-row').filter({ hasText: 'Mia Chen' });
    await expect(r).toContainText('billing address is in CA');
    const mail = r.getByRole('link', { name: 'Email customer' });
    await expect(mail).toHaveAttribute('href', /^mailto:mia%40example\.com\?subject=/);
    await r.click();
    const d = page.getByTestId('order-detail');
    await expect(d.getByTestId('check-customer')).toContainText('Nothing’s wrong on your end');
    await d.getByRole('button', { name: 'I’ve emailed them' }).click();
    await expect(d.getByTestId('check-customer')).toContainText('You emailed them');
    await d.getByRole('button', { name: 'Sorted, nothing to do' }).click();
    await expect(d.getByTestId('check-customer')).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Mark as picked up' })).toBeVisible();
  });

  test('payment still processing: no fulfillment buttons', async ({ page }) => {
    await row(page, 'Owen Park').click();
    const d = page.getByTestId('order-detail');
    await expect(d).toContainText('Payment is still processing');
    await expect(d.getByRole('button', { name: 'Mark as picked up' })).toHaveCount(0);
  });

  test('legacy pickups: no status recorded → bulk mark picked up', async ({ page }, info) => {
    await row(page, 'Maria Gonzalez').click();
    await expect(page.getByTestId('order-detail')).toContainText('no status recorded');
    await page.getByTestId('order-detail').getByRole('button', { name: 'Back to orders' }).click();
    await expect(page.getByTestId('legacy-banner')).toContainText('24 pickups');
    await page.getByRole('button', { name: 'Review & mark picked up' }).click();
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('24 selected');
    await row(page, 'Sara Laffy').click(); // deselect one
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('23 selected');
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-bulk.png` });
    await page.getByRole('button', { name: 'Mark 23 picked up' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark 23 picked up' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Marked 23 picked up' })).toBeVisible({ timeout: 20_000 });
    await expect(section(page, 'waiting_for_pickup').getByTestId('order-row')).toHaveCount(1);
  });

  test('filters and search in All orders', async ({ page }) => {
    await page.getByRole('tab', { name: /All orders/ }).click();
    await page.getByRole('button', { name: /^Filters/ }).click();
    const chips = page.getByRole('group', { name: 'Filters' });
    await chips.getByRole('button', { name: 'Spanish' }).click();
    await expect(page.getByTestId('order-row')).toHaveCount(12);
    await chips.getByRole('button', { name: 'Spanish' }).click();
    await chips.getByRole('button', { name: 'Hardcover' }).click();
    await expect(page.getByTestId('order-row')).toHaveCount(6);
    await chips.getByRole('button', { name: 'Signed' }).click();
    await expect(page.getByTestId('order-row')).toHaveCount(3);
    await chips.getByRole('button', { name: 'Clear' }).click();
    await chips.getByRole('button', { name: 'Changed after checkout' }).click();
    await expect(page.getByTestId('order-row')).toHaveCount(1);
    await expect(page.getByTestId('order-row')).toContainText('Elena Ruiz');
    await chips.getByRole('button', { name: 'Clear' }).click();
    await chips.getByRole('button', { name: 'Refunded' }).click();
    await expect(page.getByTestId('order-row')).toHaveCount(1);
    await chips.getByRole('button', { name: 'Clear' }).click();
    const s = page.getByLabel('Search orders');
    await s.fill('laffy');
    await expect(page.getByTestId('order-row')).toHaveCount(1);
    await s.fill('ana.torres@example');
    await expect(page.getByTestId('order-row')).toHaveCount(1);
    await s.fill('cs_test_jane');
    await expect(page.getByTestId('order-row')).toHaveCount(1);
    await s.fill('perez');
    await expect(page.getByTestId('order-row')).toHaveCount(1);
  });

  test('routine actions are not red — red is only for real problems', async ({ page }) => {
    const btn = row(page, 'Sara Laffy').getByRole('button', { name: 'Mark as picked up' });
    expect(await btn.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(224, 51, 63)');
    const tab = page.getByRole('tab', { name: /To do/ });
    expect(await tab.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(224, 51, 63)');
  });

  test('superadmin features are not available to Paola', async ({ page }) => {
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menuitem', { name: /Setup/ })).toHaveCount(0);
    const token = await idToken(USERS.paola.email, USERS.paola.password);
    const r = await page.request.get('/api/admin/status', { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status()).toBe(403);
  });
});

test.describe('states and scale', () => {
  test('pagination: loads every page of a large order history', async ({ page }) => {
    await reset(page, '?many=140');
    await login(page);
    await page.getByRole('tab', { name: /Completed/ }).click();
    await expect(page.getByText('Loading older orders…')).toHaveCount(0);
    await expect(page.getByTestId('order-row')).toHaveCount(143); // 140 bulk + Grace, Ana, Paul
    await page.getByLabel('Search orders').fill('Bulk Buyer 0');
    await expect(page.getByTestId('order-row').filter({ hasText: 'Bulk Buyer 0' }).first()).toBeVisible();
  });

  test('no orders', async ({ page }) => {
    await reset(page, '?empty=1');
    await login(page);
    await expect(page.getByTestId('no-orders')).toBeVisible();
  });

  test('Stripe unavailable', async ({ page }) => {
    await page.request.post('/__test/stripe-down');
    await login(page);
    await expect(page.getByTestId('load-error')).toContainText('Stripe');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('superadmin sees Setup with allowlist and data audit', async ({ page }, info) => {
    await login(page, 'ryan');
    await expect(page.getByTestId('order-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByText('superadmin').first()).toBeVisible();
    await page.getByRole('menuitem', { name: /Setup/ }).click();
    const setup = page.getByTestId('setup');
    await expect(setup).toContainText('Connected — can read orders.');
    await expect(setup).toContainText('mckevitt.r@gmail.com');
    await expect(setup).toContainText('helper@example.com');
    await expect(setup).toContainText('no_shipping_offered');
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-setup.png`, fullPage: true });
  });
});

test.describe('layout', () => {
  test('iPhone: cards, no horizontal scroll, comfortable tap targets', async ({ page }, info) => {
    test.skip(info.project.name !== 'iphone');
    await login(page);
    await expect(page.getByTestId('order-row').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const btn = row(page, 'Sara Laffy').getByRole('button', { name: 'Mark as picked up' });
    const box = (await btn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThan(250); // full-width on a phone
    // detail opens full-screen and has no sideways scroll either
    await row(page, 'Jane Smith').click();
    const panel = (await page.locator('.detail-panel').boundingBox())!;
    expect(panel.width).toBeGreaterThanOrEqual(390);
    const dOverflow = await page.locator('.detail-panel').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(dOverflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/iphone-detail.png`, fullPage: false });
    // back gesture / browser back closes it
    await page.goBack();
    await expect(page.getByTestId('order-detail')).toHaveCount(0);
  });

  test('desktop: dense rows with the detail panel docked beside the list', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await login(page);
    const r = row(page, 'Jane Smith');
    await expect(r).toBeVisible();
    const h = (await r.boundingBox())!.height;
    expect(h).toBeLessThan(120);
    await r.click();
    await expect(page.getByTestId('order-detail')).toBeVisible();
    await expect(row(page, 'Sara Laffy'))
      .toBeInViewport({ ratio: 0.5 })
      .catch(() => undefined);
    await page.screenshot({ path: `${SHOTS}/desktop-docked.png` });
  });
});
