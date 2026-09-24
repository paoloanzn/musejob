import { Hono } from 'hono';
import { requireAgent, requirePack } from '../auth';
import { checkUsdcTransfer } from '../checks';
import { type AppEnv, event, fail, isUniqueViolation, newId, optionalStr, readBody, startOfUtcDay, str, usdc } from '../lib';
import { rejectSubmission } from '../ledger';

// Master agent routes, mounted at /v1/master. The master shows each PR to the
// admin and approves only after the admin says yes; amounts and addresses
// always come from the ledger, never from request text.
export const masterRoutes = new Hono<AppEnv>();

masterRoutes.use('*', requirePack('codemarkets-master'), requireAgent('master'));

masterRoutes.get('/submissions', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'approved', 'rejected'].includes(status)) fail(400, 'invalid_status', "'status' must be pending, approved or rejected.");
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.job_id, j.title AS job_title, j.repo, j.reward_cents, s.pr_url, s.notes, s.status, s.reason,
            s.created_at, s.decided_at, a.id AS agent_id, a.name AS agent_name, a.github, a.owner_x, a.wallet,
            a.verified_at IS NOT NULL AS agent_verified, a.status AS agent_status
     FROM submissions s JOIN jobs j ON j.id = s.job_id JOIN agents a ON a.id = s.agent_id
     WHERE s.status = ? ORDER BY s.created_at ASC LIMIT 100`,
  )
    .bind(status)
    .all();
  return c.json({ submissions: results });
});

masterRoutes.post('/submissions/:id/approve', async (c) => {
  const master = c.get('agent');
  const db = c.env.DB;
  const sub = await db
    .prepare(
      `SELECT s.id, s.status, s.pr_url, j.id AS job_id, j.reward_cents, a.id AS agent_id, a.status AS agent_status, a.verified_at
       FROM submissions s JOIN jobs j ON j.id = s.job_id JOIN agents a ON a.id = s.agent_id WHERE s.id = ?`,
    )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string; pr_url: string; job_id: string; reward_cents: number; agent_id: string; agent_status: string; verified_at: number | null }>();
  if (!sub) fail(404, 'not_found', 'Submission not found.');
  const now = Date.now();
  const dayStart = startOfUtcDay(now);
  const limit = c.env.UNVERIFIED_REWARD_LIMIT_CENTS;
  const cap = c.env.DAILY_PAYOUT_CAP_CENTS;
  const payoutId = newId('pay');
  // The payout row is created first and every later statement depends on it,
  // so the daily cap, the job state and the payout change together or not at all.
  const [created] = await db.batch([
    db
      .prepare(
        `INSERT INTO payouts (id, job_id, submission_id, agent_id, amount_cents, to_address, status, created_at)
         SELECT ?1, j.id, s.id, a.id, j.reward_cents, a.wallet, 'pending', ?2
         FROM submissions s
         JOIN jobs j ON j.id = s.job_id AND j.submission_id = s.id AND j.status = 'submitted'
         JOIN agents a ON a.id = s.agent_id AND a.status = 'active'
         WHERE s.id = ?3 AND s.status = 'pending'
           AND (a.verified_at IS NOT NULL OR j.reward_cents < ?4)
           AND (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts WHERE created_at >= ?5) + j.reward_cents <= ?6`,
      )
      .bind(payoutId, now, sub.id, limit, dayStart, cap),
    db
      .prepare(`UPDATE submissions SET status = 'approved', decided_at = ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM payouts WHERE id = ?3)`)
      .bind(now, sub.id, payoutId),
    db
      .prepare(`UPDATE jobs SET status = 'approved', updated_at = ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM payouts WHERE id = ?3)`)
      .bind(now, sub.job_id, payoutId),
    event(db, { type: 'job.approved', public: true, actor: master.id, agentId: sub.agent_id, jobId: sub.job_id, data: { submission_id: sub.id, pr_url: sub.pr_url, amount_cents: sub.reward_cents } }, now),
  ]);
  if (created.meta.changes === 0) {
    if (sub.status !== 'pending') fail(409, 'not_pending', `Submission is ${sub.status}, not pending.`);
    if (sub.agent_status !== 'active') fail(409, 'agent_banned', 'The agent is banned.');
    if (!sub.verified_at && sub.reward_cents >= limit) {
      fail(409, 'agent_not_verified', 'The agent must verify (again) before a job of this size can be approved.');
    }
    fail(409, 'daily_cap_reached', `Approving would exceed the daily payout cap of ${cap} cents. Try again after 00:00 UTC.`);
  }
  const payout = await db.prepare('SELECT id, job_id, agent_id, amount_cents, to_address, status, created_at FROM payouts WHERE id = ?').bind(payoutId).first();
  return c.json({ payout });
});

masterRoutes.post('/submissions/:id/reject', async (c) => {
  const reason = optionalStr(await readBody(c), 'reason', 500);
  return c.json(await rejectSubmission(c.env.DB, c.req.param('id'), reason, c.get('agent').id));
});

masterRoutes.get('/payouts', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'paid'].includes(status)) fail(400, 'invalid_status', "'status' must be pending or paid.");
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.job_id, j.title AS job_title, p.agent_id, a.name AS agent_name, p.amount_cents, p.to_address,
            p.status, p.tx_hash, p.created_at, p.paid_at
     FROM payouts p JOIN jobs j ON j.id = p.job_id JOIN agents a ON a.id = p.agent_id
     WHERE p.status = ? ORDER BY p.created_at ASC LIMIT 100`,
  )
    .bind(status)
    .all<{ amount_cents: number }>();
  return c.json({
    usdc_address: c.env.USDC_ADDRESS,
    payouts: results.map((p) => ({ ...p, amount_usdc: usdc(p.amount_cents) })),
  });
});

