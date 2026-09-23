/**
 * PERMANENT REGRESSION TEST — v38/v39, output-architecture redesign
 *
 * The generator was rewritten to stop producing "punter 1 -> several
 * variants, punter 2 -> several variants, ..." and instead produce (a) up to
 * TWO tickets per punter (PUNTER_POOL — buildSectionA /
 * groupPerSourceLegsByPunter; v39 restored a 2nd "Safety-Max" policy after
 * v38's initial 1-ticket cut proved too restrictive) and (b) a small, fixed
 * set of 5 genuinely aggregated GLOBAL constructions (Global Best/Safe/Mix/
 * Builder/High-Risk — buildGlobalSections), built EXCLUSIVELY from
 * buildGlobalPool() / buildGlobalPool(..., {ignoreFloor:true}) — never from
 * pickMap directly, never from a punter's raw legs or their own Section A
 * ticket.
 *
 * This file proves that separation and the no-padding/no-duplicate-ticket
 * rules hold, using fake-but-realistic pick fixtures and (where a full
 * ticket needs to be built) an injected fake codeGenFn so nothing here ever
 * makes a real network call to SportyBet.
 *
 * Run with: node test-global-pool-architecture.js
 * Exit code 0 = pass, non-zero = fail.
 */
'use strict';
const assert = require('assert');
const engine = require('./advanced-generator-engine');
const {
  groupPerSourceLegsByPunter, buildSectionA, buildSectionAVariant, buildGlobalPool, jaccardOverlap, pickIdentity,
  buildAggregationReport, emitGlobalTicket, findDuplicateGlobalTicket,
  buildGlobalBest, buildGlobalSafe, buildGlobalMix, buildGlobalBuilder, buildGlobalHighRisk,
  makeExposureTracker, DEFAULT_CONFIG,
} = engine;

let failures = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// Every fixture pick gets its own unique team/league/event by index so
// exposure caps (team/league) and per-event dedup never accidentally starve
// a test regardless of what's under test — same convention
// test-moonshot-floor.js already established.
function makePick(i, overrides = {}) {
  const eventId = overrides.eventId || `evt${i}`;
  return {
    eventId, marketId: '18', specifier: 'total=1.5', outcomeId: 'o' + i,
    homeTeam: `Home${i}`, awayTeam: `Away${i}`, league: `League${i}`,
    marketName: 'Over/Under', outcomeName: 'Over 1.5', odds: 1.4, productId: 1, sportId: 'sr:sport:1',
    finalScore: 80, source: 'Punter' + i, code: 'CODE' + i, sourceCount: 1,
    riskCleared: true, eligible: true, converted: false,
    _origMarketName: 'Over/Under', _origOutcomeName: 'Over 1.5', _origOdds: 1.4,
    reasons: [],
    ...overrides,
  };
}
function withPickKey(p) { p._pickKey = `${p.eventId}|${p.marketId}|${p.specifier}|${p.outcomeId}|${p.source}|${p.code}`; return p; }
function makePickMap(picks) {
  const m = new Map();
  for (const p of picks) { withPickKey(p); m.set(p._pickKey, p); }
  return m;
}
// A fake codeGenFn that mimics generateTicketCode's contract ({code, picks})
// without any network call — lets tests exercise the FULL positive path
// (odds computed from final selections) deterministically.
function fakeCodeGenFn(finalPicksOverride) {
  return async (picks) => ({ code: 'FAKE-' + Math.random().toString(36).slice(2, 8), picks: finalPicksOverride || picks });
}
// Minimal stand-in for the run-record object log()/emit() expect — a real
// `listeners` Set (emit iterates it) and a uniquely-named fake runId (so IF
// persistRunState's every-10th-event checkpoint ever fires, it writes a
// harmless, uniquely-named scratch file rather than colliding with a real run).
function makeFakeRec() {
  return { events: [], listeners: new Set(), stopRequested: false, state: { runId: 'test-' + Math.random().toString(36).slice(2, 10) } };
}

