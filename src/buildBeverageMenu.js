/**
 * buildBeverageMenu.js
 * Builds the beverage menu JSON for display at Type 2 stores (Gulch, Medley).
 *
 * Data source: output/bev-items-config.json (manually curated items + pricing).
 * Availability: item.available flag in the config (updated seasonally or by staff).
 *
 * Output: output/data/bev-{slug}.json per location.
 *
 * Usage: npm run build-bev
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve }  from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = resolve(__dirname, '..');
const OUTPUT_DIR = resolve(ROOT_DIR, 'output');

// Type 2 stores that have a beverage display (horizontal)
const BEV_LOCATIONS = [
  { slug: 'the-gulch', name: 'The Gulch', sqId: 'L4CQJADFVPZC9' },
  { slug: 'medley',    name: 'Medley',    sqId: 'LDR9H5M3GQKXF' },
];

function expandPath(p) { return p.startsWith('~') ? p.replace('~', process.env.HOME||'') : p; }

async function buildBeverageMenu() {
  // Load item config
  const configPath = resolve(OUTPUT_DIR, 'bev-items-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  console.log(`\n🍵  Building beverage menu from config: ${config.sections.length} sections`);

  // Load staff availability overrides from GCS (public URL)
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

  mkdirSync(resolve(OUTPUT_DIR, 'data'), { recursive: true });

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

    const outPath = resolve(OUTPUT_DIR, 'data', `bev-${loc.slug}.json`);
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`    ✅  ${sections.length} sections, ${itemCount} items (${unavailCount} unavailable)`);
    for (const s of sections) {
      const unavl = (s.items||[]).filter(i=>!i.available).length;
      console.log(`       • ${s.name.padEnd(22)} ${String((s.items||[]).length).padStart(2)} items${unavl ? `  (${unavl} off)` : ''}`);
    }
  }

  console.log('\n✅  Done.\n');
}

buildBeverageMenu().catch(err => { console.error('❌  Fatal:', err.message); process.exit(1); });
