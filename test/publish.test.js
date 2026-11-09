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

test('inventory-sync patches main + gh-pages + portrait, skips Medley, and only commits on change', async () => {
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
  assert.equal(show(H, 'main',     'output/data/medley.json').sections[0].items[0].sold_out, false, 'Medley skipInventory honoured');
  assert.ok(!asked.some(([id]) => id === 'LDR9H5M3GQKXF'), 'never asks Square about Medley');
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

test('menu-build commits as menu-build[bot] with a [cloud-run] tag, distinct from the Mac mini', async () => {
  delete process.env.DRY_RUN;
  const { runMenuBuild } = await import('../src/jobs/menuBuild.js');
  const writer = (names) => async ({ outputDir }) => {
    mkdirSync(join(outputDir, 'data'), { recursive: true });
    return names.map(n => { const p = join(outputDir, 'data', n); writeFileSync(p, JSON.stringify({ v: 'cloud-run' })); return p; });
  };
  const ok = await runMenuBuild({
    buildPastry: writer(['the-gulch.json', 'medley.json', 'the-factory.json', '5th-broad.json']),
    buildBev:    writer(['bev-the-gulch.json', 'bev-medley.json']),
  });
  assert.equal(ok, true);
  for (const [bare, branch] of [[H, 'main'], [H, 'gh-pages'], [P, 'main'], [B, 'main']]) {
    const c = lastCommit(bare, branch);
    assert.equal(c.author, 'menu-build[bot]', `${branch} author`);
    assert.notEqual(c.author, 'menu-refresh[bot]', 'not the Mac mini author');
    assert.match(c.subject, /^chore: auto-refresh menu data \[cloud-run\] \[.+\]$/, `${branch} subject`);
  }
  assert.equal(show(H, 'gh-pages', 'data/the-gulch.json').v, 'cloud-run');
});
