import { event, fail } from './lib';

// Transitions shared by more than one actor. Each runs as one D1 batch, which is a transaction.

export async function rejectSubmission(db: D1Database, submissionId: string, reason: string | null, actor: string) {
  const now = Date.now();
  const sub = await db
    .prepare('SELECT id, job_id, agent_id, pr_url, status FROM submissions WHERE id = ?')
    .bind(submissionId)
    .first<{ id: string; job_id: string; agent_id: string; pr_url: string; status: string }>();
  if (!sub) fail(404, 'not_found', 'Submission not found.');
  const [, reopened] = await db.batch([
    db
      .prepare(`UPDATE submissions SET status = 'rejected', reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .bind(reason, now, sub.id),
    db
      .prepare(
        `UPDATE jobs SET status = 'open', agent_id = NULL, claimed_at = NULL, expires_at = NULL, submission_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'submitted' AND submission_id = ?`,
      )
      .bind(now, sub.job_id, sub.id),
    event(db, { type: 'job.rejected', public: true, actor, agentId: sub.agent_id, jobId: sub.job_id, data: { submission_id: sub.id, pr_url: sub.pr_url, reason } }, now),
  ]);
  if (reopened.meta.changes === 0) fail(409, 'not_pending', `Submission is ${sub.status}, not pending.`);
  return { submission_id: sub.id, job_id: sub.job_id, status: 'rejected', reason };
}

// Returns every claimed or submitted job of an agent to open.
export function reopenAgentJobs(db: D1Database, agentId: string, actor: string, reason: string, now: number) {
  return [
    db
      .prepare(
        `INSERT INTO events (type, public, actor, agent_id, job_id, data, created_at)
         SELECT 'job.reopened', 1, ?, agent_id, id, json_object('reason', ?), ? FROM jobs
         WHERE agent_id = ? AND status IN ('claimed', 'submitted')`,
      )
      .bind(actor, reason, now, agentId),
    db
      .prepare(`UPDATE submissions SET status = 'rejected', reason = ?, decided_at = ? WHERE agent_id = ? AND status = 'pending'`)
      .bind(reason, now, agentId),
    db
      .prepare(
        `UPDATE jobs SET status = 'open', agent_id = NULL, claimed_at = NULL, expires_at = NULL, submission_id = NULL, updated_at = ?
         WHERE agent_id = ? AND status IN ('claimed', 'submitted')`,
      )
      .bind(now, agentId),
  ];
}

export async function expireClaims(db: D1Database) {
  const now = Date.now();
  const [, expired] = await db.batch([
    db
      .prepare(
        `INSERT INTO events (type, public, actor, agent_id, job_id, data, created_at)
         SELECT 'job.expired', 1, 'cron', agent_id, id, json_object('expires_at', expires_at), ? FROM jobs
         WHERE status = 'claimed' AND expires_at <= ?`,
      )
      .bind(now, now),
    db
      .prepare(
        `UPDATE jobs SET status = 'open', agent_id = NULL, claimed_at = NULL, expires_at = NULL, updated_at = ?
         WHERE status = 'claimed' AND expires_at <= ?`,
      )
      .bind(now, now),
  ]);
  return expired.meta.changes;
}
