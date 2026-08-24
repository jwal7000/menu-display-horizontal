/**
 * patchMenuInventory.js
 * Patches sold_out status in output/menu.json using output/inventory.json.
 * Run after fetchInventory.js — keeps display data fresh between full rebuilds.
 *
 * Matching logic:
 *   - Multi-variation items: match variation.variation_id → inventory.counts
 *   - Single-variation items: match item.item_id → inventory.counts
 *   Items not tracked in inventory (no matching Square ID): sold_out unchanged.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, "../output");

function patchMenuInventory() {
  const menuPath      = resolve(OUTPUT_DIR, "menu.json");
  const inventoryPath = resolve(OUTPUT_DIR, "inventory.json");

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

  const counts    = inventory.counts   || {};
  const threshold = inventory.threshold ?? 3;
  let   patched   = 0;

  for (const section of (menu.sections || [])) {
    for (const item of (section.items || [])) {
      if (Array.isArray(item.variations) && item.variations.length > 0) {
        // Multi-variation: update each variation independently
        let anyAvailable = false;
        let anyTracked   = false;

        for (const v of item.variations) {
          if (v.variation_id && Object.prototype.hasOwnProperty.call(counts, v.variation_id)) {
            anyTracked = true;
            const wasOut = v.sold_out;
            v.sold_out   = counts[v.variation_id] <= threshold;
            if (v.sold_out !== wasOut) patched++;
          }
          if (!v.sold_out) anyAvailable = true;
        }

        // Roll up: item is sold out only if all tracked variations are sold out
        if (anyTracked) {
          item.sold_out = !anyAvailable;
        }
      } else {
        // Single-variation: match on item_id (works when item_id is a Square catalog object ID)
        if (item.item_id && Object.prototype.hasOwnProperty.call(counts, item.item_id)) {
          const wasOut  = item.sold_out;
          item.sold_out = counts[item.item_id] <= threshold;
          if (item.sold_out !== wasOut) patched++;
        }
      }
    }
  }

  menu.inventory_patched_at = new Date().toISOString();
  writeFileSync(menuPath, JSON.stringify(menu, null, 2));
  console.log(`✅  menu.json patched — ${patched} sold_out change(s)`);
  if (patched === 0) {
    console.log("    (no changes — all items match current state)");
  }
}

patchMenuInventory();
