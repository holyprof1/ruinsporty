/**
 * PERMANENT REGRESSION TEST — v11 §1, expanded v19 §1
 *
 * On 2026-07-23, the live generator emitted three tickets badged "Moonshot"
 * at 77.47x / 55.48x / 89.85x — the spec (patch v9) is explicit that the
 * Moonshot label is reserved for tickets >= moonshotMinOdds (50,000x by
 * default). Root cause: buildMoonshotVariants called buildCategoryVariants
 * without an odds-target argument, so only leg count (>=12) was checked;
 * the tickets were built, live-emitted over SSE, and only filtered out of
 * the SAVED results afterward — too late, the browser had already shown them.
 *
 * v19 §1 — a live-data audit (checking the STORED tier/odds fields, not
 * just what rendered) found ~50 historical entries across every category
 * violating their own floor, all dated before the relevant fix shipped
 * (Moonshot/Tier ones predate this test even existing; a handful of Mix/Max
 * Builder ones predate the v15 universal-floor chokepoint). Every run SINCE
 * each fix landed is clean. That confirmed the actual construction code
 * (buildCategoryVariants + emitVariants + generateTicketCode's universal
 * floor) was never actually broken again — but a THIRD silent regression
 * scare is one too many, so this test now covers every category, not just
 * Moonshot: Tier 1 and Tier 4 (Section B), and the universal-floor
 * chokepoint Mix/Max Builder/Consensus all depend on instead of their own
 * per-category check.
 *
 * This test exercises the real, deterministic, network-free
 * buildCategoryVariants/generateTicketCode functions directly (the one
 * network call generateTicketCode would make is never reached on the
 * rejection path under test) and fails loudly if a sub-floor ticket can
 * ever be produced again for ANY category.
 *
 * Run with: node test-moonshot-floor.js
 * Exit code 0 = pass, non-zero = fail. Wired into server.js as an actual
 * startup self-check (not just something run manually once) — see
 * runStartupSelfChecks() in server.js.
 */
'use strict';
const assert = require('assert');
const engine = require('./advanced-generator-engine');
const { buildCategoryVariants, makeExposureTracker, computeOdds, DEFAULT_CONFIG } = engine;

// Distinct league AND distinct teams per leg — a real pool spans many
// leagues/teams; a fake pool that reuses the same league/team for every leg
// artificially trips the (correct, realistic) exposure/league-diversity caps
// and starves the test regardless of what the odds-floor logic does. Every
// leg here is its own unique league and its own two unique teams so ONLY the
// odds-floor behavior under test can affect the result.
function makeFakePool(n, oddsPerLeg) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    pool.push({
      eventId: 'evt' + i, homeTeam: 'Home' + i, awayTeam: 'Away' + i, league: 'League' + i,
      marketName: 'Over/Under', specifier: 'total=1.5', outcomeName: 'Over 1.5',
      odds: oddsPerLeg, finalScore: 80, sourceCount: 1, matchKey: 'mk' + i, isSoftLeague: false,
    });
  }
  return pool;
}

let failures = 0;
// check() just registers — actual (sequential, order-preserving) execution
// happens in the async IIFE at the bottom of the file, so both sync and
// async check functions work without changing any call site above.
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ── Scenario 1: the EXACT shape of the 2026-07-23 incident ─────────────────
// 16 legs at ~1.3 avg odds -> combined odds around 1.3^16 ~= 66x, nowhere
// near the 50,000x moonshot bar.
check('a thin pool that cannot reach the moonshot bar produces ZERO Moonshot variants', () => {
  const pool = makeFakePool(16, 1.3);
  const cfg = { ...DEFAULT_CONFIG };
  const exposure = makeExposureTracker(cfg);
  const result = buildCategoryVariants(pool, 'Moonshot', 16, 5, cfg, exposure, 12, cfg.moonshotMinOdds);
  assert.strictEqual(result.activeCount, 0,
    `REGRESSION: buildCategoryVariants returned activeCount=${result.activeCount} for a pool that can only reach ~66x combined — the odds floor is not being enforced at construction time. This is the exact bug that shipped live on 2026-07-23 (77x/55x/89x "Moonshot" tickets).`);
});

