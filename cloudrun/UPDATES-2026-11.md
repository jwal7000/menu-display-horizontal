# Update packet: digital menus, Nov 2026

Work through these in order. For each item: show the plan for anything with an open question,
preview with real data and screenshots, wait for an OK before every push, and say when a jobs
deploy is needed. `npm test` must pass, as usual.

`[DEFAULT]` marks the answer to use unless told otherwise.

## 1. Store names and category headers (horizontal, portrait, v2, beverages, anywhere they appear)

Store names use the format **Five Daughters Bakery | Medley** everywhere. Today the horizontal
pastry screen shows "Five Daughters Bakery: Medley".

Section headers come from each item's Square reporting category, not FlavorSchedule's category.
Checked: Square has "Mini Hundred Layer Donuts" (the menus say "Mini Donuts") and "Yeast Raised
Donuts" (the menus say "Yeast Raised").

Before switching, list every section header, current vs Square, for all stores. Square calls
Paleo just "Paleo", for example. `[DEFAULT]` Keep a small override list in `src/lib/` for headers
we want to differ from Square, starting with "Paleo" → "Paleo Donuts". Section order is unchanged.

## 2. Staff picks: monthly expiry

The menu changes on the 1st, so picks expire automatically. `[DEFAULT]` At 12:00am Central on
the 1st of the next month. Store an `expires_at` when a pick is saved.

Both the display and admin.html ignore expired picks, and admin.html shows them as cleared.

Separately, never show a pick whose item isn't on that store's menu today.

## 3. Staff picks: manager PIN

Gate the Staff picks tab in admin.html behind a separate manager PIN. Staff keep using the
regular PIN for the rest.

`[DEFAULT]` Generate a random 6-digit manager PIN. Commit only a salted, slow hash (PBKDF2) in a
config file, never the PIN itself, and show the PIN once in the terminal. Add
`npm run set-manager-pin` to change it.

Be upfront in the notes that admin.html is a public static page, so this PIN stops casual
access, not a determined person. The real write protection is still the GitHub token. Note what
a proper server-side check would take, as a possible later step.

## 4. Rotating panel: four views

Order: beverages → promos → featured items → staff picks. Any view whose source is empty is
skipped: no drinks, no promo images in that store's Dropbox folders, no featured items, or no
unexpired picks.

Promos = the Dropbox images (today's "seasonal" view, renamed).

Featured items come from Square, with the item's photo, description and price. `[DEFAULT]`
Source: a Square category named "Menu Screen – Featured". Feature an item by adding that
category to it in Square. Show only featured items that are on that store's menu today and not
sold out.

Staff picks and featured items share the same photo, description and price data, from the
Square image work already in progress. Finish that first.

Build this for portrait v2 now, with the four views as shared components, so the same panel can
drive the horizontal carousel page later.

## Progress

| # | Item | Status |
|---|---|---|
| 1 | Store names and headers | built, previewed, waiting for OK to push (needs a jobs deploy) |
| 2 | Picks monthly expiry | not started |
| 3 | Manager PIN | not started |
| 4 | Four-view panel | not started |

## Notes

### 1. Store names and headers (2026-11-19)

- Every item on today's four menus already had a FlavorSchedule category equal to its Square
  reporting category, so no item changes section; only header text changes:
  Mini Donuts → Mini Hundred Layer Donuts, Yeast Raised → Yeast Raised Donuts.
- Overrides (`src/lib/sectionHeaders.js`): Paleo → Paleo Donuts, Rolls → Cinnamon Rolls.
- Items with no Square reporting category keep FlavorSchedule's category.
- Drink headers come from `bev-items-config.json` (not Square) and are unchanged.
- Store name "Five Daughters Bakery | {Store}" in the header and footer of the horizontal pastry,
  drinks, portrait and portrait v2 screens. The data files keep the bare name; the carousel's
  "Our team's favorites at …" line and admin.html's store picker keep it too.
- `menu_config.json` (old `buildMenu.js` only) still has the old header names; not used live.
