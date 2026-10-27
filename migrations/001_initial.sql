CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE chat_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  model TEXT NOT NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  CHECK ((status = 'pending' AND response IS NULL AND error_code IS NULL AND finished_at IS NULL)
    OR (status = 'completed' AND response IS NOT NULL AND error_code IS NULL AND finished_at IS NOT NULL)
    OR (status = 'failed' AND response IS NULL AND error_code IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE INDEX chat_turns_history_idx ON chat_turns(session_id, id DESC);
CREATE UNIQUE INDEX chat_turns_one_pending_idx ON chat_turns(session_id) WHERE status = 'pending';
CREATE INDEX chat_turns_pending_deadline_idx ON chat_turns(deadline_at) WHERE status = 'pending';