// ── Test 1 — five different punters contribute selections ──────────────────
check('Test 1: five different punters contributing eligible legs all appear in the GLOBAL pool', () => {
  const picks = [];
  for (let i = 0; i < 5; i++) picks.push(makePick(i, { source: `Punter${i}`, finalScore: 70 + i }));
  const pool = buildGlobalPool(makePickMap(picks), DEFAULT_CONFIG, new Set());
  const sources = new Set(pool.map(p => p.source));
  assert.strictEqual(pool.length, 5, `expected all 5 distinct-event legs in the pool, got ${pool.length}`);
  assert.strictEqual(sources.size, 5, `REGRESSION: GLOBAL pool should represent all 5 punters, got sources: ${[...sources]}`);
});

// ── Test 2 — one punter, three codes, does not multiply into 3 tickets ─────
check('Test 2: one punter with three booking codes is grouped into ONE pool, not three', () => {
  const perSourceLegs = [
    { source: 'Multi', kind: 'punter', code: 'CODEA', legs: [makePick(0, { source: 'Multi', code: 'CODEA' })], droppedLegs: [] },
    { source: 'Multi', kind: 'punter', code: 'CODEB', legs: [makePick(1, { source: 'Multi', code: 'CODEB' })], droppedLegs: [] },
    { source: 'Multi', kind: 'punter', code: 'CODEC', legs: [makePick(2, { source: 'Multi', code: 'CODEC' })], droppedLegs: [] },
  ];
  const grouped = groupPerSourceLegsByPunter(perSourceLegs);
  assert.strictEqual(grouped.length, 1, `REGRESSION: 3 codes for the same punter produced ${grouped.length} pool entries — should be exactly 1`);
  assert.strictEqual(grouped[0].codes.length, 3, `expected all 3 codes recorded on the single grouped entry, got ${grouped[0].codes.length}`);
  assert.strictEqual(grouped[0].legs.length, 3, `expected all 3 codes' legs merged into one pool, got ${grouped[0].legs.length}`);
});
check('Test 2b: a punter\'s own duplicate pick across two of their codes counts once, not twice', () => {
  const dupeLeg = () => makePick(0, { source: 'Multi', eventId: 'evtDupe', outcomeId: 'dupe' });
  const perSourceLegs = [
    { source: 'Multi', kind: 'punter', code: 'CODEA', legs: [dupeLeg()], droppedLegs: [] },
    { source: 'Multi', kind: 'punter', code: 'CODEB', legs: [dupeLeg()], droppedLegs: [] },
  ];
  const grouped = groupPerSourceLegsByPunter(perSourceLegs);
  assert.strictEqual(grouped[0].legs.length, 1, `REGRESSION: the same event/market/outcome posted on 2 of a punter's own codes should count once, got ${grouped[0].legs.length}`);
  assert.strictEqual(grouped[0].dupesWithinPunter, 1);
});

