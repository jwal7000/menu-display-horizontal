/**
 * targets.js — where each generated file is published.
 * Mirrors what scripts/refresh-menu.sh and refresh-inventory.sh do on the Mac mini.
 */

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { basename, join, dirname } from 'path';

export const REPOS = {
  horizontal: process.env.REPO_HORIZONTAL || 'jwal7000/menu-display-horizontal',
  portrait:   process.env.REPO_PORTRAIT   || 'jwal7000/menu-display-portrait',
  beverages:  process.env.REPO_BEVERAGES  || 'jwal7000/menu-display-beverages',
};

/** Returns an apply(dir) that copies `files` into `destDirs` inside the clone. */
export function copyInto(files, destDirs) {
  return async (dir) => {
    const touched = [];
    for (const destDir of destDirs) {
      mkdirSync(join(dir, destDir), { recursive: true });
      for (const f of files) {
        if (!existsSync(f)) continue;
        const rel = join(destDir, basename(f));
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        copyFileSync(f, join(dir, rel));
        touched.push(rel);
      }
    }
    return touched;
  };
}

/**
 * Publishing plan for a full menu build.
 *   pastryFiles — output/data/{slug}.json for every location
 *   bevFiles    — output/data/bev-{slug}.json
 *   portraitSlugs — slugs served by the portrait repo
 */
export function menuBuildTargets({ pastryFiles, bevFiles, portraitSlugs }) {
  const all = [...pastryFiles, ...bevFiles];
  const portraitFiles = pastryFiles.filter(f => portraitSlugs.includes(basename(f, '.json')));
  const targets = [];

  if (all.length) {
    targets.push({ repo: REPOS.horizontal, branch: 'main',     label: 'horizontal main',     apply: copyInto(all, ['output/data']) });
    targets.push({ repo: REPOS.horizontal, branch: 'gh-pages', label: 'horizontal gh-pages', apply: copyInto(all, ['data']) });
  }
  if (portraitFiles.length) {
    targets.push({ repo: REPOS.portrait, branch: 'main', label: 'portrait main', apply: copyInto(portraitFiles, ['output/data']) });
  }
  if (bevFiles.length) {
    // public/data is what the Mac mini writes today. The repo's deploy-pages workflow
    // copies output/data → public/data, so output/data is kept current too — otherwise
    // an Actions deploy would overwrite fresh data with the stale Sept 25 copy.
    targets.push({ repo: REPOS.beverages, branch: 'main', label: 'beverages main', apply: copyInto(bevFiles, ['public/data', 'output/data']) });
  }
  return targets;
}
