/**
 * targets.js — where each generated file is published.
 * Mirrors what scripts/refresh-menu.sh and refresh-inventory.sh do on the Mac mini.
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { basename, join, dirname } from 'path';

export const REPOS = {
  horizontal: process.env.REPO_HORIZONTAL || 'jwal7000/menu-display-horizontal',
  portrait:   process.env.REPO_PORTRAIT   || 'jwal7000/menu-display-portrait',
  beverages:  process.env.REPO_BEVERAGES  || 'jwal7000/menu-display-beverages',
};

// Timestamp-only changes are skipped, but each file is still refreshed at least this often.
// Every display shows "Last updated <generated_at>" in its footer, so a footer much older
// than this (plus one 10-min run) means publishing has stopped. That's the only staleness
// signal visible in the stores.
export const HEARTBEAT_MS = 60 * 60 * 1000;
const TIMESTAMP_KEYS = ['generated_at', 'inventory_patched_at'];

function withoutTimestamps(menu) {
  const copy = { ...menu };
  for (const k of TIMESTAMP_KEYS) delete copy[k];
  return JSON.stringify(copy);
}

/**
 * True when `newPath` differs from the published `oldPath` only in its timestamps,
 * and the published copy is younger than `heartbeatMs`. Anything unreadable → false (publish).
 */
export function onlyTimestampsChanged(oldPath, newPath, heartbeatMs, now = Date.now()) {
  if (!existsSync(oldPath)) return false;
  try {
    const prev = JSON.parse(readFileSync(oldPath, 'utf8'));
    const next = JSON.parse(readFileSync(newPath, 'utf8'));
    // Files with no timestamp at all (e.g. the bev config) are unchanged when their content is.
    if (!('generated_at' in prev) && !('generated_at' in next)) return JSON.stringify(prev) === JSON.stringify(next);
    const age  = now - Date.parse(prev.generated_at);
    if (!(age >= 0 && age < heartbeatMs)) return false;
    return withoutTimestamps(prev) === withoutTimestamps(next);
  } catch {
    return false;
  }
}

/**
 * Returns an apply(dir) that copies `files` into `destDirs` inside the clone.
 * With `heartbeatMs`, the whole target is left alone when every file differs from the
 * published copy only in its timestamps and the published copies are younger than
 * `heartbeatMs` (see HEARTBEAT_MS). Otherwise every file is copied, so all files in a
 * repo share one timestamp and the heartbeat costs at most one commit per repo.
 */
export function copyInto(files, destDirs, { heartbeatMs } = {}) {
  return copyGroups([[files, destDirs]], { heartbeatMs });
}

/**
 * Like copyInto, for several [files, destDirs] groups going to the same repo. The skip
 * decision covers all groups together, so a repo gets at most one commit per run.
 */
export function copyGroups(groups, { heartbeatMs } = {}) {
  return async (dir) => {
    const plan = [];
    for (const [files, destDirs] of groups) {
      for (const destDir of destDirs) {
        for (const f of files) {
          if (existsSync(f)) plan.push({ src: f, rel: join(destDir, basename(f)) });
        }
      }
    }
    if (heartbeatMs && plan.length && plan.every(({ src, rel }) => onlyTimestampsChanged(join(dir, rel), src, heartbeatMs))) {
      console.log(`    only timestamps changed in ${plan.length} file(s); skipped until the ${heartbeatMs / 60000}-min heartbeat`);
      return [];
    }
    for (const { src, rel } of plan) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(src, join(dir, rel));
    }
    return plan.map(p => p.rel);
  };
}

/**
 * Publishing plan for a full menu build.
 *   pastryFiles — output/data/{slug}.json for every location
 *   bevFiles    — output/data/bev-{slug}.json
 *   bevConfigFile — the bev config the build used (published for admin.html), or null
 *   portraitSlugs — slugs served by the portrait repo
 *   heartbeatMs   — skip timestamp-only changes until the published copy is this old (0 = never skip)
 */
export function menuBuildTargets({ pastryFiles, bevFiles, bevConfigFile = null, portraitSlugs, heartbeatMs = HEARTBEAT_MS }) {
  const skip = { heartbeatMs };
  const all = [...pastryFiles, ...bevFiles];
  const portraitFiles = pastryFiles.filter(f => portraitSlugs.includes(basename(f, '.json')));
  const targets = [];

  if (all.length) {
    // admin.html (staff override app) reads its pastry item list from main:public/data/{slug}.json.
    targets.push({ repo: REPOS.horizontal, branch: 'main',     label: 'horizontal main',
                   apply: copyGroups([[all, ['output/data']], [pastryFiles, ['public/data']]], skip) });
    targets.push({ repo: REPOS.horizontal, branch: 'gh-pages', label: 'horizontal gh-pages', apply: copyInto(all, ['data'], skip) });
  }
  if (portraitFiles.length) {
    targets.push({ repo: REPOS.portrait, branch: 'main', label: 'portrait main', apply: copyInto(portraitFiles, ['output/data'], skip) });
  }
  if (bevFiles.length) {
    // public/data is what the Mac mini writes today. The repo's deploy-pages workflow
    // copies output/data → public/data, so output/data is kept current too — otherwise
    // an Actions deploy would overwrite fresh data with the stale Sept 25 copy.
    // admin.html reads its drink list from output/bev-items-config.json in this repo.
    targets.push({ repo: REPOS.beverages, branch: 'main', label: 'beverages main',
                   apply: copyGroups([[bevFiles, ['public/data', 'output/data']], [bevConfigFile ? [bevConfigFile] : [], ['output']]], skip) });
  }
  return targets;
}
