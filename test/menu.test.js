import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSections, isExcluded } from '../src/buildMenuFromDB.js';
import { patchMenu, menuVariationIds } from '../src/patchMenuInventory.js';

const row = (sku, vid, cat = 'Hundred Layer Donuts', name = sku) =>
  ({ SKU: sku, Item_Category: cat, Item_Name: name, square_variation_id: vid, PreOrder_Only: 0 });

test('single-variation items carry variation_id and use the ≤3 threshold', () => {
  const items = [row('SKU-A', 'VAR-A'), row('SKU-B', 'VAR-B'), row('SKU-C', null)];
  const prices = new Map([
    ['VAR-A', { price_cents: 450, parent_item_id: 'ITEM-A', variation_name: 'Regular' }],
    ['VAR-B', { price_cents: 500, parent_item_id: 'ITEM-B', variation_name: 'Regular' }],
  ]);
  const counts = new Map([['VAR-A', 3], ['VAR-B', 4]]);
  const [section] = buildSections(items, prices, counts);
  const byId = Object.fromEntries(section.items.map(i => [i.item_id, i]));

  assert.equal(byId['SKU-A'].variation_id, 'VAR-A');
  assert.equal(byId['SKU-A'].sold_out, true);    // 3 → sold out
  assert.equal(byId['SKU-B'].sold_out, false);   // 4 → available
  assert.equal(byId['SKU-A'].price, '$4.50');
  assert.equal(byId['SKU-C'].price, null);       // unmapped item still shown
});

test('multi-variation items group by parent and price as a range', () => {
  const items = [row('S12', 'V12', 'Pastries', 'Cold Brew'), row('S16', 'V16', 'Pastries', 'Cold Brew')];
  const prices = new Map([
    ['V12', { price_cents: 400, parent_item_id: 'P', variation_name: '12 oz' }],
    ['V16', { price_cents: 500, parent_item_id: 'P', variation_name: '16 oz' }],
  ]);
  const [section] = buildSections(items, prices, new Map([['V12', 0]]));
  assert.equal(section.items.length, 1);
  assert.equal(section.items[0].price, '$4.00 – $5.00');
  assert.equal(section.items[0].sold_out, false); // 16 oz untracked → still available
});

test('day-scoped exclusions', () => {
  const item = row('SKU-A', 'VAR-A');
  const ex = [{ Exclusion_Type: 'SKU', SKU: 'SKU-A', Location: 'Medley', DaysOfWeek: 'Weekends' }];
  assert.equal(isExcluded(item, 'Medley', ex, 6), true);   // Saturday
  assert.equal(isExcluded(item, 'Medley', ex, 2), false);  // Tuesday
  assert.equal(isExcluded(item, 'The Gulch', ex, 6), false);
});

test('patchMenu matches single items by variation_id (the old SKU match never hit)', () => {
  const menu = { sections: [{ items: [
    { item_id: 'SKU-A', variation_id: 'VAR-A', sold_out: false },
    { item_id: 'SKU-B', variation_id: 'VAR-B', sold_out: true },
  ] }] };
  const n = patchMenu(menu, { 'VAR-A': 1, 'VAR-B': 20 });
  assert.equal(n, 2);
  assert.equal(menu.sections[0].items[0].sold_out, true);
  assert.equal(menu.sections[0].items[1].sold_out, false);
  assert.ok(menu.inventory_patched_at);
});

test('patchMenu falls back to item_id for older menu files', () => {
  const menu = { sections: [{ items: [{ item_id: 'VAR-X', sold_out: false }] }] };
  assert.equal(patchMenu(menu, { 'VAR-X': 0 }), 1);
});

test('patchMenu leaves the file untouched when nothing changed', () => {
  const menu = { sections: [{ items: [{ item_id: 'S', variation_id: 'V', sold_out: false }] }] };
  assert.equal(patchMenu(menu, { V: 10 }), 0);
  assert.equal(menu.inventory_patched_at, undefined);
});

test('patchMenu rolls up multi-variation items', () => {
  const menu = { sections: [{ items: [{
    item_id: 'S', sold_out: false,
    variations: [{ variation_id: 'V1', sold_out: false }, { variation_id: 'V2', sold_out: false }],
  }] }] };
  patchMenu(menu, { V1: 0, V2: 2 });
  assert.equal(menu.sections[0].items[0].sold_out, true);
  patchMenu(menu, { V1: 0, V2: 9 });
  assert.equal(menu.sections[0].items[0].sold_out, false);
  assert.deepEqual(menuVariationIds(menu).sort(), ['V1', 'V2']);
});
