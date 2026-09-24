/**
 * buildMenuFromDB.js
 * Builds per-location digital menu JSON from:
 *   - FlavorSchedule (AppSheet/MySQL) — which items are on the menu this month
 *   - Square Catalog API              — prices for those items
 *   - Square Inventory API            — sold-out status per location
 *
 * Drop-in replacement for buildMenuFromSheets.js. No Google Sheet needed.
 * Output: output/data/{slug}.json (same format, same downstream pipeline)
 *
 * Usage:
 *   npm run build-menu-db
 */

import mysql                              from 'mysql2/promise';
import { SquareClient, SquareEnvironment } from 'square';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath }                  from 'url';
import { dirname, resolve }               from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = resolve(__dirname, '..');
const OUTPUT_DIR = resolve(ROOT_DIR, 'output');

// ── Constants ─────────────────────────────────────────────────────────────────

const SOLD_OUT_THRESHOLD = 3; // inventory count ≤ this → sold out

// How Item_Category in FlavorSchedule maps to display section names + sort order
const SECTION_CONFIG = {
  'Hundred Layer Donuts':      { displayName: 'Hundred Layer Donuts', sort: 1 },
  'Mini Hundred Layer Donuts': { displayName: 'Mini Donuts',          sort: 2 },
  'Paleo':                     { displayName: 'Paleo Donuts',         sort: 3 },
  'Yeast Raised Donuts':       { displayName: 'Yeast Raised',         sort: 4 },
  'Rolls':                     { displayName: 'Cinnamon Rolls',       sort: 5 },
  'Pastries':                  { displayName: 'Pastries',             sort: 6 },
  'Breakfast':                 { displayName: 'Breakfast',            sort: 7 },
  'Cookies':                   { displayName: 'Cookies',              sort: 8 },
};

