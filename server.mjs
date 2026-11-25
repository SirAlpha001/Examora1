import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, transaction } from './db.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const loginAttempts = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const id = () => randomBytes(16).toString('hex');
const now = () => Date.now();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const norm = value => String(value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, expected] = String(stored).split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    reg: user.reg,
    email: user.email,
    role: user.role,
    klass: user.klass,
    active: Boolean(user.active),
    mustChangePassword: Boolean(user.must_change_password)
  };
}

function log(actor, userId, action) {
  db.prepare('INSERT INTO activity_log (user_id, actor, action, created_at) VALUES (?, ?, ?, ?)')
    .run(userId ?? null, actor, action, now());
}

function addNotification(userId, message) {
  db.prepare('INSERT INTO notifications (id, user_id, message, created_at) VALUES (?, ?, ?, ?)')
    .run(id(), userId, message, now());
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) fail(403, 'You do not have permission to do that.');
}

function requiredText(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(400, `${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

function positiveNumber(value, label, max = 100000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) fail(400, `${label} must be a positive number.`);
  return number;
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function getExam(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) fail(404, 'Examination not found.');
  return exam;
}

function getAttempt(attemptId) {
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) fail(404, 'Attempt not found.');
  return attempt;
}

function canManageExam(user, exam) {
  return user.role === 'admin' || (user.role === 'lecturer' && exam.author_id === user.id);
}

function assignedToExam(examId, student) {
  return Boolean(
    db.prepare('SELECT 1 FROM exam_classes WHERE exam_id = ? AND klass = ?').get(examId, student.klass)
    || db.prepare('SELECT 1 FROM exam_regs WHERE exam_id = ? AND reg = ?').get(examId, student.reg)
  );
}

function answerForStudent(question) {
  return {
    id: question.id,
    type: question.type,
    text: question.text,
    marks: question.marks,
    options: parse(question.options_json)
  };
}

function getExamQuestions(examId) {
  return db.prepare(`
    SELECT q.*, eq.position, eq.marks AS exam_marks
    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = ? ORDER BY eq.position
  `).all(examId);
}

function scoreAnswer(question, answer, maxMarks) {
  const correct = parse(question.correct_json);
  if (question.type === 'mcq') {
    const submitted = Array.isArray(answer) ? [...new Set(answer)].sort((a, b) => a - b) : [];
    return submitted.length === correct.length
      && submitted.every((value, index) => value === [...correct].sort((a, b) => a - b)[index])
      ? maxMarks : 0;
  }
  if (question.type === 'tf') return answer === correct[0] ? maxMarks : 0;
  if (question.type === 'short') {
    const accepted = parse(question.accepted_json);
    const match = accepted.some(value => norm(value) === norm(answer));
    return accepted.length ? (match ? maxMarks : 0) : null;
  }
  return null;
}

function finishAttempt(attempt, automatic = false) {
  if (attempt.submitted_at !== null) return attempt;
  const exam = getExam(attempt.exam_id);
  const questions = getExamQuestions(exam.id);
  const answers = db.prepare('SELECT * FROM answers WHERE attempt_id = ?').all(attempt.id);
  transaction(() => {
    for (const question of questions) {
      const answerRow = answers.find(row => row.question_id === question.id);
      const answer = answerRow ? parse(answerRow.answer_json) : null;
      const mark = scoreAnswer(question, answer, question.exam_marks);
      db.prepare('UPDATE answers SET mark = ? WHERE attempt_id = ? AND question_id = ?')
        .run(mark, attempt.id, question.id);
    }
    db.prepare('UPDATE attempts SET submitted_at = ? WHERE id = ? AND submitted_at IS NULL')
      .run(Math.min(now(), attempt.deadline), attempt.id);
    addNotification(attempt.student_id, `Submission received for ${exam.title}`);
    if (automatic) {
      const student = getUser(attempt.student_id);
      log(student?.name || 'Student', attempt.student_id, `Automatically submitted examination ${exam.code}`);
    }
  });
  return getAttempt(attempt.id);
}

function expireDueAttempts() {
  const due = db.prepare('SELECT * FROM attempts WHERE submitted_at IS NULL AND deadline <= ?').all(now());
  for (const attempt of due) finishAttempt(attempt, true);
}

function validateAnswer(question, answer) {
  if (question.type === 'mcq') {
    const options = parse(question.options_json);
    if (!Array.isArray(answer) || answer.some(index => !Number.isInteger(index) || index < 0 || index >= options.length)) {
      fail(400, 'Choose valid option numbers.');
    }
    return [...new Set(answer)];
  }
  if (question.type === 'tf') {
    if (answer !== 'true' && answer !== 'false') fail(400, 'Answer must be true or false.');
    return answer;
  }
  if (typeof answer !== 'string' || answer.length > 10000) fail(400, 'Answer must be text of at most 10000 characters.');
  return answer;
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') fail(415, 'Send JSON using Content-Type: application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'The JSON body must be an object.');
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, 'Request body is not valid JSON.');
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function setSessionCookie(res, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `oems_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function currentSession(req) {
  const token = parseCookies(req.headers.cookie).oems_session;
  if (!token) return null;
  const session = db.prepare(`
    SELECT s.*, u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), now());
  if (!session || !session.active) return null;
  return { session, user: session };
}

function ensureSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = process.env.OEM_PUBLIC_ORIGIN
    || `${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://${req.headers.host}`;
  let actualOrigin, expectedOrigin;
  try {
    actualOrigin = new URL(origin).origin;
    expectedOrigin = new URL(expected).origin;
  } catch {
    fail(403, 'Request origin is not allowed.');
  }
  if (actualOrigin !== expectedOrigin) fail(403, 'Request origin is not allowed.');
}

function checkLoginRate(req) {
  if (loginAttempts.size > 2000) {
    for (const [address, entry] of loginAttempts) {
      if (entry.until <= now()) loginAttempts.delete(address);
    }
  }
  const address = req.socket.remoteAddress || 'unknown';
  const entry = loginAttempts.get(address);
  if (entry && entry.until > now() && entry.count >= 20) fail(429, 'Too many sign-in requests. Try again later.');
  if (!entry || entry.until <= now()) loginAttempts.set(address, { count: 1, until: now() + 15 * 60 * 1000 });
  else entry.count++;
}

function createQuestion(user, body, questionId = id()) {
  const type = body.type;
  if (!['mcq', 'tf', 'short', 'essay'].includes(type)) fail(400, 'Question type is invalid.');
  const text = requiredText(body.text, 'Question', 5000);
  const subject = requiredText(body.subject, 'Subject', 120);
  const marks = positiveNumber(body.marks, 'Marks', 1000);
  const options = type === 'mcq' ? body.options : [];
  const correct = body.correct ?? [];
  const accepted = body.accepted ?? [];
  if (type === 'mcq') {
    if (!Array.isArray(options) || options.length < 2 || options.length > 6
      || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 500)) {
      fail(400, 'Multiple-choice questions need 2 to 6 non-empty options.');
    }
    if (!Array.isArray(correct) || !correct.length || correct.some(index => !Number.isInteger(index) || index < 0 || index >= options.length)) {
      fail(400, 'Provide valid correct option indexes.');
    }
    if (new Set(correct).size !== correct.length) fail(400, 'Correct option indexes must not repeat.');
  } else if (type === 'tf') {
    if (!Array.isArray(correct) || correct.length !== 1 || !['true', 'false'].includes(correct[0])) {
      fail(400, 'True/false questions need one correct answer.');
    }
  } else if (!Array.isArray(accepted) || accepted.some(value => typeof value !== 'string' || value.length > 500)) {
    fail(400, 'Accepted answers must be an array of short text values.');
  }
  const isNew = !db.prepare('SELECT 1 FROM questions WHERE id = ?').get(questionId);
  const time = now();
  db.prepare(`
    INSERT INTO questions
      (id, author_id, type, text, marks, subject, options_json, correct_json, accepted_json, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, text = excluded.text, marks = excluded.marks, subject = excluded.subject,
      options_json = excluded.options_json, correct_json = excluded.correct_json,
      accepted_json = excluded.accepted_json, notes = excluded.notes, updated_at = excluded.updated_at
  `).run(
    questionId, user.id, type, text, marks, subject, json(options.map(value => value.trim())),
    json(correct), json(accepted.map(value => value.trim())),
    typeof body.notes === 'string' ? body.notes.trim().slice(0, 5000) : '', time, time
  );
  if (isNew) log(user.name, user.id, 'Created a question');
  return questionId;
}

function mapQuestion(row, includeKey = true) {
  const question = {
    id: row.id,
    authorId: row.author_id,
    type: row.type,
    text: row.text,
    marks: row.marks,
    subject: row.subject,
    options: parse(row.options_json),
    archived: Boolean(row.archived)
  };
  if (includeKey) {
    question.correct = parse(row.correct_json);
    question.accepted = parse(row.accepted_json);
    question.notes = row.notes;
  }
  return question;
}

function serializeExam(exam, user) {
  const state = exam.status === 'draft'
    ? 'draft'
    : exam.published
      ? 'published'
      : now() < exam.opens_at
        ? 'scheduled'
        : now() <= exam.closes_at
          ? 'active'
          : 'completed';
  const base = {
    id: exam.id,
    code: exam.code,
    title: exam.title,
    subject: exam.subject,
    opensAt: exam.opens_at,
    closesAt: exam.closes_at,
    durationMinutes: exam.duration_minutes,
    passMark: exam.pass_mark,
    instructions: exam.instructions,
    status: state,
    published: Boolean(exam.published)
  };
  if (user.role !== 'student') {
    base.authorId = exam.author_id;
    base.classes = db.prepare('SELECT klass FROM exam_classes WHERE exam_id = ?').all(exam.id).map(row => row.klass);
    base.regs = db.prepare('SELECT reg FROM exam_regs WHERE exam_id = ?').all(exam.id).map(row => row.reg);
    base.questions = getExamQuestions(exam.id).map(question => ({
      ...mapQuestion(question),
      marks: question.exam_marks,
      position: question.position
    }));
  }
  return base;
}

function notifyAssigned(exam, message) {
  const students = db.prepare(`
    SELECT DISTINCT u.id FROM users u
    WHERE u.role = 'student' AND u.active = 1 AND (
      EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id = ? AND ec.klass = u.klass)
      OR EXISTS (SELECT 1 FROM exam_regs er WHERE er.exam_id = ? AND er.reg = u.reg)
    )
  `).all(exam.id, exam.id);
  students.forEach(student => addNotification(student.id, message));
}

function createExam(user, body) {
  const code = requiredText(body.code, 'Code', 80).toUpperCase();
  const title = requiredText(body.title, 'Title', 250);
  const subject = requiredText(body.subject, 'Subject', 120);
  const opensAt = Number(body.opensAt);
  const closesAt = Number(body.closesAt);
  const durationMinutes = Number(body.durationMinutes);
  const passMark = Number(body.passMark);
  if (!Number.isSafeInteger(opensAt) || !Number.isSafeInteger(closesAt) || closesAt <= opensAt) {
    fail(400, 'Closing time must be after opening time.');
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1440) fail(400, 'Duration must be between 5 and 1440 minutes.');
  if (!Number.isFinite(passMark) || passMark < 0 || passMark > 100) fail(400, 'Pass mark must be between 0 and 100.');
  if (!Array.isArray(body.questions) || body.questions.length === 0) fail(400, 'Choose at least one question.');
  if (!Array.isArray(body.classes) || !Array.isArray(body.regs)) fail(400, 'Classes and registration numbers must be arrays.');
  const questionIds = body.questions.map(item => item?.id);
  if (new Set(questionIds).size !== questionIds.length) fail(400, 'A question may only appear once in an examination.');
  const classes = body.classes.map(value => requiredText(value, 'Class', 120));
  const regs = body.regs.map(value => requiredText(value, 'Registration number', 120));
  if (!classes.length && !regs.length) fail(400, 'Assign at least one class or student.');
  if (regs.length) {
    const placeholders = regs.map(() => '?').join(',');
    const found = db.prepare(`SELECT reg FROM users WHERE role = 'student' AND active = 1 AND reg IN (${placeholders})`).all(...regs);
    if (new Set(found.map(row => row.reg.toLocaleLowerCase())).size !== new Set(regs.map(value => value.toLocaleLowerCase())).size) {
      fail(400, 'Every individual registration number must belong to an active student.');
    }
  }

  const examId = id();
  transaction(() => {
    db.prepare(`
      INSERT INTO exams (id, code, title, subject, opens_at, closes_at, duration_minutes, pass_mark,
        author_id, instructions, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      examId, code, title, subject, opensAt, closesAt, durationMinutes, passMark,
      user.id, String(body.instructions || '').slice(0, 5000), now()
    );
    const insertQuestion = db.prepare('INSERT INTO exam_questions (exam_id, question_id, position, marks) VALUES (?, ?, ?, ?)');
    body.questions.forEach((item, position) => {
      const question = db.prepare('SELECT * FROM questions WHERE id = ? AND archived = 0').get(item.id);
      if (!question || (user.role !== 'admin' && question.author_id !== user.id)) fail(400, 'Each selected question must exist and belong to you.');
      const marks = positiveNumber(item.marks ?? question.marks, 'Question marks', 1000);
      insertQuestion.run(examId, question.id, position, marks);
    });
    for (const klass of new Set(classes)) db.prepare('INSERT INTO exam_classes (exam_id, klass) VALUES (?, ?)').run(examId, klass);
    for (const reg of new Set(regs)) db.prepare('INSERT INTO exam_regs (exam_id, reg) VALUES (?, ?)').run(examId, reg);
  });
  log(user.name, user.id, `Created draft examination ${code}`);
  return examId;
}

function gradeSummary(attemptId) {
  const attempt = getAttempt(attemptId);
  const exam = getExam(attempt.exam_id);
  const rows = db.prepare(`
    SELECT eq.marks AS max_marks, a.mark
    FROM exam_questions eq
    LEFT JOIN answers a ON a.question_id = eq.question_id AND a.attempt_id = ?
    WHERE eq.exam_id = ?
  `).all(attempt.id, exam.id);
  const maximum = rows.reduce((sum, row) => sum + row.max_marks, 0);
  const awarded = rows.reduce((sum, row) => sum + (row.mark ?? 0), 0);
  const pending = rows.filter(row => row.mark === null).length;
  const percent = maximum ? Math.round((awarded / maximum) * 1000) / 10 : 0;
  const scale = parse(db.prepare("SELECT value_json FROM settings WHERE key = 'grade_scale'").get().value_json);
  const letter = percent >= scale[0] ? 'A' : percent >= scale[1] ? 'B' : percent >= scale[2] ? 'C' : percent >= scale[3] ? 'D' : 'F';
  return { marks: awarded, maximum, pending, percent, grade: letter, passed: percent >= exam.pass_mark };
}

async function handleApi(req, res, url) {
  const method = req.method;
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readJson(req) : {};
  const auth = currentSession(req);
  const user = auth?.user;

  if (method === 'GET' && path === '/api/public') {
    const values = Object.fromEntries(db.prepare('SELECT key, value_json FROM settings').all()
      .map(row => [row.key, parse(row.value_json)]));
    return { status: 200, body: { institution: values.institution, selfRegistration: values.self_registration } };
  }

  if (method === 'GET' && path === '/api/health') {
    return { status: 200, body: { status: 'ok' } };
  }

  if (method === 'POST' && path === '/api/auth/login') {
    checkLoginRate(req);
    const identifier = requiredText(body.identifier, 'Registration number or email', 320);
    if (typeof body.password !== 'string' || body.password.length > 1024) fail(400, 'Password is required.');
    const account = db.prepare('SELECT * FROM users WHERE reg = ? OR email = ?').get(identifier, identifier);
    if (!account) {
      verifyPassword(body.password, 'scrypt$00$00');
      fail(401, 'Incorrect registration number, email, or password.');
    }
    if (account.locked_until > now()) fail(423, 'Account locked. Try again later or contact an administrator.');
    if (!account.active) fail(403, 'This account is deactivated.');
    if (!verifyPassword(body.password, account.password_hash)) {
      const attempts = account.failed_attempts + 1;
      const lockedUntil = attempts >= 5 ? now() + 15 * 60 * 1000 : 0;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .run(lockedUntil ? 0 : attempts, lockedUntil, account.id);
      log(account.name, account.id, 'Failed sign-in');
      fail(401, 'Incorrect registration number, email, or password.');
    }
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(account.id);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), account.id, now() + SESSION_MS, now());
    setSessionCookie(res, token, Math.floor(SESSION_MS / 1000));
    log(account.name, account.id, 'Signed in');
    return { status: 200, body: { user: publicUser(account) } };
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const enabled = parse(db.prepare("SELECT value_json FROM settings WHERE key = 'self_registration'").get().value_json);
    if (!enabled) fail(403, 'Student self-registration is disabled.');
    const name = requiredText(body.name, 'Name', 200);
    const reg = requiredText(body.reg, 'Registration number', 120);
    const email = requiredText(body.email, 'Email', 320);
    const klass = requiredText(body.klass, 'Class', 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
    if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 1024) {
      fail(400, 'Password must contain at least 12 characters.');
    }
    const userId = id();
    try {
      db.prepare(`
        INSERT INTO users (id, name, reg, email, role, klass, password_hash, created_at)
        VALUES (?, ?, ?, ?, 'student', ?, ?, ?)
      `).run(userId, name, reg, email, klass, hashPassword(body.password), now());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) fail(409, 'Registration number or email is already in use.');
      throw error;
    }
    log(name, userId, 'Registered a student account');
    return { status: 201, body: { ok: true } };
  }

  if (method === 'GET' && path === '/api/auth/me') {
    if (!user) fail(401, 'Sign in is required.');
    return { status: 200, body: { user: publicUser(user) } };
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    if (auth) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.session.token_hash);
    setSessionCookie(res, '', 0);
    return { status: 200, body: { ok: true } };
  }

  if (path.startsWith('/api/') && !user
    && !(method === 'POST' && (path === '/api/auth/login' || path === '/api/auth/register'))) {
    fail(401, 'Sign in is required.');
  }
  if (method === 'POST' && path === '/api/auth/password') {
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 1024) {
      fail(400, 'A current password and a new password of at least 12 characters are required.');
    }
    if (!verifyPassword(body.currentPassword, user.password_hash)) fail(400, 'Current password is incorrect.');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashPassword(body.newPassword), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, auth.session.token_hash);
    log(user.name, user.id, 'Changed password');
    return { status: 200, body: { ok: true } };
  }

  if (path.startsWith('/api/') && user.must_change_password
    && path !== '/api/auth/password' && path !== '/api/state') {
    fail(403, 'Change your initial password before continuing.');
  }

  if (method === 'GET' && path === '/api/state') {
    if (user.must_change_password) {
      const settings = Object.fromEntries(db.prepare('SELECT key, value_json FROM settings').all()
        .map(row => [row.key, parse(row.value_json)]));
      return { status: 200, body: {
        seq: 0,
        currentUser: publicUser(user),
        users: [publicUser(user)],
        questions: [],
        exams: [],
        attempts: [],
        notifs: [],
        log: [],
        set: { inst: settings.institution, selfReg: settings.self_registration, grade: settings.grade_scale }
      } };
    }
    return { status: 200, body: uiState(user) };
  }

  if (method === 'GET' && path === '/api/users') {
    requireRole(user, 'admin');
    const users = db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(publicUser);
    return { status: 200, body: { users } };
  }
  if (method === 'POST' && path === '/api/users') {
    requireRole(user, 'admin');
    const name = requiredText(body.name, 'Name', 200);
    const reg = requiredText(body.reg, 'Registration number', 120);
    const email = requiredText(body.email, 'Email', 320);
    const role = body.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
    if (!['admin', 'lecturer', 'student'].includes(role)) fail(400, 'Role is invalid.');
    const initialPassword = randomBytes(24).toString('base64url');
    const userId = id();
    try {
      db.prepare(`
        INSERT INTO users (id, name, reg, email, role, klass, password_hash, must_change_password, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(userId, name, reg, email, role, String(body.klass || '').trim().slice(0, 120), hashPassword(initialPassword), now());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) fail(409, 'Registration number or email is already in use.');
      throw error;
    }
    log(user.name, user.id, `Created ${role} account`);
    return { status: 201, body: { user: publicUser(getUser(userId)), temporaryPassword: initialPassword } };
  }
  if (method === 'POST' && path === '/api/users/import') {
    requireRole(user, 'admin');
    if (typeof body.rows !== 'string' || body.rows.length > 100_000) fail(400, 'Student rows are required and must be under 100 KB.');
    const rows = body.rows.split(/\r?\n/).map((line, index) => {
      const fields = line.split(',').map(value => value.trim());
      if (!fields.some(Boolean)) return null;
      if (fields.length < 4 || fields.slice(0, 4).some(value => !value)) fail(400, `Row ${index + 1} needs a name, registration number, email, and class.`);
      const [name, reg, email, klass] = fields;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, `Row ${index + 1} has an invalid email address.`);
      return { name, reg, email, klass };
    }).filter(Boolean);
    if (!rows.length) fail(400, 'No student rows were supplied.');
    const credentials = [];
    transaction(() => {
      const insert = db.prepare(`
        INSERT INTO users (id, name, reg, email, role, klass, password_hash, must_change_password, created_at)
        VALUES (?, ?, ?, ?, 'student', ?, ?, 1, ?)
      `);
      for (const row of rows) {
        const temporaryPassword = randomBytes(24).toString('base64url');
        try {
          insert.run(id(), row.name, row.reg, row.email, row.klass, hashPassword(temporaryPassword), now());
        } catch (error) {
          if (String(error.message).includes('UNIQUE')) fail(409, `Registration number or email on row ${rows.indexOf(row) + 1} is already in use.`);
          throw error;
        }
        credentials.push({ email: row.email, password: temporaryPassword });
      }
      log(user.name, user.id, `Imported ${rows.length} students`);
    });
    return { status: 201, body: { credentials } };
  }
  if (method === 'PATCH' && parts[0] === 'api' && parts[1] === 'users' && parts[2]) {
    requireRole(user, 'admin');
    const target = getUser(parts[2]);
    if (!target) fail(404, 'User not found.');
    if (typeof body.active !== 'boolean') fail(400, 'active must be a boolean.');
    if (target.id === user.id && !body.active) fail(400, 'You cannot deactivate your own account.');
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(Number(body.active), target.id);
    if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    log(user.name, user.id, `${body.active ? 'Activated' : 'Deactivated'} account ${target.reg}`);
    return { status: 200, body: { user: publicUser(getUser(target.id)) } };
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'users' && parts[2] && parts[3] === 'unlock') {
    requireRole(user, 'admin');
    const target = getUser(parts[2]);
    if (!target) fail(404, 'User not found.');
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(target.id);
    log(user.name, user.id, `Unlocked account ${target.reg}`);
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'users' && parts[2] && parts[3] === 'reset-password') {
    requireRole(user, 'admin');
    const target = getUser(parts[2]);
    if (!target) fail(404, 'User not found.');
    const temporaryPassword = randomBytes(24).toString('base64url');
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = 0
      WHERE id = ?
    `).run(hashPassword(temporaryPassword), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    log(user.name, user.id, `Reset password for ${target.reg}`);
    return { status: 200, body: { temporaryPassword } };
  }

  if (method === 'GET' && path === '/api/questions') {
    requireRole(user, 'admin', 'lecturer');
    const rows = user.role === 'admin'
      ? db.prepare('SELECT * FROM questions WHERE archived = 0 ORDER BY created_at DESC').all()
      : db.prepare('SELECT * FROM questions WHERE archived = 0 AND author_id = ? ORDER BY created_at DESC').all(user.id);
    return { status: 200, body: { questions: rows.map(row => mapQuestion(row)) } };
  }
  if (method === 'POST' && path === '/api/questions') {
    requireRole(user, 'admin', 'lecturer');
    const questionId = createQuestion(user, body);
    return { status: 201, body: { question: mapQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId)) } };
  }
  if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'questions' && parts[2]) {
    requireRole(user, 'admin', 'lecturer');
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(parts[2]);
    if (!question) fail(404, 'Question not found.');
    if (user.role !== 'admin' && question.author_id !== user.id) fail(403, 'You may only edit your own questions.');
    if (db.prepare(`
      SELECT 1 FROM exam_questions eq JOIN exams e ON e.id = eq.exam_id
      WHERE eq.question_id = ? AND e.status != 'draft' LIMIT 1
    `).get(question.id)) fail(409, 'A question used by a scheduled examination is locked.');
    createQuestion(user, body, question.id);
    log(user.name, user.id, 'Updated a question');
    return { status: 200, body: { question: mapQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(question.id)) } };
  }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'questions' && parts[2]) {
    requireRole(user, 'admin', 'lecturer');
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(parts[2]);
    if (!question) fail(404, 'Question not found.');
    if (user.role !== 'admin' && question.author_id !== user.id) fail(403, 'You may only archive your own questions.');
    if (db.prepare(`
      SELECT 1 FROM exam_questions eq JOIN exams e ON e.id = eq.exam_id
      WHERE eq.question_id = ? AND e.status != 'draft' LIMIT 1
    `).get(question.id)) fail(409, 'A question used by a scheduled examination is locked.');
    db.prepare('UPDATE questions SET archived = 1, updated_at = ? WHERE id = ?').run(now(), question.id);
    log(user.name, user.id, 'Archived a question');
    return { status: 200, body: { ok: true } };
  }

  if (method === 'GET' && path === '/api/exams') {
    let rows;
    if (user.role === 'student') {
      rows = db.prepare(`
        SELECT DISTINCT e.* FROM exams e
        JOIN exam_questions eq ON eq.exam_id = e.id
        WHERE e.status = 'scheduled' AND (
          EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id = e.id AND ec.klass = ?)
          OR EXISTS (SELECT 1 FROM exam_regs er WHERE er.exam_id = e.id AND er.reg = ?)
        ) ORDER BY e.opens_at
      `).all(user.klass, user.reg);
      return { status: 200, body: { exams: rows.map(exam => serializeExam(exam, user)) } };
    }
    requireRole(user, 'admin', 'lecturer');
    rows = user.role === 'admin'
      ? db.prepare('SELECT * FROM exams ORDER BY created_at DESC').all()
      : db.prepare('SELECT * FROM exams WHERE author_id = ? ORDER BY created_at DESC').all(user.id);
    return { status: 200, body: { exams: rows.map(exam => serializeExam(exam, user)) } };
  }
  if (method === 'POST' && path === '/api/exams') {
    requireRole(user, 'admin', 'lecturer');
    let examId;
    try {
      examId = createExam(user, body);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: exams.code')) fail(409, 'That examination code is already in use.');
      throw error;
    }
    return { status: 201, body: { exam: serializeExam(getExam(examId), user) } };
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'exams' && parts[2] && parts.length === 3) {
    const exam = getExam(parts[2]);
    if (user.role === 'student') {
      if (exam.status !== 'scheduled' || !assignedToExam(exam.id, user)) fail(404, 'Examination not found.');
      return { status: 200, body: { exam: serializeExam(exam, user) } };
    }
    requireRole(user, 'admin', 'lecturer');
    if (!canManageExam(user, exam)) fail(403, 'You may only access your own examinations.');
    return { status: 200, body: { exam: serializeExam(exam, user) } };
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'exams' && parts[2] && parts[3] === 'schedule') {
    requireRole(user, 'admin', 'lecturer');
    const exam = getExam(parts[2]);
    if (!canManageExam(user, exam)) fail(403, 'You may only manage your own examinations.');
    if (exam.status !== 'draft') fail(409, 'Only a draft can be scheduled.');
    if (exam.closes_at <= now()) fail(400, 'The closing time must be in the future.');
    if (!db.prepare('SELECT 1 FROM exam_questions WHERE exam_id = ? LIMIT 1').get(exam.id)) fail(400, 'Add at least one question first.');
    const assignees = db.prepare(`
      SELECT COUNT(DISTINCT u.id) AS count FROM users u
      WHERE u.role = 'student' AND u.active = 1 AND (
        EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id = ? AND ec.klass = u.klass)
        OR EXISTS (SELECT 1 FROM exam_regs er WHERE er.exam_id = ? AND er.reg = u.reg)
      )
    `).get(exam.id, exam.id).count;
    if (!assignees) fail(400, 'Assign at least one active student before scheduling.');
    db.prepare("UPDATE exams SET status = 'scheduled' WHERE id = ?").run(exam.id);
    notifyAssigned(exam, `New examination scheduled: ${exam.title}`);
    log(user.name, user.id, `Scheduled examination ${exam.code}`);
    return { status: 200, body: { exam: serializeExam(getExam(exam.id), user) } };
  }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'exams' && parts[2]) {
    requireRole(user, 'admin', 'lecturer');
    const exam = getExam(parts[2]);
    if (!canManageExam(user, exam)) fail(403, 'You may only manage your own examinations.');
    if (exam.status !== 'draft') fail(409, 'Only draft examinations can be deleted.');
    db.prepare('DELETE FROM exams WHERE id = ?').run(exam.id);
    log(user.name, user.id, `Deleted draft examination ${exam.code}`);
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'exams' && parts[2] && parts[3] === 'publish') {
    requireRole(user, 'admin', 'lecturer');
    const exam = getExam(parts[2]);
    if (!canManageExam(user, exam)) fail(403, 'You may only manage your own examinations.');
    if (exam.status !== 'scheduled' || exam.closes_at > now()) fail(409, 'Results can only be published after the examination closes.');
    const pending = db.prepare(`
      SELECT COUNT(*) AS count FROM attempts at
      JOIN answers a ON a.attempt_id = at.id
      WHERE at.exam_id = ? AND at.submitted_at IS NOT NULL AND a.mark IS NULL
    `).get(exam.id).count;
    if (pending) fail(409, 'Some submitted answers still need to be marked.');
    db.prepare('UPDATE exams SET published = 1 WHERE id = ?').run(exam.id);
    db.prepare('SELECT student_id FROM attempts WHERE exam_id = ? AND submitted_at IS NOT NULL').all(exam.id)
      .forEach(row => addNotification(row.student_id, `Results published for ${exam.title}`));
    log(user.name, user.id, `Published results for ${exam.code}`);
    return { status: 200, body: { exam: serializeExam(getExam(exam.id), user) } };
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'exams' && parts[2] && parts[3] === 'unpublish') {
    requireRole(user, 'admin');
    const exam = getExam(parts[2]);
    if (!exam.published) fail(409, 'Results are not published.');
    db.prepare('UPDATE exams SET published = 0 WHERE id = ?').run(exam.id);
    log(user.name, user.id, `Unpublished results for ${exam.code}`);
    return { status: 200, body: { exam: serializeExam(getExam(exam.id), user) } };
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'exams' && parts[2] && parts[3] === 'start') {
    requireRole(user, 'student');
    const exam = getExam(parts[2]);
    if (exam.status !== 'scheduled' || !assignedToExam(exam.id, user)) fail(404, 'Examination not found.');
    const existing = db.prepare('SELECT * FROM attempts WHERE exam_id = ? AND student_id = ?').get(exam.id, user.id);
    if (existing) {
      if (existing.submitted_at === null && now() >= existing.deadline) finishAttempt(existing);
      return { status: 200, body: attemptPayload(getAttempt(existing.id), exam) };
    }
    if (now() < exam.opens_at || now() > exam.closes_at) fail(409, 'This examination is not open.');
    const startedAt = now();
    const deadline = Math.min(startedAt + exam.duration_minutes * 60_000, exam.closes_at);
    const attemptId = id();
    try {
      transaction(() => {
        db.prepare('INSERT INTO attempts (id, exam_id, student_id, started_at, deadline) VALUES (?, ?, ?, ?, ?)')
          .run(attemptId, exam.id, user.id, startedAt, deadline);
        for (const question of getExamQuestions(exam.id)) {
          db.prepare('INSERT INTO answers (attempt_id, question_id) VALUES (?, ?)').run(attemptId, question.id);
        }
      });
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
      const existingAttempt = db.prepare('SELECT * FROM attempts WHERE exam_id = ? AND student_id = ?').get(exam.id, user.id);
      return { status: 200, body: attemptPayload(existingAttempt, exam) };
    }
    log(user.name, user.id, `Started examination ${exam.code}`);
    return { status: 201, body: attemptPayload(getAttempt(attemptId), exam) };
  }

  if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'attempts' && parts[2] && parts[3] === 'answers' && parts[4]) {
    requireRole(user, 'student');
    const attempt = getAttempt(parts[2]);
    if (attempt.student_id !== user.id) fail(404, 'Attempt not found.');
    if (attempt.submitted_at !== null) fail(409, 'This attempt has already been submitted.');
    if (now() >= attempt.deadline) {
      finishAttempt(attempt, true);
      fail(409, 'The examination deadline has passed; your answers were submitted.');
    }
    const question = db.prepare(`
      SELECT q.*, eq.marks AS exam_marks
      FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
      WHERE eq.exam_id = ? AND q.id = ?
    `).get(attempt.exam_id, parts[4]);
    if (!question) fail(404, 'Question not found in this examination.');
    const answer = validateAnswer(question, body.answer);
    db.prepare('UPDATE answers SET answer_json = ? WHERE attempt_id = ? AND question_id = ?')
      .run(json(answer), attempt.id, question.id);
    return { status: 200, body: { saved: true, serverTime: now(), deadline: attempt.deadline } };
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'attempts' && parts[2] && parts[3] === 'review' && parts[4]) {
    requireRole(user, 'student');
    const attempt = getAttempt(parts[2]);
    if (attempt.student_id !== user.id) fail(404, 'Attempt not found.');
    if (attempt.submitted_at !== null || now() >= attempt.deadline) fail(409, 'This attempt is no longer being taken.');
    if (typeof body.reviewed !== 'boolean') fail(400, 'reviewed must be a boolean.');
    const result = db.prepare(`
      UPDATE answers SET reviewed = ?
      WHERE attempt_id = ? AND question_id = ?
    `).run(Number(body.reviewed), attempt.id, parts[4]);
    if (!result.changes) fail(404, 'Question not found in this examination.');
    return { status: 200, body: { reviewed: body.reviewed } };
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'attempts' && parts[2] && parts[3] === 'submit') {
    requireRole(user, 'student');
    let attempt = getAttempt(parts[2]);
    if (attempt.student_id !== user.id) fail(404, 'Attempt not found.');
    const alreadySubmitted = attempt.submitted_at !== null;
    attempt = finishAttempt(attempt);
    if (!alreadySubmitted) log(user.name, user.id, `Submitted examination ${getExam(attempt.exam_id).code}`);
    return { status: 200, body: { submitted: true, submittedAt: attempt.submitted_at } };
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'attempts' && parts[2]) {
    const attempt = getAttempt(parts[2]);
    const exam = getExam(attempt.exam_id);
    if (user.role === 'student') {
      if (attempt.student_id !== user.id) fail(404, 'Attempt not found.');
      if (exam.published && attempt.submitted_at !== null) {
        return { status: 200, body: { attempt: resultPayload(attempt, exam) } };
      }
      return { status: 200, body: { attempt: attemptPayload(attempt, exam) } };
    }
    requireRole(user, 'admin', 'lecturer');
    if (!canManageExam(user, exam)) fail(403, 'You may only access attempts for your examinations.');
    if (attempt.submitted_at === null) fail(409, 'An attempt can be reviewed after the student submits it.');
    return { status: 200, body: { attempt: markingPayload(attempt, exam) } };
  }

  if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'attempts' && parts[2] && parts[3] === 'marks') {
    requireRole(user, 'admin', 'lecturer');
    const attempt = getAttempt(parts[2]);
    const exam = getExam(attempt.exam_id);
    if (!canManageExam(user, exam)) fail(403, 'You may only mark attempts for your examinations.');
    if (exam.published) fail(409, 'Published marks are locked.');
    if (attempt.submitted_at === null) fail(409, 'Only submitted attempts can be marked.');
    if (!Array.isArray(body.marks)) fail(400, 'marks must be an array.');
    const questions = getExamQuestions(exam.id);
    const byId = new Map(questions.map(question => [question.id, question]));
    const seen = new Set();
    for (const mark of body.marks) {
      const question = byId.get(mark.questionId);
      if (!question || seen.has(mark.questionId)) fail(400, 'Each mark must refer to a unique question in this examination.');
      seen.add(mark.questionId);
      if (mark.mark !== null && (!Number.isFinite(mark.mark) || mark.mark < 0 || mark.mark > question.exam_marks)) {
        fail(400, 'Marks must be between zero and the question maximum.');
      }
      if (typeof (mark.feedback ?? '') !== 'string' || String(mark.feedback ?? '').length > 5000) fail(400, 'Feedback is too long.');
    }
    transaction(() => {
      for (const mark of body.marks) {
        db.prepare('UPDATE answers SET mark = ?, feedback = ? WHERE attempt_id = ? AND question_id = ?')
          .run(mark.mark, String(mark.feedback ?? ''), attempt.id, mark.questionId);
      }
    });
    log(user.name, user.id, `Marked attempt for ${exam.code}`);
    return { status: 200, body: { summary: gradeSummary(attempt.id) } };
  }

  if (method === 'GET' && path === '/api/results') {
    requireRole(user, 'student');
    const attempts = db.prepare(`
      SELECT at.* FROM attempts at JOIN exams e ON e.id = at.exam_id
      WHERE at.student_id = ? AND at.submitted_at IS NOT NULL AND e.published = 1
      ORDER BY at.submitted_at DESC
    `).all(user.id);
    return { status: 200, body: { results: attempts.map(attempt => resultPayload(attempt, getExam(attempt.exam_id))) } };
  }

  if (method === 'GET' && path === '/api/notifications') {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(user.id);
    return { status: 200, body: { notifications: rows.map(row => ({
      id: row.id, message: row.message, createdAt: row.created_at, read: row.read_at !== null
    })) } };
  }
  if (method === 'POST' && path === '/api/notifications/read-all') {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), user.id);
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'notifications' && parts[2] && parts[3] === 'read') {
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(now(), parts[2], user.id);
    if (!result.changes) fail(404, 'Notification not found.');
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && path === '/api/announcements') {
    requireRole(user, 'admin');
    const message = requiredText(body.message, 'Message', 5000);
    transaction(() => {
      db.prepare('SELECT id FROM users WHERE active = 1').all()
        .forEach(account => addNotification(account.id, `Announcement: ${message}`));
      log(user.name, user.id, 'Sent an announcement');
    });
    return { status: 201, body: { ok: true } };
  }
  if (method === 'GET' && path === '/api/activity') {
    requireRole(user, 'admin');
    const rows = db.prepare('SELECT actor, action, created_at AS createdAt FROM activity_log ORDER BY id DESC LIMIT 500').all();
    return { status: 200, body: { entries: rows } };
  }
  if (method === 'GET' && path === '/api/settings') {
    requireRole(user, 'admin');
    const values = Object.fromEntries(db.prepare('SELECT key, value_json FROM settings').all().map(row => [row.key, parse(row.value_json)]));
    return { status: 200, body: { settings: values } };
  }
  if (method === 'PUT' && path === '/api/settings') {
    requireRole(user, 'admin');
    const institution = requiredText(body.institution, 'Institution', 200);
    if (typeof body.selfRegistration !== 'boolean') fail(400, 'selfRegistration must be a boolean.');
    const scale = body.gradeScale;
    if (!Array.isArray(scale) || scale.length !== 4 || scale.some(value => !Number.isFinite(value) || value < 0 || value > 100)
      || !scale.every((value, index) => index === 0 || value < scale[index - 1])) {
      fail(400, 'Grade scale must contain four descending percentages from 0 to 100.');
    }
    transaction(() => {
      const update = db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json');
      update.run('institution', json(institution));
      update.run('self_registration', json(body.selfRegistration));
      update.run('grade_scale', json(scale));
      log(user.name, user.id, 'Changed system settings');
    });
    return { status: 200, body: { ok: true } };
  }

  fail(404, 'API endpoint not found.');
}

function attemptPayload(attempt, exam) {
  const answers = db.prepare('SELECT question_id, answer_json, reviewed FROM answers WHERE attempt_id = ?').all(attempt.id);
  return {
    id: attempt.id,
    examId: exam.id,
    startedAt: attempt.started_at,
    deadline: attempt.deadline,
    serverTime: now(),
    submittedAt: attempt.submitted_at,
    answers: Object.fromEntries(answers.map(row => [row.question_id, parse(row.answer_json)])),
    review: Object.fromEntries(answers.map(row => [row.question_id, Boolean(row.reviewed)])),
    questions: getExamQuestions(exam.id).map(answerForStudent)
  };
}

function resultPayload(attempt, exam) {
  const summary = gradeSummary(attempt.id);
  const answers = db.prepare(`
    SELECT a.question_id, a.answer_json, a.mark, a.feedback, q.type, q.text,
      q.options_json, q.correct_json, q.accepted_json, eq.marks AS max_marks
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    JOIN exam_questions eq ON eq.exam_id = ? AND eq.question_id = q.id
    WHERE a.attempt_id = ?
    ORDER BY eq.position
  `).all(exam.id, attempt.id);
  return {
    id: attempt.id,
    exam: { id: exam.id, code: exam.code, title: exam.title, subject: exam.subject, closesAt: exam.closes_at },
    submittedAt: attempt.submitted_at,
    summary,
    answers: answers.map(row => ({
      questionId: row.question_id,
      text: row.text,
      type: row.type,
      options: parse(row.options_json),
      answer: parse(row.answer_json),
      correct: parse(row.correct_json),
      accepted: parse(row.accepted_json),
      mark: row.mark,
      maximum: row.max_marks,
      feedback: row.feedback
    }))
  };
}

function markingPayload(attempt, exam) {
  const answers = db.prepare(`
    SELECT a.question_id, a.answer_json, a.mark, a.feedback, q.type, q.text,
      q.options_json, q.correct_json, q.accepted_json, q.notes, eq.marks AS max_marks
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    JOIN exam_questions eq ON eq.exam_id = ? AND eq.question_id = q.id
    WHERE a.attempt_id = ?
    ORDER BY eq.position
  `).all(exam.id, attempt.id);
  return {
    id: attempt.id,
    examId: exam.id,
    studentId: attempt.student_id,
    submittedAt: attempt.submitted_at,
    summary: gradeSummary(attempt.id),
    answers: answers.map(row => ({
      questionId: row.question_id,
      text: row.text,
      type: row.type,
      options: parse(row.options_json),
      answer: parse(row.answer_json),
      correct: parse(row.correct_json),
      accepted: parse(row.accepted_json),
      notes: row.notes,
      mark: row.mark,
      maximum: row.max_marks,
      feedback: row.feedback
    }))
  };
}

function serveStatic(req, res, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(ROOT, `.${decodeURIComponent(requestPath)}`);
  if (!target.startsWith(`${ROOT}${sep}`) && target !== ROOT) fail(404, 'File not found.');
  let stat;
  try {
    stat = statSync(target);
  } catch {
    fail(404, 'File not found.');
  }
  if (!stat.isFile() || !MIME[extname(target)]) fail(404, 'File not found.');
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)],
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  createReadStream(target).pipe(res);
}

function uiState(user) {
  let exams;
  if (user.role === 'admin') {
    exams = db.prepare('SELECT * FROM exams ORDER BY created_at DESC').all();
  } else if (user.role === 'lecturer') {
    exams = db.prepare('SELECT * FROM exams WHERE author_id = ? ORDER BY created_at DESC').all(user.id);
  } else {
    exams = db.prepare(`
      SELECT DISTINCT e.* FROM exams e
      WHERE e.status = 'scheduled' AND (
        EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id = e.id AND ec.klass = ?)
        OR EXISTS (SELECT 1 FROM exam_regs er WHERE er.exam_id = e.id AND er.reg = ?)
      ) ORDER BY e.opens_at
    `).all(user.klass, user.reg);
  }
  const examIds = exams.map(exam => exam.id);
  const questionIds = new Set(exams.flatMap(exam => getExamQuestions(exam.id).map(question => question.id)));
  if (user.role === 'lecturer') {
    db.prepare('SELECT id FROM questions WHERE author_id = ? AND archived = 0')
      .all(user.id).forEach(question => questionIds.add(question.id));
  }
  const questions = user.role === 'admin'
    ? db.prepare('SELECT * FROM questions').all()
    : questionIds.size
      ? db.prepare(`SELECT * FROM questions WHERE id IN (${[...questionIds].map(() => '?').join(',')})`).all(...questionIds)
      : [];
  const visibleQuestions = questions.map(question => {
    const mapped = mapQuestion(question, user.role !== 'student');
    return { ...mapped, by: mapped.authorId, opts: mapped.options };
  });

  let users;
  if (user.role === 'admin') {
    users = db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(row => ({
      ...publicUser(row), fails: row.failed_attempts, lock: row.locked_until
    }));
  } else if (user.role === 'lecturer' && examIds.length) {
    const placeholders = examIds.map(() => '?').join(',');
    const assignedStudents = db.prepare(`
      SELECT DISTINCT u.* FROM users u
      WHERE u.role = 'student' AND (
        EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.klass = u.klass AND ec.exam_id IN (${placeholders}))
        OR EXISTS (SELECT 1 FROM exam_regs er WHERE er.reg = u.reg AND er.exam_id IN (${placeholders}))
      )
    `).all(...examIds, ...examIds).map(row => ({
      id: row.id, name: row.name, reg: row.reg, role: row.role, klass: row.klass, active: Boolean(row.active)
    }));
    users = [{
      id: user.id, name: user.name, reg: user.reg, email: user.email,
      role: user.role, klass: user.klass, active: Boolean(user.active)
    }, ...assignedStudents];
  } else {
    users = [{
      id: user.id, name: user.name, reg: user.reg, email: user.email,
      role: user.role, klass: user.klass, active: Boolean(user.active)
    }];
  }

  let attempts;
  if (user.role === 'admin') {
    attempts = db.prepare('SELECT * FROM attempts ORDER BY started_at DESC').all();
  } else if (user.role === 'student') {
    attempts = db.prepare('SELECT * FROM attempts WHERE student_id = ? ORDER BY started_at DESC').all(user.id);
  } else if (examIds.length) {
    const placeholders = examIds.map(() => '?').join(',');
    attempts = db.prepare(`SELECT * FROM attempts WHERE exam_id IN (${placeholders}) ORDER BY started_at DESC`).all(...examIds);
  } else {
    attempts = [];
  }
  const uiAttempts = attempts.map(attempt => {
    const answerRows = db.prepare('SELECT * FROM answers WHERE attempt_id = ?').all(attempt.id);
    const uiAttempt = {
      id: attempt.id,
      examId: attempt.exam_id,
      uid: attempt.student_id,
      start: attempt.started_at,
      deadline: attempt.deadline,
      submittedAt: attempt.submitted_at,
      done: attempt.submitted_at !== null,
      ans: Object.fromEntries(answerRows.map(row => [row.question_id, parse(row.answer_json)])),
      review: Object.fromEntries(answerRows.map(row => [row.question_id, Boolean(row.reviewed)])),
      scores: Object.fromEntries(answerRows.map(row => [row.question_id, { m: row.mark, fb: row.feedback }]))
    };
    const exam = exams.find(item => item.id === attempt.exam_id) || getExam(attempt.exam_id);
    if (user.role === 'student' && exam.published && uiAttempt.done) {
      const result = resultPayload(attempt, exam);
      uiAttempt.resultAnswers = Object.fromEntries(result.answers.map(answer => [answer.questionId, answer]));
    }
    return uiAttempt;
  });

  const settingRows = Object.fromEntries(db.prepare('SELECT key, value_json FROM settings').all()
    .map(row => [row.key, parse(row.value_json)]));
  const notifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(user.id)
    .map(row => ({ id: row.id, uid: row.user_id, m: row.message, t: row.created_at, read: row.read_at !== null }));
  const logRows = user.role === 'admin'
    ? db.prepare('SELECT actor, action, created_at FROM activity_log ORDER BY id DESC LIMIT 500').all()
      .map(row => ({ u: row.actor, a: row.action, t: row.created_at }))
    : [];
  const uiExams = exams.map(exam => {
    const serialized = serializeExam(exam, user);
    return {
      id: serialized.id,
      code: serialized.code,
      title: serialized.title,
      subject: serialized.subject,
      opens: serialized.opensAt,
      closes: serialized.closesAt,
      mins: serialized.durationMinutes,
      pass: serialized.passMark,
      by: exam.author_id,
      instr: serialized.instructions,
      status: exam.status,
      published: serialized.published,
      classes: user.role === 'student'
        ? (db.prepare('SELECT 1 FROM exam_classes WHERE exam_id = ? AND klass = ?').get(exam.id, user.klass) ? [user.klass] : [])
        : serialized.classes,
      regs: user.role === 'student'
        ? (db.prepare('SELECT 1 FROM exam_regs WHERE exam_id = ? AND reg = ?').get(exam.id, user.reg) ? [user.reg] : [])
        : serialized.regs,
      qs: getExamQuestions(exam.id).map(question => ({ id: question.id, marks: question.exam_marks }))
    };
  });

  return {
    seq: 0,
    currentUser: publicUser(user),
    users,
    questions: visibleQuestions,
    exams: uiExams,
    attempts: uiAttempts,
    notifs,
    log: logRows,
    set: {
      inst: settingRows.institution,
      selfReg: settingRows.self_registration,
      grade: settingRows.grade_scale
    }
  };
}

export function createServer() {
  return createHttpServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) ensureSameOrigin(req);
        expireDueAttempts();
        const result = await handleApi(req, res, url);
        if (!res.headersSent) {
          res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(json(result.body));
        }
      } else {
        serveStatic(req, res, url.pathname);
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(json({ error: status === 500 ? 'An unexpected server error occurred.' : error.message }));
      }
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  const server = createServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  server.listen(port, host, () => console.log(`OEMS backend listening at http://${host}:${port}`));
  const expirationTimer = setInterval(expireDueAttempts, 5000);
  expirationTimer.unref();
}
