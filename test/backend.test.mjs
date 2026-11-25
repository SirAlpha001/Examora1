import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { after, before, test } from 'node:test';

const tempDir = await mkdtemp(join(tmpdir(), 'oems-backend-'));
process.env.OEM_DB_PATH = join(tempDir, 'test.sqlite');
const { db } = await import('../db.mjs');
const { createServer } = await import('../server.mjs');

const password = 'Test-passphrase-27!';
const hashPassword = value => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`;
};

let server;
let origin;

before(async () => {
  const insert = db.prepare(`
    INSERT INTO users (id, name, reg, email, role, klass, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('admin', 'Admin', 'ADMIN', 'admin@example.test', 'admin', '', hashPassword(password), Date.now());
  insert.run('lecturer', 'Lecturer', 'LEC1', 'lecturer@example.test', 'lecturer', '', hashPassword(password), Date.now());
  insert.run('student', 'Student', 'STU1', 'student@example.test', 'student', 'CS', hashPassword(password), Date.now());
  insert.run('student2', 'Student Two', 'STU2', 'student2@example.test', 'student', 'CS', hashPassword(password), Date.now());
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

async function request(path, { method = 'GET', body, cookie, requestOrigin = origin } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers.Origin = requestOrigin;
  }
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    payload,
    cookie: setCookie?.split(';')[0]
  };
}

async function login(identifier) {
  const response = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier, password }
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return response.cookie;
}

