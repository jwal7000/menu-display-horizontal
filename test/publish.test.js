// End-to-end tests for the publisher and both jobs' publishing logic,
// against local bare git repos standing in for GitHub.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'remotes-'));
process.env.GIT_BASE_URL = `file://${root}`;
delete process.env.DRY_RUN;

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
                                          { encoding: 'utf8' }).trim();

/** Creates a bare repo with the given { branch: { path: content } } and returns its path. */
function makeRemote(name, branches) {
  const bare = join(root, 'jwal7000', `${name}.git`);
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', bare]);
  for (const [branch, files] of Object.entries(branches)) {
    const work = mkdtempSync(join(tmpdir(), 'seed-'));
    execFileSync('git', ['init', '--quiet', '-b', branch, work]);
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(join(work, p, '..'), { recursive: true });
      writeFileSync(join(work, p), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'seed');
    git(work, 'push', '--quiet', bare, `${branch}:${branch}`);
  }
  return bare;
}

const show = (bare, branch, path) => JSON.parse(execFileSync('git', ['--git-dir', bare, 'show', `${branch}:${path}`], { encoding: 'utf8' }));
const commits = (bare, branch) => Number(execFileSync('git', ['--git-dir', bare, 'rev-list', '--count', branch], { encoding: 'utf8' }));
const lastCommit = (bare, branch) => {
  const [author, subject] = execFileSync('git', ['--git-dir', bare, 'log', '-1', '--format=%an%n%s', branch], { encoding: 'utf8' }).trim().split('\n');
  return { author, subject };
};

const menu = (vid, soldOut = false) => ({
  location_name: 'x', sections: [{ name: 'Donuts', items: [{ item_id: 'SKU-1', variation_id: vid, name: 'Glazed', sold_out: soldOut }] }],
});

let H, P, B, inv, build, publish;
before(async () => {
  H = makeRemote('menu-display-horizontal', {
    main:       { 'output/data/the-gulch.json': menu('V-GULCH'), 'output/data/medley.json': menu('V-MED'),
                  'output/data/12th-south.json': { keep: true } },
    'gh-pages': { 'data/the-gulch.json': menu('V-GULCH'), 'data/medley.json': menu('V-MED'), 'index.html': '<html>' },
  });
  P = makeRemote('menu-display-portrait', {
    main: { 'output/data/the-factory.json': menu('V-FAC'), 'output/data/5th-broad.json': menu('V-5TH') },
  });
  B = makeRemote('menu-display-beverages', {
    main: { 'public/data/bev-the-gulch.json': { old: true }, 'output/data/bev-the-gulch.json': { stale: true },
            'public/overrides-the-gulch.json': { sold_out: ['Latte'] } },
  });
  inv     = await import('../src/jobs/inventorySync.js');
  build   = await import('../src/jobs/targets.js');
  publish = await import('../src/jobs/publish.js');
});

test('inventory-sync patches main + gh-pages + portrait, including Medley, and only commits on change', async () => {
  const asked = [];
  const fetchCounts = async (sqId, ids) => {
    asked.push([sqId, ...ids]);
    return new Map(ids.map(id => [id, 0])); // everything sold out
  };
  const before = { hm: commits(H, 'main'), hg: commits(H, 'gh-pages'), p: commits(P, 'main') };

  assert.equal(await inv.runInventorySync({ fetchCounts }), true);

  assert.equal(show(H, 'main',     'output/data/the-gulch.json').sections[0].items[0].sold_out, true);
  assert.equal(show(H, 'gh-pages', 'data/the-gulch.json').sections[0].items[0].sold_out, true);
  assert.equal(show(P, 'main',     'output/data/the-factory.json').sections[0].items[0].sold_out, true);
  assert.equal(show(H, 'main',     'output/data/medley.json').sections[0].items[0].sold_out, true, 'Medley inventory is tracked');
  assert.equal(show(H, 'gh-pages', 'data/medley.json').sections[0].items[0].sold_out, true);
  assert.equal(asked.filter(([id]) => id === 'LDR9H5M3GQKXF').length, 1, 'Medley counts fetched once for main + gh-pages');
  assert.equal(asked.filter(([id]) => id === 'L4CQJADFVPZC9').length, 1, 'Gulch counts fetched once for main + gh-pages');

  assert.equal(commits(H, 'main'), before.hm + 1);
  assert.equal(commits(H, 'gh-pages'), before.hg + 1);
  assert.equal(commits(P, 'main'), before.p + 1);
  const c = lastCommit(H, 'main');
  assert.equal(c.author, 'inventory-sync[bot]');
  assert.match(c.subject, /^chore: update sold_out flags \[cloud-run\] \[.+\]$/, 'Cloud Run commits are tagged');

  // Second run, same inventory → nothing to push
  await inv.runInventorySync({ fetchCounts });
  assert.equal(commits(H, 'main'), before.hm + 1);
  assert.equal(commits(P, 'main'), before.p + 1);
});

