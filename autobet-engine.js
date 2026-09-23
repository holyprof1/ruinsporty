'use strict';

/**
 * autobet-engine.js — SportyBet auto-placement core (LOCAL/DEV ONLY)
 *
 * Single source of truth for every rule that can move money. The CLI
 * (sporty-autobet.js) and the admin "Auto-Bet" tab both delegate here, so
 * there is exactly one implementation of "what are we allowed to place".
 *
 * ── THE HARD RULES ───────────────────────────────────────────────────────
 * These are constants, not config, and nothing in the UI or CLI can raise
 * them. The user's instruction was "never", so they are not parameters:
 *
 *   MAX_STAKE        ₦10 per code, always. A larger request is an error,
 *                    not a clamp — silently staking less than asked is its
 *                    own kind of wrong, so we refuse instead.
 *   MIN_LEGS         3. No singles, no two-leg codes. Multiples only.
 *   ONE MARKET/MATCH A code with two selections on the same match is
 *                    rejected outright — SportyBet cannot accumulate them
 *                    anyway, so the slip that loads is never the slip that
 *                    was analysed.
 *   NO LIVE LEGS     Any leg already kicked off ⇒ reject. Odds returned by
 *                    the share API decay after kickoff (see the settled-odds
 *                    contamination finding), so both the price and the bet
 *                    would be wrong.
 *
 * ── FLEX ─────────────────────────────────────────────────────────────────
 * Default bet type is a straight multiple ("Sports"). A code priced over
 * FLEX_TRIGGER_ODDS is heavy enough that a cut is worth more than the tail:
 * we ask SportyBet for the flex payout at cut 3, then 2, then 1, and take
 * the largest cut that still returns at least FLEX_MIN_ODDS. If flexing
 * cannot clear that bar, it goes on as a straight multiple instead.
 *
 * The flex payout is READ FROM SPORTYBET'S OWN BETSLIP, never estimated.
 * Their reduction factors are not public and a guessed formula would be a
 * confident lie about money. If the flex payout cannot be read, the code is
 * SKIPPED rather than placed on the wrong bet type.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = __dirname;
const SESSION_DIR = path.join(ROOT, '.sporty-session');
const SHOT_DIR = path.join(ROOT, 'autobet-screenshots');
const LEDGER = path.join(ROOT, 'data', '_autobet-ledger.json');
const CONFIG_FILE = path.join(ROOT, 'sporty-autobet.config.json');

const BASE = 'https://www.sportybet.com/ng/';

// ─── Hard rules ───────────────────────────────────────────────────────────────
const MAX_STAKE = 10;            // naira, per code. Absolute.
const MIN_LEGS = 3;              // multiples only
const FLEX_TRIGGER_ODDS = 20000; // above this, consider cutting
const FLEX_MIN_ODDS = 100;       // a cut must still return at least this
const FLEX_CUTS = [3, 2, 1];     // biggest cut first — most protection wins

const DEFAULTS = {
  maxSlips: 30,
  oddsTolerancePct: 10,
  headless: true,
  timeoutMs: 30000,
  betweenSlipsMs: 800,
  // 'chrome' drives the Chrome already installed on this machine; 'chromium'
  // uses Playwright's bundled build. Real Chrome is the default: same browser
  // build, same fingerprint, nothing extra to download.
  browser: 'chrome',
  // Point these at a REAL Chrome profile to reuse a login that already exists
  // there. Chrome must be fully closed first — see chromeInUse() below.
  chromeUserDataDir: null,
  chromeProfile: null,
};

/**
 * Selectors read off the live SportyBet NG desktop site. First visible match
 * wins; override any list in sporty-autobet.config.json.
 *
 * Names here are SportyBet's own, including their typo `.m-opertaion`.
 */
const SELECTORS = {
  loggedIn: ['[class*="balance" i]', 'text=/NGN\\s*[\\d,]+/', 'text=/\\bBalance\\b/i'],
  loginLink: ['button:has-text("Log in")', 'a:has-text("Log in")'],
  betslip: ['.m-betslip-wrapper', '.m-betslips'],
  // Each leg is a .m-item inside the betslip panel.
  selectionRow: ['.m-betslip-wrapper .m-item', '.m-betslips .m-item'],
  // Authoritative leg count badge on the Betslip tab.
  betCount: ['.m-bet-count'],
  stakeInput: ['.m-betslip-wrapper input.m-input', 'input.m-input[placeholder*="min" i]', 'input.m-input'],
  // "Remove All" — the clickable is the inner span, not the .m-opertaion box.
  removeAll: ['span.m-text-min:has-text("Remove All")', '.m-opertaion:has-text("Remove All")'],
  // Any modal. The confirm has [Later][OK]; the OK one is the one we want.
  dialogOk: ['.es-dialog-btn:has-text("OK")', '.es-dialog-wrap button:has-text("OK")'],
  dialogAny: ['.es-dialog-wrap', '.layout.mask'],
  // Bet-type tabs: Single | Multiple | System.
  multipleTab: ['.m-table-cell:has-text("Multiple")'],
  activeTab: ['.m-table-cell--active'],
  // Flexi is a checkbox, not a tab.
  flexCheckbox: ['.flexibet-checkbox-container', '.af-checkbox:has-text("Flexi")'],
  // Same element serves both "Place Bet" and "Accept Changes".
  placeButton: ['button.af-button--primary', 'button:has-text("Place Bet")'],
  successMarker: ['text=/bet\\s*(is\\s*)?(placed|accepted|received)/i', 'text=/successful/i', 'text=/bet\\s*id/i'],
  errorMarker: [
    'text=/insufficient/i', 'text=/suspended/i', 'text=/not\\s*available/i',
    'text=/minimum.*stake/i', 'text=/bet\\s*limit/i',
  ],
};

