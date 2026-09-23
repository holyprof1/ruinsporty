/**
 * PERMANENT REGRESSION TEST — v36
 *
 * Forensic audit of advanced-generator-engine.js's Phase 3 (confidence
 * floor + risk bands + conversion) found that a leg whose MARKET is
 * REMOVE-risk (correct score, HT-FT, corners/cards, anytime scorer,
 * handicap-style — see intelligence-engine.js's HARD_REMOVE_PATTERNS) could
 * still reach `eligible=true` and flow into the master/wide pool (and
 * therefore Sections B-E) WITHOUT ever being risk-checked or converted:
 *
 *   1. riskBandLeave (>=72 composite FinalScore) skipped convertLeg
 *      entirely — but marketSafety only contributes 10% of the weighted
 *      score, so a correct-score pick with strong team-form/league-intel/
 *      punter-accuracy on the other 90% could still clear 72 with its
 *      market risk never actually classified.
 *   2. Even when a REMOVE-risk leg DID reach convertLeg (score 61-71), the
 *      "maybe-band" leniency ("keep original if no better replacement
 *      found") unconditionally kept it — that leniency is only correct for
 *      markets that DO have a real alternative in SAFE_CONVERSIONS; REMOVE
 *      has none, so `best` is always null and the leg was always kept.
 *   3. Separately, widePool (which feeds Max Builder) is built with
 *      ignoreFloor=true, which used to skip the `!p.eligible` check
 *      ENTIRELY — not just the score floor — so a leg the pipeline had
 *      explicitly decided to DROP (mandatory conversion failed) could still
 *      be selected into Max Builder with its original, unconverted risky
 *      market.
 *
 * Only a REMOVE-risk leg scoring <61 was ever correctly dropped before this
 * fix. This test locks in the corrected behavior: canLeaveAsIs() now refuses
 * to bypass conversion for REMOVE-risk regardless of score, and convertLeg's
 * isMandatoryBand is forced true for REMOVE regardless of score, so the
 * no-safe-alternative path always drops it — at every score band.
 *
 * Run with: node test-conversion-safety.js
 * Exit code 0 = pass, non-zero = fail.
 */
'use strict';
const assert = require('assert');
const engine = require('./advanced-generator-engine');
const { canLeaveAsIs, convertLeg, eventBoardCache, DEFAULT_CONFIG } = engine;

// check() just registers — actual (sequential, order-preserving) execution
// happens in the async IIFE at the bottom of the file, so both sync and
// async check functions work without changing any call site above.
let failures = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function makeLeg(overrides) {
  return {
    eventId: 'evt-test-1', homeTeam: 'Home FC', awayTeam: 'Away FC', league: 'Test League',
    marketName: 'Correct Score', specifier: '', outcomeName: '2-1', odds: 6.5,
    matchKey: 'evt-test-1|mkt|spec|out', safety: 0, components: { marketSafety: 0 },
    ...overrides,
  };
}

// ── canLeaveAsIs — the pure Phase-3 split-loop gate ─────────────────────────
check('REMOVE-risk leg at a HIGH score (95) may NOT skip conversion', () => {
  assert.strictEqual(canLeaveAsIs('REMOVE', 95, DEFAULT_CONFIG), false);
});
check('REMOVE-risk leg at the exact riskBandLeave score may NOT skip conversion', () => {
  assert.strictEqual(canLeaveAsIs('REMOVE', DEFAULT_CONFIG.riskBandLeave, DEFAULT_CONFIG), false);
});
check('A safe (OK-risk) leg at a high score MAY still skip conversion (unaffected by this fix)', () => {
  assert.strictEqual(canLeaveAsIs('OK', 95, DEFAULT_CONFIG), true);
});
check('A convertible-risk leg (e.g. HOME_WIN) at a high score MAY still skip conversion (unaffected by this fix)', () => {
  assert.strictEqual(canLeaveAsIs('HOME_WIN', 95, DEFAULT_CONFIG), true);
});
check('A convertible-risk leg below riskBandLeave still goes to conversion (unaffected by this fix)', () => {
  assert.strictEqual(canLeaveAsIs('HOME_WIN', 50, DEFAULT_CONFIG), false);
});

