/**
 * menuBuild.js — Cloud Run Job "menu-build" (every 10 min).
 * Replaces scripts/refresh-menu.sh on the Mac mini.
 *
 *   1. Pastry menus from FlavorSchedule (Cloud SQL) + Square prices/inventory
 *   2. Beverage menus from bev-items-config.json (GCS)
 *   3. Promo slides for the portrait v2 screens from Dropbox (skipped when not configured)
 *   4. Publish to horizontal (main + gh-pages), portrait and beverages repos
 *
 * If one build step fails, whatever did build is still published, and the job
 * exits non-zero so the failure shows up in Cloud Run.
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join }   from 'path';
import { buildMenuFromDB }   from '../buildMenuFromDB.js';
import { buildBeverageMenu } from '../buildBeverageMenu.js';
import { buildPromos }       from '../buildPromos.js';
import { DISPLAY_LOCATIONS } from '../lib/locations.js';
import { publishTargets }    from './publish.js';
import { menuBuildTargets }  from './targets.js';
import { centralTime }       from './time.js';

// The builders are parameters only so tests can stand in for MySQL/Square; run.js passes nothing.
export async function runMenuBuild({ buildPastry = buildMenuFromDB, buildBev = buildBeverageMenu, buildPromo = buildPromos } = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), 'menu-build-'));
  const errors = [];
  let pastryFiles = [];
  let bevFiles    = [];
  let promos      = null;

  try {
    try { pastryFiles = await buildPastry({ outputDir }); }
    catch (err) { errors.push('pastry'); console.error('❌  Pastry build failed:', err.message); }

    try { bevFiles = await buildBev({ outputDir }); }
    catch (err) { errors.push('beverages'); console.error('❌  Beverage build failed:', err.message); }

    // A failed promo build publishes nothing for promos, so the screens keep the last good set.
    try { promos = await buildPromo({ outputDir: join(outputDir, 'promo-build') }); }
    catch (err) { errors.push('promos'); console.error('❌  Promo build failed:', err.message); }

    const portraitSlugs = DISPLAY_LOCATIONS.filter(l => l.layout === 'portrait').map(l => l.slug);
    // The bev build leaves a copy of the config it used; admin.html reads it from the beverages repo.
    const bevConfig = join(outputDir, 'bev-items-config.json');
    const bevConfigFile = bevFiles.length && existsSync(bevConfig) ? bevConfig : null;
    const targets = menuBuildTargets({ pastryFiles, bevFiles, bevConfigFile, portraitSlugs, promos });

    const { failed } = await publishTargets(
      targets,
      // Distinct from the Mac mini's menu-refresh[bot] commits, so GitHub shows which pipeline pushed.
      `chore: auto-refresh menu data [cloud-run] [${centralTime()}]`,
      { name: 'menu-build[bot]', email: 'menu-build@fivedaughtersbakery.com' },
    );

    const ok = !errors.length && !failed.length;
    console.log(`\n${ok ? '✅' : '⚠️ '}  menu-build done — build failures: [${errors.join(', ')}], push failures: [${failed.join(', ')}]`);
    return ok;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
