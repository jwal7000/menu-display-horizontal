/**
 * run.js — container entrypoint for the Cloud Run Jobs.
 *
 *   node src/jobs/run.js menu-build       (Cloud Scheduler: every 10 min)
 *   node src/jobs/run.js inventory-sync   (Cloud Scheduler: every 2 min)
 */

import { runMenuBuild }     from './menuBuild.js';
import { runInventorySync } from './inventorySync.js';

const JOBS = {
  'menu-build':     runMenuBuild,
  'inventory-sync': runInventorySync,
};

const name = process.argv[2] || process.env.JOB_NAME;
const job  = JOBS[name];
if (!job) {
  console.error(`Usage: node src/jobs/run.js <${Object.keys(JOBS).join('|')}>`);
  process.exit(2);
}

console.log(`▶︎  ${name} starting${process.env.DRY_RUN === '1' ? ' (DRY RUN)' : ''} — ${new Date().toISOString()}`);
job()
  .then(ok => process.exit(ok ? 0 : 1))
  .catch(err => { console.error(`❌  ${name} fatal:`, err.stack || err.message); process.exit(1); });