test('role boundaries, server-timed attempt, hidden keys, and published result', async () => {
  assert.equal((await request('/api/health')).payload.status, 'ok');
  assert.equal((await request('/api/users')).status, 401);

  const adminCookie = await login('ADMIN');
  const lecturerCookie = await login('lecturer@example.test');
  const studentCookie = await login('STU1');
  const otherStudentCookie = await login('STU2');

  const adminState = await request('/api/state', { cookie: adminCookie });
  assert.equal(adminState.status, 200);
  assert.equal(adminState.payload.currentUser.role, 'admin');
  assert.ok(Array.isArray(adminState.payload.users));

  assert.equal((await request('/api/users', { cookie: studentCookie })).status, 403);
  assert.equal((await request('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    requestOrigin: 'https://attacker.example',
    body: {
      name: 'Blocked', reg: 'X1', email: 'blocked@example.test',
      role: 'student', initialPassword: 'Long-enough-password-1!'
    }
  })).status, 403);

  const invalidQuestion = await request('/api/questions', {
    method: 'POST',
    cookie: lecturerCookie,
    body: {
      type: 'mcq',
      text: 'Invalid duplicate key',
      marks: 1,
      subject: 'CS',
      options: ['A', 'B'],
      correct: [0, 0]
    }
  });
  assert.equal(invalidQuestion.status, 400);

  const questionResponse = await request('/api/questions', {
    method: 'POST',
    cookie: lecturerCookie,
    body: {
      type: 'mcq',
      text: 'Which option is correct?',
      marks: 2,
      subject: 'CS',
      options: ['Correct', 'Incorrect'],
      correct: [0]
    }
  });
  assert.equal(questionResponse.status, 201, JSON.stringify(questionResponse.payload));
  const questionId = questionResponse.payload.question.id;
  const lecturerState = await request('/api/state', { cookie: lecturerCookie });
  assert.equal(lecturerState.payload.questions[0].id, questionId);
  assert.equal(lecturerState.payload.questions[0].opts[0], 'Correct');
  assert.deepEqual(lecturerState.payload.questions[0].correct, [0]);

  const examResponse = await request('/api/exams', {
    method: 'POST',
    cookie: lecturerCookie,
    body: {
      code: 'CS-TEST-1',
      title: 'Test exam',
      subject: 'CS',
      opensAt: Date.now() - 60_000,
      closesAt: Date.now() + 60 * 60_000,
      durationMinutes: 5,
      passMark: 50,
      instructions: '',
      classes: ['CS'],
      regs: [],
      questions: [{ id: questionId, marks: 2 }]
    }
  });
  assert.equal(examResponse.status, 201, JSON.stringify(examResponse.payload));
  const examId = examResponse.payload.exam.id;
  assert.equal((await request(`/api/exams/${examId}/schedule`, { method: 'POST', cookie: lecturerCookie, body: {} })).status, 200);
  const lecturerExamState = await request('/api/state', { cookie: lecturerCookie });
  assert.ok(lecturerExamState.payload.users.some(user => user.id === 'lecturer'));

  const studentExams = await request('/api/exams', { cookie: studentCookie });
  assert.equal(studentExams.status, 200);
  assert.equal('questions' in studentExams.payload.exams[0], false);

  const started = await request(`/api/exams/${examId}/start`, { method: 'POST', cookie: studentCookie, body: {} });
  assert.equal(started.status, 201, JSON.stringify(started.payload));
  const attempt = started.payload;
  assert.equal('correct' in attempt.questions[0], false);
  assert.equal('accepted' in attempt.questions[0], false);
  const studentState = await request('/api/state', { cookie: studentCookie });
  assert.equal(studentState.status, 200);
  assert.equal(studentState.payload.questions[0].opts[0], 'Correct');
  assert.equal('correct' in studentState.payload.questions[0], false);
  assert.equal(studentState.payload.exams[0].qs[0].id, questionId);
  assert.equal('resultAnswers' in studentState.payload.attempts[0], false);

  const resumed = await request(`/api/exams/${examId}/start`, { method: 'POST', cookie: studentCookie, body: {} });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.payload.id, attempt.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE exam_id = ? AND student_id = ?').get(examId, 'student').count, 1);
  assert.equal((await request(`/api/attempts/${attempt.id}`, { cookie: otherStudentCookie })).status, 404);
  assert.equal((await request(`/api/attempts/${attempt.id}`, { cookie: lecturerCookie })).status, 409);

  const saved = await request(`/api/attempts/${attempt.id}/answers/${questionId}`, {
    method: 'PUT',
    cookie: studentCookie,
    body: { answer: [0] }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  db.prepare('UPDATE attempts SET deadline = ? WHERE id = ?').run(Date.now() - 1, attempt.id);
  const expired = await request(`/api/attempts/${attempt.id}`, { cookie: studentCookie });
  assert.ok(expired.payload.attempt.submittedAt > 0);
  const submitted = await request(`/api/attempts/${attempt.id}/submit`, { method: 'POST', cookie: studentCookie, body: {} });
  assert.equal(submitted.status, 200);

  db.prepare('UPDATE exams SET closes_at = ? WHERE id = ?').run(Date.now() - 1, examId);
  const published = await request(`/api/exams/${examId}/publish`, { method: 'POST', cookie: lecturerCookie, body: {} });
  assert.equal(published.status, 200, JSON.stringify(published.payload));

  const results = await request('/api/results', { cookie: studentCookie });
  assert.equal(results.status, 200);
  assert.equal(results.payload.results.length, 1);
  assert.equal(results.payload.results[0].summary.percent, 100);
  assert.deepEqual(results.payload.results[0].answers[0].correct, [0]);
  const publishedState = await request('/api/state', { cookie: studentCookie });
  assert.deepEqual(publishedState.payload.attempts[0].resultAnswers[questionId].correct, [0]);

  const afterSubmit = await request(`/api/attempts/${attempt.id}/answers/${questionId}`, {
    method: 'PUT',
    cookie: studentCookie,
    body: { answer: [1] }
  });
  assert.equal(afterSubmit.status, 409);

  const unpublishAsLecturer = await request(`/api/exams/${examId}/unpublish`, {
    method: 'POST',
    cookie: lecturerCookie,
    body: {}
  });
  assert.equal(unpublishAsLecturer.status, 403);
  assert.equal((await request(`/api/exams/${examId}/unpublish`, { method: 'POST', cookie: adminCookie, body: {} })).status, 200);

  for (let index = 0; index < 5; index++) {
    const failed = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'student2@example.test', password: 'wrong-password' }
    });
    assert.equal(failed.status, 401);
  }
  const locked = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'STU2', password }
  });
  assert.equal(locked.status, 423);
});
