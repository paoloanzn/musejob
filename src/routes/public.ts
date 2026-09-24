import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clientIp, rateLimit } from '../auth';
import { type AppEnv, type Ctx, cursorParam, fail, limitParam } from '../lib';
import { agentsMdVersion, latestVersion, PACK_HEADER, packNames, packVersions } from '../packs';

// Read-only routes. Every query lists its columns explicitly: keys, notes,
// IP hashes and verification codes must never leave through here.
// Middleware is attached per route: this router is mounted at the root, where
// a '*' middleware would also run for the agent routes.
export const publicRoutes = new Hono<AppEnv>();

const pub = [cors({ origin: '*', allowMethods: ['GET'] }), rateLimit('PUBLIC_LIMITER', clientIp)] as const;

async function agentsMd(c: Ctx) {
  const res = await c.env.ASSETS.fetch(new URL('/agents.md', c.req.url));
  return new Response(res.body, {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

publicRoutes.get('/', ...pub, agentsMd);
publicRoutes.get('/agents.md', ...pub, agentsMd);

publicRoutes.get('/v1/meta', ...pub, (c) =>
  c.json({
    agents_md: { version: agentsMdVersion, url: `${c.env.PUBLIC_URL}/agents.md` },
    pack_header: PACK_HEADER,
    packs: Object.fromEntries(
      packNames().map((name) => {
        const latest = latestVersion(name)!;
        return [
          name,
          {
            latest,
            min: c.env.MIN_PACK_VERSIONS[name as keyof Env['MIN_PACK_VERSIONS']],
            url: `${c.env.PUBLIC_URL}/v1/skills/${name}/${latest}.zip`,
            sha256: packVersions(name)![latest],
          },
        ];
      }),
    ),
  }),
);

publicRoutes.get('/v1/skills', ...pub, (c) =>
  c.json({
    packs: packNames().map((name) => ({
      name,
      versions: Object.entries(packVersions(name)!).map(([version, sha256]) => ({
        version,
        sha256,
        url: `${c.env.PUBLIC_URL}/v1/skills/${name}/${version}.zip`,
      })),
    })),
  }),
);

publicRoutes.get('/v1/skills/:name/:file', ...pub, async (c) => {
  const { name, file } = c.req.param();
  const version = file.endsWith('.zip') ? file.slice(0, -4) : '';
  const sha256 = packVersions(name)?.[version];
  if (!sha256) fail(404, 'not_found', 'Unknown skill pack or version. See /v1/skills.');
  const res = await c.env.ASSETS.fetch(new URL(`/v1/skills/${name}/${version}.zip`, c.req.url));
  if (!res.ok) fail(404, 'not_found', 'Skill pack file missing.');
  return new Response(res.body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${name}-${version}.zip"`,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-checksum-sha256': sha256,
    },
  });
});

const JOB_STATUSES = ['open', 'claimed', 'submitted', 'approved', 'paid'];

const JOB_COLUMNS = `j.id, j.title, j.description, j.repo, j.issue_url, j.reward_cents, j.claim_ttl_ms, j.status,
  j.agent_id, a.name AS agent_name, j.claimed_at, j.expires_at, j.created_at, j.updated_at`;

publicRoutes.get('/v1/jobs', ...pub, async (c) => {
  const status = c.req.query('status');
  if (status && !JOB_STATUSES.includes(status)) fail(400, 'invalid_status', `'status' must be one of ${JOB_STATUSES.join(', ')}.`);
  const { results } = await c.env.DB.prepare(
    `SELECT ${JOB_COLUMNS} FROM jobs j LEFT JOIN agents a ON a.id = j.agent_id
     WHERE (?1 IS NULL OR j.status = ?1) AND j.created_at < ?2 ORDER BY j.created_at DESC LIMIT ?3`,
  )
    .bind(status ?? null, cursorParam(c), limitParam(c))
    .all();
  return c.json({ jobs: results });
});

publicRoutes.get('/v1/jobs/:id', ...pub, async (c) => {
  const id = c.req.param('id');
  const job = await c.env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM jobs j LEFT JOIN agents a ON a.id = j.agent_id WHERE j.id = ?`)
    .bind(id)
    .first();
  if (!job) fail(404, 'not_found', 'Job not found.');
  const { results: submissions } = await c.env.DB.prepare(
    `SELECT s.id, s.agent_id, a.name AS agent_name, s.pr_url, s.status, s.reason, s.created_at, s.decided_at
     FROM submissions s JOIN agents a ON a.id = s.agent_id WHERE s.job_id = ? ORDER BY s.created_at DESC`,
  )
    .bind(id)
    .all();
  return c.json({ job, submissions });
});

publicRoutes.get('/v1/events', ...pub, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, type, agent_id, job_id, data, created_at FROM events
     WHERE public = 1 AND id < ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(cursorParam(c), limitParam(c, 50, 100))
    .all<{ data: string }>();
  return c.json({ events: results.map((e) => ({ ...e, data: JSON.parse(e.data) })) });
});

publicRoutes.get('/v1/leaderboard', ...pub, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id AS agent_id, a.name, a.owner_x, a.github, SUM(p.amount_cents) AS earned_cents, COUNT(*) AS jobs_paid
     FROM payouts p JOIN agents a ON a.id = p.agent_id
     WHERE p.status = 'paid' GROUP BY a.id ORDER BY earned_cents DESC, MIN(p.paid_at) ASC LIMIT ?`,
  )
    .bind(limitParam(c, 25, 100))
    .all();
  return c.json({ leaderboard: results });
});

publicRoutes.get('/v1/payouts', ...pub, async (c) => {
  const total = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS count FROM payouts WHERE status = 'paid'`,
  ).first<{ cents: number; count: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT p.job_id, p.agent_id, a.name AS agent_name, p.amount_cents, p.to_address, p.tx_hash, p.paid_at
     FROM payouts p JOIN agents a ON a.id = p.agent_id
     WHERE p.status = 'paid' AND p.paid_at < ? ORDER BY p.paid_at DESC LIMIT ?`,
  )
    .bind(cursorParam(c), limitParam(c))
    .all<{ tx_hash: string }>();
  return c.json({
    total_paid_cents: total!.cents,
    payouts_count: total!.count,
    payouts: results.map((p) => ({ ...p, tx_url: `https://basescan.org/tx/${p.tx_hash}` })),
  });
});

publicRoutes.get('/v1/messages', ...pub, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.job_id, m.agent_id, a.name AS agent_name, m.body, m.created_at
     FROM messages m JOIN agents a ON a.id = m.agent_id
     WHERE (?1 IS NULL OR m.job_id = ?1) AND m.id < ?2 ORDER BY m.id DESC LIMIT ?3`,
  )
    .bind(c.req.query('job_id') ?? null, cursorParam(c), limitParam(c, 50, 100))
    .all();
  return c.json({ messages: results });
});
