/**
 * patchMenuInventory.js
 * Patches sold_out status in a menu JSON using Square inventory counts.
 * Keeps display data fresh between full rebuilds.
 *
 * Matching logic:
 *   - Multi-variation items:  variation.variation_id → counts
 *   - Single-variation items: item.variation_id (written by buildMenuFromDB) → counts,
 *                             falling back to item.item_id for older menu files.
 *   Items not tracked in inventory: sold_out unchanged.
 *
 * The file is only rewritten when at least one sold_out flag changes, so callers
 * can use `git diff` to decide whether to push.
 *
 * CLI env (Mac mini): MENU_FILE, INVENTORY_FILE
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, "../output");

const has = (obj, key) => key != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Mutates `menu` in place. `counts` is a plain object { variation_id: qty }.
 * Returns the number of sold_out flags that changed.
 */
export function patchMenu(menu, counts, threshold = 3) {
  let patched = 0;

  for (const section of (menu.sections || [])) {
    for (const item of (section.items || [])) {
      if (Array.isArray(item.variations) && item.variations.length > 0) {
        let anyAvailable = false;
        let anyTracked   = false;

        for (const v of item.variations) {
          if (has(counts, v.variation_id)) {
            anyTracked = true;
            const next = counts[v.variation_id] <= threshold;
            if (v.sold_out !== next) { v.sold_out = next; patched++; }
          }
          if (!v.sold_out) anyAvailable = true;
        }

        // Roll up: item is sold out only if every variation is sold out
        if (anyTracked && item.sold_out !== !anyAvailable) {
          item.sold_out = !anyAvailable;
        }
      } else {
        const key = has(counts, item.variation_id) ? item.variation_id
                  : has(counts, item.item_id)      ? item.item_id
                  : null;
        if (key) {
          const next = counts[key] <= threshold;
          if (item.sold_out !== next) { item.sold_out = next; patched++; }
        }
      }
    }
  }

  if (patched > 0) menu.inventory_patched_at = new Date().toISOString();
  return patched;
}

/** All Square variation IDs referenced by a menu (for a targeted inventory fetch). */
export function menuVariationIds(menu) {
  const ids = new Set();
  for (const section of (menu.sections || [])) {
    for (const item of (section.items || [])) {
      if (item.variation_id) ids.add(item.variation_id);
      for (const v of (item.variations || [])) if (v.variation_id) ids.add(v.variation_id);
    }
  }
  return [...ids];
}

function cli() {
  const menuPath      = process.env.MENU_FILE      ? resolve(process.env.MENU_FILE)      : resolve(OUTPUT_DIR, "menu.json");
  const inventoryPath = process.env.INVENTORY_FILE ? resolve(process.env.INVENTORY_FILE) : resolve(OUTPUT_DIR, "inventory.json");

  let menu, inventory;
  try {
    menu = JSON.parse(readFileSync(menuPath, "utf8"));
  } catch (err) {
    console.error(`❌  Could not read menu.json: ${err.message}`);
    process.exit(1);
  }
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  } catch (err) {
    console.error(`❌  Could not read inventory.json: ${err.message}`);
    process.exit(1);
  }

  const patched = patchMenu(menu, inventory.counts || {}, inventory.threshold ?? 3);
  if (patched > 0) {
    writeFileSync(menuPath, JSON.stringify(menu, null, 2));
    console.log(`✅  ${menuPath} patched — ${patched} sold_out change(s)`);
  } else {
    console.log("    (no changes — all items match current state)");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli();
