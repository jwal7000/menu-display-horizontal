/**
 * sectionHeaders.js — pastry section headers.
 *
 * A section's header is its items' Square reporting category name. HEADER_OVERRIDES lists
 * the few headers we want to read differently from Square; anything not listed is shown
 * exactly as Square names it. SECTION_ORDER is the order sections appear on the menu
 * (keyed by the Square name); unknown categories go last, in the order they were found.
 */

export const HEADER_OVERRIDES = {
  'Paleo': 'Paleo Donuts',
  'Rolls': 'Cinnamon Rolls',
};

export const SECTION_ORDER = [
  'Hundred Layer Donuts',
  'Mini Hundred Layer Donuts',
  'Paleo',
  'Yeast Raised Donuts',
  'Rolls',
  'Pastries',
  'Breakfast',
  'Cookies',
];

/** The header to show for a Square reporting category (or FlavorSchedule category) name. */
export function sectionHeader(category) {
  return HEADER_OVERRIDES[category] ?? category;
}

/** Sort key for a category name: its place in SECTION_ORDER, else after all of them. */
export function sectionSort(category) {
  const i = SECTION_ORDER.indexOf(category);
  return i === -1 ? SECTION_ORDER.length : i;
}