test('menu-build targets: all data to horizontal, portrait slugs to portrait, bev to public/ and output/', async () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const f = (name, body) => { const p = join(out, name); writeFileSync(p, JSON.stringify(body)); return p; };
  const pastryFiles = [f('the-gulch.json', { v: 2 }), f('medley.json', { v: 2 }), f('the-factory.json', { v: 2 }), f('5th-broad.json', { v: 2 })];
  const bevFiles    = [f('bev-the-gulch.json', { v: 2 }), f('bev-medley.json', { v: 2 })];

  const targets = build.menuBuildTargets({ pastryFiles, bevFiles, portraitSlugs: ['the-factory', '5th-broad'] });
  const { failed } = await publish.publishTargets(targets, 'chore: test', { name: 'bot', email: 'b@b' });
  assert.deepEqual(failed, []);

  assert.equal(show(H, 'main', 'output/data/bev-medley.json').v, 2);
  assert.equal(show(H, 'gh-pages', 'data/the-factory.json').v, 2);
  assert.deepEqual(show(H, 'main', 'output/data/12th-south.json'), { keep: true }, 'unrelated files preserved');
  assert.equal(show(P, 'main', 'output/data/5th-broad.json').v, 2);
  assert.throws(() => show(P, 'main', 'output/data/the-gulch.json'), 'horizontal-only slugs stay out of portrait');
  assert.equal(show(B, 'main', 'public/data/bev-the-gulch.json').v, 2);
  assert.equal(show(B, 'main', 'output/data/bev-the-gulch.json').v, 2, 'stale output/ copy refreshed');
  assert.deepEqual(show(B, 'main', 'public/overrides-the-gulch.json'), { sold_out: ['Latte'] }, 'admin overrides untouched');
});

test('onlyTimestampsChanged: ignores generated_at / inventory_patched_at, but only within the heartbeat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-'));
  const now = Date.parse('2026-11-12T20:00:00Z');
  const w = (name, body) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body, null, 2)); return p; };
  const HOUR = 60 * 60 * 1000;
  const menu = { location_name: 'The Gulch', sections: [{ items: [{ name: 'Glazed', sold_out: false }] }] };
  const prev10 = w('prev10.json', { ...menu, generated_at: '2026-11-12T19:50:00Z', inventory_patched_at: '2026-11-12T19:52:00Z' });
  const prev61 = w('prev61.json', { ...menu, generated_at: '2026-11-12T18:59:00Z' });
  const prevNoTs = w('prevNoTs.json', { ...menu });
  const next   = w('next.json',   { ...menu, generated_at: '2026-11-12T20:00:00Z' });
  const sold   = w('sold.json',   { ...menu, generated_at: '2026-11-12T20:00:00Z', sections: [{ items: [{ name: 'Glazed', sold_out: true }] }] });
  const broken = w('broken.json', '{not json');

  assert.equal(build.onlyTimestampsChanged(prev10, next, HOUR, now), true, 'timestamps only, 10 min old → skip');
  assert.equal(build.onlyTimestampsChanged(prev61, next, HOUR, now), false, 'older than the heartbeat → publish');
  assert.equal(build.onlyTimestampsChanged(prev10, sold, HOUR, now), false, 'a sold_out change → publish');
  assert.equal(build.onlyTimestampsChanged(prevNoTs, next, HOUR, now), false, 'no published timestamp → publish');
  assert.equal(build.onlyTimestampsChanged(join(dir, 'missing.json'), next, HOUR, now), false, 'new file → publish');
  assert.equal(build.onlyTimestampsChanged(broken, next, HOUR, now), false, 'unreadable → publish');
});

