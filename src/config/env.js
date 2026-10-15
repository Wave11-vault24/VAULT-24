'use strict';

const path = require('path');
const { z } = require('zod');

// Load .env only outside tests; tests set their own environment explicitly.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ quiet: true });
}

const ROOT = path.resolve(__dirname, '..', '..');
const INSECURE_SECRETS = new Set(['', 'changeme', 'change-me', 'secret', 'replace-with-a-long-random-string']);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default('data/vault24.db'),
  SESSION_SECRET: z.string().default(''),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  DOCUMENT_STORAGE_PATH: z.string().min(1).default('storage/private-documents'),
  MAX_DOCUMENT_SIZE_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  BANK_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('ZMW'),
  // Test runs only (e2e logs in many times). Ignored when NODE_ENV=production.
  DISABLE_RATE_LIMIT: z.enum(['true', 'false']).default('false'),
});

function loadConfig(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Report which keys are invalid, never their values.
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  const env = parsed.data;

  const secretIsWeak = INSECURE_SECRETS.has(env.SESSION_SECRET) || env.SESSION_SECRET.length < 32;
  if (secretIsWeak) {
    if (env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET is missing or insecure (minimum 32 characters) in production.');
    }
    // Non-production fallback so local dev and tests can start. Never used in production.
    env.SESSION_SECRET = 'dev-only-insecure-session-secret-do-not-use-in-prod';
    env.usingFallbackSecret = true;
  }

  const resolve = (p) => (p === ':memory:' || path.isAbsolute(p) ? p : path.join(ROOT, p));
  env.DATABASE_PATH = resolve(env.DATABASE_PATH);
  env.DOCUMENT_STORAGE_PATH = resolve(env.DOCUMENT_STORAGE_PATH);
  env.isProduction = env.NODE_ENV === 'production';
  env.rateLimitEnabled = env.isProduction || env.DISABLE_RATE_LIMIT !== 'true';
  env.isTest = env.NODE_ENV === 'test';
  return Object.freeze(env);
}

module.exports = { loadConfig, config: loadConfig() };
