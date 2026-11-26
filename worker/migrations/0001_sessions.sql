CREATE TABLE connections (
  token_hash TEXT PRIMARY KEY NOT NULL,
  lastfm_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX connections_expiry ON connections(expires_at);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  sealed_key TEXT NOT NULL
);