test('menu-build skips timestamp-only pushes, publishes real changes, and refreshes on the heartbeat', async () => {
  const out = mkdtempSync(join(tmpdir(), 'out-hb-'));
  const write = (name, body) => { const p = join(out, name); writeFileSync(p, JSON.stringify({ ...body, generated_at: new Date().toISOString() }, null, 2)); return p; };
  const files = (gulch) => ({
    pastryFiles: [write('the-gulch.json', gulch), write('the-factory.json', { menu: 'factory' })],
    bevFiles:    [write('bev-the-gulch.json', { menu: 'bev' })],
    portraitSlugs: ['the-factory'],
  });
  const run = (opts) => publish.publishTargets(build.menuBuildTargets(opts), 'chore: hb', { name: 'bot', email: 'b@b' });
  const counts = () => [commits(H, 'main'), commits(H, 'gh-pages'), commits(P, 'main'), commits(B, 'main')];

  await run(files({ menu: 'gulch', sold_out: false }));            // first publish of this content
  const first = counts();
  const gulchTs = show(H, 'gh-pages', 'data/the-gulch.json').generated_at;
  const factoryTs = show(P, 'main', 'output/data/the-factory.json').generated_at;

  await new Promise(r => setTimeout(r, 5));
  await run(files({ menu: 'gulch', sold_out: false }));            // same content, new generated_at
  assert.deepEqual(counts(), first, 'no commits anywhere for a timestamp-only build');

  await run(files({ menu: 'gulch', sold_out: true }));             // a real change at one store
  const [hm, hg, p, b] = counts();
  assert.deepEqual([hm, hg, p, b], [first[0] + 1, first[1] + 1, first[2], first[3]], 'only the horizontal repo gets a commit');
  assert.equal(show(H, 'gh-pages', 'data/the-gulch.json').sold_out, true);
  assert.notEqual(show(H, 'gh-pages', 'data/the-gulch.json').generated_at, gulchTs, 'the changed file gets a new timestamp');
  assert.notEqual(show(H, 'gh-pages', 'data/the-factory.json').generated_at, factoryTs, 'the rest of that repo is refreshed in the same commit');
  assert.equal(show(P, 'main', 'output/data/the-factory.json').generated_at, factoryTs, 'repos with no real change are left alone');

  await new Promise(r => setTimeout(r, 5));
  await run({ ...files({ menu: 'gulch', sold_out: true }), heartbeatMs: 1 });   // heartbeat due
  assert.deepEqual(counts(), [hm + 1, hg + 1, p + 1, b + 1], 'heartbeat refreshes every repo');
  assert.notEqual(show(P, 'main', 'output/data/the-factory.json').generated_at, factoryTs);
});

test('admin.html sources: pastry files also go to horizontal main public/data, the bev config to beverages output/', async () => {
  const out = mkdtempSync(join(tmpdir(), 'out-admin-'));
  const ts = () => new Date().toISOString();
  const w = (name, text) => { const p = join(out, name); writeFileSync(p, text); return p; };
  const configText = (drink) => `{\n  "_note": "curated by hand",\n  "sections": [ { "name": "Espresso", "items": [ { "name": "${drink}", "available": true } ] } ]\n}\n`;
  const files = (drink) => ({
    pastryFiles: [w('the-gulch.json', JSON.stringify({ menu: 'gulch-admin', generated_at: ts() })), w('the-factory.json', JSON.stringify({ menu: 'factory-admin', generated_at: ts() }))],
    bevFiles:    [w('bev-the-gulch.json', JSON.stringify({ menu: 'bev-admin', generated_at: ts() }))],
    bevConfigFile: w('bev-items-config.json', configText(drink)),
    portraitSlugs: ['the-factory'],
  });
  const run = (opts) => publish.publishTargets(build.menuBuildTargets(opts), 'chore: admin', { name: 'bot', email: 'b@b' });

  assert.deepEqual((await run(files('Latte'))).failed, []);
  assert.equal(show(H, 'main', 'public/data/the-gulch.json').menu, 'gulch-admin', 'admin pastry list is current');
  assert.equal(show(H, 'main', 'public/data/the-factory.json').menu, 'factory-admin');
  assert.throws(() => show(H, 'main', 'public/data/bev-the-gulch.json'), 'bev menus are not added to public/data');
  const rawConfig = execFileSync('git', ['--git-dir', B, 'show', 'main:output/bev-items-config.json'], { encoding: 'utf8' });
  assert.equal(rawConfig, configText('Latte'), 'config published byte for byte');
  assert.throws(() => show(B, 'main', 'public/data/bev-items-config.json'), 'config only goes to output/');
  assert.throws(() => show(H, 'main', 'output/data/bev-items-config.json'), 'and only to the beverages repo');

  const before = [commits(H, 'main'), commits(B, 'main')];
  await new Promise(r => setTimeout(r, 5));
  await run(files('Latte'));                                      // nothing but timestamps changed
  assert.deepEqual([commits(H, 'main'), commits(B, 'main')], before, 'an unchanged config does not force a commit');

  await run(files('Oat Latte'));                                  // config edited in GCS
  assert.equal(commits(B, 'main'), before[1] + 1, 'a config edit reaches the beverages repo');
  assert.equal(show(B, 'main', 'output/bev-items-config.json').sections[0].items[0].name, 'Oat Latte');
  assert.equal(commits(H, 'main'), before[0], 'horizontal is unaffected by a bev config edit');
});

