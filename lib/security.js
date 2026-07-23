const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const SCRYPT_KEY_LENGTH = 64;

function validateNewPassword(password) {
  if (typeof password !== 'string') throw new Error('密码格式无效');
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符`);
  if (password.length > PASSWORD_MAX_LENGTH) throw new Error(`密码最多允许 ${PASSWORD_MAX_LENGTH} 个字符`);
  return password;
}

async function hashPassword(password) {
  validateNewPassword(password);
  const salt = crypto.randomBytes(24);
  const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return {
    version: 1,
    algorithm: 'scrypt',
    salt: salt.toString('base64url'),
    hash: Buffer.from(derived).toString('base64url'),
    keyLength: SCRYPT_KEY_LENGTH,
    cost: SCRYPT_OPTIONS.N,
    blockSize: SCRYPT_OPTIONS.r,
    parallelization: SCRYPT_OPTIONS.p,
    createdAt: new Date().toISOString()
  };
}

async function verifyPassword(password, record) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX_LENGTH) return false;
  if (!record || record.version !== 1 || record.algorithm !== 'scrypt') return false;
  try {
    const salt = Buffer.from(record.salt, 'base64url');
    const expected = Buffer.from(record.hash, 'base64url');
    const keyLength = Number(record.keyLength);
    const options = {
      N: Number(record.cost),
      r: Number(record.blockSize),
      p: Number(record.parallelization),
      maxmem: 64 * 1024 * 1024
    };
    if (salt.length < 16 || expected.length !== keyLength || keyLength !== SCRYPT_KEY_LENGTH) return false;
    if (!Number.isInteger(options.N) || !Number.isInteger(options.r) || !Number.isInteger(options.p)) return false;
    const actual = Buffer.from(await scryptAsync(password, salt, keyLength, options));
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const item of String(header).split(';')) {
    const index = item.indexOf('=');
    if (index <= 0) continue;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

class SessionStore {
  constructor({ ttlMs = 8 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  create(ip) {
    const token = randomToken(36);
    const session = {
      token,
      csrfToken: randomToken(24),
      ip,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  cleanup() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

class LoginRateLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000, blockMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.records = new Map();
  }

  status(ip) {
    const now = Date.now();
    const record = this.records.get(ip);
    if (!record) return { allowed: true, retryAfterSeconds: 0 };
    if (record.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((record.blockedUntil - now) / 1000) };
    }
    record.failures = record.failures.filter((timestamp) => timestamp > now - this.windowMs);
    if (record.failures.length === 0) this.records.delete(ip);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  fail(ip) {
    const now = Date.now();
    const record = this.records.get(ip) || { failures: [], blockedUntil: 0 };
    record.failures = record.failures.filter((timestamp) => timestamp > now - this.windowMs);
    record.failures.push(now);
    if (record.failures.length >= this.maxFailures) record.blockedUntil = now + this.blockMs;
    this.records.set(ip, record);
    return this.status(ip);
  }

  reset(ip) {
    this.records.delete(ip);
  }
}

module.exports = {
  LoginRateLimiter,
  SessionStore,
  equalText,
  hashPassword,
  parseCookies,
  randomToken,
  validateNewPassword,
  verifyPassword
};
