import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const filename = resolve(process.env.OEM_DB_PATH || 'data/oems.sqlite');
mkdirSync(dirname(filename), { recursive: true });

export const db = new DatabaseSync(filename);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    reg TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'lecturer', 'student')),
    klass TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('mcq', 'tf', 'short', 'essay')),
    text TEXT NOT NULL,
    marks REAL NOT NULL CHECK (marks > 0),
    subject TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    correct_json TEXT NOT NULL DEFAULT '[]',
    accepted_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    opens_at INTEGER NOT NULL,
    closes_at INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 5),
    pass_mark REAL NOT NULL CHECK (pass_mark BETWEEN 0 AND 100),
    author_id TEXT NOT NULL REFERENCES users(id),
    instructions TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled')),
    published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
    created_at INTEGER NOT NULL,
    CHECK (closes_at > opens_at)
  );

  CREATE TABLE IF NOT EXISTS exam_classes (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    klass TEXT NOT NULL,
    PRIMARY KEY (exam_id, klass)
  );
  CREATE TABLE IF NOT EXISTS exam_regs (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    reg TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (exam_id, reg)
  );
  CREATE TABLE IF NOT EXISTS exam_questions (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id),
    position INTEGER NOT NULL,
    marks REAL NOT NULL CHECK (marks > 0),
    PRIMARY KEY (exam_id, question_id),
    UNIQUE (exam_id, position)
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL REFERENCES exams(id),
    student_id TEXT NOT NULL REFERENCES users(id),
    started_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    submitted_at INTEGER,
    UNIQUE (exam_id, student_id)
  );
  CREATE INDEX IF NOT EXISTS attempts_deadline ON attempts(deadline) WHERE submitted_at IS NULL;
  CREATE TABLE IF NOT EXISTS answers (
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id),
    answer_json TEXT NOT NULL DEFAULT 'null',
    reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
    mark REAL,
    feedback TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (attempt_id, question_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activity_time ON activity_log(created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  INSERT OR IGNORE INTO settings (key, value_json) VALUES
    ('institution', '"Examora"'),
    ('self_registration', 'false'),
    ('grade_scale', '[70,60,50,40]');
`);

export function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
