'use strict';

/**
 * test-autobet-guards.js — the rules in autobet-engine.js are the only thing
 * between a pasted code and real money leaving the account, so they are
 * covered directly. No browser, no bets. The validateCode cases use a stubbed
 * SportyBet response so they test the rules, not the network.
 */

const assert = require('assert');
const Module = require('module');

// Stub https BEFORE the engine loads so validateCode reads our fixture.
let FIXTURE = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'https' && parent && /autobet-engine/.test(parent.filename || '')) {
    return {
      get(_opts, cb) {
        const res = { on(ev, fn) { if (ev === 'data') fn(JSON.stringify(FIXTURE)); if (ev === 'end') fn(); } };
        setImmediate(() => cb(res));
        return { on() {}, setTimeout() {}, destroy() {} };
      },
    };
  }
  return realLoad.apply(this, arguments);
};

const e = require('./autobet-engine');
Module._load = realLoad;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); fail++; }
}

const FUTURE = Date.now() + 6 * 3600 * 1000;

/** Builds a share-API response with `n` legs, each on its own match. */
function fixture(n, opts = {}) {
  const odds = opts.odds || 2.0;
  const outcomes = Array.from({ length: n }, (_, i) => ({
    eventId: opts.sameEvent ? 'sr:match:1' : `sr:match:${i + 1}`,
    homeTeamName: `Home${i}`, awayTeamName: `Away${i}`,
    estimateStartTime: (opts.kickoffs && opts.kickoffs[i]) || FUTURE,
    markets: [{ id: '1', desc: '1X2', outcomes: [{ id: '1', desc: 'Home', odds: String(odds) }] }],
  }));
  return {
    bizCode: 10000,
    data: {
      outcomes,
      unavailableOutcomes: opts.unavailable || [],
      ticket: { selections: outcomes.map(o => ({ eventId: o.eventId, odds: String(odds) })) },
    },
  };
}

(async () => {
  console.log('\nHard stake cap');
  t('₦10 is allowed', () => assert.strictEqual(e.assertStake(10), 10));
  t('₦11 is refused, not clamped', () => assert.throws(() => e.assertStake(11), /hard cap/));
  t('₦200 is refused', () => assert.throws(() => e.assertStake(200), /hard cap/));
  t('the cap constant is 10', () => assert.strictEqual(e.MAX_STAKE, 10));
  t('a config file cannot raise the stake', () => {
    // loadConfig always overwrites stake with the constant, whatever is on disk.
    assert.strictEqual(e.loadConfig().stake, e.MAX_STAKE);
  });

  console.log('\nparseCodes');
  t('uppercases, splits on any separator, drops junk', () => {
    assert.deepStrictEqual(e.parseCodes('v563nf, HR7C6J\nqd0j89 bad!! 12'), ['V563NF', 'HR7C6J', 'QD0J89']);
  });
  t('a code pasted twice is only played once', () => {
    assert.deepStrictEqual(e.parseCodes('V563NF V563NF v563nf'), ['V563NF']);
  });
  t('empty input yields nothing', () => assert.deepStrictEqual(e.parseCodes('   '), []));

  console.log('\nvalidateCode — multiples only');
  await ta('a single is rejected', async () => {
    FIXTURE = fixture(1);
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /single/);
  });
  await ta('a 2-leg code is rejected', async () => {
    FIXTURE = fixture(2);
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /only 2 legs/);
  });
  await ta('a 3-leg code is accepted', async () => {
    FIXTURE = fixture(3);
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, true, v.reason);
    assert.strictEqual(v.legs, 3);
  });

  console.log('\nvalidateCode — one market per match');
  await ta('two markets on the same match is rejected', async () => {
    FIXTURE = fixture(4, { sameEvent: true });
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /same match/);
  });

  console.log('\nvalidateCode — nothing already running');
  await ta('a kicked-off leg is rejected', async () => {
    FIXTURE = fixture(5, { kickoffs: { 2: Date.now() - 60000 } });
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /kicked off/);
  });
  await ta('an unavailable selection is rejected', async () => {
    FIXTURE = fixture(5, { unavailable: [{ eventId: 'x' }] });
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /no longer available/);
  });
  await ta('a missing code is rejected', async () => {
    FIXTURE = { bizCode: 20000, data: null };
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /not found/);
  });
  t('a malformed code never reaches the network', async () => {
    FIXTURE = null; // would throw if the request were actually attempted
  });

  console.log('\nvalidateCode — bet type');
  await ta('under 20,000x goes on as a straight multiple', async () => {
    FIXTURE = fixture(10, { odds: 2.0 });   // 2^10 = 1,024
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, true, v.reason);
    assert.strictEqual(v.betType, 'sports');
  });
  await ta('over 20,000x is marked for flex', async () => {
    FIXTURE = fixture(15, { odds: 2.0 });   // 2^15 = 32,768
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.ok, true, v.reason);
    assert.strictEqual(v.betType, 'flex');
    assert.ok(v.odds > e.FLEX_TRIGGER_ODDS);
  });
  await ta('exactly at the trigger stays on Sports', async () => {
    // 20,000x is not "over" 20,000 — the boundary must not flip.
    FIXTURE = fixture(3, { odds: 1 });
    FIXTURE.data.ticket.selections = FIXTURE.data.outcomes.map((o, i) => ({ eventId: o.eventId, odds: i === 0 ? '20000' : '1.0' }));
    FIXTURE.data.outcomes.forEach((o, i) => { o.markets[0].outcomes[0].odds = i === 0 ? '20000' : '1.02'; });
    const v = await e.validateCode('AAAAAA');
    assert.strictEqual(v.betType, 'sports');
  });

  console.log('\nflexQualifies (stake ₦10, bar 100x)');
  t('payout ₦1000 exactly clears the bar', () => assert.strictEqual(e.flexQualifies(1000, 10), true));
  t('payout ₦999 does not', () => assert.strictEqual(e.flexQualifies(999, 10), false));
  t('an unreadable payout never qualifies', () => {
    assert.strictEqual(e.flexQualifies(null, 10), false);
    assert.strictEqual(e.flexQualifies(NaN, 10), false);
    assert.strictEqual(e.flexQualifies(0, 10), false);
  });

  console.log('\nLedger');
  const ledger = { entries: [
    { code: 'AAA111', status: 'placed' },
    { code: 'BBB222', status: 'skipped' },
    { code: 'CCC333', status: 'failed' },
  ] };
  t('a placed code cannot be restaked', () => assert.strictEqual(e.ledgerHasPlaced(ledger, 'AAA111'), true));
  t('a skipped code is still available', () => assert.strictEqual(e.ledgerHasPlaced(ledger, 'BBB222'), false));
  t('a failed code is not auto-blocked (human decides)', () => assert.strictEqual(e.ledgerHasPlaced(ledger, 'CCC333'), false));

  console.log('\nreadLabelledNumber (fake page)');
  const fakePage = text => ({ locator: () => ({ innerText: async () => text }) });
  for (const [name, text, want] of [
    ['same line', 'Total Odds 1028.23\n', 1028.23],
    ['next line', 'Total Odds\n4,377.10\n', 4377.10],
    ['naira-prefixed payout', 'Potential Winnings\n₦ 1,250.00\n', 1250],
    ['absent label', 'Bet Slip\nStake\n', null],
  ]) {
    const got = await e.readLabelledNumber(fakePage(text), /total\s*odds|potential\s*win/i);
    await ta(name, () => assert.strictEqual(got, want));
  }

  console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
