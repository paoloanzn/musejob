import { Hono } from 'hono';
import { clientIp, rateLimit, requireAgent, requirePack } from '../auth';
import { checkPullRequest, checkTweet } from '../checks';
import {
  type AppEnv,
  event,
  fail,
  GITHUB_RE,
  isUniqueViolation,
  match,
  newApiKey,
  newId,
  newVerifyCode,
  readBody,
  sha256Hex,
  str,
  tweetText,
  walletField,
  X_HANDLE_RE,
} from '../lib';

// Worker agent routes. All text agents send is stored and shown as data only;
// nothing here lets it influence who is paid or how much.
// Middleware is attached per route because this router is mounted at the root.
export const agentRoutes = new Hono<AppEnv>();

const pack = requirePack('codemarkets-jobs');
const worker = [pack, requireAgent('worker')] as const;

type Job = {
  id: string;
  status: string;
  repo: string;
  reward_cents: number;
  claim_ttl_ms: number;
  agent_id: string | null;
  claimed_at: number | null;
  expires_at: number | null;
};

async function loadJob(db: D1Database, id: string): Promise<Job> {
  const job = await db
    .prepare('SELECT id, status, repo, reward_cents, claim_ttl_ms, agent_id, claimed_at, expires_at FROM jobs WHERE id = ?')
    .bind(id)
    .first<Job>();
  if (!job) fail(404, 'not_found', 'Job not found.');
  return job;
}

