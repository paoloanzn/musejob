import { Hono } from 'hono';
import { requireAccess } from '../auth';
import { type AppEnv, event, fail, newId, optionalStr, readBody, str } from '../lib';
import { rejectSubmission, reopenAgentJobs } from '../ledger';

// Admin routes, mounted at /v1/admin behind Cloudflare Access.
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireAccess);

adminRoutes.post('/jobs', async (c) => {
  const body = await readBody(c);
  const title = str(body, 'title', 120);
  const description = str(body, 'description', 5000);
  const repo = str(body, 'repo', 140).toLowerCase();
  if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repo)) fail(400, 'invalid_field', "'repo' must look like owner/name.");
  const issueUrl = optionalStr(body, 'issue_url', 300);
  if (issueUrl && !issueUrl.startsWith('https://github.com/')) fail(400, 'invalid_field', "'issue_url' must be a GitHub URL.");
  const reward = body.reward_cents;
  if (!Number.isSafeInteger(reward) || (reward as number) <= 0) fail(400, 'invalid_field', "'reward_cents' must be a positive integer.");
  const ttl = body.claim_ttl_ms ?? c.env.DEFAULT_CLAIM_TTL_MS;
  if (!Number.isSafeInteger(ttl) || (ttl as number) < 600_000) fail(400, 'invalid_field', "'claim_ttl_ms' must be an integer of at least 600000.");
  const id = newId('job');
  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO jobs (id, title, description, repo, issue_url, reward_cents, claim_ttl_ms, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .bind(id, title, description, repo, issueUrl, reward, ttl, now, now),
    event(db, { type: 'job.created', public: true, actor: `admin:${c.get('admin')}`, jobId: id, data: { title, repo, reward_cents: reward } }, now),
  ]);
  return c.json({ job_id: id, status: 'open' }, 201);
});

adminRoutes.post('/agents/:id/ban', async (c) => {
  const reason = optionalStr(await readBody(c), 'reason', 500);
  const agentId = c.req.param('id');
  const actor = `admin:${c.get('admin')}`;
  const now = Date.now();
  const db = c.env.DB;
  const [banned] = await db.batch([
    db.prepare(`UPDATE agents SET status = 'banned' WHERE id = ? AND role = 'worker' AND status = 'active'`).bind(agentId),
    event(db, { type: 'agent.banned', public: true, actor, agentId, data: { reason } }, now),
    ...reopenAgentJobs(db, agentId, actor, 'agent banned', now),
  ]);
  if (banned.meta.changes === 0) fail(404, 'not_found', 'No active worker agent with that id.');
  return c.json({ agent_id: agentId, status: 'banned' });
});

adminRoutes.post('/submissions/:id/reject', async (c) => {
  const reason = optionalStr(await readBody(c), 'reason', 500);
  return c.json(await rejectSubmission(c.env.DB, c.req.param('id'), reason, `admin:${c.get('admin')}`));
});
