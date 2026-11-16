import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCaption, buildPromos, PROMO_ROOT } from '../src/buildPromos.js';
import { createDropbox, headerJson } from '../src/lib/dropbox.js';

test('parseCaption: fields first, everything after is the description; bad dates ignored', () => {
  const c = parseCaption('﻿Title: S\'mores Latte\r\nPrice: $6.00\nTag: Seasonal\nStarts: 2026-11-20\nEnds: Dec 31\n\nDouble shot espresso.\nTitle: not a field here\n');
  assert.deepEqual(c, { title: "S'mores Latte", price: '$6.00', tag: 'Seasonal', starts: '2026-11-20',
                        body: 'Double shot espresso.\nTitle: not a field here' });
  assert.deepEqual(parseCaption(''), {});
});

/** Fake Dropbox: { folderPath: [ { name, size?, text? } ] } */
function fakeDropbox(tree) {
  const calls = [];
  const find = (path) => Object.entries(tree).flatMap(([dir, files]) => files.map(f => ({ ...f, path: `${dir}/${f.name}` })))
                                             .find(f => f.path.toLowerCase() === path.toLowerCase());
  return {
    calls,
    async listFolder(path) {
      calls.push(['list', path]);
      if (!tree[path]) return null;
      return tree[path].map(f => ({ '.tag': f.folder ? 'folder' : 'file', name: f.name, size: f.size ?? 1000,
                                    content_hash: 'hash' + f.name.replace(/\W/g, ''), path_display: `${path}/${f.name}` }));
    },
    async thumbnail(path, format) { calls.push(['thumb', path, format]); return Buffer.from(`img:${path}`); },
    async downloadText(path) { calls.push(['text', path]); return find(path).text; },
  };
}

test('buildPromos: store slides first, then All Stores; captions make cards; hidden, oversized and non-image files skipped', async () => {
  const out = mkdtempSync(join(tmpdir(), 'promos-'));
  const dbx = fakeDropbox({
    [`${PROMO_ROOT}/All Stores`]: [{ name: 'Gift cards.jpg' }],
    [`${PROMO_ROOT}/The Factory`]: [
      { name: '2 Cookie.PNG' },
      { name: '10 Late.jpg' },
      { name: '1 Latte.png' },
      { name: '1 latte.txt', text: 'Title: S\'mores Latte\nPrice: $6.00\n\nYum.' },
      { name: '_draft.jpg' },
      { name: 'huge.jpg', size: 30 * 1024 * 1024 },
      { name: 'notes.pdf' },
      { name: 'old', folder: true },
    ],
  });
  const locations = [{ slug: 'the-factory', name: 'The Factory' }, { slug: '5th-broad', name: '5th & Broadway' }];
  const res = await buildPromos({ outputDir: out, locations, dropbox: dbx });

  const fac = JSON.parse(readFileSync(join(out, 'data', 'promos-the-factory.json'), 'utf8'));
  assert.deepEqual(fac.slides.map(s => s.source), ['1 Latte.png', '2 Cookie.PNG', '10 Late.jpg', 'Gift cards.jpg'], 'numeric name order, shared last');
  assert.deepEqual(fac.slides[0], { type: 'card', image: 'hash1Lattepng.png', title: "S'mores Latte", price: '$6.00', body: 'Yum.', source: '1 Latte.png' });
  assert.equal(fac.slides[1].type, 'graphic');
  assert.equal(fac.slides[1].image, 'hash2CookiePNG.png', 'png kept as png');
  assert.equal(fac.slides[2].image, 'hash10Latejpg.jpg');
  assert.ok(dbx.calls.some(c => c[0] === 'thumb' && c[2] === 'png'));

  const fifth = JSON.parse(readFileSync(join(out, 'data', 'promos-5th-broad.json'), 'utf8'));
  assert.deepEqual(fifth.slides.map(s => s.source), ['Gift cards.jpg'], 'missing store folder → shared slides only');
  assert.equal(res.files.length, 2);
  assert.deepEqual(readdirSync(res.imagesDir).sort(), ['hash10Latejpg.jpg', 'hash1Lattepng.png', 'hash2CookiePNG.png', 'hashGiftcardsjpg.jpg']);
});

test('buildPromos returns null (publishes nothing) when Dropbox is not configured', async () => {
  const saved = { env: process.env.DROPBOX_CREDENTIALS, home: process.env.HOME };
  delete process.env.DROPBOX_CREDENTIALS;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'home-'));
  try {
    assert.equal(await buildPromos({ outputDir: mkdtempSync(join(tmpdir(), 'promos-')), locations: [] }), null);
  } finally {
    if (saved.env !== undefined) process.env.DROPBOX_CREDENTIALS = saved.env;
    process.env.HOME = saved.home;
  }
});

test('headerJson escapes non-ASCII for the Dropbox-API-Arg header', () => {
  assert.equal(headerJson({ path: '/Café' }), '{"path":"/Caf\\u00e9"}');
});

test('Dropbox client: refreshes the token once, uses the team root, maps a missing folder to null', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.endsWith('/oauth2/token')) return json(200, { access_token: 'AT' });
    if (url.endsWith('/users/get_current_account')) return json(200, { root_info: { root_namespace_id: '111', home_namespace_id: '222' } });
    if (url.endsWith('/files/list_folder')) {
      const { path } = JSON.parse(init.body);
      if (path === '/missing') return json(409, { error_summary: 'path/not_found/..' });
      return json(200, { entries: [{ name: 'a' }], has_more: true, cursor: 'c1' });
    }
    if (url.endsWith('/files/list_folder/continue')) return json(200, { entries: [{ name: 'b' }], has_more: false });
    throw new Error('unexpected ' + url);
  };
  const dbx = createDropbox({ app_key: 'k', app_secret: 's', refresh_token: 'r' }, { fetchFn });

  assert.deepEqual((await dbx.listFolder('/x')).map(e => e.name), ['a', 'b'], 'follows has_more');
  assert.equal(await dbx.listFolder('/missing'), null);
  assert.equal(seen.filter(s => s.url.endsWith('/oauth2/token')).length, 1, 'token fetched once');
  const list = seen.find(s => s.url.endsWith('/files/list_folder'));
  assert.equal(list.headers.Authorization, 'Bearer AT');
  assert.deepEqual(JSON.parse(list.headers['Dropbox-API-Path-Root']), { '.tag': 'root', root: '111' });
  assert.equal(seen.find(s => s.url.endsWith('/get_current_account')).headers['Dropbox-API-Path-Root'], undefined);
});