// Physical display locations
// dbName must match the Location field in FlavorSchedule_Exclusions exactly.
const DISPLAY_LOCATIONS = [
  { slug: 'the-factory', name: 'The Factory',    sqId: 'ECE7YC9G73NXK', dbName: 'The Factory' },
  { slug: 'the-gulch',   name: 'The Gulch',       sqId: 'L4CQJADFVPZC9', dbName: 'The Gulch' },
  { slug: '5th-broad',   name: '5th & Broadway',  sqId: 'L862ACB6EPKVT', dbName: '5th & Broad' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function expandPath(p) {
  return p.startsWith('~') ? p.replace('~', process.env.HOME || '') : p;
}

function formatCents(cents) {
  if (cents == null) return null;
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

/** Returns today's date in Central Time as YYYY-MM-DD */
function todayCST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// ── MySQL: FlavorSchedule ────────────────────────────────────────────────────

/**
 * Loads all exclusion rules for the current month.
 * Returns an array of { Exclusion_Type, Item_Category, SKU, Location, DaysOfWeek }.
 */
async function fetchExclusions(conn, year, month) {
  const [rows] = await conn.query(`
    SELECT Exclusion_Type, Item_Category, SKU, Location, DaysOfWeek
    FROM   FlavorSchedule_Exclusions
    WHERE  Sales_Year = ? AND Sales_Month = ?
  `, [year, month]);
  return rows;
}

/**
 * Returns true if the item should be excluded for this location today.
 *
 * DaysOfWeek values observed:
 *   'All'      — exclude every day
 *   'Weekdays' — exclude Monday–Friday only
 *   'Weekends' — exclude Saturday–Sunday only
 *   null/''    — treated as 'All'
 *
 * @param {object} item       - FlavorSchedule row
 * @param {string} dbName     - Location name as stored in FlavorSchedule_Exclusions
 * @param {Array}  exclusions - Rows from fetchExclusions()
 * @param {number} dow        - Day of week: 0=Sun, 1=Mon, … 6=Sat (Central time)
 */
function isExcluded(item, dbName, exclusions, dow) {
  const isWeekday = dow >= 1 && dow <= 5;
  const isWeekend = dow === 0 || dow === 6;

  for (const ex of exclusions) {
    if (ex.Location !== dbName) continue;

    // Check whether the exclusion applies today
    const scope = (ex.DaysOfWeek || 'All').toLowerCase();
    if (scope === 'weekdays' && isWeekend) continue;  // rule only applies weekdays
    if (scope === 'weekends' && isWeekday) continue;  // rule only applies weekends
    // 'all' or unrecognised → always applies

    if (ex.Exclusion_Type === 'Category' && ex.Item_Category === item.Item_Category) return true;
    if (ex.Exclusion_Type === 'SKU'      && ex.SKU            === item.SKU)           return true;
  }
  return false;
}

async function fetchScheduledItems(conn, today) {
  const [year, month] = today.split('-');
  const [rows] = await conn.query(`
    SELECT
      fs.SKU,
      fs.Item_Category,
      fs.Item_Name,
      fs.Start_Date,
      fs.End_Date,
      fs.PreOrder_Only,
      ssm.square_variation_id
    FROM FlavorSchedule fs
    LEFT JOIN Square_SKU_Mapping ssm ON fs.SKU = ssm.sku
    WHERE fs.Sales_Year  = ?
      AND fs.Sales_Month = ?
      AND (fs.Start_Date IS NULL OR fs.Start_Date <= ?)
      AND (fs.End_Date   IS NULL OR fs.End_Date   >= ?)
    ORDER BY fs.Item_Category, fs.SKU
  `, [year, month, today, today]);
  return rows;
}

// ── Square: Catalog prices ────────────────────────────────────────────────────

/**
 * Returns a Map of { variation_id → { price_cents, parent_item_id, variation_name } }
 * for the given variation IDs.
 */
async function fetchCatalogPrices(client, variationIds) {
  const priceMap = new Map();
  if (!variationIds.length) return priceMap;

  const BATCH = 1000;
  for (let i = 0; i < variationIds.length; i += BATCH) {
    const res = await client.catalog.batchGet({
      objectIds: variationIds.slice(i, i + BATCH),
      includeRelatedObjects: false,
    });
    // Square SDK: catalog.batchGet puts results directly at res.objects
    const objects = res.objects || [];
    for (const obj of objects) {
      if (obj.type !== 'ITEM_VARIATION') continue;
      const vd = obj.itemVariationData || {};
      priceMap.set(obj.id, {
        price_cents:    vd.priceMoney?.amount ?? null,
        parent_item_id: vd.itemId            ?? null,
        variation_name: vd.name              ?? null,
      });
    }
  }
  return priceMap;
}

// ── Square: Inventory counts ──────────────────────────────────────────────────

/**
 * Returns a Map of { variation_id → quantity } for IN_STOCK items
 * at the given location.
 */
async function fetchInventoryCounts(client, locationId, variationIds) {
  const counts = new Map();
  if (!variationIds.length) return counts;

  const BATCH = 100;
  for (let i = 0; i < variationIds.length; i += BATCH) {
    const res = await client.inventory.batchGetCounts({
      catalogObjectIds: variationIds.slice(i, i + BATCH),
      locationIds:      [locationId],
    });
    for (const c of (res.data || [])) {
      if (c.state === 'IN_STOCK') {
        counts.set(c.catalogObjectId, parseFloat(c.quantity || '0'));
      }
    }
  }
  return counts;
}

// ── Menu assembly ─────────────────────────────────────────────────────────────

function buildSections(items, priceMap, inventoryCounts) {
  // Group variations by Square parent item ID so multi-size items are combined
  const parentMap = new Map(); // parentId → [{ item, vid, priceInfo }]
  const noVidItems = [];

  for (const item of items) {
    if (!item.square_variation_id) {
      noVidItems.push(item);
      continue;
    }
    const vid       = item.square_variation_id;
    const priceInfo = priceMap.get(vid);
    // If catalog lookup failed, use the vid itself as the parent key
    const parentId  = priceInfo?.parent_item_id || vid;

    if (!parentMap.has(parentId)) parentMap.set(parentId, []);
    parentMap.get(parentId).push({ item, vid, priceInfo });
  }

  const sectionItems = new Map(); // category → [menuItem]

  const addItem = (category, menuItem) => {
    if (!sectionItems.has(category)) sectionItems.set(category, []);
    sectionItems.get(category).push(menuItem);
  };

  // Items with no Square mapping — show without price/inventory
  for (const item of noVidItems) {
    addItem(item.Item_Category, {
      item_id:       item.SKU,
      name:          item.Item_Name,
      price:         null,
      sold_out:      false,
      preorder_only: !!item.PreOrder_Only,
    });
  }

  // Items with Square mapping
  const seen = new Set();
  for (const item of items) {
    if (!item.square_variation_id) continue;
    const vid       = item.square_variation_id;
    const priceInfo = priceMap.get(vid);
    const parentId  = priceInfo?.parent_item_id || vid;
    if (seen.has(parentId)) continue;
    seen.add(parentId);

    const siblings = parentMap.get(parentId) || [];

    if (siblings.length === 1) {
      // ── Single-variation item ───────────────────────────────────────────
      const { item: it, vid: v, priceInfo: pi } = siblings[0];
      const qty     = inventoryCounts.get(v) ?? null;
      const soldOut = qty !== null ? qty <= SOLD_OUT_THRESHOLD : false;
      addItem(it.Item_Category, {
        item_id:       it.SKU,
        name:          it.Item_Name,
        price:         formatCents(pi?.price_cents ?? null),
        sold_out:      soldOut,
        preorder_only: !!it.PreOrder_Only,
      });
    } else {
      // ── Multi-variation item (e.g. 12 oz / 16 oz) ──────────────────────
      const allCents = siblings.map(s => s.priceInfo?.price_cents).filter(c => c != null);
      const lo = allCents.length ? Math.min(...allCents) : null;
      const hi = allCents.length ? Math.max(...allCents) : null;
      const priceStr = lo == null ? null
        : lo === hi ? formatCents(lo)
        : `${formatCents(lo)} – ${formatCents(hi)}`;

      const variations = siblings.map(({ item: it, vid: v, priceInfo: pi }) => {
        const qty = inventoryCounts.get(v) ?? null;
        return {
          variation_id:   v,
          variation_name: pi?.variation_name || null,
          price:          formatCents(pi?.price_cents ?? null),
          sold_out:       qty !== null ? qty <= SOLD_OUT_THRESHOLD : false,
        };
      });

      const rep = siblings[0].item;
      addItem(rep.Item_Category, {
        item_id:       rep.SKU,
        name:          rep.Item_Name,
        price:         priceStr,
        sold_out:      variations.every(v => v.sold_out),
        preorder_only: !!rep.PreOrder_Only,
        variations,
      });
    }
  }

  // Sort sections by configured order, then sort items within each section
  return [...sectionItems.entries()]
    .map(([cat, catItems]) => ({
      name:  (SECTION_CONFIG[cat]?.displayName ?? cat),
      _sort: (SECTION_CONFIG[cat]?.sort        ?? 99),
      items: catItems,
    }))
    .sort((a, b) => a._sort - b._sort)
    .map(({ name, items }) => ({ name, items }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function buildMenuFromDB() {
  // Load credentials
  const mysqlEnv = readFileSync(expandPath('~/.openclaw/secrets/mysql.env'), 'utf8');
  const mysqlPw  = mysqlEnv.split('\n')
    .find(l => l.startsWith('MYSQL_PASSWORD'))
    .split('=').slice(1).join('=').trim();

  const squareCreds = JSON.parse(
    readFileSync(expandPath('~/.openclaw/secrets/square.json'), 'utf8')
  );

  // MySQL
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3307,
    user: 'FDB_SteveConnect', password: mysqlPw,
    database: 'production', dateStrings: true,
  });

  // Square
  const client = new SquareClient({
    token:       squareCreds.access_token,
    environment: SquareEnvironment.Production,
  });

  const today = todayCST();
  const [yr, mo] = today.split('-');
  // Day of week in Central time (0=Sun … 6=Sat) — used for day-scoped exclusions
  const dow = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short' });
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(dow);
  console.log(`\n📅  Building menu — ${today} (${dow}, month ${mo}/${yr})`);

  // 1. FlavorSchedule items + exclusion rules for this month
  console.log('📋  Querying FlavorSchedule...');
  const items      = await fetchScheduledItems(conn, today);
  const exclusions = await fetchExclusions(conn, parseInt(yr, 10), parseInt(mo, 10));
  await conn.end();
  console.log(`    ${items.length} items on schedule today`);
  console.log(`    ${exclusions.length} exclusion rules for ${mo}/${yr}`);

  const variationIds = [...new Set(items.map(i => i.square_variation_id).filter(Boolean))];
  console.log(`    ${variationIds.length} mapped to Square variation IDs`);

  // 2. Prices from Square catalog
  console.log('💲  Fetching Square catalog prices...');
  const priceMap = await fetchCatalogPrices(client, variationIds);
  console.log(`    ${priceMap.size} prices found`);

  // 3. Build per-location menus
  mkdirSync(resolve(OUTPUT_DIR, 'data'), { recursive: true });

  for (const loc of DISPLAY_LOCATIONS) {
    console.log(`\n📍  ${loc.name}`);

    // Apply location + day-of-week exclusions before building the menu
    const locItems = items.filter(item => !isExcluded(item, loc.dbName, exclusions, DOW));
    const excluded = items.length - locItems.length;
    if (excluded > 0) console.log(`    Excluded: ${excluded} item(s) via FlavorSchedule_Exclusions`);

    // Only fetch inventory for variations that survived the exclusion filter
    const locVarIds = [...new Set(locItems.map(i => i.square_variation_id).filter(Boolean))];
    const inventoryCounts = await fetchInventoryCounts(client, loc.sqId, locVarIds);
    const soldOutCount    = [...inventoryCounts.values()].filter(q => q <= SOLD_OUT_THRESHOLD).length;
    console.log(`    Inventory: ${inventoryCounts.size} tracked, ${soldOutCount} sold out`);

    const sections  = buildSections(locItems, priceMap, inventoryCounts);
    const itemCount = sections.reduce((n, s) => n + s.items.length, 0);

    const menu = {
      location_id:   loc.sqId,
      location_name: loc.name,
      generated_at:  new Date().toISOString(),
      source:        'FlavorSchedule+Square',
      section_count: sections.length,
      item_count:    itemCount,
      sections,
    };

    const outPath = resolve(OUTPUT_DIR, 'data', `${loc.slug}.json`);
    writeFileSync(outPath, JSON.stringify(menu, null, 2));
    console.log(`    ✅  ${sections.length} sections, ${itemCount} items`);
    for (const s of sections) {
      const so = s.items.filter(i => i.sold_out).length;
      console.log(`       • ${s.name.padEnd(28)} ${String(s.items.length).padStart(2)} items${so ? `  (${so} sold out)` : ''}`);
    }
  }

  console.log('\n✅  All locations done.\n');
}

buildMenuFromDB().catch(err => {
  console.error('\n❌  Fatal:', err.message);
  process.exit(1);
});
