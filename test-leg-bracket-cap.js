/**
 * PERMANENT REGRESSION TEST — v14 §2
 *
 * checkLegBracketCap is the single gate every leg-count-choosing builder
 * (Section B Tiers 1-4, Consensus, the Moonshot ladder, Sure Tier) consults
 * before attempting a category. It exists because the learning loop up to
 * v13 only corrected PICK quality (league/punter/market down-weighting) —
 * it never asked whether a TICKET SIZE was winnable at all: real stored
 * history on 2026-07-24 showed the 21-30 and 31+ leg brackets at exactly
 * 0% observed ticket win rate over 110 and 31 settled tickets respectively,
 * despite ~72-78% real leg accuracy — a portfolio-construction problem, not
 * a picks problem.
 *
 * This test exercises the real, deterministic, network-free
 * checkLegBracketCap function directly, plus a sanity check on the
 * theoretical-win-rate formula it's built to compare against.
 *
 * Run with: node test-leg-bracket-cap.js
 * Exit code 0 = pass, non-zero = fail (safe to wire into CI).
 */
'use strict';
const assert = require('assert');
const engine = require('./advanced-generator-engine');
const { checkLegBracketCap } = engine;

function makeFakeRec() { return { events: [], listeners: [], state: { runId: 'test-leg-bracket-cap' } }; }

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.error('  ✗', name, '—', e.message); }
}

console.log('test-leg-bracket-cap.js\n');

check('no cap active (legBracketCap null) never blocks any leg count', () => {
  const rec = makeFakeRec();
  const result = checkLegBracketCap('Tier 3', 'B', 40, { legBracketCap: null }, rec);
  assert.strictEqual(result, null, 'expected null (not blocked) when no cap is active');
});

check('a target AT the cap is allowed — the cap is a ceiling, not an exclusive bound', () => {
  const rec = makeFakeRec();
  const result = checkLegBracketCap('Tier 1', 'B', 20, { legBracketCap: 20 }, rec);
  assert.strictEqual(result, null, 'expected null — 20 legs should be allowed when the cap is exactly 20');
});

check('a target ABOVE the cap is blocked with an honest, distinguishable notBuilt entry', () => {
  const rec = makeFakeRec();
  const result = checkLegBracketCap('Tier 2', 'B', 32, { legBracketCap: 20 }, rec);
  assert.ok(result, 'expected a notBuilt entry, got null');
  assert.strictEqual(result.notBuilt, true);
  assert.strictEqual(result.legBracketCapped, true, 'must be distinguishable from an ordinary pool-limited notBuilt entry');
  assert.strictEqual(result.tier, 'Tier 2');
  assert.strictEqual(result.section, 'B');
  assert.ok(/20/.test(result.notBuiltReason), 'the real cap number must appear in the reason, not a placeholder');
});

check('a target below the cap is allowed', () => {
  const rec = makeFakeRec();
  const result = checkLegBracketCap('Sure Tier', 'E', 18, { legBracketCap: 20 }, rec);
  assert.strictEqual(result, null);
});

check('the notBuiltReason mentions the override setting, so a capped user can find the way out', () => {
  const rec = makeFakeRec();
  const result = checkLegBracketCap('Moonshot', 'D', 55, { legBracketCap: 20 }, rec);
  assert.ok(/allowBeyondProvenLegCount|Build tickets beyond/i.test(result.notBuiltReason) || /override/i.test(result.notBuiltReason),
    `expected the reason to point at the override control, got: "${result.notBuiltReason}"`);
});

// Sanity check on the theoretical-win-rate formula itself (legHitRate^legCount)
// against the exact real numbers this session observed live from
// /api/admin/advanced-generator/leg-bracket-survival on 2026-07-24: the
// 21-30 leg bracket, 71.6% real leg hit rate, avg 23.7 legs -> ~0.036%
// theoretical win rate (vs 0% actually observed over 110 settled tickets).
check('theoretical win rate formula matches the real observed 21-30 bracket calculation', () => {
  const legHitRate = 0.716, avgLegCount = 23.7;
  const theoreticalPct = Math.pow(legHitRate, avgLegCount) * 100;
  assert.ok(Math.abs(theoreticalPct - 0.036) < 0.01, `expected ~0.036%, got ${theoreticalPct.toFixed(4)}%`);
});

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