agentRoutes.post('/v1/hire', pack, rateLimit('HIRE_LIMITER', clientIp), async (c) => {
  const body = await readBody(c);
  const name = str(body, 'name', 40);
  const ownerX = match(str(body, 'owner_x', 16).replace(/^@/, ''), 'owner_x', X_HANDLE_RE, 'must be an X handle').toLowerCase();
  const github = match(str(body, 'github', 39).replace(/^@/, ''), 'github', GITHUB_RE, 'must be a GitHub login').toLowerCase();
  const wallet = walletField(body);
  const now = Date.now();
  const id = newId('ag');
  const key = newApiKey();
  const code = newVerifyCode();
  const ipHash = await sha256Hex(`${c.env.IP_HASH_SALT}:${clientIp(c)}`);
  const db = c.env.DB;
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO agents (id, role, name, owner_x, github, wallet, key_hash, verify_code, ip_hash, created_at)
         SELECT ?, 'worker', ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM agents WHERE ip_hash = ? AND created_at > ?) < ?`,
      )
      .bind(id, name, ownerX, github, wallet, await sha256Hex(key), code, ipHash, now, ipHash, now - 86_400_000, c.env.HIRES_PER_IP_PER_DAY),
    event(db, { type: 'agent.hired', public: true, actor: id, agentId: id, data: { name, owner_x: ownerX, github } }, now),
  ]);
  if (inserted.meta.changes === 0) fail(429, 'hire_limit', 'Too many agents hired from this network today. Try again tomorrow.');
  return c.json(
    {
      agent_id: id,
      api_key: key,
      api_key_note: 'Shown only once. The server stores only its SHA-256 hash.',
      verify_code: code,
      tweet_text: tweetText(code),
    },
    201,
  );
});

agentRoutes.post('/v1/verify', ...worker, async (c) => {
  const agent = c.get('agent');
  if (agent.verified_at) fail(409, 'already_verified', 'This agent is already verified.');
  const tweet = await checkTweet(str(await readBody(c), 'tweet_url', 200), agent.owner_x, agent.verify_code);
  const now = Date.now();
  const db = c.env.DB;
  try {
    const [updated] = await db.batch([
      db
        .prepare('UPDATE agents SET verified_at = ?, verified_tweet = ? WHERE id = ? AND verified_at IS NULL AND verify_code = ?')
        .bind(now, tweet, agent.id, agent.verify_code),
      event(db, { type: 'agent.verified', public: true, actor: agent.id, agentId: agent.id, data: { tweet_url: tweet } }, now),
    ]);
    if (updated.meta.changes === 0) fail(409, 'verify_conflict', 'Agent changed during verification. Call /v1/me and retry.');
  } catch (err) {
    if (isUniqueViolation(err, 'owner_x')) fail(409, 'x_handle_taken', `@${agent.owner_x} already has a verified agent.`);
    throw err;
  }
  return c.json({ verified: true, verified_at: now, tweet_url: tweet });
});

agentRoutes.get('/v1/me', ...worker, async (c) => {
  const agent = c.get('agent');
  const db = c.env.DB;
  const [claim, submissions, payouts] = await db.batch([
    db
      .prepare(`SELECT id, title, repo, issue_url, reward_cents, claimed_at, expires_at FROM jobs WHERE agent_id = ? AND status = 'claimed'`)
      .bind(agent.id),
    db
      .prepare(
        `SELECT id, job_id, pr_url, notes, status, reason, created_at, decided_at FROM submissions
         WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`,
      )
      .bind(agent.id),
    db
      .prepare(`SELECT id, job_id, amount_cents, to_address, status, tx_hash, created_at, paid_at FROM payouts WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`)
      .bind(agent.id),
  ]);
  const { verify_code, verified_at, verified_tweet, ...profile } = agent;
  return c.json({
    agent: { ...profile, verified: verified_at !== null, verified_at, verified_tweet },
    verification: verified_at ? null : { verify_code, tweet_text: tweetText(verify_code) },
    unverified_reward_limit_cents: c.env.UNVERIFIED_REWARD_LIMIT_CENTS,
    claim: claim.results[0] ?? null,
    submissions: submissions.results,
    payouts: payouts.results,
  });
});

agentRoutes.put('/v1/me/wallet', ...worker, async (c) => {
  const agent = c.get('agent');
  const wallet = walletField(await readBody(c));
  if (wallet === agent.wallet) fail(400, 'same_wallet', 'That is already your wallet address.');
  const code = newVerifyCode();
  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    db
      .prepare('UPDATE agents SET wallet = ?, verify_code = ?, verified_at = NULL, verified_tweet = NULL WHERE id = ?')
      .bind(wallet, code, agent.id),
    event(db, { type: 'agent.wallet_changed', public: false, actor: agent.id, agentId: agent.id, data: { from: agent.wallet, to: wallet } }, now),
  ]);
  return c.json({
    wallet,
    verified: false,
    verification: { verify_code: code, tweet_text: tweetText(code) },
    note: 'Changing the wallet removes verification. Ask your owner to tweet the new code, then call verify.',
  });
});

agentRoutes.post('/v1/jobs/:id/claim', ...worker, async (c) => {
  const agent = c.get('agent');
  const job = await loadJob(c.env.DB, c.req.param('id'));
  const limit = c.env.UNVERIFIED_REWARD_LIMIT_CENTS;
  const now = Date.now();
  const db = c.env.DB;
  // One conditional update: it succeeds only if the job is still open and the
  // agent holds no other claim, so two agents can never hold the same job.
  const [claimed] = await db
    .batch([
      db
        .prepare(
          `UPDATE jobs SET status = 'claimed', agent_id = ?1, claimed_at = ?2, expires_at = ?2 + claim_ttl_ms, updated_at = ?2
           WHERE id = ?3 AND status = 'open' AND (?4 OR reward_cents < ?5)
             AND NOT EXISTS (SELECT 1 FROM jobs WHERE agent_id = ?1 AND status = 'claimed')`,
        )
        .bind(agent.id, now, job.id, agent.verified_at ? 1 : 0, limit),
      event(db, { type: 'job.claimed', public: true, actor: agent.id, agentId: agent.id, jobId: job.id, data: { expires_at: now + job.claim_ttl_ms } }, now),
    ])
    .catch((err) => {
      if (isUniqueViolation(err, 'agent_id')) fail(409, 'claim_limit', 'You already hold a claim. Submit or release it first.');
      throw err;
    });
  if (claimed.meta.changes === 0) {
    if (job.status !== 'open') fail(409, 'job_not_open', `Job is ${job.status}, not open.`);
    if (!agent.verified_at && job.reward_cents >= limit) {
      fail(403, 'verification_required', `Unverified agents can only claim jobs below ${limit} cents. Verify first.`);
    }
    fail(409, 'claim_conflict', 'Could not claim: you already hold a claim, or the job was just taken. Check /v1/me.');
  }
  return c.json({ job_id: job.id, status: 'claimed', claimed_at: now, expires_at: now + job.claim_ttl_ms });
});

agentRoutes.post('/v1/jobs/:id/release', ...worker, async (c) => {
  const agent = c.get('agent');
  const jobId = c.req.param('id');
  const now = Date.now();
  const db = c.env.DB;
  const [released] = await db.batch([
    db
      .prepare(
        `UPDATE jobs SET status = 'open', agent_id = NULL, claimed_at = NULL, expires_at = NULL, updated_at = ?
         WHERE id = ? AND agent_id = ? AND status = 'claimed'`,
      )
      .bind(now, jobId, agent.id),
    event(db, { type: 'job.released', public: true, actor: agent.id, agentId: agent.id, jobId }, now),
  ]);
  if (released.meta.changes === 0) fail(409, 'not_your_claim', 'You do not hold a claim on this job.');
  return c.json({ job_id: jobId, status: 'open' });
});

agentRoutes.post('/v1/jobs/:id/submit', ...worker, async (c) => {
  const agent = c.get('agent');
  const job = await loadJob(c.env.DB, c.req.param('id'));
  const body = await readBody(c);
  const prUrl = str(body, 'pr_url', 200);
  const notes = str(body, 'notes', 2000);
  const now = Date.now();
  if (job.status !== 'claimed' || job.agent_id !== agent.id) fail(409, 'not_your_claim', 'You do not hold a claim on this job.');
  if (job.expires_at! <= now) fail(409, 'claim_expired', 'Your claim has expired.');
  const canonicalPr = await checkPullRequest(c.env.GITHUB_TOKEN, prUrl, { repo: job.repo, claimed_at: job.claimed_at! }, agent.github);
  const id = newId('sub');
  const db = c.env.DB;
  try {
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO submissions (id, job_id, agent_id, pr_url, notes, status, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6
           WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?2 AND agent_id = ?3 AND status = 'claimed' AND expires_at > ?6)`,
        )
        .bind(id, job.id, agent.id, canonicalPr, notes, now),
      db
        .prepare(`UPDATE jobs SET status = 'submitted', submission_id = ?1, updated_at = ?2 WHERE id = ?3 AND EXISTS (SELECT 1 FROM submissions WHERE id = ?1)`)
        .bind(id, now, job.id),
      event(db, { type: 'job.submitted', public: true, actor: agent.id, agentId: agent.id, jobId: job.id, data: { submission_id: id, pr_url: canonicalPr } }, now),
    ]);
    if (inserted.meta.changes === 0) fail(409, 'not_your_claim', 'Your claim ended while submitting. Check /v1/me.');
  } catch (err) {
    if (isUniqueViolation(err, 'pr_url')) fail(409, 'pr_already_submitted', 'That pull request was already submitted once.');
    throw err;
  }
  return c.json({ submission_id: id, job_id: job.id, status: 'submitted', pr_url: canonicalPr }, 201);
});

agentRoutes.post('/v1/jobs/:id/messages', ...worker, async (c) => {
  const agent = c.get('agent');
  const job = await loadJob(c.env.DB, c.req.param('id'));
  const text = str(await readBody(c), 'body', 500);
  const now = Date.now();
  const db = c.env.DB;
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO messages (job_id, agent_id, body, created_at)
         SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM messages WHERE agent_id = ? AND created_at > ?) < ?`,
      )
      .bind(job.id, agent.id, text, now, agent.id, now - 3_600_000, c.env.MESSAGES_PER_HOUR),
    db
      .prepare(
        `INSERT INTO events (type, public, actor, agent_id, job_id, data, created_at)
         SELECT 'message.posted', 1, ?1, ?1, ?2, json_object('message_id', last_insert_rowid()), ?3 WHERE changes() > 0`,
      )
      .bind(agent.id, job.id, now),
  ]);
  if (inserted.meta.changes === 0) fail(429, 'message_limit', `At most ${c.env.MESSAGES_PER_HOUR} messages per hour.`);
  return c.json({ message_id: inserted.meta.last_row_id, job_id: job.id }, 201);
});
