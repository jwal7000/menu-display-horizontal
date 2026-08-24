/**
 * fetchInventory.js
 * Lightweight Square inventory fetch — writes output/inventory.json.
 * Run every 2 minutes via launchd (refresh-inventory.sh).
 *
 * Env:
 *   SQUARE_LOCATION_ID      — Square location ID to check inventory for
 *   SQUARE_CREDENTIALS_PATH — path to credentials JSON
 *                             (default: ~/.openclaw/secrets/square.json)
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { SquareClient, SquareEnvironment } from "square";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(ROOT_DIR, "output");

const SOLD_OUT_THRESHOLD = 3;
const SQUARE_PATH        = process.env.SQUARE_CREDENTIALS_PATH || "~/.openclaw/secrets/square.json";
const LOCATION_ID        = process.env.SQUARE_LOCATION_ID;

function expandPath(p) {
  return p.startsWith("~") ? p.replace("~", process.env.HOME || "") : p;
}

async function fetchInventory() {
  if (!LOCATION_ID) {
    console.error("❌  SQUARE_LOCATION_ID not set");
    process.exit(1);
  }

  const squareFile = expandPath(SQUARE_PATH);
  let token;
  try {
    const creds = JSON.parse(readFileSync(squareFile, "utf8"));
    token = creds.access_token;
  } catch (err) {
    console.error(`❌  Could not read Square credentials: ${err.message}`);
    process.exit(1);
  }
  if (!token) {
    console.error("❌  No access_token in square.json");
    process.exit(1);
  }

  const client = new SquareClient({ token, environment: SquareEnvironment.Production });

  // 1. Page through all catalog variations to get their IDs
  console.log("📋  Fetching catalog variations...");
  const variationIds = [];
  let page = await client.catalog.list({ types: ["ITEM_VARIATION"] });
  while (true) {
    for (const obj of (page.data || [])) variationIds.push(obj.id);
    if (!page._hasNextPage) break;
    page = await page.loadNextPage();
  }
  console.log(`    Found ${variationIds.length} variations`);

  // 2. Batch-fetch inventory counts (100 per request)
  console.log(`📦  Fetching inventory counts at location ${LOCATION_ID}...`);
  const counts   = {};
  const lowStock = [];
  const BATCH    = 100;

  for (let i = 0; i < variationIds.length; i += BATCH) {
    const batch = variationIds.slice(i, i + BATCH);
    const res   = await client.inventory.batchGetCounts({
      catalogObjectIds: batch,
      locationIds:      [LOCATION_ID],
    });
    for (const c of (res.data || [])) {
      if (c.state === "IN_STOCK") {
        const qty = parseFloat(c.quantity || "0");
        counts[c.catalogObjectId] = qty;
        if (qty <= SOLD_OUT_THRESHOLD) lowStock.push(c.catalogObjectId);
      }
    }
  }

  // 3. Write output/inventory.json
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const out = {
    fetched_at:   new Date().toISOString(),
    location_id:  LOCATION_ID,
    threshold:    SOLD_OUT_THRESHOLD,
    // catalog object IDs (Square variation IDs) with qty <= threshold
    low_stock:    lowStock,
    // full count map — { catalog_object_id: qty }
    counts,
  };
  writeFileSync(resolve(OUTPUT_DIR, "inventory.json"), JSON.stringify(out, null, 2));
  console.log(`✅  inventory.json — ${lowStock.length} low-stock, ${Object.keys(counts).length} tracked`);
}

fetchInventory().catch(err => {
  console.error("❌  Fatal:", err.message);
  process.exit(1);
});