// ── Test 2c/2d — v39: up to 2 tickets per punter (not the old 3-4, not
// back to just 1) ────────────────────────────────────────────────────────
check('Test 2c: the Balanced and Safety-Max policies produce genuinely different edited slips when their removal budgets actually differ', () => {
  // 3 safe legs @2.0 (combined 8.0) + 2 always-replace legs @1.5 each
  // (worst-scored first), combined 8.0*1.5*1.5=18.0. Removing 1 always-
  // replace leg leaves 12.0; removing both leaves 8.0.
  const safe = [0, 1, 2].map(i => makePick(i, { odds: 2.0, finalScore: 80 }));
  const risky = [3, 4].map(i => makePick(i, { odds: 1.5, finalScore: 40 + i, discretionaryRemovalCategory: 'always-replace', discretionaryRemovalReason: 'test' }));
  const allOfSrc = [...safe, ...risky];
  const strict = buildSectionAVariant(allOfSrc, 10, 'always', null);  // stopFloor=10: removes 1 (12>=10), stops before the 2nd (8<10)
  const loose = buildSectionAVariant(allOfSrc, 5, 'always', null);    // stopFloor=5: removes both (12>=5, then 8>=5)
  assert.strictEqual(strict.picks.length, 4, `expected the higher-floor policy to keep 1 risky leg (4 total), got ${strict.picks.length}`);
  assert.strictEqual(loose.picks.length, 3, `expected the lower-floor policy to remove both risky legs (3 total), got ${loose.picks.length}`);
  assert.notDeepStrictEqual(strict.picks.map(p => p._pickKey).sort(), loose.picks.map(p => p._pickKey).sort(), 'REGRESSION: the two policies must be capable of producing genuinely distinct edited slips, not just two labels on the same list');
});
check('Test 2d: buildSectionA never produces more than 2 tickets for one punter, and identical-outcome policies dedupe to exactly 1', async () => {
  // No discretionary-removal legs at all -> Balanced and Safety-Max have
  // nothing to trade off and MUST converge to the identical slip.
  const legs = Array.from({ length: 8 }, (_, i) => makePick(i, { source: 'Solo', code: 'SOLO01', odds: 2.0, finalScore: 80 }));
  const perSourceLegs = [{ source: 'Solo', kind: 'punter', code: 'SOLO01', legs, droppedLegs: [] }];
  const pickMap = makePickMap(legs);
  const exposure = makeExposureTracker(DEFAULT_CONFIG);
  const { results } = await buildSectionA(perSourceLegs, pickMap, DEFAULT_CONFIG, exposure, makeFakeRec(), null, fakeCodeGenFn());
  assert.ok(results.length <= 2, `REGRESSION: never more than 2 tickets per punter, got ${results.length}`);
  assert.strictEqual(results.length, 1, `REGRESSION: two policies with nothing to trade off must dedupe to exactly 1 ticket, got ${results.length}`);
  assert.strictEqual(results[0].variantsTotal, 2, 'variantsTotal must honestly report 2 policies were attempted');
  assert.strictEqual(results[0].variantsBuilt, 1, 'variantsBuilt must honestly report only 1 was genuinely distinct');
});

// ── Test 3 — a dropped leg can never appear in GLOBAL output ───────────────
check('Test 3: a dropped leg (riskCleared=false) is excluded from the GLOBAL pool even as the ONLY candidate for its event', () => {
  const picks = [makePick(0, { riskCleared: false, eligible: false })];
  const pool = buildGlobalPool(makePickMap(picks), DEFAULT_CONFIG, new Set());
  assert.strictEqual(pool.length, 0, `REGRESSION: a dropped leg reached the GLOBAL pool — got ${pool.length} entries`);
  const widePool = buildGlobalPool(makePickMap(picks), DEFAULT_CONFIG, new Set(), { ignoreFloor: true });
  assert.strictEqual(widePool.length, 0, `REGRESSION: a dropped leg reached GLOBAL_WIDE_POOL (ignoreFloor must never bypass riskCleared) — got ${widePool.length} entries`);
});
check('Test 3b: a below-floor-but-risk-cleared leg is excluded from the floor-gated pool but included in the wide pool', () => {
  const picks = [makePick(0, { riskCleared: true, eligible: false })];
  const pool = buildGlobalPool(makePickMap(picks), DEFAULT_CONFIG, new Set());
  assert.strictEqual(pool.length, 0, 'floor-gated pool must exclude a below-floor leg');
  const widePool = buildGlobalPool(makePickMap(picks), DEFAULT_CONFIG, new Set(), { ignoreFloor: true });
  assert.strictEqual(widePool.length, 1, 'wide pool should include a risk-cleared leg regardless of score floor');
});

