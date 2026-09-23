#!/usr/bin/env node
'use strict';

/**
 * sporty-autobet.js — command-line front end for autobet-engine.js
 *
 * Every rule that can move money lives in autobet-engine.js, not here, so the
 * CLI and the admin Auto-Bet tab cannot drift apart. In particular the ₦10
 * stake cap, the 3-leg minimum, the one-market-per-match rule and the flex
 * policy are all enforced by the engine.
 *
 * Usage:
 *   node sporty-autobet.js --login                 one-time, log in by hand
 *   node sporty-autobet.js --check                 validate only, no browser
 *   node sporty-autobet.js                         DRY RUN (places nothing)
 *   node sporty-autobet.js --live                  place for real, ₦10 each
 *   node sporty-autobet.js --codes V563NF,HR7C6J   explicit codes
 *   node sporty-autobet.js --file data/x.json      a different portfolio file
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const engine = require('./autobet-engine');

const ROOT = __dirname;
const DEFAULT_PORTFOLIO = path.join(ROOT, 'data', '_portfolio-final.json');

function parseArgs(argv) {
  const a = { flags: new Set(), opts: {} };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a.opts[t.slice(2)] = next; i++; }
    else a.flags.add(t.slice(2));
  }
  return a;
}

/** Codes come from --codes, or from the portfolio file the generator wrote. */
function collectCodes(args) {
  if (args.opts.codes) return engine.parseCodes(args.opts.codes);
  const file = args.opts.file ? path.resolve(args.opts.file) : DEFAULT_PORTFOLIO;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${file} is missing or unreadable (or pass --codes)`); }
  const arr = Array.isArray(raw) ? raw : (raw.codes || raw.slips || []);
  const codes = engine.parseCodes(arr.map(c => c.shareCode || c.code || '').join(' '));
  if (!codes.length) throw new Error(`${file} contained no booking codes`);
  return codes;
}

async function confirmArmed(n) {
  const phrase = `PLACE ${n}`;
  console.log('\n  ┌────────────────────────────────────────────────────────┐');
  console.log('  │  LIVE — real bets, real money.                         │');
  console.log('  └────────────────────────────────────────────────────────┘');
  console.log(`  ${n} code(s) × ₦${engine.MAX_STAKE} = ₦${n * engine.MAX_STAKE} maximum exposure.`);
  console.log(`  Type exactly "${phrase}" to proceed.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question('  > ', res));
  rl.close();
  return answer.trim() === phrase;
}

async function main() {
  const args = parseArgs(process.argv);
  engine.assertSafeEnvironment();

  if (args.flags.has('login')) {
    console.log('Opening SportyBet — log in by hand in the window that appears.');
    const r = await engine.signIn();
    console.log(r.success ? '✓ Session saved — later runs are unattended.' : `✗ ${r.error}`);
    return;
  }

  const codes = collectCodes(args);

  if (args.flags.has('check')) {
    console.log(`\nChecking ${codes.length} code(s) — no browser, nothing placed.\n`);
    for (const code of codes) {
      const v = await engine.validateCode(code);
      console.log(v.ok
        ? `  ✓ ${code.padEnd(8)} ${String(v.legs).padStart(2)} legs  ${v.odds.toLocaleString().padStart(12)}x  → ${v.betType === 'flex' ? 'FLEX' : 'Sports'}`
        : `  ✗ ${code.padEnd(8)} ${v.reason}`);
    }
    return;
  }

  const dryRun = !args.flags.has('live');
  console.log(`\nSlipPilot auto-bet — ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  codes : ${codes.join(', ')}`);
  console.log(`  stake : ₦${engine.MAX_STAKE} flat (hard cap, not configurable)`);
  if (dryRun) console.log('  (nothing will be staked — pass --live to place)');

  if (!dryRun && !await confirmArmed(codes.length)) { console.log('\nAborted — nothing placed.'); return; }

  const state = await engine.startRun(codes, { dryRun });
  const rec = engine.getRun(state.runId);

  // Mirror the engine's event log to stdout until the run ends.
  let seq = 0;
  await new Promise(resolve => {
    const tick = setInterval(() => {
      while (seq < rec.events.length) {
        const ev = rec.events[seq++];
        if (ev.type === 'log') console.log(ev.data.msg);
      }
      if (rec.state.status !== 'running') { clearInterval(tick); resolve(); }
    }, 200);
  });

  const s = rec.state;
  console.log('\n── Summary ───────────────────────────────────────');
  console.log(`  placed  : ${s.placed}${s.placed ? ` (₦${s.placed * engine.MAX_STAKE})` : ''}`);
  console.log(`  skipped : ${s.skipped}`);
  console.log(`  failed  : ${s.failed}`);
  if (s.failed) console.log(`\n  Check ${path.basename(engine.SHOT_DIR)}/ before retrying any failed code.`);
  process.exit(s.status === 'error' ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => { console.error(`\n✗ ${err.message}`); process.exit(1); });
}

module.exports = { collectCodes, parseArgs };