// ─── Config ───────────────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadConfig() {
  const raw = readJSON(CONFIG_FILE, {});
  const cfg = Object.assign({}, DEFAULTS, raw);
  cfg.selectors = {};
  for (const [k, v] of Object.entries(SELECTORS)) {
    const over = raw.selectors && raw.selectors[k];
    cfg.selectors[k] = Array.isArray(over) && over.length ? over : v;
  }
  // Stake is never read from config — the hard cap IS the stake.
  cfg.stake = MAX_STAKE;
  return cfg;
}

function assertStake(stake) {
  if (!Number.isFinite(stake) || stake <= 0) throw new Error(`invalid stake: ${JSON.stringify(stake)}`);
  if (stake > MAX_STAKE) throw new Error(`stake ₦${stake} exceeds the hard cap of ₦${MAX_STAKE} — this limit is not configurable`);
  return stake;
}

function assertSafeEnvironment() {
  if (process.env.NODE_ENV === 'production') throw new Error('auto-bet is disabled in production');
  if (ROOT.startsWith('/home/') && fs.existsSync('/usr/local/cpanel')) throw new Error('refusing to run on the production host');
}

// ─── Ledger ───────────────────────────────────────────────────────────────────
function loadLedger() {
  const l = readJSON(LEDGER, null);
  return l && Array.isArray(l.entries) ? l : { entries: [] };
}

function ledgerHasPlaced(ledger, code) {
  return ledger.entries.some(e => e.code === code && e.status === 'placed');
}

function ledgerAppend(ledger, entry) {
  ledger.entries.push(Object.assign({ at: new Date().toISOString() }, entry));
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  } catch { /* a ledger write failure must not strand an in-flight run */ }
}

// ─── Code validation (no browser — this is the fast path) ─────────────────────
function sbGetShare(code) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'www.sportybet.com',
      path: '/api/ng/orders/share/' + encodeURIComponent(code),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** Posts selections back to SportyBet and returns the new booking code. */
