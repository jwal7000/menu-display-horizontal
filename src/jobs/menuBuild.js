/**
 * menuBuild.js — Cloud Run Job "menu-build" (every 10 min).
 * Replaces scripts/refresh-menu.sh on the Mac mini.
 *
 *   1. Pastry menus from FlavorSchedule (Cloud SQL) + Square prices/inventory
 *   2. Beverage menus from bev-items-config.json (GCS)
 *   3. Publish to horizontal (main + gh-pages), portrait and beverages repos
 *
 * If one build step fails, whatever did build is still published, and the job
 * exits non-zero so the failure shows up in Cloud Run.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join }   from 'path';
import { buildMenuFromDB }   from '../buildMenuFromDB.js';
import { buildBeverageMenu } from '../buildBeverageMenu.js';
import { DISPLAY_LOCATIONS } from '../lib/locations.js';
import { publishTargets }    from './publish.js';
import { menuBuildTargets }  from './targets.js';
import { centralTime }       from './time.js';

export async function runMenuBuild() {
  const outputDir = mkdtempSync(join(tmpdir(), 'menu-build-'));
  const errors = [];
  let pastryFiles = [];
  let bevFiles    = [];

  try {
    try { pastryFiles = await buildMenuFromDB({ outputDir }); }
    catch (err) { errors.push('pastry'); console.error('❌  Pastry build failed:', err.message); }

    try { bevFiles = await buildBeverageMenu({ outputDir }); }
    catch (err) { errors.push('beverages'); console.error('❌  Beverage build failed:', err.message); }

    const portraitSlugs = DISPLAY_LOCATIONS.filter(l => l.layout === 'portrait').map(l => l.slug);
    const targets = menuBuildTargets({ pastryFiles, bevFiles, portraitSlugs });

    const { failed } = await publishTargets(
      targets,
      `chore: auto-refresh menu data [${centralTime()}]`,
      { name: 'menu-refresh[bot]', email: 'menu-refresh@fivedaughtersbakery.com' },
    );

    const ok = !errors.length && !failed.length;
    console.log(`\n${ok ? '✅' : '⚠️ '}  menu-build done — build failures: [${errors.join(', ')}], push failures: [${failed.join(', ')}]`);
    return ok;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