// ── Scenario 2: sanity check the test isn't trivially passing ──────────────
// A pool that genuinely CAN clear 50,000x must still produce at least 1
// variant, proving the floor check isn't just rejecting everything.
check('a pool that CAN clear the moonshot bar still produces at least 1 variant', () => {
  const pool = makeFakePool(40, 1.4); // 1.4^40 ~= 850,000x, comfortably over 50k
  const cfg = { ...DEFAULT_CONFIG };
  const exposure = makeExposureTracker(cfg);
  const result = buildCategoryVariants(pool, 'Moonshot', 40, 5, cfg, exposure, 12, cfg.moonshotMinOdds);
  assert.ok(result.activeCount >= 1, `SANITY: expected >=1 variant from a pool that clears the bar, got activeCount=${result.activeCount} — the test itself may be broken, or the floor check is rejecting everything unconditionally.`);
  for (const picks of result.picksByVariant) {
    const odds = computeOdds(picks);
    assert.ok(odds >= cfg.moonshotMinOdds, `every returned Moonshot variant must individually clear the floor — got ${odds}`);
  }
});

// ── Scenario 3: Tier 1 (a non-Moonshot category) must NOT be affected by
// the Moonshot-specific hard guard — it has its own, different floor.
check('a non-Moonshot category (Tier 1) is unaffected by the Moonshot-specific guard', () => {
  const pool = makeFakePool(21, 1.4); // 1.4^21 ~= 1,590x, clears Tier 1's 1,000x floor but nowhere near 50,000x
  const cfg = { ...DEFAULT_CONFIG };
  const exposure = makeExposureTracker(cfg);
  const result = buildCategoryVariants(pool, 'Tier 1', 21, 5, cfg, exposure, undefined, 1000);
  assert.ok(result.activeCount >= 1, `Tier 1 should build normally at its own (much lower) floor — got activeCount=${result.activeCount}`);
});

// ── v12 §5: graduated ladder — Moonshot Lite (≥15,000x) and Moonshot Mini
// (≥5,000x) get their own construction-time floor, exactly like the
// original Moonshot label did in v11. A pool too thin for full Moonshot but
// deep enough for Lite must produce a Lite variant that clears 15k (and
// would legitimately fail the stricter 50k Moonshot floor) — proving the
// ladder's per-tier floors are real and independent, not a copy-paste of
// the Moonshot floor under a different name.
check('a pool that clears Moonshot Lite (15k) but not full Moonshot (50k) builds a Lite variant, and is correctly rejected at the Moonshot floor', () => {
  const pool = makeFakePool(30, 1.4); // 1.4^30 ~= 29,960x — clears 15k, fails 50k
  const cfg = { ...DEFAULT_CONFIG };
  const exposureLite = makeExposureTracker(cfg);
  const liteResult = buildCategoryVariants(pool, 'Moonshot Lite', 30, 5, cfg, exposureLite, 12, cfg.moonshotLiteMinOdds);
  assert.ok(liteResult.activeCount >= 1, `expected >=1 Moonshot Lite variant from a ~29,960x pool, got activeCount=${liteResult.activeCount}`);
  for (const picks of liteResult.picksByVariant) {
    const odds = computeOdds(picks);
    assert.ok(odds >= cfg.moonshotLiteMinOdds, `every Moonshot Lite variant must clear ${cfg.moonshotLiteMinOdds} — got ${odds}`);
  }
  const exposureFull = makeExposureTracker(cfg);
  const fullResult = buildCategoryVariants(pool, 'Moonshot', 30, 5, cfg, exposureFull, 12, cfg.moonshotMinOdds);
  assert.strictEqual(fullResult.activeCount, 0, `REGRESSION: the same ~29,960x pool must NOT clear the full Moonshot (50k) floor — got activeCount=${fullResult.activeCount}. If this fails, a Lite-tier pool could be mislabeled as full Moonshot.`);
});

check('a pool too thin for Lite but deep enough for Moonshot Mini (5k) builds a Mini variant, and is correctly rejected at the Lite floor', () => {
  const pool = makeFakePool(26, 1.4); // 1.4^26 ~= 6,300x — clears 5k, fails 15k
  const cfg = { ...DEFAULT_CONFIG };
  const exposureMini = makeExposureTracker(cfg);
  const miniResult = buildCategoryVariants(pool, 'Moonshot Mini', 26, 5, cfg, exposureMini, 12, cfg.moonshotMiniMinOdds);
  assert.ok(miniResult.activeCount >= 1, `expected >=1 Moonshot Mini variant from a ~6,300x pool, got activeCount=${miniResult.activeCount}`);
  for (const picks of miniResult.picksByVariant) {
    const odds = computeOdds(picks);
    assert.ok(odds >= cfg.moonshotMiniMinOdds, `every Moonshot Mini variant must clear ${cfg.moonshotMiniMinOdds} — got ${odds}`);
  }
  const exposureLite = makeExposureTracker(cfg);
  const liteResult = buildCategoryVariants(pool, 'Moonshot Lite', 26, 5, cfg, exposureLite, 12, cfg.moonshotLiteMinOdds);
  assert.strictEqual(liteResult.activeCount, 0, `REGRESSION: the same ~6,300x pool must NOT clear the Moonshot Lite (15k) floor — got activeCount=${liteResult.activeCount}. If this fails, a Mini-tier pool could be mislabeled as Lite.`);
});