function sbPostShare(selections) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ selections });
    const req = https.request({
      hostname: 'www.sportybet.com', path: '/api/ng/orders/share', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

const toPayload = s => ({
  eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
  specifier: s.specifier || '', productId: parseInt(s.productId) || 3,
  sportId: s.sportId || 'sr:sport:1',
});

/**
 * Everything that can be decided without a browser is decided here: leg
 * count, same-match clashes, kickoff, availability, live price. Rejecting a
 * bad code costs one HTTP call instead of a page load.
 *
 * With `rebuild`, a code containing legs that have already kicked off is not
 * thrown away: the started legs are dropped and the survivors are posted back
 * to SportyBet as a NEW booking code, which is what actually gets played. The
 * original code is left untouched — it is a shared artefact and rewriting it
 * is not ours to do. The rebuilt code must still clear every other rule.
 *
 * @returns {{ok: boolean, reason: string|null, legs: number, odds: number,
 *            betType: 'sports'|'flex', code: string, originalCode: string,
 *            dropped: number, selections: object[]}}
 */
async function validateCode(code, opts = {}) {
  const now = opts.now || Date.now();
  const rebuild = !!opts.rebuild;
  const bad = (reason, extra = {}) => Object.assign({ ok: false, reason, legs: 0, odds: 0, betType: 'sports', selections: [] }, extra);

  if (!/^[A-Z0-9]{4,12}$/.test(code)) return bad('not a valid booking code');

  let json;
  try { json = await sbGetShare(code); }
  catch (e) { return bad(`could not reach SportyBet: ${e.message}`); }

  if (!json || json.bizCode !== 10000 || !json.data) return bad('code not found on SportyBet');

  const outcomes = json.data.outcomes || [];
  const ticketSels = json.data.ticket?.selections || [];
  const unavailable = json.data.unavailableOutcomes || [];

  if (unavailable.length) return bad(`${unavailable.length} selection(s) no longer available`);

  const tsByEvent = new Map(ticketSels.map(t => [t.eventId, t]));
  const selections = outcomes.map(o => {
    const mkt = (o.markets && o.markets[0]) || {};
    const oc = (mkt.outcomes && mkt.outcomes[0]) || {};
    const ts = tsByEvent.get(o.eventId) || {};
    return {
      eventId: o.eventId || '',
      match: `${o.homeTeamName || '?'} v ${o.awayTeamName || '?'}`,
      market: mkt.desc || '',
      outcome: oc.desc || '',
      odds: parseFloat(ts.odds) || parseFloat(oc.odds) || 0,
      kickoff: Number(o.estimateStartTime) || 0,
      matchStatus: o.matchStatus || '',
      // Needed to repost the survivors as a new code.
      marketId: String(ts.marketId || mkt.id || ''),
      outcomeId: String(ts.outcomeId || oc.id || ''),
      specifier: ts.specifier || mkt.specifier || '',
      productId: ts.productId || mkt.product || 3,
      sportId: o.sport?.id || ts.sportId || 'sr:sport:1',
    };
  });

  // Rule: nothing already running. With `rebuild`, drop those legs and repost
  // the survivors instead of discarding the whole code.
  const started = selections.filter(s => s.kickoff && s.kickoff <= now);
  let playable = selections;
  let playCode = code;
  let dropped = 0;
  let note = null;

  if (started.length) {
    if (!rebuild) {
      return bad(`${started.length} leg(s) already kicked off (${started[0].match})`, { legs: selections.length });
    }
    playable = selections.filter(s => !s.kickoff || s.kickoff > now);
    dropped = started.length;
    if (playable.length < MIN_LEGS) {
      return bad(`only ${playable.length} leg(s) left after dropping ${dropped} kicked-off — under the ${MIN_LEGS}-leg minimum`, { legs: selections.length, dropped });
    }
    if (playable.some(s => !s.marketId || !s.outcomeId)) {
      return bad('cannot rebuild — SportyBet did not return full market ids for the surviving legs', { legs: selections.length, dropped });
    }
    let posted;
    try { posted = await sbPostShare(playable.map(toPayload)); }
    catch (e) { return bad(`could not rebuild the code: ${e.message}`, { legs: selections.length, dropped }); }
    const newCode = posted && posted.bizCode === 10000 && posted.data && posted.data.shareCode;
    if (!newCode) {
      return bad(`SportyBet refused the rebuilt code${posted && posted.msg ? `: ${posted.msg}` : ''}`, { legs: selections.length, dropped });
    }
    playCode = newCode;
    note = `dropped ${dropped} kicked-off leg(s), rebuilt as ${newCode}`;
  }

  const legs = playable.length;

  // Rule: multiples only. Checked after the drop, so a code that thins out to
  // one or two live legs is refused rather than turned into a single.
  if (legs < MIN_LEGS) {
    return bad(legs === 1 ? 'single — never played' : `only ${legs} legs (minimum ${MIN_LEGS}) — never played`, { legs, dropped });
  }

  // Rule: one market per match.
  const seen = new Map();
  for (const s of playable) seen.set(s.eventId, (seen.get(s.eventId) || 0) + 1);
  const clash = [...seen.entries()].find(([, n]) => n > 1);
  if (clash) {
    const m = playable.find(s => s.eventId === clash[0]);
    return bad(`two markets on the same match (${m ? m.match : clash[0]}) — never played`, { legs, dropped });
  }

  const dead = playable.filter(s => !s.odds || s.odds <= 1.01);
  if (dead.length) return bad(`${dead.length} leg(s) have no live price`, { legs, dropped });

  const odds = playable.reduce((a, s) => a * s.odds, 1);

  return {
    ok: true,
    reason: note,
    legs,
    odds: Math.round(odds * 100) / 100,
    betType: odds > FLEX_TRIGGER_ODDS ? 'flex' : 'sports',
    code: playCode,
    originalCode: code,
    dropped,
    selections: playable,
  };
}

/** Pure: does this flex payout clear the bar? Kept separate so it is testable. */
function flexQualifies(payout, stake) {
  if (!Number.isFinite(payout) || payout <= 0) return false;
  return (payout / stake) >= FLEX_MIN_ODDS;
}

// ─── Run registry ─────────────────────────────────────────────────────────────
// In memory only, on purpose. A run that replays from disk could re-drive a
// placement; the ledger is the durable record, not the run log.
const RUNS = new Map();

function newRun(codes) {
  const runId = crypto.randomBytes(6).toString('hex');
  const rec = {
    runId,
    events: [],
    listeners: new Set(),
    stopRequested: false,
    state: {
      runId, status: 'running', startedAt: new Date().toISOString(),
      total: codes.length, done: 0, placed: 0, skipped: 0, failed: 0,
      stake: MAX_STAKE, results: [],
    },
  };
  RUNS.set(runId, rec);
  // Keep memory bounded across a long dev session.
  if (RUNS.size > 20) RUNS.delete(RUNS.keys().next().value);
  return rec;
}

function emit(rec, type, data) {
  const ev = { seq: rec.events.length, type, data, ts: new Date().toISOString() };
  rec.events.push(ev);
  const payload = `event: ${type}\ndata: ${JSON.stringify({ ...data, seq: ev.seq })}\n\n`;
  for (const res of rec.listeners) { try { res.write(payload); } catch { /* client gone */ } }
}

const getRun = runId => RUNS.get(runId) || null;

function subscribe(runId, res) {
  const rec = getRun(runId);
  if (!rec) return false;
  rec.listeners.add(res);
  res.on('close', () => rec.listeners.delete(res));
  return true;
}

function stopRun(runId) {
  const rec = getRun(runId);
  if (!rec) return false;
  rec.stopRequested = true;
  return true;
}

// ─── Browser ──────────────────────────────────────────────────────────────────
function requirePlaywright() {
  try { return require('playwright'); }
  catch { throw new Error('Playwright is not installed — run: npm install -D playwright && npx playwright install chromium'); }
}

function playwrightAvailable() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

/**
 * Is Chrome holding a profile open right now? Chrome takes an exclusive lock
 * on its user-data-dir, so a second process cannot open the same profile —
 * attaching to a running Chrome is not a thing we can choose to do.
 */
function chromeInUse() {
  if (process.platform !== 'win32') return false;
  try {
    const out = require('child_process')
      .execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8', timeout: 8000 });
    return /chrome\.exe/i.test(out);
  } catch { return false; }
}

/**
 * Which browser and which profile directory this run will use.
 *
 * Reusing the profile of a *running* Chrome is impossible by design, not by
 * omission: Chrome locks its user-data-dir, and since Chrome 127 the cookie
 * store is sealed with app-bound encryption so no other program can read a
 * live login. Chrome 136 additionally refuses remote debugging against a real
 * profile. All three exist because borrowing a logged-in Chrome session was
 * the single most common credential-theft technique. So the options are:
 * our own profile (sign in once, it persists), or a real profile with Chrome
 * fully closed.
 */
function resolveLaunch(cfg) {
  const useReal = !!cfg.chromeUserDataDir;
  const channel = cfg.browser === 'chromium' ? null : 'chrome';
  // Chrome and Playwright's bundled Chromium must not share a user-data-dir —
  // a profile written by one build can be rejected or silently migrated by the
  // other, which would look like a mysteriously lost login.
  const dir = useReal ? path.resolve(cfg.chromeUserDataDir)
    : (channel ? SESSION_DIR : SESSION_DIR + '-chromium');
  const args = ['--disable-blink-features=AutomationControlled'];
  if (useReal && cfg.chromeProfile) args.push(`--profile-directory=${cfg.chromeProfile}`);
  return { dir, channel, args, useReal };
}

function hasSession() {
  try {
    const { dir } = resolveLaunch(loadConfig());
    if (!fs.existsSync(dir)) return false;
    // Cookies live at <profile>/Network/Cookies on current Chrome, and at
    // <profile>/Cookies on older builds — accept either, in any profile dir.
    for (const sub of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, sub, 'Network', 'Cookies'))) return true;
      if (fs.existsSync(path.join(dir, sub, 'Cookies'))) return true;
    }
    return false;
  } catch { return false; }
}