test('buildBeverageMenu leaves a byte-for-byte copy of the config it used in outputDir', async () => {
  const { buildBeverageMenu } = await import('../src/buildBeverageMenu.js');
  const out = mkdtempSync(join(tmpdir(), 'bev-out-'));
  // Odd spacing on purpose: the copy must be the GCS bytes, not a re-serialisation.
  const src = '{ "_note":"hand-curated",\n  "sections": [ {"name":"Espresso","items":[{"name":"Latte","available":true}]} ] }\n';
  const realFetch = globalThis.fetch;
  const asked = [];
  process.env.BEV_CONFIG_URL = 'gs://test-bucket/bev-items-config.json';
  globalThis.__FAKE_GCS_TOKEN = 'fake-token';
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(src, { status: 200 }); };
  try {
    const written = await buildBeverageMenu({ outputDir: out });
    assert.ok(written.length >= 1);
    assert.ok(written.every(p => /bev-[^/]+\.json$/.test(p)), 'the config copy is not returned as a menu file');
    assert.equal(readFileSync(join(out, 'bev-items-config.json'), 'utf8'), src);
    assert.match(asked[0], /test-bucket\/o\/bev-items-config\.json/);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__FAKE_GCS_TOKEN;
    delete process.env.BEV_CONFIG_URL;
  }
});

test('a push race is retried from a fresh clone and keeps the other writer\'s commit', async () => {
  let attempt = 0;
  const target = {
    repo: 'jwal7000/menu-display-beverages', branch: 'main', label: 'race',
    apply: async (dir) => {
      attempt++;
      if (attempt === 1) {
        // Simulate admin.html committing an override while we're working
        const other = mkdtempSync(join(tmpdir(), 'other-'));
        execFileSync('git', ['clone', '--quiet', B, other]);
        writeFileSync(join(other, 'public/overrides-the-gulch.json'), JSON.stringify({ sold_out: ['Mocha Latte'] }));
        git(other, 'commit', '--quiet', '-am', 'admin override');
        git(other, 'push', '--quiet', 'origin', 'main');
      }
      writeFileSync(join(dir, 'public/data/bev-medley.json'), JSON.stringify({ v: 3 }));
      return ['public/data/bev-medley.json'];
    },
  };
  const { failed } = await publish.publishTargets([target], 'chore: race', { name: 'bot', email: 'b@b' });
  assert.deepEqual(failed, []);
  assert.equal(attempt, 2);
  assert.equal(show(B, 'main', 'public/data/bev-medley.json').v, 3);
  assert.deepEqual(show(B, 'main', 'public/overrides-the-gulch.json'), { sold_out: ['Mocha Latte'] });
});

test('DRY_RUN commits locally but never pushes', async () => {
  process.env.DRY_RUN = '1';
  try {
    const n = commits(B, 'main');
    const target = { repo: 'jwal7000/menu-display-beverages', branch: 'main', label: 'dry',
      apply: async (dir) => { writeFileSync(join(dir, 'public/data/bev-medley.json'), '{"v":99}'); return ['public/data/bev-medley.json']; } };
    const { failed } = await publish.publishTargets([target], 'chore: dry', { name: 'bot', email: 'b@b' });
    assert.deepEqual(failed, []);
    assert.equal(commits(B, 'main'), n);
  } finally { delete process.env.DRY_RUN; }
});