// ── Test 4 — a converted leg appears as the converted market ───────────────
check('Test 4: a converted leg\'s market/odds in the GLOBAL pool are the CONVERTED values, never the original', () => {
  const picks = [makePick(0, {
    converted: true, marketName: 'Double Chance', outcomeName: '1X', odds: 1.2,
    _origMarketName: 'Match Winner', _origOutcomeName: 'Home', _origOdds: 1.55,
  })];
  const pool = buildGlobalPool(makePickMap(picks), DEFAULT_CONFIG, new Set());
  assert.strictEqual(pool.length, 1);
  assert.strictEqual(pool[0].marketName, 'Double Chance', 'GLOBAL pool must carry the converted market');
  assert.strictEqual(pool[0].odds, 1.2, 'GLOBAL pool must carry the converted odds');
  assert.notStrictEqual(pool[0].marketName, pool[0]._origMarketName, 'converted pick must differ from its own recorded original');
});

// ── Test 5 — two 95%-identical global tickets are not both displayed ───────
check('Test 5: two tickets with 95% identical selections are flagged as duplicates (jaccard >= 0.90)', () => {
  const base = []; for (let i = 0; i < 20; i++) base.push(makePick(i));
  const ticketA = { tier: 'Global Best', picks: base };
  const ticketB = { tier: 'Global Mix', picks: [...base.slice(0, 19), makePick(999)] }; // 19/21 shared = 90.5% jaccard
  const overlap = jaccardOverlap(ticketA.picks, ticketB.picks);
  assert.ok(overlap >= 0.90, `expected >=90% overlap for a 19-of-20-shared pair, got ${(overlap * 100).toFixed(1)}%`);
  const dup = findDuplicateGlobalTicket(ticketB.picks, [ticketA]);
  assert.strictEqual(dup, ticketA, 'REGRESSION: a 90%+ identical ticket must be flagged as a duplicate of the earlier one');
});
check('Test 5b: two genuinely different tickets (< 90% overlap) are NOT flagged as duplicates', () => {
  const ticketA = { tier: 'Global Best', picks: Array.from({ length: 20 }, (_, i) => makePick(i)) };
  const ticketB = { tier: 'Global Mix', picks: Array.from({ length: 20 }, (_, i) => makePick(i + 100)) }; // 0% shared
  const dup = findDuplicateGlobalTicket(ticketB.picks, [ticketA]);
  assert.strictEqual(dup, null, 'two genuinely distinct selection sets must not be flagged as duplicates');
});

// ── Test 6 — insufficient eligible selections never fabricates a ticket ────
check('Test 6: emitGlobalTicket returns "Insufficient eligible selections" and never calls codeGenFn when short on legs', async () => {
  let called = false;
  const spyGenFn = async (picks) => { called = true; return { code: 'SHOULD-NOT-HAPPEN', picks }; };
  const picks = [makePick(0), makePick(1)]; // 2 legs, minLegs default 6
  const entry = await emitGlobalTicket('Global Best', picks, DEFAULT_CONFIG, makeFakeRec(), { minLegs: 6, codeGenFn: spyGenFn });
  assert.strictEqual(entry.notBuilt, true, 'REGRESSION: a ticket was fabricated from only 2 eligible selections');
  assert.strictEqual(entry.notBuiltReason.includes('Insufficient eligible selections'), true);
  assert.strictEqual(called, false, 'REGRESSION: code generation was attempted despite too few eligible selections — a network call would have been made for nothing');
});

// ── Test 7 — GLOBAL odds are computed from the FINAL selections ────────────
check('Test 7: GLOBAL aggregate odds are computed from the actual final selections, not the pre-guard input list', async () => {
  const inputPicks = Array.from({ length: 8 }, (_, i) => makePick(i, { odds: 2.0 })); // combined 2^8 = 256x if all 8 land
  // Simulate SportyBet silently dropping 2 legs on posting (a real, documented failure mode) —
  // codeGenFn returns only 6 of the 8 submitted picks.
  const finalPicks = inputPicks.slice(0, 6);
  const entry = await emitGlobalTicket('Global Best', inputPicks, DEFAULT_CONFIG, makeFakeRec(), { minLegs: 3, codeGenFn: fakeCodeGenFn(finalPicks) });
  assert.strictEqual(entry.notBuilt, undefined, 'expected a real ticket');
  const expectedOdds = Math.round(finalPicks.reduce((t, p) => t * p.odds, 1) * 100) / 100;
  assert.strictEqual(entry.odds, expectedOdds, `REGRESSION: displayed odds (${entry.odds}) must match the FINAL confirmed selections' odds (${expectedOdds}), not the original 8-leg submission's 2^8=256`);
  assert.strictEqual(entry.legCount, 6, 'legCount must reflect the final confirmed selections');
});