/**
 * Speed comes from three things: headless, one browser reused for the whole
 * run, and refusing to download anything that cannot affect the betslip.
 * Images/fonts/media/analytics are the bulk of SportyBet's page weight and
 * none of them matter to us.
 */
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);
const BLOCKED_HOSTS = /googletagmanager|google-analytics|facebook|doubleclick|hotjar|sentry|appsflyer|branch\.io/i;

async function launch(cfg, headless) {
  const { chromium } = requirePlaywright();
  const { dir, channel, args, useReal } = resolveLaunch(cfg);

  if (useReal && chromeInUse()) {
    throw new Error(
      'Chrome is running, and Chrome locks its profile — close Chrome completely (check the tray) and try again. ' +
      'Or clear chromeUserDataDir in sporty-autobet.config.json to use the tool\'s own profile instead.'
    );
  }

  if (!useReal) fs.mkdirSync(dir, { recursive: true });

  const opts = { headless: !!headless, viewport: { width: 1280, height: 900 }, args };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dir, channel ? { ...opts, channel } : opts);
  } catch (e) {
    // Chrome missing or unusable — fall back to the bundled build rather than
    // failing the whole run over a browser choice.
    if (!channel) throw e;
    ctx = await chromium.launchPersistentContext(dir, opts);
  }
  ctx.setDefaultTimeout(cfg.timeoutMs);

  if (headless) {
    await ctx.route('**/*', route => {
      const r = route.request();
      if (BLOCKED_TYPES.has(r.resourceType()) || BLOCKED_HOSTS.test(r.url())) return route.abort();
      return route.continue();
    });
  }

  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** First visible locator from a candidate list, or null. */
async function firstVisible(page, candidates, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 300 })) return loc;
      } catch { /* bad or detached selector */ }
    }
    await sleep(150);
  }
  return null;
}

/**
 * The Betslip tab badge is the authoritative leg count — it is present even
 * while rows are still rendering, and it is what SportyBet itself counts
 * against the 50-selection limit.
 */
async function readBetCount(page) {
  try {
    const el = page.locator('.m-bet-count').first();
    if (!await el.isVisible({ timeout: 1500 }).catch(() => false)) return null;
    const n = parseInt((await el.innerText()).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return null; }
}

async function countSelections(page, cfg) {
  const badge = await readBetCount(page);
  if (badge !== null) return badge;
  for (const sel of cfg.selectors.selectionRow) {
    try { const n = await page.locator(sel).count(); if (n > 0) return n; } catch { /* next */ }
  }
  return null;
}

/**
 * SportyBet interrupts with modal dialogs — "Bet Limit Reached" (over 50
 * selections) and the Remove-All confirm. Both use .es-dialog-btn, and the
 * confirm offers [Later][OK], so we must click OK specifically: clicking the
 * first button would hit "Later" and silently cancel the clear.
 */
async function dismissDialogs(page, log = () => {}) {
  for (let i = 0; i < 4; i++) {
    const wrap = page.locator('.es-dialog-wrap').first();
    if (!await wrap.isVisible({ timeout: 800 }).catch(() => false)) return;
    const text = await wrap.innerText().catch(() => '');
    const ok = page.locator('.es-dialog-btn', { hasText: /^\s*ok\s*$/i }).first();
    if (await ok.isVisible({ timeout: 800 }).catch(() => false)) {
      log(`    dismissing: ${text.replace(/\s+/g, ' ').slice(0, 60)}`);
      await ok.click().catch(() => {});
    } else {
      await page.locator('.es-dialog-btn').first().click().catch(() => {});
    }
    await sleep(800);
  }
}

/**
 * Empties the betslip. This is not optional housekeeping: loading a share
 * code ADDS to whatever is already there, so without it code #2 is placed as
 * codes #1+#2 merged, and past 50 selections SportyBet blocks the slip
 * outright. That is exactly how the first live run wedged itself.
 */
/**
 * Empties the betslip by dropping its client-side state.
 *
 * The betslip lives in localStorage under `betslips*`, so removing those keys
 * is both faster and more reliable than driving the UI: SportyBet's own
 * "Bet Limit Reached" modal puts a mask over the page that swallows the
 * Remove All click, which is precisely the situation you are in when the slip
 * most needs clearing. No reload is needed here — the caller navigates to the
 * share-code URL next, and the fresh page reads the emptied storage.
 *
 * The real guarantee is not this function but the leg-count check after the
 * code loads: if anything survived, the count will not match and the slip is
 * skipped rather than placed.
 */
async function clearSlip(page, cfg, log = () => {}) {
  await dismissDialogs(page, log);
  const n = await readBetCount(page);
  if (n === 0 || n === null) return 0;

  const cleared = await page.evaluate(() => {
    let removed = 0;
    for (const k of Object.keys(localStorage)) {
      if (/^betslips/i.test(k)) { localStorage.removeItem(k); removed++; }
    }
    return removed;
  }).catch(() => -1);

  if (cleared > 0) return 0;

  // Storage was unreachable — fall back to the UI once, then let the
  // post-load leg-count check be the backstop.
  const rm = await firstVisible(page, cfg.selectors.removeAll, 2500);
  if (rm) {
    await rm.click({ timeout: 4000 }).catch(e => log(`    Remove All blocked: ${e.message.split('\n')[0].slice(0, 50)}`));
    await sleep(800);
    await dismissDialogs(page, log);
  }
  const after = await readBetCount(page);
  return after === null ? 0 : after;
}

/**
 * SportyBet labels the accumulator price "Odds" — not "Total Odds". Read it
 * from inside the betslip panel only: the word "Odds" appears all over the
 * page, and picking up a match listing's price instead of the slip total
 * would corrupt the flex decision.
 */
async function readSlipOdds(page) {
  try {
    const wrap = page.locator('.m-betslip-wrapper').first();
    if (!await wrap.isVisible({ timeout: 2000 }).catch(() => false)) return null;
    const lines = (await wrap.innerText()).split('\n').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!/^odds$/i.test(lines[i])) continue;
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const m = lines[i + j].match(/^([\d][\d,]*\.?\d*)$/);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
      }
    }
    return null;
  } catch { return null; }
}

