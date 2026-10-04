// Reset the Auth emulator and create the test accounts.
const EMU = 'http://127.0.0.1:9099';
const PROJECT = 'demo-paola';

export const USERS = {
  paola: { email: 'paola@example.com', password: 'correct-horse-1', verified: true },
  ryan: { email: 'mckevitt.r@gmail.com', password: 'superadmin-pass-1', verified: true },
  stranger: { email: 'stranger@example.com', password: 'stranger-pass-1', verified: true },
  helper: { email: 'helper@example.com', password: 'helper-pass-1', verified: false },
};

export default async function globalSetup() {
  await fetch(`${EMU}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  for (const u of Object.values(USERS)) {
    const r = await fetch(`${EMU}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ email: u.email, password: u.password, emailVerified: u.verified }),
    });
    if (!r.ok) throw new Error(`seed ${u.email}: ${r.status} ${await r.text()}`);
  }
}