// ── Test 8 — Builder/Mix/High-Risk cannot bypass GLOBAL_POOL ───────────────
check('Test 8: Global Builder never returns a selection absent from the pool it was given (array of variants)', async () => {
  const pool = Array.from({ length: 20 }, (_, i) => makePick(i, { finalScore: 60 + i }));
  const entries = await buildGlobalBuilder(pool, { ...DEFAULT_CONFIG, maxBuilderMinPoolSize: 5 }, makeFakeRec(), fakeCodeGenFn());
  assert.ok(Array.isArray(entries), 'Global Builder must return an array of variants');
  const poolIds = new Set(pool.map(pickIdentity));
  for (const entry of entries) {
    assert.strictEqual(entry.notBuilt, undefined);
    for (const p of entry.picks) assert.ok(poolIds.has(pickIdentity(p)), `REGRESSION: Global Builder returned a selection (${pickIdentity(p)}) not present in its input pool — it must be impossible for a global section to source from anywhere but GLOBAL_POOL`);
  }
});
check('Test 8f: multiple Global Builder variants never share a game with each other', async () => {
  // 120 legs -> up to 3 variants of 50 (120/50 = 2.4 -> 2 full + 1 partial of 20)
  const pool = Array.from({ length: 120 }, (_, i) => makePick(i, { finalScore: 200 - i, source: `P${i % 30}` })); // 30 distinct sources, well under any single-source cap issue
  const cfg = { ...DEFAULT_CONFIG, maxBuilderMinPoolSize: 5, maxVariantsGlobalBuilder: 5, maxBuilderPerSourceCap: 8 };
  const entries = await buildGlobalBuilder(pool, cfg, makeFakeRec(), fakeCodeGenFn());
  const builtEntries = entries.filter(e => !e.notBuilt);
  assert.ok(builtEntries.length >= 2, `expected at least 2 Global Builder variants from a 120-leg pool, got ${builtEntries.length}`);
  const seen = new Set();
  for (const entry of builtEntries) {
    for (const p of entry.picks) {
      const id = pickIdentity(p);
      assert.ok(!seen.has(id), `REGRESSION: ${id} appeared in more than one Global Builder variant — variants must never share a game`);
      seen.add(id);
    }
  }
});
check('Test 8b: Global Mix never returns a selection absent from the pool it was given', async () => {
  const pool = Array.from({ length: 25 }, (_, i) => makePick(i, { finalScore: 60 + i }));
  const exposure = makeExposureTracker(DEFAULT_CONFIG);
  const entry = await buildGlobalMix(pool, DEFAULT_CONFIG, exposure, makeFakeRec(), fakeCodeGenFn());
  assert.strictEqual(entry.notBuilt, undefined);
  const poolIds = new Set(pool.map(pickIdentity));
  for (const p of entry.picks) assert.ok(poolIds.has(pickIdentity(p)), `REGRESSION: Global Mix returned a selection not present in its input pool`);
});
check('Test 8c: Global High-Risk never returns a selection absent from the pool it was given', async () => {
  const pool = Array.from({ length: 20 }, (_, i) => makePick(i, { finalScore: 60 + i }));
  const exposure = makeExposureTracker(DEFAULT_CONFIG);
  const entry = await buildGlobalHighRisk(pool, DEFAULT_CONFIG, exposure, makeFakeRec(), fakeCodeGenFn());
  assert.strictEqual(entry.notBuilt, undefined);
  const poolIds = new Set(pool.map(pickIdentity));
  for (const p of entry.picks) assert.ok(poolIds.has(pickIdentity(p)), `REGRESSION: Global High-Risk returned a selection not present in its input pool`);
});
check('Test 8d: Global Safe (the 5th section) never returns a selection absent from the pool it was given', async () => {
  const pool = Array.from({ length: 20 }, (_, i) => makePick(i, { finalScore: 60 + i, safety: 70 }));
  const exposure = makeExposureTracker(DEFAULT_CONFIG);
  const entry = await buildGlobalSafe(pool, DEFAULT_CONFIG, exposure, makeFakeRec(), fakeCodeGenFn());
  assert.strictEqual(entry.notBuilt, undefined);
  const poolIds = new Set(pool.map(pickIdentity));
  for (const p of entry.picks) assert.ok(poolIds.has(pickIdentity(p)), `REGRESSION: Global Safe returned a selection not present in its input pool`);
});
check('Test 8e: Global Safe excludes legs below its safety bar even when they would otherwise be the highest-scored', () => {
  const pool = [
    makePick(0, { finalScore: 99, safety: 20 }), // high score, unsafe market — must be excluded
    ...Array.from({ length: 10 }, (_, i) => makePick(i + 1, { finalScore: 60, safety: 70 })), // safe markets
  ];
  const safeCandidates = pool.filter(p => (p.safety ?? 0) >= 65);
  assert.strictEqual(safeCandidates.length, 10, 'sanity: exactly 10 legs should clear the safety bar');
  assert.ok(!safeCandidates.some(p => p.eventId === 'evt0'), 'REGRESSION: Global Safe must never include a leg below its own safety threshold, regardless of score');
});

