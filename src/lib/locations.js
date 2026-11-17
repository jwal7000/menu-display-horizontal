/**
 * locations.js — single source of truth for the physical display locations.
 *
 *   slug          — used in URLs (?loc=<slug>) and JSON file names
 *   sqId          — Square location ID
 *   dbName        — must match the Location field in FlavorSchedule_Exclusions exactly
 *   layout        — which display repo serves the pastry screen ('horizontal' | 'portrait')
 *   hasBeverages  — a bev-{slug}.json is built: the store has a beverage screen (horizontal) or
 *                   shows the drinks panel of the portrait v2 page
 *   hasCarousel   — the store has a 1920×1080 carousel screen (menu-display-horizontal
 *                   carousel/): Dropbox carousel photos plus promos and staff picks
 *   skipInventory — optional: Square inventory not configured yet; show every item as available.
 *                   No store uses it now (Medley's inventory went live 2026-11-11).
 */

export const DISPLAY_LOCATIONS = [
  { slug: 'the-factory', name: 'The Factory',    sqId: 'ECE7YC9G73NXK', dbName: 'The Factory', layout: 'portrait',   hasBeverages: true },
  { slug: 'the-gulch',   name: 'The Gulch',      sqId: 'L4CQJADFVPZC9', dbName: 'The Gulch',   layout: 'horizontal', hasBeverages: true, hasCarousel: true },
  { slug: '5th-broad',   name: '5th & Broadway', sqId: 'L862ACB6EPKVT', dbName: '5th & Broad', layout: 'portrait'   },
  { slug: 'medley',      name: 'Medley',         sqId: 'LDR9H5M3GQKXF', dbName: 'Medley',      layout: 'horizontal', hasBeverages: true, hasCarousel: true },
];

export const BEV_LOCATIONS = DISPLAY_LOCATIONS.filter(l => l.hasBeverages);
/** Stores whose screens show Dropbox promos: portrait v2 pages and the horizontal carousels. */
export const PROMO_LOCATIONS = DISPLAY_LOCATIONS.filter(l => l.layout === 'portrait' || l.hasCarousel);