const BET_HISTORY_URL = 'https://www.sportybet.com/ng/my_accounts/bet_history/sport_bets?isSettled=10';

/**
 * Fingerprint of the most recent bet on the account: its timestamp plus the
 * first match named on it.
 *
 * This is the only trustworthy "did it place?" signal. SportyBet shows no
 * success toast we can match, does NOT clear the betslip after placing, and
 * the header balance lags by minutes — which is exactly how one run reported
 * ten failures while the bets were quietly going on. A count is no good here
 * because the history paginates at five, so the count never changes; the
 * identity of the newest row does.
 */
async function readLatestBet(page) {
  try {
    await page.goto(BET_HISTORY_URL, { waitUntil: 'domcontentloaded' });
    await sleep(6000);
    return await page.evaluate(() => {
      const t = document.body.innerText;
      const when = (t.match(/\d\d\/\d\d\/\d{4} \d\d:\d\d/) || [])[0] || null;
      if (!when) return null;
      const after = t.slice(t.indexOf(when) + when.length, t.indexOf(when) + when.length + 220);
      const firstMatch = (after.match(/[A-Za-z0-9][^\n]{6,60}\sv\s[^\n]{2,40}/) || [])[0] || '';
      return `${when}|${firstMatch.trim()}`;
    });
  } catch { return null; }
}

/** Balance in the header, used to prove real money actually moved. */
async function readBalance(page) {
  try {
    const t = await page.locator('body').innerText();
    const m = t.match(/NGN\s*([\d,]+\.?\d*)/i);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  } catch { return null; }
}

/** Waits for the betslip to actually hydrate instead of sleeping a fixed guess. */
async function waitForSlip(page, cfg, expectedLegs, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1, stableFor = 0;
  while (Date.now() < deadline) {
    const n = await countSelections(page, cfg);
    if (n !== null && n > 0) {
      if (expectedLegs && n === expectedLegs) return n;   // exact match, stop early
      if (n === last) { stableFor += 1; if (stableFor >= 3) return n; }
      else { last = n; stableFor = 0; }
    }
    await sleep(200);
  }
  return last > 0 ? last : null;
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = path.join(SHOT_DIR, `${Date.now()}-${name}.png`);
    await page.screenshot({ path: f });
    return f;
  } catch { return null; }
}

const isLoggedIn = (page, cfg) => firstVisible(page, cfg.selectors.loggedIn, 4000).then(Boolean);

/**
 * Reads a number that follows a label in the page's own text. Reading
 * rendered text survives class-name churn far better than a DOM path.
 */
async function readLabelledNumber(page, labelRe) {
  const body = await page.locator('body').innerText().catch(() => '');
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    const here = lines[i].match(/([\d][\d,]*\.?\d*)\s*$/);
    if (here) return parseFloat(here[1].replace(/,/g, ''));
    for (let j = 1; j <= 2 && i + j < lines.length; j++) {
      const m = lines[i + j].match(/^₦?\s*([\d][\d,]*\.?\d*)$/);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
    }
  }
  return null;
}

/**
 * Switches the betslip to Flex and picks the biggest cut that still returns
 * FLEX_MIN_ODDS. Returns { applied, cut, payout } — applied:false means the
 * caller must decide between a straight multiple and skipping.
 */
/** Is the Flexi checkbox currently ticked? null when it cannot be read. */
async function isFlexOn(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.flexibet-checkbox-container');
    if (!el) return null;
    const i = el.querySelector('input');
    if (i) return !!i.checked;
    return /checked|--active|is-active/i.test(el.className) || null;
  }).catch(() => null);
}

async function tryFlex(page, cfg, stake, emitLog) {
  const box = await firstVisible(page, cfg.selectors.flexCheckbox, 4000);
  if (!box) return { applied: false, cut: null, odds: null, reason: 'flex control not found' };

  const before = await readSlipOdds(page);
  await box.click().catch(() => {});
  await sleep(2200);
  await dismissDialogs(page, emitLog);

  const after = await readSlipOdds(page);
  if (after === null) {
    await box.click().catch(() => {});   // put it back the way we found it
    await sleep(1200);
    return { applied: false, cut: null, odds: null, reason: 'flexed odds unreadable' };
  }

  // SportyBet NG only offers a single cut ("One Cut") on these slips, so the
  // cut is whatever it gives us; the bar is the same either way.
  emitLog(`    flexi on: ${before ? before.toLocaleString() : '?'}x → ${after.toLocaleString()}x`);

  if (after >= FLEX_MIN_ODDS) return { applied: true, cut: 1, odds: after, reason: null };

  await box.click().catch(() => {});     // below the bar — revert to a straight multiple
  await sleep(1500);
  return { applied: false, cut: null, odds: after, reason: `flexed to ${after.toLocaleString()}x, under the ${FLEX_MIN_ODDS}x bar` };
}

/**
 * Places one already-validated code.
 * status: 'placed' | 'skipped' | 'failed'. 'skipped' is a guard doing its
 * job, not an error.
 */