test('a failing target is reported without stopping the others, and tokens are scrubbed', async () => {
  const saved = process.env.GIT_BASE_URL;
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    delete process.env.GIT_BASE_URL;
    process.env.GITHUB_TOKEN = 'ghp_SECRET123';
    const bad  = { repo: 'jwal7000/does-not-exist-xyz', branch: 'main', label: 'bad', apply: async () => [] };
    process.env.GIT_BASE_URL = `file://${root}`;
    const good = { repo: 'jwal7000/menu-display-portrait', branch: 'main', label: 'good', apply: async () => [] };
    const { failed } = await publish.publishTargets([bad, good], 'x', { name: 'b', email: 'b@b' });
    assert.deepEqual(failed, ['bad']);
  } finally {
    console.error = orig;
    process.env.GIT_BASE_URL = saved;
    delete process.env.GITHUB_TOKEN;
  }
  assert.ok(!logs.join('\n').includes('ghp_SECRET123'));
});

test('DRY_RUN with DRY_RUN_URL uploads changed files to GCS (gcs.js loaded on demand) and never pushes', async () => {
  const realFetch = globalThis.fetch;
  const uploads = [];
  globalThis.__FAKE_GCS_TOKEN = 'fake-token';
  globalThis.fetch = async (url, init) => { uploads.push({ url: String(url), init }); return new Response('{}', { status: 200 }); };
  process.env.DRY_RUN = '1';
  process.env.DRY_RUN_URL = 'gs://test-bucket/dry-run/';
  try {
    const n = commits(B, 'main');
    const target = { repo: 'jwal7000/menu-display-beverages', branch: 'main', label: 'dry-upload',
      apply: async (dir) => { writeFileSync(join(dir, 'public/data/bev-the-gulch.json'), '{"v":"dry"}'); return ['public/data/bev-the-gulch.json']; } };
    const { failed } = await publish.publishTargets([target], 'chore: dry', { name: 'bot', email: 'b@b' });
    assert.deepEqual(failed, []);
    assert.equal(commits(B, 'main'), n, 'nothing pushed');
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].url, /\/b\/test-bucket\/o\?uploadType=media&name=dry-run%2Fmenu-display-beverages%2Fmain%2Fpublic%2Fdata%2Fbev-the-gulch\.json$/);
    assert.equal(uploads[0].init.headers.Authorization, 'Bearer fake-token');
    assert.equal(String(uploads[0].init.body), '{"v":"dry"}');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__FAKE_GCS_TOKEN;
    delete process.env.DRY_RUN;
    delete process.env.DRY_RUN_URL;
  }
});

test('menu-build commits as menu-build[bot] with a [cloud-run] tag, distinct from the Mac mini', async () => {
  delete process.env.DRY_RUN;
  const { runMenuBuild } = await import('../src/jobs/menuBuild.js');
  const writer = (names) => async ({ outputDir }) => {
    mkdirSync(join(outputDir, 'data'), { recursive: true });
    return names.map(n => { const p = join(outputDir, 'data', n); writeFileSync(p, JSON.stringify({ v: 'cloud-run' })); return p; });
  };
  const ok = await runMenuBuild({
    buildPastry: writer(['the-gulch.json', 'medley.json', 'the-factory.json', '5th-broad.json']),
    buildBev:    async ({ outputDir }) => {
      writeFileSync(join(outputDir, 'bev-items-config.json'), '{"sections":[],"_note":"from-menu-build"}');
      return writer(['bev-the-gulch.json', 'bev-medley.json'])({ outputDir });
    },
  });
  assert.equal(ok, true);
  assert.equal(show(B, 'main', 'output/bev-items-config.json')._note, 'from-menu-build', 'menu-build publishes the config the bev build used');
  for (const [bare, branch] of [[H, 'main'], [H, 'gh-pages'], [P, 'main'], [B, 'main']]) {
    const c = lastCommit(bare, branch);
    assert.equal(c.author, 'menu-build[bot]', `${branch} author`);
    assert.notEqual(c.author, 'menu-refresh[bot]', 'not the Mac mini author');
    assert.match(c.subject, /^chore: auto-refresh menu data \[cloud-run\] \[.+\]$/, `${branch} subject`);
  }
  assert.equal(show(H, 'gh-pages', 'data/the-gulch.json').v, 'cloud-run');
});
