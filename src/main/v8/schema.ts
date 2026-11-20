import type Database from 'better-sqlite3';

/**
 * v8 tables. Self-contained and idempotent so v8 runs next to the v7 tables without touching their migrations.
 * Only the Scheduler writes them. Messages are append-only.
 */
export function createV8Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v8_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id     INTEGER REFERENCES v8_tickets(id),
      assignment_id INTEGER REFERENCES v8_assignments(id),
      author        TEXT NOT NULL CHECK (author IN ('boss','lead','worker','system')),
      kind          TEXT NOT NULL CHECK (kind IN ('say','report','note')),
      body          TEXT NOT NULL,
      review        TEXT CHECK (review IS NULL OR review IN ('not_required','pending','passed','rejected')),
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS v8_messages_ticket ON v8_messages(ticket_id, id);

    CREATE TABLE IF NOT EXISTS v8_tickets (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_message_id INTEGER NOT NULL UNIQUE REFERENCES v8_messages(id),
      title             TEXT NOT NULL,
      original_request  TEXT NOT NULL,
      routing_note      TEXT NOT NULL,
      session_ref       TEXT,
      workdir           TEXT,
      created_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      end_kind          TEXT CHECK (end_kind IS NULL OR end_kind IN ('done','stopped'))
    );

    CREATE TABLE IF NOT EXISTS v8_assignments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id   INTEGER NOT NULL REFERENCES v8_tickets(id),
      status      TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','ENDED','INTERRUPTED')),
      slot_id     TEXT,
      urgent      INTEGER NOT NULL DEFAULT 0,
      recovery    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      started_at  INTEGER,
      ended_at    INTEGER,
      end_reason  TEXT CHECK (end_reason IS NULL OR end_reason IN ('reported','exited','stopped','restart'))
    );
    CREATE INDEX IF NOT EXISTS v8_assignments_ticket ON v8_assignments(ticket_id, id);
    CREATE INDEX IF NOT EXISTS v8_assignments_status ON v8_assignments(status);

    -- One row per review verdict. The checks are what the review page shows.
    CREATE TABLE IF NOT EXISTS v8_reviews (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id         INTEGER NOT NULL REFERENCES v8_tickets(id),
      report_message_id INTEGER NOT NULL REFERENCES v8_messages(id),
      verdict           TEXT NOT NULL CHECK (verdict IN ('passed','rejected')),
      reason            TEXT NOT NULL,
      checks_json       TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS v8_reviews_ticket ON v8_reviews(ticket_id, id);

    CREATE TABLE IF NOT EXISTS v8_slots (
      id        TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      model     TEXT,
      emergency INTEGER NOT NULL DEFAULT 0,
      position  INTEGER NOT NULL
    );
  `);
  // Added after the first release: the boss can move a queued ticket to the front. Lower rank goes first; 0 is the
  // default, so existing rows keep their first-come order.
  // v8 计划书 S2: a ticket whose account ran out of quota waits here until the quota is back, the boss switches the
  // account or model, or anything else opens a new assignment. And per-ticket supply overrides (model, account).
  db.exec(`
    CREATE TABLE IF NOT EXISTS v8_quota_waits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id     INTEGER NOT NULL REFERENCES v8_tickets(id),
      assignment_id INTEGER NOT NULL REFERENCES v8_assignments(id),
      resets_at     INTEGER,
      detail        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      resolved_at   INTEGER,
      resolved_how  TEXT
    );
    CREATE INDEX IF NOT EXISTS v8_quota_waits_open ON v8_quota_waits(ticket_id, resolved_at);
    CREATE TABLE IF NOT EXISTS v8_ticket_supply (
      ticket_id  INTEGER PRIMARY KEY REFERENCES v8_tickets(id),
      model      TEXT,
      account    TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  const cols = db.prepare("SELECT name FROM pragma_table_info('v8_tickets')").pluck().all() as string[];
  const supplyCols = db.prepare("SELECT name FROM pragma_table_info('v8_ticket_supply')").pluck().all() as string[];
  if (!supplyCols.includes('effort')) db.exec('ALTER TABLE v8_ticket_supply ADD COLUMN effort TEXT');
  if (!cols.includes('queue_rank')) db.exec('ALTER TABLE v8_tickets ADD COLUMN queue_rank INTEGER NOT NULL DEFAULT 0');
}