masterRoutes.post('/payouts/:id/tx', async (c) => {
  const master = c.get('agent');
  const txHash = str(await readBody(c), 'tx_hash', 66).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) fail(400, 'invalid_field', "'tx_hash' must be a 0x-prefixed 32-byte hash.");
  const db = c.env.DB;
  const payout = await db
    .prepare('SELECT id, job_id, agent_id, amount_cents, to_address, status, created_at FROM payouts WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; job_id: string; agent_id: string; amount_cents: number; to_address: string; status: string; created_at: number }>();
  if (!payout) fail(404, 'not_found', 'Payout not found.');
  if (payout.status !== 'pending') fail(409, 'already_paid', 'This payout is already paid.');
  if (await db.prepare('SELECT 1 FROM payouts WHERE tx_hash = ?').bind(txHash).first()) {
    fail(409, 'tx_already_used', 'This transaction hash was already used for a payout.');
  }
  await checkUsdcTransfer(c.env, txHash, { from: master.wallet, to: payout.to_address, cents: payout.amount_cents, notBefore: payout.created_at });
  const now = Date.now();
  try {
    const [paid] = await db.batch([
      db.prepare(`UPDATE payouts SET status = 'paid', tx_hash = ?, paid_at = ? WHERE id = ? AND status = 'pending'`).bind(txHash, now, payout.id),
      db
        .prepare(`UPDATE jobs SET status = 'paid', updated_at = ?1 WHERE id = ?2 AND status = 'approved' AND EXISTS (SELECT 1 FROM payouts WHERE id = ?3 AND tx_hash = ?4)`)
        .bind(now, payout.job_id, payout.id, txHash),
      event(db, { type: 'job.paid', public: true, actor: master.id, agentId: payout.agent_id, jobId: payout.job_id, data: { amount_cents: payout.amount_cents, to_address: payout.to_address, tx_hash: txHash } }, now),
    ]);
    if (paid.meta.changes === 0) fail(409, 'already_paid', 'This payout is already paid.');
  } catch (err) {
    if (isUniqueViolation(err, 'tx_hash')) fail(409, 'tx_already_used', 'This transaction hash was already used for a payout.');
    throw err;
  }
  return c.json({ payout_id: payout.id, job_id: payout.job_id, status: 'paid', tx_hash: txHash, tx_url: `https://basescan.org/tx/${txHash}` });
});
