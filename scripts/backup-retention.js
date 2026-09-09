#!/usr/bin/env node
// Retention pruning for daily Firestore backups (prod-YYYY-MM-DD.json) in
// the private backup repo.
//
// Policy: keep all backups <=14d old; 1/week for 15d-6mo; 1/month for
// 6mo-2y; delete >2y. Within a week/month bucket the NEWEST backup is kept.
//
// Usage: node scripts/backup-retention.js <backup-dir> [--dry-run]

const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const DAILY_WINDOW_DAYS = 14;
const WEEKLY_WINDOW_DAYS = 182;  // ~6 months
const MONTHLY_WINDOW_DAYS = 730; // ~2 years

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else args._.push(a);
  }
  return args;
}

function daysSinceEpoch(d) {
  return Math.floor(d.getTime() / DAY_MS);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args._[0];
  if (!dir) {
    console.error('Usage: node scripts/backup-retention.js <backup-dir> [--dry-run]');
    process.exit(1);
  }

  const RE = /^prod-(\d{4}-\d{2}-\d{2})\.json$/;
  const files = fs.readdirSync(dir)
    .map(function (name) {
      const m = name.match(RE);
      if (!m) return null;
      return { name: name, date: new Date(m[1] + 'T00:00:00Z') };
    })
    .filter(Boolean)
    .sort(function (a, b) { return b.date - a.date; }); // newest first

  const todayDays = daysSinceEpoch(new Date());
  const keptWeeks = new Set();
  const keptMonths = new Set();
  const toDelete = [];

  for (const f of files) {
    const ageDays = todayDays - daysSinceEpoch(f.date);

    if (ageDays <= DAILY_WINDOW_DAYS) continue; // keep every daily backup

    if (ageDays <= WEEKLY_WINDOW_DAYS) {
      const bucket = Math.floor(daysSinceEpoch(f.date) / 7);
      if (keptWeeks.has(bucket)) toDelete.push(f);
      else keptWeeks.add(bucket);
      continue;
    }

    if (ageDays <= MONTHLY_WINDOW_DAYS) {
      const bucket = f.date.getUTCFullYear() * 12 + f.date.getUTCMonth();
      if (keptMonths.has(bucket)) toDelete.push(f);
      else keptMonths.add(bucket);
      continue;
    }

    toDelete.push(f); // older than 2 years
  }

  for (const f of toDelete) {
    console.log((args.dryRun ? '[dry-run] ' : '') + 'delete ' + f.name);
    if (!args.dryRun) fs.unlinkSync(path.join(dir, f.name));
  }
  console.log('Kept ' + (files.length - toDelete.length) + ', deleted ' + toDelete.length + ' of ' + files.length + ' backups.');
}

main();
