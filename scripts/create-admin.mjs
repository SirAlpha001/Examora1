import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../db.mjs';

const prompt = createInterface({ input: stdin, output: stdout });
const lines = prompt[Symbol.asyncIterator]();

async function ask(label) {
  stdout.write(`${label}: `);
  const { value, done } = await lines.next();
  if (done) throw new Error('Input ended before all administrator details were entered.');
  return value.trim();
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

try {
  const name = await ask('Administrator name');
  const reg = await ask('Registration number');
  const email = await ask('Email');

  if (!name || !reg || !email) {
    throw new Error('Name, registration number, and email are required.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE role = ? LIMIT 1').get('admin')) {
    throw new Error('An administrator already exists. Use the existing admin account or a reviewed reset procedure.');
  }

  const password = randomBytes(24).toString('base64url');
  db.prepare(`
    INSERT INTO users (id, name, reg, email, role, password_hash, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 'admin', ?, 1, ?)
  `).run(randomBytes(16).toString('hex'), name, reg, email, hashPassword(password), Date.now());
  console.log(`Administrator created. Temporary password (shown once): ${password}`);
  console.log('Sign in and change this password immediately.');
} finally {
  prompt.close();
  db.close();
}
