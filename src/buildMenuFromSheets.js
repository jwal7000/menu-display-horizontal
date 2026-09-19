/**
 * buildMenuFromSheets.js
 * Reads menu data from a Google Sheet and generates output/menu.json
 * for display on digital menu boards.
 *
 * Sold-out status is determined by Square Inventory API (count <= 3 = sold out).
 * The sheet's Sold Out column is used as a manual override fallback only.
 *
 * Usage:
 *   npm run build-menu-sheets
 *
 * Environment:
 *   GOOGLE_SHEETS_ID         — the Google Sheet ID
 *   GOOGLE_CREDENTIALS_PATH  — path to service account JSON
 *                              (default: ~/.openclaw/secrets/gcp-sheets-key.json)
 *   SQUARE_CREDENTIALS_PATH  — path to Square credentials JSON
 *                              (default: ~/.openclaw/secrets/square.json)
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { google } from "googleapis";
import { SquareClient, SquareEnvironment } from "square";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(ROOT_DIR, "output");

const SOLD_OUT_THRESHOLD = 3; // inventory <= this → sold out

// ── Environment ───────────────────────────────────────────────────────────

const SHEETS_ID   = process.env.GOOGLE_SHEETS_ID;
const CREDS_PATH  = process.env.GOOGLE_CREDENTIALS_PATH  || "~/.openclaw/secrets/gcp-sheets-key.json";
const SQUARE_PATH = process.env.SQUARE_CREDENTIALS_PATH  || "~/.openclaw/secrets/square.json";

if (!SHEETS_ID) {
  console.error("❌  GOOGLE_SHEETS_ID environment variable not set.");
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandPath(p) {
  return p.startsWith("~") ? p.replace("~", process.env.HOME || "") : p;
}

function parsePriceCents(priceStr) {
  if (!priceStr) return null;
  const match = String(priceStr).match(/([\d.]+)/);
  return match ? Math.round(parseFloat(match[1]) * 100) : null;
}

function formatPrice(cents) {
  if (cents === null || cents === undefined) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

function parseBool(val) {
  if (!val) return false;
  return String(val).toLowerCase().trim() === "true";
}

function parseNum(val) {
  const n = Number(val);
  return isNaN(n) ? null : n;
}

// ── Google Sheets ─────────────────────────────────────────────────────────

async function getSheetsClient() {
  const credsFile = expandPath(CREDS_PATH);
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credsFile, "utf8"));
  } catch (err) {
    console.error(`❌  Could not read Google credentials: ${err.message}`);
    process.exit(1);
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getFirstTabName(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const first = meta.data.sheets?.[0];
  if (!first) { console.error("❌  No tabs found in spreadsheet."); process.exit(1); }
  return first.properties.title;
}

async function fetchSheetRows(sheets, sheetId, tabName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: tabName,
    });
    return res.data.values || [];
  } catch (err) {
    console.error(`❌  Could not fetch sheet data: ${err.message}`);
    process.exit(1);
  }
}

// ── Square Inventory ──────────────────────────────────────────────────────

/**
 * Returns a Map of { variationId -> inventoryCount } for the given Square location ID.
 * Items not tracked in inventory are omitted (not assumed sold out).
 */
async function fetchSquareInventory(squareLocationId) {
  const squareFile = expandPath(SQUARE_PATH);
  let token;
  try {
    const creds = JSON.parse(readFileSync(squareFile, "utf8"));
    token = creds.access_token;
  } catch (err) {
    console.warn(`⚠️   Could not read Square credentials: ${err.message}`);
    return new Map();
  }

  if (!token) {
    console.warn("⚠️   No Square access_token found — skipping inventory check.");
    return new Map();
  }

  const client = new SquareClient({
    token,
    environment: SquareEnvironment.Production,
  });

  const inventoryMap = new Map();

  try {
    // Page through all catalog item variations using v44 pager
    const variationIds = [];
    let page = await client.catalog.list({ types: ["ITEM_VARIATION"] });
    while (true) {
      const objs = page.data || [];
      for (const obj of objs) variationIds.push(obj.id);
      if (!page._hasNextPage) break;
      page = await page.loadNextPage();
    }

    if (variationIds.length === 0) {
      console.warn("⚠️   No catalog variations found in Square.");
      return inventoryMap;
    }

    console.log(`📋  Fetching inventory for ${variationIds.length} variations at location ${squareLocationId}...`);

    // Batch fetch inventory counts (100 per request)
    const BATCH = 100;
    for (let i = 0; i < variationIds.length; i += BATCH) {
      const batch = variationIds.slice(i, i + BATCH);
      const res = await client.inventory.batchGetCounts({
        catalogObjectIds: batch,
        locationIds: [squareLocationId],
      });
      const counts = res.data || [];
      for (const c of counts) {
        if (c.state === "IN_STOCK") {
          const qty = parseFloat(c.quantity || "0");
          inventoryMap.set(c.catalogObjectId, qty);
        }
      }
    }

    console.log(`📦  Square inventory: ${inventoryMap.size} variations with stock data`);
  } catch (err) {
    console.warn(`⚠️   Square inventory fetch failed: ${err.message}`);
  }

  return inventoryMap;
}