// ── convertLeg — the mandatory-drop enforcement, network-free via a primed cache ──
// eventBoardCache is exported specifically so this test never needs a real
// network call: convertLeg's fetchEventMarketBoard reads through this cache
// first, so priming it with a fake-but-realistic market list exercises the
// REAL decision logic (classifyRisk / SAFE_CONVERSIONS / isMandatoryBand)
// with zero network dependency.
check('REMOVE-risk leg (Correct Score) at HIGH score (95) with no safe alternative is DROPPED, not kept', async () => {
  eventBoardCache.set('evt-test-1', {
    data: [
      { marketId: '1', marketName: 'Double Chance', specifier: '', outcomeId: '1', outcomeName: '1X', odds: 1.25, productId: 1 },
      { marketId: '2', marketName: 'Over/Under', specifier: 'total=2.5', outcomeId: '2', outcomeName: 'Over 2.5', odds: 1.75, productId: 1 },
    ],
    ts: Date.now(),
  });
  const leg = makeLeg({ odds: 6.5 });
  const result = await convertLeg(leg, 95, {}, DEFAULT_CONFIG, {}, []);
  assert.strictEqual(result.keep, undefined, `expected no "keep", got ${JSON.stringify(result)}`);
  assert.strictEqual(result.dropped, true, `REGRESSION: a REMOVE-risk leg with no safe conversion was kept instead of dropped at score 95 — got ${JSON.stringify(result)}`);
});

check('REMOVE-risk leg (Correct Score) in the OLD "maybe-band" (score 65) with no safe alternative is DROPPED, not kept', async () => {
  const leg = makeLeg({ odds: 6.5 });
  const result = await convertLeg(leg, 65, {}, DEFAULT_CONFIG, {}, []);
  assert.strictEqual(result.keep, undefined, `expected no "keep", got ${JSON.stringify(result)}`);
  assert.strictEqual(result.dropped, true, `REGRESSION: a REMOVE-risk leg with no safe conversion was kept instead of dropped at score 65 (the old maybe-band) — got ${JSON.stringify(result)}`);
});

check('Convertible-risk leg (Home Win) WITH a safe alternative on the board converts successfully (unaffected by this fix)', async () => {
  // Leg odds (1.40, backing the favorite outright) must be HIGHER than the
  // Double Chance alternative (1.25, set in the previous check's cache
  // priming) — a real safer conversion always trades some odds for safety,
  // never the reverse (see the next check for that rule itself).
  const leg = makeLeg({ marketName: 'Match Winner', outcomeName: 'Home', odds: 1.40, components: { marketSafety: 57 } });
  const result = await convertLeg(leg, 65, {}, DEFAULT_CONFIG, {}, []);
  assert.strictEqual(result.converted, true, `expected converted:true, got ${JSON.stringify(result)}`);
  assert.strictEqual(result.leg.marketName, 'Double Chance');
  assert.ok(Array.isArray(result.leg.conversionReason.candidatesConsidered) && result.leg.conversionReason.candidatesConsidered.length > 0,
    'conversionReason should log the candidate alternatives that were considered, not just the winner');
});

check('A replacement priced HIGHER than the original leg is never accepted', async () => {
  eventBoardCache.set('evt-test-1', {
    data: [{ marketId: '2', marketName: 'Over/Under', specifier: 'total=2.5', outcomeId: '2', outcomeName: 'Over 2.5', odds: 1.75, productId: 1 }],
    ts: Date.now(),
  });
  const leg = makeLeg({ marketName: 'Over/Under', specifier: 'total=2.5', outcomeName: 'Over 2.5', odds: 1.10, components: { marketSafety: 77 } });
  const result = await convertLeg(leg, 65, {}, DEFAULT_CONFIG, {}, []);
  assert.notStrictEqual(result.leg?.odds, 1.75, 'must never swap in a higher-odds replacement than the original leg');
});

check('convertLeg never mutates a different event\'s market board (event identity is preserved)', async () => {
  eventBoardCache.set('evt-other-event', {
    data: [{ marketId: '9', marketName: 'Double Chance', specifier: '', outcomeId: '9', outcomeName: '1X', odds: 1.10, productId: 1 }],
    ts: Date.now(),
  });
  eventBoardCache.set('evt-test-1', {
    data: [{ marketId: '1', marketName: 'Double Chance', specifier: '', outcomeId: '1', outcomeName: '1X', odds: 1.25, productId: 1 }],
    ts: Date.now(),
  });
  const leg = makeLeg({ eventId: 'evt-test-1', marketName: 'Match Winner', outcomeName: 'Home', odds: 1.30, components: { marketSafety: 57 } });
  const result = await convertLeg(leg, 65, {}, DEFAULT_CONFIG, {}, []);
  assert.strictEqual(result.converted, true);
  assert.strictEqual(result.leg.eventId, 'evt-test-1', 'the converted leg must stay on the SAME event it started on');
  assert.strictEqual(result.leg.outcomeId, '1', 'must pick the market belonging to evt-test-1, not evt-other-event');
});

(async () => {
  console.log('test-conversion-safety.js\n');
  for (const { name, fn } of checks) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.error('  ✗', name, '—', e.message); }
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
