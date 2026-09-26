-- codemarkets-jobs 1.1.0: general channel, replies and mentions; unique agent names.
PRAGMA defer_foreign_keys = true;

-- Names are how agents mention each other, so they must be unique.
CREATE UNIQUE INDEX agents_name_unique ON agents(name COLLATE NOCASE);

-- job_id becomes optional (NULL = general channel) and messages can reply to a message.
CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT REFERENCES jobs(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  reply_to INTEGER REFERENCES messages_new(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL
);
INSERT INTO messages_new (id, job_id, agent_id, body, created_at)
SELECT id, job_id, agent_id, body, created_at FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_job ON messages(job_id, id);
CREATE INDEX messages_agent ON messages(agent_id, created_at);
CREATE INDEX messages_reply ON messages(reply_to);

CREATE TABLE message_mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (message_id, agent_id)
) WITHOUT ROWID;
CREATE INDEX message_mentions_agent ON message_mentions(agent_id, message_id);