/**
 * Determine sold-out status for a variation.
 * Square inventory wins if data is present (count <= threshold).
 * Falls back to sheet value if Square has no data for this variation.
 */
function isSoldOut(variationId, inventoryMap, sheetSoldOut) {
  if (inventoryMap.has(variationId)) {
    return inventoryMap.get(variationId) <= SOLD_OUT_THRESHOLD;
  }
  return sheetSoldOut; // fallback to manual sheet value
}

// ── Square Location ID lookup ─────────────────────────────────────────────

// Map display location names → Square location IDs
// These come from output/locations.json (run npm run list-locations to refresh)
const LOCATION_NAME_TO_SQUARE_ID = {
  "12th South":          "AX2YMJVN8QJ7C",
  "12 South":            "AX2YMJVN8QJ7C",
  "5th & Broad":         "L862ACB6EPKVT",
  "Avalon":              "LCEVX3XQTM8WP",
  "East":                "FXG8HKPA0CFDV",
  "L&L Market":          "KT6WPWXNTSBB8",
  "Ponce City Market":   "L3VJ4QYD3NCPK",
  "The Factory":         "ECE7YC9G73NXK",
  "The Fountains":       "LFCKHR2CKGE9X",
  "The Gulch":           "L4CQJADFVPZC9",
  "Westside Provisions": "L1ZBPSYJ6T2Y3",
};