// ── v19 §1 — the "audit every other category label" ask. Same harness,
// same guard (buildCategoryVariants + emitVariants), applied to the
// Tier 1-4 (Section B) floors so a future refactor touching the shared
// labeling/emission path can't silently break those either.
check('Tier 1 (1,000x floor): a pool that cannot reach it produces ZERO Tier 1 variants', () => {
  const pool = makeFakePool(21, 1.25); // 1.25^21 ~= 146x, nowhere near 1,000x
  const cfg = { ...DEFAULT_CONFIG };
  const exposure = makeExposureTracker(cfg);
  const result = buildCategoryVariants(pool, 'Tier 1', 21, 5, cfg, exposure, undefined, 1000);
  assert.strictEqual(result.activeCount, 0, `REGRESSION: Tier 1 built from a ~146x pool — got activeCount=${result.activeCount}`);
});
check('Tier 1 (1,000x floor): a pool that CAN clear it builds, and every variant clears 1,000x', () => {
  const pool = makeFakePool(21, 1.4); // 1.4^21 ~= 1,590x
  const cfg = { ...DEFAULT_CONFIG };
  const exposure = makeExposureTracker(cfg);
  const result = buildCategoryVariants(pool, 'Tier 1', 21, 5, cfg, exposure, undefined, 1000);
  assert.ok(result.activeCount >= 1, `expected >=1 Tier 1 variant, got activeCount=${result.activeCount}`);
  for (const picks of result.picksByVariant) {
    const odds = computeOdds(picks);
    assert.ok(odds >= 1000, `every Tier 1 variant must clear 1,000x — got ${odds}`);
  }
});
check('Tier 4 MEGA (1,000,000x floor): a pool that clears Tier 3 (100k) but not Tier 4 is correctly rejected at Tier 4', () => {
  const thinPool = makeFakePool(35, 1.4); // 1.4^35 ~= 243,000x — clears Tier 3 (100k), fails Tier 4 (1M)
  const cfg = { ...DEFAULT_CONFIG };
  const exposureT3 = makeExposureTracker(cfg);
  const t3 = buildCategoryVariants(thinPool, 'Tier 3', 35, 5, cfg, exposureT3, undefined, 100000);
  assert.ok(t3.activeCount >= 1, `expected the ~243,000x pool to clear Tier 3 (100k) — got activeCount=${t3.activeCount}`);
  const exposureT4 = makeExposureTracker(cfg);
  const t4 = buildCategoryVariants(thinPool, 'Tier 4 (MEGA)', 35, 5, cfg, exposureT4, undefined, 1000000);
  assert.strictEqual(t4.activeCount, 0, `REGRESSION: the same ~243,000x pool must NOT clear Tier 4's 1,000,000x floor — got activeCount=${t4.activeCount}`);
});

// ── v19 §1 — Mix / Max Builder / Consensus don't go through
// buildCategoryVariants at all (no diversification needed for a
// single-ticket builder) — their only safety net is generateTicketCode's
// own default `minOdds` parameter (the universal floor). Test that
// chokepoint directly: below-floor picks must be rejected (return null)
// BEFORE any network call — proven here by using deliberately-fake
// eventIds that would blow up if the request ever actually went out.
check('generateTicketCode (the universal chokepoint Mix/Max Builder/Consensus all rely on) rejects picks below the universal floor without a network call', async () => {
  const belowFloorPicks = [
    { eventId: 'fakeA', marketId: '1', outcomeId: '1', odds: 1.05, sportId: 'sr:sport:1' },
    { eventId: 'fakeB', marketId: '1', outcomeId: '1', odds: 1.05, sportId: 'sr:sport:1' },
    { eventId: 'fakeC', marketId: '1', outcomeId: '1', odds: 1.05, sportId: 'sr:sport:1' },
  ]; // combined ~1.16x — nowhere near the 100x universal floor
  const code = await engine.generateTicketCode(belowFloorPicks, null);
  assert.strictEqual(code, null, `REGRESSION: generateTicketCode returned a code for ~1.16x combined odds — the universal floor chokepoint is not rejecting before the network call`);
});

(async () => {
  console.log('test-moonshot-floor.js\n');
  for (const { name, fn } of checks) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.error('  ✗', name, '—', e.message); }
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
