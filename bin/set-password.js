#!/usr/bin/env node
/**
 * Generate a scrypt password hash for the dashboard login.
 *
 * Usage:
 *   npm run set-password -- "YourStrongPassword"
 *   node bin/set-password.js "YourStrongPassword"
 *
 * Paste the printed value into DASHBOARD_PASSWORD_HASH in your .env.
 * The format ("scrypt$<salt>$<hash>") is what src/server.js verifies, timing-safe.
 */
const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node bin/set-password.js "YourStrongPassword"');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const value = `scrypt$${salt}$${hash}`;

console.log('\nAdd this line to your .env:\n');
console.log(`DASHBOARD_PASSWORD_HASH=${value}\n`);
