/**
 * run.js — container entrypoint for the Cloud Run Jobs.
 *
 *   node src/jobs/run.js menu-build       (Cloud Scheduler: every 10 min)
 *   node src/jobs/run.js inventory-sync   (Cloud Scheduler: every 2 min)
 */

// Each job is imported only when it runs, so inventory-sync doesn't load menu-build's
// dependencies (mysql2, googleapis). Cold module loads are a large part of startup.
const JOBS = {
  'menu-build':     async () => (await import('./menuBuild.js')).runMenuBuild,
  'inventory-sync': async () => (await import('./inventorySync.js')).runInventorySync,
};

const secs = () => process.uptime().toFixed(1);

const name = process.argv[2] || process.env.JOB_NAME;
if (!JOBS[name]) {
  console.error(`Usage: node src/jobs/run.js <${Object.keys(JOBS).join('|')}>`);
  process.exit(2);
}

console.log(`▶︎  ${name} starting${process.env.DRY_RUN === '1' ? ' (DRY RUN)' : ''} — ${new Date().toISOString()}`);
JOBS[name]()
  .then(job => { console.log(`⏱  ${name}: modules loaded at ${secs()}s`); return job(); })
  .then(ok => { console.log(`⏱  ${name}: finished at ${secs()}s (process time; Cloud Run's own startup isn't included)`); process.exit(ok ? 0 : 1); })
  .catch(err => { console.error(`❌  ${name} fatal:`, err.stack || err.message); process.exit(1); });
