/**
 * buildBeverageMenu.js
 * Builds the beverage menu JSON for display at Type 2 stores (Gulch, Medley).
 *
 * Data source: bev-items-config.json (manually curated items + pricing).
 *   - BEV_CONFIG_URL=gs://analytics-link-370416-menu/bev-items-config.json → read from GCS (Cloud Run)
 *   - otherwise output/bev-items-config.json on local disk (Mac mini)
 * Availability: item.available flag in the config (updated seasonally or by staff).
 *
 * Output: output/data/bev-{slug}.json per location.
 *
 * Usage: npm run build-bev
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve }  from 'path';
import { BEV_LOCATIONS }     from './lib/locations.js';
import { readObject }        from './lib/gcs.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = resolve(ROOT_DIR, 'output');

async function loadConfig() {
  const url = process.env.BEV_CONFIG_URL;
  if (url) {
    console.log(`   📥  Loading bev config from ${url}`);
    return JSON.parse(await readObject(url));
  }
  return JSON.parse(readFileSync(resolve(DEFAULT_OUTPUT_DIR, 'bev-items-config.json'), 'utf8'));
}

/**
 * Builds bev-{slug}.json for every beverage location into {outputDir}/data/.
 * Returns the list of files written.
 */
export async function buildBeverageMenu({ outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const config = await loadConfig();
  if (!Array.isArray(config.sections)) throw new Error('bev-items-config.json has no sections array');
  console.log(`\n🍵  Building beverage menu from config: ${config.sections.length} sections`);

  // Load staff availability overrides from GCS (public URL).
  // NOTE: legacy — written by the old fdb-bev-override service. admin.html now writes
  // overrides-{slug}.json in menu-display-beverages, which bev.js applies in the browser.
  // Kept so behaviour doesn't change during the migration; remove when that service is retired.
  const OVERRIDES_URL = 'https://storage.googleapis.com/analytics-link-370416-menu/bev-overrides.json';
  let overrideSet = new Set();
  try {
    const res = await fetch(OVERRIDES_URL + '?t=' + Date.now());
    if (res.ok) {
      const ov = await res.json();
      overrideSet = new Set(ov.unavailable || []);
      if (overrideSet.size) {
        console.log(`   🚫  Staff overrides (${overrideSet.size}): ${[...overrideSet].join(', ')}`);
      }
    }
  } catch (e) { console.warn('   ⚠️   Could not fetch bev-overrides from GCS:', e.message); }

  mkdirSync(resolve(outputDir, 'data'), { recursive: true });
  const written = [];

  for (const loc of BEV_LOCATIONS) {
    console.log(`\n📍  ${loc.name}`);

    // Deep copy sections from config (so we can mutate availability per location)
    const sections = JSON.parse(JSON.stringify(config.sections));

    // Apply staff overrides
    if (overrideSet.size) {
      for (const sec of sections) {
        for (const item of (sec.items || [])) {
          if (overrideSet.has(item.name)) item.available = false;
        }
        for (const sub of (sec.sub_sections || [])) {
          for (const item of sub.items) {
            if (overrideSet.has(item.name)) item.available = false;
          }
        }
      }
    }

    let itemCount = 0;
    let unavailCount = 0;
    for (const sec of sections) {
      const items = sec.items || [];
      itemCount += items.length;
      unavailCount += items.filter(i => !i.available).length;

      // sub_sections (NON ESPRESSO)
      if (sec.sub_sections) {
        for (const sub of sec.sub_sections) {
          itemCount += sub.items.length;
          unavailCount += sub.items.filter(i => !i.available).length;
        }
      }
    }

    const output = {
      location_name: loc.name,
      generated_at:  new Date().toISOString(),
      source:        'bev-items-config',
      item_count:    itemCount,
      unavailable:   unavailCount,
      sections,
    };

    const outPath = resolve(outputDir, 'data', `bev-${loc.slug}.json`);
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    written.push(outPath);
    console.log(`    ✅  ${sections.length} sections, ${itemCount} items (${unavailCount} unavailable)`);
    for (const s of sections) {
      const unavl = (s.items||[]).filter(i=>!i.available).length;
      console.log(`       • ${s.name.padEnd(22)} ${String((s.items||[]).length).padStart(2)} items${unavl ? `  (${unavl} off)` : ''}`);
    }
  }

  console.log('\n✅  Done.\n');
  return written;
}

// CLI: `npm run build-bev` (Mac mini launchd path — unchanged behaviour)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildBeverageMenu().catch(err => { console.error('❌  Fatal:', err.message); process.exit(1); });
}