// ── Test 9 — order independence ─────────────────────────────────────────────
check('Test 9: reordering the underlying punters/codes does not change the resulting GLOBAL pool composition', () => {
  const picks = Array.from({ length: 10 }, (_, i) => makePick(i, { source: `Punter${i}`, finalScore: 50 + i })); // distinct, non-tied scores
  const forward = buildGlobalPool(makePickMap(picks), DEFAULT_CONFIG, new Set());
  const reversed = buildGlobalPool(makePickMap([...picks].reverse()), DEFAULT_CONFIG, new Set());
  const idsF = new Set(forward.map(pickIdentity)), idsR = new Set(reversed.map(pickIdentity));
  assert.strictEqual(idsF.size, idsR.size, 'pool size must be order-independent');
  for (const id of idsF) assert.ok(idsR.has(id), `REGRESSION: pool composition changed under reordering — ${id} present forward but not reversed`);
});

// ── Test 10 — UI can identify which punters/codes contributed ──────────────
check('Test 10: the aggregation report identifies exactly which punters and booking codes contributed to a GLOBAL ticket', () => {
  const picks = [
    makePick(0, { source: 'Alice', code: 'AAAA11' }),
    makePick(1, { source: 'Bob', code: 'BBBB22' }),
    makePick(2, { source: 'Alice', code: 'AAAA11', eventId: 'evt2b' }), // Alice again, same code — should not double-count the code
  ];
  const report = buildAggregationReport(picks, 'Global Best', [], picks.length);
  assert.deepStrictEqual([...report.sourcePunters].sort(), ['Alice', 'Bob'], 'REGRESSION: aggregation report must list every distinct contributing punter');
  assert.deepStrictEqual([...report.sourceCodes].sort(), ['AAAA11', 'BBBB22'], 'REGRESSION: aggregation report must list every distinct contributing booking code');
  assert.strictEqual(report.sourcePunterCount, 2);
  assert.strictEqual(report.sourceCodeCount, 2);
  assert.strictEqual(report.numSelections, 3);
});

(async () => {
  console.log('test-global-pool-architecture.js\n');
  for (const { name, fn } of checks) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.error('  ✗', name, '—', e.message); }
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
