/**
 * inventorySync.js — Cloud Run Job "inventory-sync" (every 2 min).
 * Replaces scripts/refresh-inventory.sh on the Mac mini.
 *
 * Reads the menu JSON currently published in each repo, fetches Square
 * inventory for just the variations on that menu, patches sold_out flags, and
 * pushes only when a flag actually changed.
 *
 * Differences from the Mac mini script (all intentional fixes):
 *   - Also patches horizontal gh-pages (the branch the Gulch/Medley screens are
 *     served from), not just main.
 *   - Honours skipInventory like the 10-min build does (no store sets it now).
 *   - Fetches counts only for menu items instead of paging the whole catalog.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DISPLAY_LOCATIONS } from '../lib/locations.js';
import { squareClient, fetchInventoryCounts, SOLD_OUT_THRESHOLD } from '../lib/square.js';
import { patchMenu, menuVariationIds } from '../patchMenuInventory.js';
import { publishTargets } from './publish.js';
import { REPOS }          from './targets.js';
import { centralTime }    from './time.js';

/**
 * Caches Square counts per location across targets (main and gh-pages hold the
 * same menu), fetching only IDs not seen yet.
 */
function countsCache(fetchCounts) {
  const byLoc = new Map(); // sqId → { fetched:Set, counts:{} }
  return async (loc, ids) => {
    if (!byLoc.has(loc.sqId)) byLoc.set(loc.sqId, { fetched: new Set(), counts: {} });
    const entry   = byLoc.get(loc.sqId);
    const missing = ids.filter(id => !entry.fetched.has(id));
    if (missing.length) {
      const got = await fetchCounts(loc.sqId, missing);
      for (const id of missing) entry.fetched.add(id);
      for (const [id, qty] of got) entry.counts[id] = qty;
    }
    return entry.counts;
  };
}

/** apply(dir) that patches {destDir}/{slug}.json for each location in the clone. */
export function patchInClone(locations, destDir, getCounts) {
  return async (dir) => {
    const touched = [];
    for (const loc of locations) {
      const rel  = join(destDir, `${loc.slug}.json`);
      const full = join(dir, rel);
      if (!existsSync(full)) { console.log(`   ${loc.slug}: no ${rel} — skipping`); continue; }

      const menu    = JSON.parse(readFileSync(full, 'utf8'));
      const counts  = await getCounts(loc, menuVariationIds(menu));
      const patched = patchMenu(menu, counts, SOLD_OUT_THRESHOLD);
      if (patched > 0) {
        writeFileSync(full, JSON.stringify(menu, null, 2));
        touched.push(rel);
        console.log(`   ${loc.slug} (${rel}): ${patched} sold_out change(s)`);
      }
    }
    return touched;
  };
}

export async function runInventorySync({ fetchCounts } = {}) {
  if (!fetchCounts) {
    const client = squareClient();
    fetchCounts = (sqId, ids) => fetchInventoryCounts(client, sqId, ids);
  }
  const getCounts = countsCache(fetchCounts);

  const tracked    = DISPLAY_LOCATIONS.filter(l => !l.skipInventory);
  const horizontal = tracked.filter(l => l.layout === 'horizontal');
  const portrait   = tracked.filter(l => l.layout === 'portrait');

  const targets = [
    { repo: REPOS.horizontal, branch: 'main',     label: 'horizontal main',     apply: patchInClone(horizontal, 'output/data', getCounts) },
    { repo: REPOS.horizontal, branch: 'gh-pages', label: 'horizontal gh-pages', apply: patchInClone(horizontal, 'data',        getCounts) },
    { repo: REPOS.portrait,   branch: 'main',     label: 'portrait main',       apply: patchInClone(portrait,   'output/data', getCounts) },
  ];

  const { failed } = await publishTargets(
    targets,
    // [cloud-run] tells these apart from the Mac mini's refresh-inventory.sh, which uses the same author.
    `chore: update sold_out flags [cloud-run] [${centralTime()}]`,
    { name: 'inventory-sync[bot]', email: 'inventory-sync@fivedaughtersbakery.com' },
  );
  console.log(`\n${failed.length ? '⚠️ ' : '✅'}  inventory-sync done — push failures: [${failed.join(', ')}]`);
  return !failed.length;
}