function getSquareLocationId(locationName) {
  // Try to load from locations.json if available
  try {
    const locFile = resolve(OUTPUT_DIR, "locations.json");
    const locations = JSON.parse(readFileSync(locFile, "utf8"));
    const match = locations.find(
      (l) => l.name?.toLowerCase() === locationName.toLowerCase()
    );
    if (match) return match.id;
  } catch (_) {
    // locations.json not available — fall through to hardcoded map
  }
  return LOCATION_NAME_TO_SQUARE_ID[locationName] || null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function buildMenuFromSheets() {
  console.log(`📄  Google Sheets ID: ${SHEETS_ID}`);
  console.log(`🔐  Google creds:     ${expandPath(CREDS_PATH)}`);
  console.log(`🟦  Square creds:     ${expandPath(SQUARE_PATH)}\n`);

  // 1. Fetch sheet data
  const sheets = await getSheetsClient();
  console.log(`✅  Authenticated with Google Sheets`);
  const tabName   = await getFirstTabName(sheets, SHEETS_ID);
  console.log(`📋  Sheet tab: "${tabName}"`);
  const allRows   = await fetchSheetRows(sheets, SHEETS_ID, tabName);

  if (allRows.length === 0) {
    console.error(`❌  Sheet is empty.`);
    process.exit(1);
  }

  // 2. Parse headers
  const headers = allRows[0];
  const col = (name) => headers.indexOf(name);
  const H = {
    Location:         col("Location"),
    Section:          col("Section"),
    ItemId:           col("Item ID"),
    ItemName:         col("Item Name"),
    Price:            col("Price"),
    SoldOut:          col("Sold Out"),
    Description:      col("Description"),
    ImageUrl:         col("Image URL"),
    SectionSort:      col("Section Sort Order"),
    ItemSort:         col("Item Sort Order"),
    VariationName:    col("Variation Name"),
    VariationId:      col("Variation ID"),
  };

  const required = ["Location", "Section", "ItemId", "ItemName", "Price"];
  for (const name of required) {
    if (H[name] === -1) {
      console.error(`❌  Missing required column: "${name}"`);
      process.exit(1);
    }
  }

  const dataRows = allRows.slice(1).filter((r) => r && r.length > 0);
  console.log(`📦  Data rows: ${dataRows.length}\n`);

  // 3. Group rows by location → section → item
  const locationMap = new Map();
  for (const row of dataRows) {
    const location      = (row[H.Location]      || "").trim();
    const section       = (row[H.Section]       || "").trim();
    const itemId        = (row[H.ItemId]        || "").trim();
    const itemName      = (row[H.ItemName]      || "").trim();
    const priceStr      = (row[H.Price]         || "").trim();
    const soldOut       = parseBool(row[H.SoldOut]);
    const description   = (row[H.Description]  || "").trim();
    const imageUrl      = (row[H.ImageUrl]      || "").trim();
    const sectionSort   = parseNum(row[H.SectionSort]);
    const itemSort      = parseNum(row[H.ItemSort]);
    const variationName = (row[H.VariationName] || "").trim();
    const variationId   = (row[H.VariationId]   || "").trim();

    if (!location || !itemId || !itemName) continue;

    if (!locationMap.has(location)) {
      locationMap.set(location, { sections: new Map() });
    }
    const locData = locationMap.get(location);

    if (!locData.sections.has(section)) {
      locData.sections.set(section, { name: section, sort_order: sectionSort, items: new Map() });
    }
    const secData = locData.sections.get(section);

    if (!secData.items.has(itemId)) {
      secData.items.set(itemId, {
        item_id: itemId, name: itemName,
        _sheet_sold_out: soldOut,
        description, image_url: imageUrl,
        sort_order: itemSort,
        variations: [], _variation_ids: new Set(),
        _price_cents: null,
      });
    }
    const item = secData.items.get(itemId);

    if (variationId && !item._variation_ids.has(variationId)) {
      item.variations.push({
        variation_id:   variationId,
        variation_name: variationName,
        price:          formatPrice(parsePriceCents(priceStr)),
        _cents:         parsePriceCents(priceStr),
        _sheet_sold_out: soldOut,
      });
      item._variation_ids.add(variationId);
    }

    if (item.variations.length === 0 && item._price_cents === null) {
      item._price_cents = parsePriceCents(priceStr);
    }
  }

  // 4. For each location, fetch Square inventory and build menu
  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const [locationName, locData] of locationMap) {
    console.log(`\n📍  Building: ${locationName}`);

    // Fetch Square inventory
    const squareLocationId = getSquareLocationId(locationName);
    let inventoryMap = new Map();
    if (squareLocationId) {
      console.log(`🟦  Square location ID: ${squareLocationId}`);
      inventoryMap = await fetchSquareInventory(squareLocationId);
    } else {
      console.warn(`⚠️   No Square location ID mapped for "${locationName}" — sold out from sheet only`);
    }

    // Sort sections
    const sections = Array.from(locData.sections.values())
      .sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99));

    const builtSections = [];
    let totalItems = 0;
    let soldOutCount = 0;
    let squareOverrideCount = 0;

    for (const secData of sections) {
      const items = Array.from(secData.items.values())
        .sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99));

      const cleanItems = [];
      for (const item of items) {
        delete item._variation_ids;

        if (item.variations && item.variations.length > 0) {
          // Multi-variation item
          const cents = item.variations.map((v) => v._cents).filter((c) => c !== null);
          if (cents.length > 0) {
            const lo = Math.min(...cents), hi = Math.max(...cents);
            item.price = lo === hi ? formatPrice(lo) : `${formatPrice(lo)} – ${formatPrice(hi)}`;
          }

          let anyAvailable = false;
          item.variations = item.variations.map((v) => {
            const soldOut = isSoldOut(v.variation_id, inventoryMap, v._sheet_sold_out);
            if (!soldOut) anyAvailable = true;
            if (inventoryMap.has(v.variation_id)) squareOverrideCount++;
            const clean = { variation_id: v.variation_id, price: v.price, sold_out: soldOut };
            if (v.variation_name) clean.variation_name = v.variation_name;
            return clean;
          });
          item.sold_out = !anyAvailable;
        } else {
          // Single-variation item — use item_id as the variation ID for inventory lookup
          if (item._price_cents !== null) {
            item.price = formatPrice(item._price_cents);
          }
          item.sold_out = isSoldOut(item.item_id, inventoryMap, item._sheet_sold_out);
          if (inventoryMap.has(item.item_id)) squareOverrideCount++;
          delete item.variations;
        }

        if (item.sold_out) soldOutCount++;
        delete item._price_cents;
        delete item._sheet_sold_out;
        delete item.sort_order;
        if (!item.description) delete item.description;
        if (!item.image_url)   delete item.image_url;

        cleanItems.push(item);
      }

      if (cleanItems.length > 0) {
        builtSections.push({ name: secData.name, items: cleanItems });
        totalItems += cleanItems.length;
      }
    }

    // 5. Write output/data/{slug}.json
    const slug = locationName
      .toLowerCase()
      .replace(/\s*&\s*/g, "-")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const menu = {
      location_id:       locationName,
      location_name:     locationName,
      generated_at:      new Date().toISOString(),
      section_count:     builtSections.length,
      item_count:        totalItems,
      sections:          builtSections,
    };

    const dataDir = resolve(OUTPUT_DIR, "data");
    mkdirSync(dataDir, { recursive: true });
    const outPath = resolve(dataDir, `${slug}.json`);
    writeFileSync(outPath, JSON.stringify(menu, null, 2));

    console.log(`✅  Done — ${builtSections.length} sections, ${totalItems} items, ${soldOutCount} sold out`);
    if (squareOverrideCount > 0) {
      console.log(`🟦  Square overrode sold-out for ${squareOverrideCount} variation(s)`);
    }
    console.log(`📄  Saved → output/data/${slug}.json`);
    console.log();
    builtSections.forEach((s) => {
      const so = s.items.filter((i) => i.sold_out).length;
      console.log(`    • ${s.name.padEnd(36)} ${String(s.items.length).padStart(3)} items${so > 0 ? `  (${so} sold out)` : ""}`);
    });
  }
}

buildMenuFromSheets().catch((err) => {
  console.error("❌  Fatal:", err.message);
  process.exit(1);
});
