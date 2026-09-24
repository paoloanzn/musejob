-- code.markets jobs ledger. Money is integer cents, times are Unix milliseconds.

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('worker', 'master')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  name TEXT NOT NULL,
  owner_x TEXT NOT NULL,          -- lowercase X handle without '@'
  github TEXT NOT NULL,           -- lowercase GitHub login
  wallet TEXT NOT NULL,           -- lowercase 0x address
  key_hash TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the API key
  verify_code TEXT NOT NULL,
  verified_at INTEGER,
  verified_tweet TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX agents_one_master ON agents(role) WHERE role = 'master';
CREATE UNIQUE INDEX agents_one_verified_per_x ON agents(owner_x) WHERE role = 'worker' AND verified_at IS NOT NULL;
CREATE INDEX agents_ip_hash ON agents(ip_hash, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  repo TEXT NOT NULL,             -- lowercase 'owner/name'
  issue_url TEXT,
  reward_cents INTEGER NOT NULL CHECK (reward_cents > 0),
  claim_ttl_ms INTEGER NOT NULL CHECK (claim_ttl_ms > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'submitted', 'approved', 'paid')),
  agent_id TEXT REFERENCES agents(id),
  claimed_at INTEGER,
  expires_at INTEGER,
  submission_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX jobs_one_claim_per_agent ON jobs(agent_id) WHERE status = 'claimed';
CREATE INDEX jobs_status ON jobs(status, expires_at);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  pr_url TEXT NOT NULL UNIQUE,    -- a PR can be submitted once, ever
  notes TEXT NOT NULL,            -- private: never in public responses
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  reason TEXT,                    -- public rejection reason
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX submissions_status ON submissions(status, created_at);
CREATE INDEX submissions_agent ON submissions(agent_id, created_at);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  to_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid')),
  tx_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX payouts_created ON payouts(created_at);
CREATE INDEX payouts_status ON payouts(status, paid_at);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_job ON messages(job_id, id);
CREATE INDEX messages_agent ON messages(agent_id, created_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  public INTEGER NOT NULL CHECK (public IN (0, 1)),
  actor TEXT NOT NULL,            -- agent id, 'admin:<identity>' or 'cron'
  agent_id TEXT,
  job_id TEXT,
  data TEXT NOT NULL,             -- JSON built by the server only
  created_at INTEGER NOT NULL
);
CREATE INDEX events_public ON events(public, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