async function placeOne(page, slip, cfg, stake, dryRun, emitLog) {
  // Loading a share code ADDS to the betslip, so the slip must be emptied
  // first or codes merge into one another.
  await dismissDialogs(page, emitLog);
  const leftover = await clearSlip(page, cfg, emitLog);
  if (leftover && leftover > 0) {
    return { status: 'failed', reason: `could not empty the betslip (${leftover} left) — refusing to place a merged slip` };
  }

  // Baseline for the only reliable confirmation signal, taken while we are
  // still navigating anyway — before the code is loaded, so it costs nothing
  // extra and cannot disturb the slip.
  const latestBefore = dryRun ? null : await readLatestBet(page);

  const url = `${BASE}?shareCode=${slip.code}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await dismissDialogs(page, emitLog);

  const legs = await waitForSlip(page, cfg, slip.legs);
  if (legs === null) return { status: 'failed', reason: 'betslip never loaded (selectors may need calibrating)' };
  if (legs !== slip.legs) {
    return { status: 'skipped', reason: `slip loaded ${legs} legs, code has ${slip.legs} — not the bet that was checked` };
  }

  // Bet type. Default is a straight multiple on Sports; only heavy codes flex.
  let betType = 'sports', flexCut = null;
  if (slip.betType === 'flex') {
    emitLog(`  ${slip.odds.toLocaleString()}x is over ${FLEX_TRIGGER_ODDS.toLocaleString()} — trying flex`);
    const flex = await tryFlex(page, cfg, stake, emitLog);
    if (flex.applied) { betType = 'flex'; flexCut = flex.cut; emitLog(`  flexing at cut ${flex.cut}`); }
    else if (flex.reason === 'flex control not found') {
      // Never quietly place a 200,000x code straight when a cut was asked for.
      return { status: 'skipped', reason: 'flex was required but the flex control could not be found — place this one by hand', betType: 'flex' };
    } else {
      emitLog(`  ${flex.reason} — placing as a straight multiple`);
    }
  }

  const stakeBox = await firstVisible(page, cfg.selectors.stakeInput, 6000);
  if (!stakeBox) return { status: 'failed', reason: 'stake input not found (run calibrate)' };

  // Typing a stake places nothing, so a dry run still does it — that way the
  // rehearsal proves the whole chain (clear → load → count → flex → stake →
  // button) instead of stopping one step short of everything that can break.
  // Set the stake, then read it back. The betslip re-renders as it settles and
  // can revert the field to its default (₦100), so the write is retried — but
  // the check itself never softens: if we cannot confirm ₦10 in the box, the
  // code is not placed.
  let typedNum = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await stakeBox.fill(String(stake)).catch(() => {});
    await sleep(500);
    const typed = await stakeBox.inputValue().catch(() => null);
    typedNum = typed === null ? null : parseFloat(String(typed).replace(/[^\d.]/g, ''));
    if (Number.isFinite(typedNum) && typedNum <= MAX_STAKE) break;
    emitLog(`    stake box read ₦${typed} — retrying (${attempt}/3)`);
  }
  if (typedNum === null || !Number.isFinite(typedNum)) {
    return { status: 'failed', reason: 'could not confirm the stake field value' };
  }
  if (typedNum > MAX_STAKE) {
    return { status: 'failed', reason: `stake box still shows ₦${typedNum} after 3 tries but the cap is ₦${MAX_STAKE} — aborted` };
  }

  if (dryRun) {
    const b = await firstVisible(page, cfg.selectors.placeButton, 6000);
    const lbl = b ? (await b.innerText().catch(() => '')).trim() : null;
    const odds = await readSlipOdds(page);
    emitLog(`  dry run: stake ₦${typedNum}, odds ${odds ? odds.toLocaleString() : '?'}x, button "${lbl || 'NOT FOUND'}"`);
    return {
      status: b ? 'skipped' : 'failed',
      reason: b ? `dry run — ready (${betType}${flexCut ? ` cut ${flexCut}` : ''}, button "${lbl}")` : 'Place Bet button not found (run calibrate)',
      betType, flexCut, legs,
    };
  }

  const balanceBefore = await readBalance(page);

  // The primary button doubles as "Accept Changes" whenever a leg's price has
  // moved — clicking it blindly would accept drift without anyone looking. So
  // read its label, accept only if the resulting odds still pass our rules,
  // then place.
  let btn = await firstVisible(page, cfg.selectors.placeButton, 6000);
  if (!btn) return { status: 'failed', reason: 'Place Bet button not found (run calibrate)' };

  let label = (await btn.innerText().catch(() => '')).trim();
  if (/accept\s*changes/i.test(label)) {
    const oddsBefore = await readSlipOdds(page);
    await btn.click().catch(() => {});
    await sleep(1800);
    await dismissDialogs(page, emitLog);
    const oddsAfter = await readSlipOdds(page);
    emitLog(`  odds moved: ${oddsBefore ? oddsBefore.toLocaleString() : '?'}x → ${oddsAfter ? oddsAfter.toLocaleString() : '?'}x (accepted)`);

    if (betType === 'flex') {
      // Accepting an odds change can drop the Flexi tick. Placing then would
      // put the full un-cut price on instead of the flexed one — a different
      // bet from the one that was decided.
      const stillFlexed = await isFlexOn(page);
      if (stillFlexed === false) {
        emitLog('    flexi was reset by the odds change — re-applying');
        const box = await firstVisible(page, cfg.selectors.flexCheckbox, 3000);
        if (box) { await box.click().catch(() => {}); await sleep(1800); }
        if (await isFlexOn(page) !== true) {
          return { status: 'skipped', reason: 'flexi would not stay applied after the odds change — place this one by hand', betType, flexCut, legs };
        }
      }
      const flexedOdds = await readSlipOdds(page);
      if (flexedOdds !== null && flexedOdds < FLEX_MIN_ODDS) {
        return { status: 'skipped', reason: `after the odds change the flexed price is ${flexedOdds.toLocaleString()}x, under the ${FLEX_MIN_ODDS}x bar`, betType, flexCut, legs };
      }
    }

    btn = await firstVisible(page, cfg.selectors.placeButton, 6000);
    if (!btn) return { status: 'failed', reason: 'Place Bet button vanished after accepting the odds change' };
    label = (await btn.innerText().catch(() => '')).trim();
    if (/accept\s*changes/i.test(label)) {
      return { status: 'failed', reason: 'odds kept moving — button still says Accept Changes' };
    }
  }

  // Watch for the placement request itself. If the click produces no request
  // at all, the page's own handler declined it — that is a very different
  // failure from "the bet was sent and we could not read the result", and the
  // two must never be reported the same way.
  let sawRequest = false;
  // v21 — REAL BUG: the ledger showed a consistent pattern — sawRequest true
  // (the real placement POST fired) but outcome staying unconfirmed, over
  // and over, across different codes/days. Confirmation used to rely ONLY
  // on fragile DOM-text matching (successMarker/errorMarker regexes, plus a
  // body-innerText scrape of the bet-history page in readLatestBet) — both
  // break silently the moment SportyBet's page wording/layout drifts even
  // slightly, with no error, just an empty result. SportyBet's OTHER API
  // (the booking-code share/scan endpoint) reports success via
  // `bizCode === 10000` — reading the ACTUAL backend response for the order
  // POST itself uses that same, authoritative, already-proven convention
  // instead of guessing from the DOM. Purely additive: if the response
  // isn't JSON or has no bizCode, apiResult stays null and every existing
  // DOM-based check below runs exactly as before — this can only make
  // confirmation MORE reliable, never less.
  let apiResult = null;
  const watchReq = req => {
    if (req.method() === 'POST' && /\/api\/ng\/orders\//i.test(req.url()) && !/\/orders\/share/i.test(req.url())) sawRequest = true;
  };
  const watchRes = async res => {
    const req = res.request();
    if (req.method() !== 'POST' || !/\/api\/ng\/orders\//i.test(req.url()) || /\/orders\/share/i.test(req.url())) return;
    try { const body = await res.json(); apiResult = { ok: body?.bizCode === 10000, raw: body }; } catch { /* fall through to DOM-based checks */ }
  };
  page.on('request', watchReq);
  page.on('response', watchRes);

  await btn.click();

  let outcome = null;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !outcome) {
    if (apiResult) { outcome = apiResult.ok ? 'placed' : 'error'; break; }
    if (await firstVisible(page, cfg.selectors.successMarker, 500)) outcome = 'placed';
    else if (await firstVisible(page, cfg.selectors.errorMarker, 500)) outcome = 'error';
    else await sleep(400);
  }
  page.off('request', watchReq);
  page.off('response', watchRes);

  const img = await shot(page, `${outcome || 'unknown'}-${slip.code}`);

  // No on-screen marker means nothing — SportyBet shows none for a successful
  // bet. Ask the account instead: did the open-bet count go up?
  if (!outcome && latestBefore !== null) {
    const latestAfter = await readLatestBet(page);
    if (latestAfter !== null && latestAfter !== latestBefore) {
      emitLog(`  confirmed by bet history — newest bet is now ${latestAfter}`);
      outcome = 'placed';
    } else if (latestAfter !== null) {
      emitLog('  bet history unchanged — not placed');
    }
  }

  if (outcome === 'placed') {
    // Prove real money moved. SportyBet has a SIM/REAL toggle, and a bet
    // placed in SIM looks identical on screen but costs nothing — a balance
    // that did not move is the tell.
    await sleep(1200);
    const balanceAfter = await readBalance(page);
    let note = null;
    if (balanceBefore !== null && balanceAfter !== null) {
      const delta = Math.round((balanceBefore - balanceAfter) * 100) / 100;
      emitLog(`  balance ₦${balanceBefore.toLocaleString()} → ₦${balanceAfter.toLocaleString()} (−₦${delta})`);
      if (delta <= 0) note = 'balance did not drop — check the SIM/REAL toggle on SportyBet';
      if (note) emitLog(`  ⚠ ${note}`);
    }
    return { status: 'placed', reason: note, betType, flexCut, legs, stake, shot: img, balanceBefore, balanceAfter };
  }
  if (outcome === 'error') {
    // v21 — prefer the real backend message over a guessed DOM-text scrape
    // when we actually have one (see apiResult above).
    const apiMsg = apiResult && !apiResult.ok ? (apiResult.raw?.message || apiResult.raw?.innerMsg) : null;
    let reason = apiMsg;
    if (!reason) {
      const txt = await page.locator('body').innerText().catch(() => '');
      const m = txt.match(/.{0,70}(insufficient|suspended|odds.*changed|not\s*available|minimum.*stake|failed).{0,70}/i);
      reason = (m ? m[0] : 'unknown').replace(/\s+/g, ' ').trim();
    }
    return { status: 'failed', reason: `rejected: ${reason}`, betType, flexCut, shot: img };
  }
  if (!sawRequest) {
    // Nothing left the browser, so nothing was staked — safe to retry later.
    return {
      status: 'failed',
      reason: 'SportyBet ignored the Place Bet click — no request was sent, so NOTHING was staked. Place one by hand in the same window to see the real reason.',
      betType, flexCut, shot: img,
    };
  }
  return { status: 'failed', reason: 'the bet was sent but no confirmation appeared (backend response was not JSON/bizCode-shaped, and no on-screen or bet-history signal matched) — CHECK THIS ONE MANUALLY before retrying', betType, flexCut, shot: img };
}

// ─── Sign-in ──────────────────────────────────────────────────────────────────
/** Opens a real window for a human to log in. Nothing is typed or stored. */
async function signIn({ timeoutMs = 300000 } = {}) {
  assertSafeEnvironment();
  const cfg = loadConfig();
  const { ctx, page } = await launch(cfg, false);   // must be headed
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isLoggedIn(page, cfg)) return { success: true };
      await sleep(1500);
    }
    return { success: false, error: 'timed out waiting for a logged-in session' };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function checkSession() {
  assertSafeEnvironment();
  const cfg = loadConfig();
  const { channel, useReal } = resolveLaunch(cfg);
  const info = {
    browser: channel === 'chrome' ? 'Chrome (installed on this PC)' : 'Chromium (bundled)',
    profile: useReal ? 'your real Chrome profile' : 'the tool\'s own profile',
    chromeRunning: useReal ? chromeInUse() : false,
  };

  if (!playwrightAvailable()) return { playwright: false, signedIn: false, ...info };
  if (!hasSession()) return { playwright: true, signedIn: false, ...info };

  const { ctx, page } = await launch(cfg, true);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const ok = await isLoggedIn(page, cfg);
    return { playwright: true, signedIn: ok, ...info };
  } catch (e) {
    return { playwright: true, signedIn: false, error: e.message, ...info };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────
function parseCodes(input) {
  const raw = Array.isArray(input) ? input.join('\n') : String(input || '');
  const seen = new Set();
  const out = [];
  for (const tok of raw.split(/[\s,;]+/)) {
    const c = tok.trim().toUpperCase();
    if (!c) continue;
    if (!/^[A-Z0-9]{4,12}$/.test(c)) continue;
    if (seen.has(c)) continue;      // pasting the same code twice must not stake twice
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Validates every code first (cheap, parallel, no browser), then places the
 * survivors in one browser session.
 */
async function startRun(codesInput, { dryRun = false, dropStarted = true } = {}) {
  assertSafeEnvironment();
  const cfg = loadConfig();
  const stake = assertStake(MAX_STAKE);

  const codes = parseCodes(codesInput).slice(0, cfg.maxSlips);
  if (!codes.length) throw new Error('no valid booking codes found in that input');

  const rec = newRun(codes);
  const log = msg => emit(rec, 'log', { msg });

  // Run the browser work in the background; the caller gets the runId now.
  (async () => {
    const ledger = loadLedger();
    let ctx = null;
    try {
      log(`Checking ${codes.length} code${codes.length > 1 ? 's' : ''}…`);

      // Validation is network-bound and independent per code — do it at once.
      const checks = await Promise.all(codes.map(async code => {
        if (ledgerHasPlaced(ledger, code)) return { code, originalCode: code, ok: false, reason: 'already placed earlier (ledger)' };
        try { return { originalCode: code, ...(await validateCode(code, { rebuild: dropStarted })) }; }
        catch (e) { return { code, originalCode: code, ok: false, reason: e.message }; }
      }));

      for (const c of checks) {
        const shown = c.originalCode || c.code;
        if (c.ok) {
          log(`  ✓ ${shown} — ${c.legs} legs, ${c.odds.toLocaleString()}x → ${c.betType === 'flex' ? 'FLEX' : 'Sports'}`);
          if (c.dropped) log(`      ${c.reason}`);
        } else {
          log(`  ✗ ${shown} — ${c.reason}`);
        }
      }

      const runnable = checks.filter(c => c.ok);
      for (const c of checks.filter(c => !c.ok)) {
        rec.state.skipped++; rec.state.done++;
        const row = { code: c.originalCode || c.code, status: 'skipped', reason: c.reason, dropped: c.dropped || 0 };
        rec.state.results.push(row);
        emit(rec, 'result', row);
      }

      if (!runnable.length) { log('Nothing left to place.'); return; }

      log(`Opening SportyBet (${runnable.length} to place at ₦${stake} each)…`);
      const launched = await launch(cfg, cfg.headless);
      ctx = launched.ctx;
      const page = launched.page;

      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      if (!await isLoggedIn(page, cfg)) throw new Error('not signed in — use the Sign in button first');
      log('✓ signed in');

      let consecutiveFailures = 0;
      for (const slip of runnable) {
        if (rec.stopRequested) { log('Stopped by user.'); break; }

        const shown = slip.originalCode || slip.code;
        log(`${shown}${slip.dropped ? ` → ${slip.code}` : ''} — ${slip.legs} legs, ${slip.odds.toLocaleString()}x`);
        let r;
        try { r = await placeOne(page, slip, cfg, stake, dryRun, log); }
        catch (e) { r = { status: 'failed', reason: e.message }; }

        rec.state.done++;
        if (r.status === 'placed') { rec.state.placed++; log(`  ✓ placed ₦${stake}${r.flexCut ? ` (flex cut ${r.flexCut})` : ''}`); }
        else if (r.status === 'skipped') { rec.state.skipped++; log(`  – skipped: ${r.reason}`); }
        else { rec.state.failed++; log(`  ✗ failed: ${r.reason}`); }

        const row = { code: shown, playedCode: slip.code, dropped: slip.dropped || 0, legs: slip.legs, odds: slip.odds, ...r };
        rec.state.results.push(row);
        emit(rec, 'result', row);

        if (!dryRun) {
          // Keyed on the ORIGINAL code so re-pasting the same list cannot
          // restake it, even though a rebuilt code was what went on.
          ledgerAppend(ledger, {
            code: shown, playedCode: slip.code, dropped: slip.dropped || 0,
            stake, status: r.status, reason: r.reason,
            legs: slip.legs, odds: slip.odds, betType: r.betType, flexCut: r.flexCut,
          });
        }

        consecutiveFailures = r.status === 'failed' ? consecutiveFailures + 1 : 0;
        if (consecutiveFailures >= 2) { log('Two failures in a row — stopping the run.'); break; }

        await sleep(cfg.betweenSlipsMs);
      }

      rec.state.status = 'done';
    } catch (e) {
      rec.state.status = 'error';
      rec.state.error = e.message;
      log(`✗ ${e.message}`);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      rec.state.finishedAt = new Date().toISOString();
      if (rec.state.status === 'running') rec.state.status = 'done';
      emit(rec, rec.state.status === 'error' ? 'run-error' : 'done', rec.state);
      for (const res of rec.listeners) { try { res.end(); } catch { /* gone */ } }
      rec.listeners.clear();
    }
  })();

  return rec.state;
}

module.exports = {
  MAX_STAKE, MIN_LEGS, FLEX_TRIGGER_ODDS, FLEX_MIN_ODDS,
  validateCode, flexQualifies, parseCodes, assertStake, assertSafeEnvironment,
  loadConfig, loadLedger, ledgerHasPlaced,
  signIn, checkSession, startRun, getRun, subscribe, stopRun,
  playwrightAvailable, hasSession, chromeInUse, resolveLaunch,
  readLabelledNumber, launch, isLoggedIn, firstVisible, countSelections,
  readLatestBet, readBalance, readSlipOdds, clearSlip,
  SESSION_DIR, SHOT_DIR, LEDGER,
};
