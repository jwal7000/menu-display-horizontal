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

const LOCAL_CONFIG = resolve(DEFAULT_OUTPUT_DIR, 'bev-items-config.json');

/** Returns the config's raw text and where it came from. */
async function loadConfigText() {
  const url = process.env.BEV_CONFIG_URL;
  if (url) {
    console.log(`   📥  Loading bev config from ${url}`);
    return { raw: String(await readObject(url)), from: url };
  }
  return { raw: readFileSync(LOCAL_CONFIG, 'utf8'), from: LOCAL_CONFIG };
}

/**
 * Builds bev-{slug}.json for every beverage location into {outputDir}/data/.
 * Returns the list of files written.
 *
 * Also saves the config it used, byte for byte, as {outputDir}/bev-items-config.json
 * (unless that's the file it was read from). menu-build publishes it to the beverages
 * repo, where admin.html reads its drink list.
 */
export async function buildBeverageMenu({ outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const { raw, from } = await loadConfigText();
  const config = JSON.parse(raw);
  if (!Array.isArray(config.sections)) throw new Error('bev-items-config.json has no sections array');
  console.log(`\n🍵  Building beverage menu from config: ${config.sections.length} sections`);

  // Staff availability overrides aren't applied here: admin.html writes
  // overrides-{slug}.json in menu-display-beverages, and bev.js applies it in the browser.

  mkdirSync(resolve(outputDir, 'data'), { recursive: true });
  const configCopy = resolve(outputDir, 'bev-items-config.json');
  if (configCopy !== from) writeFileSync(configCopy, raw);
  const written = [];

  for (const loc of BEV_LOCATIONS) {
    console.log(`\n📍  ${loc.name}`);

    // Deep copy sections from config, so each location's output is independent
    const sections = JSON.parse(JSON.stringify(config.sections));

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
