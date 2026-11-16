/**
 * buildPromos.js — seasonal promo slides for the portrait v2 screens, from Dropbox.
 *
 * Marketing drops images into Dropbox; nothing else is needed:
 *
 *   <DROPBOX_PROMO_ROOT>/All Stores/     slides shown at every portrait store
 *   <DROPBOX_PROMO_ROOT>/<Store name>/   slides for that store only (e.g. "The Factory")
 *
 *   • An image on its own (jpg, png, gif, webp, heic) is shown as a finished graphic,
 *     fitted to the panel (about 1000 × 500 px; landscape 2:1 fills it best).
 *   • An image with a .txt file of the same name becomes a photo-and-caption card:
 *
 *         Title: S'mores Latte
 *         Price: $6.00
 *         Tag: Seasonal
 *         Starts: 2026-11-20        (optional; shown from this day)
 *         Ends: 2026-12-31          (optional; last day shown)
 *
 *         Any other lines are the description.
 *
 *     Starts/Ends also work on a .txt beside a finished graphic (it stays a graphic
 *     when there's no Title).
 *   • Slides play in file-name order ("1 Latte.png" before "2 Cookie.png").
 *     Names starting with "_" or "." are ignored, so "_draft.png" stays hidden.
 *
 * Output (under outputDir):
 *   data/promos-{slug}.json   { location_name, generated_at, slides: [...] }
 *   promos/<content-hash>.<jpg|png>   images, resized by Dropbox to fit 2048×1536
 *
 * Images are named by Dropbox's content hash, so an unchanged file keeps its name and
 * publishing only commits when something in the folder actually changed.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDropbox } from './lib/dropbox.js';
import { dropboxCredentials } from './lib/settings.js';
import { DISPLAY_LOCATIONS } from './lib/locations.js';

export const PROMO_ROOT    = process.env.DROPBOX_PROMO_ROOT || '/Menu Displays/Promos';
export const ALL_STORES    = 'All Stores';
const IMAGE_EXT            = /\.(jpe?g|png|gif|webp|heic)$/i;
const MAX_BYTES            = 20 * 1024 * 1024;   // Dropbox won't thumbnail anything bigger
const FIELD                = /^(title|price|tag|starts|ends)\s*:\s*(.*)$/i;
const DATE                 = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a caption .txt into { title, price, tag, starts, ends, body }. */
export function parseCaption(text) {
  const out = {};
  const body = [];
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(FIELD);
    if (m && !body.length) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if ((key === 'starts' || key === 'ends') && !DATE.test(val)) {
        console.warn(`    ⚠️  ignoring ${m[1]}: "${val}" — use YYYY-MM-DD`);
        continue;
      }
      if (val) out[key] = val;
    } else if (line.trim() || body.length) {
      body.push(line.trim());
    }
  }
  const description = body.join('\n').trim();
  if (description) out.body = description;
  return out;
}

const stem = name => name.replace(/\.[^.]+$/, '');
const hidden = name => name.startsWith('_') || name.startsWith('.');

/**
 * Slides for one folder, in name order. Images are written to imagesDir.
 * Returns [] for a missing or empty folder.
 */
async function folderSlides(dbx, folder, imagesDir) {
  const entries = await dbx.listFolder(folder);
  if (!entries) return [];
  const files = entries.filter(e => e['.tag'] === 'file' && !hidden(e.name))
                       .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const captions = new Map(files.filter(f => /\.txt$/i.test(f.name)).map(f => [stem(f.name).toLowerCase(), f]));
  const slides = [];

  for (const f of files.filter(f => IMAGE_EXT.test(f.name))) {
    if (f.size > MAX_BYTES) {
      console.warn(`    ⚠️  ${f.path_display}: ${(f.size / 1048576).toFixed(0)} MB is over the 20 MB limit — skipped`);
      continue;
    }
    const format = /\.png$/i.test(f.name) ? 'png' : 'jpeg';      // png keeps transparency
    const file = `${(f.content_hash || f.rev || f.id).replace(/[^a-z0-9]/gi, '').slice(0, 20)}.${format === 'png' ? 'png' : 'jpg'}`;
    writeFileSync(join(imagesDir, file), await dbx.thumbnail(f.path_lower || f.path_display, format));

    const cap = captions.get(stem(f.name).toLowerCase());
    const caption = cap ? parseCaption(await dbx.downloadText(cap.path_lower || cap.path_display)) : {};
    slides.push({ type: caption.title ? 'card' : 'graphic', image: file, ...caption, source: f.name });
  }
  return slides;
}

/**
 * Builds promos for `locations` (default: the portrait stores).
 * Returns null when Dropbox isn't configured (the caller publishes nothing), else
 * { files: [data/promos-{slug}.json …], imagesDir }.
 */
export async function buildPromos({ outputDir, locations, dropbox } = {}) {
  locations = locations || DISPLAY_LOCATIONS.filter(l => l.layout === 'portrait');
  let dbx = dropbox;
  if (!dbx) {
    const creds = dropboxCredentials();
    if (!creds) { console.log('\n🖼   Promos: no Dropbox credentials configured — skipped.'); return null; }
    dbx = createDropbox(creds);
  }
  console.log(`\n🖼   Building promos from Dropbox ${PROMO_ROOT}`);

  const imagesDir = join(outputDir, 'promos');
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(join(outputDir, 'data'), { recursive: true });

  const shared = await folderSlides(dbx, `${PROMO_ROOT}/${ALL_STORES}`, imagesDir);
  const files = [];
  for (const loc of locations) {
    const own = await folderSlides(dbx, `${PROMO_ROOT}/${loc.name}`, imagesDir);
    const slides = [...own, ...shared];
    const out = join(outputDir, 'data', `promos-${loc.slug}.json`);
    writeFileSync(out, JSON.stringify({ location_name: loc.name, generated_at: new Date().toISOString(), slides }, null, 2));
    files.push(out);
    console.log(`    📍 ${loc.name}: ${slides.length} slide(s)${slides.length ? ' — ' + slides.map(s => s.source).join(', ') : ''}`);
  }
  return { files, imagesDir };
}
