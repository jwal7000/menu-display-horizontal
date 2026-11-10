/**
 * publish.js — stateless git publisher for Cloud Run Jobs.
 *
 * Each target is { repo, branch, label, apply(dir) → [relative paths touched] }.
 * For every target we shallow-clone the branch into a temp dir, run apply(),
 * commit if anything changed, and push. If the push is rejected (someone else —
 * e.g. admin.html or the other job — pushed first) we throw the clone away and
 * start again from a fresh one, so there are never rebase conflicts on
 * generated files.
 *
 * A failure in one target never stops the others. publishTargets() returns
 * { failed: [...labels] } so the job can exit non-zero.
 *
 * Env:
 *   GITHUB_TOKEN   — token with contents:write on the display repos
 *   GIT_BASE_URL   — override for tests (e.g. file:///tmp/remotes); default https://github.com
 *   DRY_RUN=1      — do everything except push; changed files are uploaded to
 *                    DRY_RUN_URL (gs://…) instead, when that is set
 */

import { execFile }  from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir }    from 'os';
import { join }      from 'path';
import { githubToken } from '../lib/settings.js';
// gcs.js (googleapis) is imported only for dry-run uploads: it's slow to load on a cold container.

const exec = promisify(execFile);
const MAX_ATTEMPTS = 3;


function remoteUrl(repo) {
  const base = process.env.GIT_BASE_URL;
  if (base) return `${base.replace(/\/$/, '')}/${repo}.git`;
  return `https://x-access-token:${githubToken()}@github.com/${repo}.git`;
}

/** Never let a token reach the logs. */
function scrub(text) {
  return String(text).replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

async function git(dir, ...args) {
  try {
    const { stdout } = await exec('git', ['-C', dir, '-c', 'credential.helper=', ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = new Error(scrub(`git ${args[0]} failed: ${err.stderr || err.message}`));
    e.code = err.code;
    throw e;
  }
}

const dryRun = () => process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function publishOne(target, message, author) {
  const { repo, branch, label, apply } = target;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), 'publish-'));
    try {
      await exec('git', ['-c', 'credential.helper=', 'clone', '--quiet', '--depth', '1',
                         '--branch', branch, '--single-branch', remoteUrl(repo), dir],
                 { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
        .catch(err => { throw new Error(scrub(`clone ${repo}@${branch} failed: ${err.stderr || err.message}`)); });

      const paths = (await apply(dir)) || [];
      if (!paths.length) { console.log(`[publish] ${label}: nothing to apply.`); return true; }

      await git(dir, 'add', '--', ...paths);
      const changed = (await git(dir, 'diff', '--cached', '--name-only')).trim().split('\n').filter(Boolean);
      if (!changed.length) { console.log(`[publish] ${label}: no changes.`); return true; }

      await git(dir, '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
                'commit', '--quiet', '-m', message);

      if (dryRun()) {
        console.log(`[publish] ${label}: DRY RUN — would push ${changed.length} file(s): ${changed.join(', ')}`);
        const prefix = process.env.DRY_RUN_URL;
        if (prefix) {
          const { writeObject } = await import('../lib/gcs.js');
          for (const p of changed) {
            await writeObject(`${prefix.replace(/\/$/, '')}/${repo.split('/')[1]}/${branch}/${p}`,
                              readFileSync(join(dir, p)));
          }
          console.log(`[publish] ${label}: uploaded to ${prefix}`);
        }
        return true;
      }

      try {
        await git(dir, 'push', '--quiet', 'origin', `HEAD:${branch}`);
        console.log(`[publish] ${label}: pushed ${changed.length} file(s)${attempt > 1 ? ` (attempt ${attempt})` : ''}.`);
        return true;
      } catch (err) {
        console.warn(`[publish] ${label}: push rejected (attempt ${attempt}/${MAX_ATTEMPTS}) — ${err.message.split('\n')[0]}`);
        if (attempt === MAX_ATTEMPTS) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return false;
}

export async function publishTargets(targets, message, author) {
  const failed = [];
  for (const t of targets) {
    const start = Date.now();
    try {
      if (!(await publishOne(t, message, author))) failed.push(t.label);
    } catch (err) {
      console.error(`[publish] ${t.label}: FAILED — ${scrub(err.message)}`);
      failed.push(t.label);
    }
    console.log(`[publish] ${t.label}: ${((Date.now() - start) / 1000).toFixed(1)}s (clone, apply, push)`);
  }
  return { failed };
}
