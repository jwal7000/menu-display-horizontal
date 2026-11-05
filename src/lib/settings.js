/**
 * settings.js — credentials and connection settings.
 *
 * On Cloud Run, everything comes from environment variables (secrets are
 * injected from Secret Manager with `--set-secrets`). On the Mac mini, nothing
 * is set in the environment, so we fall back to the existing files under
 * ~/.openclaw/secrets/ — the launchd scripts keep working unchanged.
 */

import { readFileSync, existsSync } from 'fs';

function expandPath(p) {
  return p.startsWith('~') ? p.replace('~', process.env.HOME || '') : p;
}

function readSecretFile(path) {
  const full = expandPath(path);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8');
}

export function squareToken() {
  if (process.env.SQUARE_ACCESS_TOKEN) return process.env.SQUARE_ACCESS_TOKEN.trim();
  const raw = readSecretFile(process.env.SQUARE_CREDENTIALS_PATH || '~/.openclaw/secrets/square.json');
  const token = raw ? JSON.parse(raw).access_token : null;
  if (!token) throw new Error('No Square token: set SQUARE_ACCESS_TOKEN or provide ~/.openclaw/secrets/square.json');
  return token;
}

function mysqlPassword() {
  if (process.env.MYSQL_PASSWORD) return process.env.MYSQL_PASSWORD.trim();
  const raw = readSecretFile('~/.openclaw/secrets/mysql.env');
  const line = raw?.split('\n').find(l => l.startsWith('MYSQL_PASSWORD'));
  if (!line) throw new Error('No MySQL password: set MYSQL_PASSWORD or provide ~/.openclaw/secrets/mysql.env');
  return line.split('=').slice(1).join('=').trim();
}

/**
 * mysql2 connection options.
 * Cloud Run: MYSQL_SOCKET=/cloudsql/<project>:<region>:<instance> (built-in Cloud SQL connector).
 * Mac mini:  Cloud SQL Auth Proxy on 127.0.0.1:3307.
 */
export function mysqlOptions() {
  const base = {
    user:        process.env.MYSQL_USER     || 'FDB_SteveConnect',
    password:    mysqlPassword(),
    database:    process.env.MYSQL_DATABASE || 'production',
    dateStrings: true,
  };
  if (process.env.MYSQL_SOCKET) return { ...base, socketPath: process.env.MYSQL_SOCKET };
  return {
    ...base,
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3307),
  };
}

export function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const raw = readSecretFile('~/.openclaw/secrets/menu-refresh.json');
  const token = raw ? JSON.parse(raw).github_token : null;
  if (!token) throw new Error('No GitHub token: set GITHUB_TOKEN');
  return token;
}
