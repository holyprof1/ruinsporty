/**
 * advanced-generator-engine.js — SlipPilot Advanced Generator (v2)
 *
 * Implements the 9-phase Advanced Generator spec: collect every tracked
 * punter/community code, drop late legs, score every remaining leg on a
 * 7-factor weighted FinalScore, convert risky markets against the LIVE
 * market board (never inventing a market), apply killer-league / month-loss /
 * exposure protection, then build Sections A–E of booking codes and stream
 * progress to the admin UI as it works.
 *
 * Reuses the already-calibrated primitives from intelligence-engine.js
 * (market safety table, safe-conversion ladders, league tiers, punter
 * tiering, team-scoped market detection) rather than re-deriving them from
 * scratch — those numbers are tuned against real settled results, and
 * duplicating them with fresh guesses would be strictly worse.
 *
 * Nothing here invents a market, a score, or a stat that wasn't actually
 * computed from a real data file or a real live API response. Where a
 * factor can't be computed (no H2H, no settled history yet, etc.) it is
 * marked unavailable and its weight is redistributed — never guessed.
 */
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const intel = require('./intelligence-engine');
const {
  loadIntelDeps, marketSafety, classifyRisk, SAFE_CONVERSIONS, findSafeMarket,
  getLine, leagueTier, getPunterData, sbGetEvent, sbPost, sbGet, isTeamScopedMarket,
} = intel;

// ─── PATHS ──────────────────────────────────────────────────────────────────
const DATA        = path.join(__dirname, 'data');
const AG_DIR       = path.join(DATA, 'advanced-generator');
try { fs.mkdirSync(AG_DIR, { recursive: true }); } catch {}

const PUNTER_CODES_FILE     = path.join(DATA, 'punter-codes.json');
const COMMUNITY_CODES_FILE  = path.join(DATA, 'community-codes.json');
const LEAGUE_INTEL_FILE     = path.join(DATA, 'league-intelligence.json');
const TEAM_INTEL_FILE       = path.join(DATA, 'team-intelligence.json');
const SPEC_FILE             = path.join(DATA, 'punter-specializations.json');
const REPORTS_DIR           = path.join(DATA, 'reports');

const RESULTS_FILE          = path.join(DATA, 'advanced-generator-results.json'); // per §10
const GENERATED_CODES_FILE  = path.join(DATA, 'generated-codes.json'); // shared with admin dashboard's "Codes Today" stat (server.js CODES_FILE)
const BLACKLIST_FILE        = path.join(AG_DIR, 'league-blacklist.json');
const BLACKLIST_CANDIDATES_FILE = path.join(AG_DIR, 'league-blacklist-candidates.json');
const DROP_LEARNING_FILE    = path.join(AG_DIR, 'drop-learning.json');
const CONVERSION_LEARNING_FILE = path.join(AG_DIR, 'conversion-learning.json');
const AG_PUNTER_PROFILES_FILE  = path.join(AG_DIR, 'punter-profiles.json');
const MONTH_LOSSES_FILE     = path.join(AG_DIR, 'month-losses.json');
const LEAGUE_EXT_FILE       = path.join(AG_DIR, 'league-intel-extended.json');
const DOWNWEIGHTS_FILE      = path.join(AG_DIR, 'downweights.json');
const LAST_LESSONS_FILE     = path.join(AG_DIR, 'last-lessons.json');
const FLOOR_STATE_FILE      = path.join(AG_DIR, 'floor-state.json');       // v3.1 §3 — adaptive confidence floor
const SETTINGS_FILE         = path.join(AG_DIR, 'settings.json');          // v6 — Generator Settings modal overrides, merged under DEFAULT_CONFIG, under explicit per-run options.config
const BACKFILL_STATE_FILE   = path.join(AG_DIR, 'backfill-state.json');   // v3.1 §4 — tracks which report files are already ingested

function safeJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch { return fallback; }
}
function saveJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { console.error('[adv-gen] write failed', file, e.message); }
}
function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

// ─── CONFIG (all DEFAULT values, single config object per spec §0) ─────────
const DEFAULT_CONFIG = {
  lateLegDropDefaultN: 3,        // §1 — allowed 2-3
  weights: {                     // §2 — must sum to 1.0
    teamForm: 0.35, leagueIntel: 0.20, punterAccuracy: 0.15,
    h2h: 0.10, marketSafety: 0.10, communityConsensus: 0.05, oddsValue: 0.05,
  },
  // v4 §2 — confidenceFloor applies ONLY to pool-based sections (B/C/D/E).
  // Section A (edited punter slips) is a separate code path entirely — see
  // `sectionARemovalDecision` — that uses specific removal rules (HARD
  // blacklist, always-replace markets with no safe equivalent, proven TOXIC
  // patterns) instead of a score threshold. A punter's low-confidence pick
  // is flagged in the UI, never silently deleted by the pool floor.
  confidenceFloor: 62,           // v3.1 §3 — was 70; adaptive from here, see floor-state.json — POOL SECTIONS (B/C/D/E) ONLY
  adaptiveFloorMin: 62, adaptiveFloorMax: 70, adaptiveFloorStep: 2, adaptiveFloorCoverageThreshold: 0.60, // v3.1 §3
  riskBandLeave: 72,             // v7 §4 — was 75; raised the leave-as-is band, conversions were firing too eagerly in the maybe-band
  riskBandConvertIfBetter: 61,   // §2 — 61-71 convert only if replacement clears conversionMinImprovement
  conversionMinImprovement: 6,   // v7 §4 — maybe-band (61-71): only convert if projected score gain >= this; marginal gains leave the leg alone
  forcedUnderShift: true,        // v7 §4 — Generator Settings toggle for the Under X.5→(X+1).5 forced-shift rule
  teamExposureCap: 3,            // §7
  leagueExposureCapBig: 8,       // §7 — big tickets (>=15 legs)
  leagueExposureCapSmall: 3,     // §7 — small tickets (<15 legs)
  highTierOverlapCap: 2,         // §7 — max tickets a >=10-slip consensus leg may appear in
  highTierConsensusThreshold: 10,// §7 — punter-slip count that defines a "consensus trap" leg
  communityMinHitRate: 65,       // §6
  maxKickoffDaysAhead: 5,        // §0.5
  minSettledForTeamForm: 3,      // v3.1 §1 — below this, team form is "unavailable" not neutral-55
  minSettledForLeagueIntel: 4,   // v3.1 §1 — below this, league intel is "unavailable" not neutral-55
  minActiveFactorsForFullConfidence: 5, // v3.1 §3 — "good coverage" leg threshold, out of 7 factors
  thinDataPenalty: 4,            // v3.1 §1 — DEFAULT −4 per missing major factor (teamForm/leagueIntel/h2h)
  softLeaguePenalty: 12,         // v3.1 §2 — DEFAULT −12 for SOFT-list leagues (not excluded, just penalized)
  softLeagueTicketCapPct: 0.30,  // v3.1 §2 — max share of any ticket's legs from SOFT leagues
  conversionConcurrency: 3,      // v3.2 — parallel live market-board fetches in Phase 3 (was strictly serial). Kept conservative — no confirmed-safe rate ceiling for the SportyBet account.
  softLeagueFloor: 55,           // v3.2 — separate, lower confidence floor specifically for SOFT-list (friendly) legs, on top of their existing −12 score penalty
  // v21 — REAL BUG: this was a bare loss-COUNT threshold ("≥3 recorded
  // kills = proven killer") with no win data or sample size at all —
  // month-losses.json only ever tallied LOSSES, so a league/market/band
  // picked 3 times and lost all 3 (100% fail, tiny sample) was flagged
  // identically to one picked 300 times and lost 3 (1% fail, not actually
  // risky). This is the exact base-rate fallacy already fixed for the
  // league/market blacklist (see leagueWins/leagueFails in runDailyReview)
  // but it had never been applied here — confirmed via a forensic audit of
  // ugochukwu's 2026-07-25 ticket. buildMonthLosses now tracks wins per
  // bucket too, so isToxicPattern can require both a minimum sample AND a
  // real fail rate. toxicMinKillCount is repurposed as that minimum sample
  // size (kept under its old name/Settings entry to avoid breaking the
  // existing Settings UI wiring); toxicFailRateThreshold is the new
  // fail-rate cutoff, matching the same pattern as blacklistCandidateFailRate.
  toxicMinKillCount: 8,          // v21 — minimum total recorded picks (win+loss) for this league/market/odds-band before its fail rate is trusted at all
  toxicFailRateThreshold: 0.45,  // v21 — real fail rate (losses / (wins+losses)) required, same threshold as blacklistCandidateFailRate for consistency
  sectionASurvivalLabelMinLegs: 25, // v21 — Section A tickets at/above this leg count get an honest real-survival-rate label (info only, never changes what's built — see legCountSurvivalLabel)
  legOddsPreferredMin: 1.35, legOddsPreferredMax: 1.70, // v7 §2 — pool sections (B/D/E) only; Section A keeps the punter's own odds profile
  legOddsHardFloor: 1.28,        // v7 §2 — below this, a pool leg is last-resort filler only, flagged
  tierOverlapCapPct: 0.35,       // v7 §1 — max shared legs between any two Section B tiers, as a fraction of the smaller ticket's leg count
  // v8 §1 — buildCategoryVariants' own same-category overlap cap (still used
  // by test-moonshot-floor.js's regression coverage of that primitive).
  // The old per-tier maxVariantsTier1-4/Moonshot/Consensus/SureTier/Mix
  // knobs that used to gate HOW MANY near-duplicate tickets each pool
  // section could emit are gone (v38/v39) — GLOBAL sections are exactly 5,
  // fixed, deduplicated constructions, not a variant count to tune.
  variantOverlapCapPct: 0.40,
  // v8 §4 — Morning Readiness scheduler
  autoRunEnabled: false, autoRunHour: 8, autoRunMinute: 0, // Africa/Lagos local time; off by default
  // v9 — Global Builder draws the widest genuinely eligible construction
  // whenever the pool clears this size (see buildGlobalBuilder, v38).
  maxBuilderMinPoolSize: 15,
  maxBuilderPerSourceCap: 8, // v23 — max legs any single source/punter can contribute to Global Builder, so pool-wide breadth actually shows up instead of one punter's raw volume dominating
  maxVariantsGlobalBuilder: 5, // v40 — user feedback: Global Builder can be more than one — up to 5 non-overlapping numbered variants (Builder 1..5), sequential best-legs-first chunks
  variantOverlapCapMax: 0.60, variantOverlapCapStep: 0.05, // v9 §2 — progressive relaxation before giving up on a variant slot (buildCategoryVariants)
  // v38 — the live pipeline no longer targets these directly (Global
  // High-Risk has no fixed odds floor — see spec §G, "no arbitrary odds
  // targets"). Kept as named reference points ONLY because
  // test-moonshot-floor.js's permanent regression test still exercises
  // buildCategoryVariants' own odds-floor-enforcement primitive directly
  // against them — removing these would silently turn that test's floor
  // checks into `undefined` (always-pass) instead of a real assertion.
  moonshotMinOdds: 50000, moonshotLiteMinOdds: 15000, moonshotMiniMinOdds: 5000,
  minPunterSlipOdds: 500,     // v11 §4 — raised from the earlier 100 placeholder to the user's actual stated target
  // v10 §2 — blacklist-candidate gate: fail RATE + minimum sample, not raw
  // loss count (a good 83%-hit-rate league with high volume was getting
  // flagged purely for having played a lot of games). Variance threshold is
  // the day-level hit-rate standard deviation (in hitRate units, 0-1) above
  // which a league's results look non-random for a "safe" market rather
  // than just unlucky.
  blacklistCandidateFailRate: 0.45, blacklistCandidateMinSample: 12, leagueVarianceStdDevThreshold: 0.20,
  // v14 — the learning loop corrected PICK QUALITY (league/punter/market
  // down-weighting) but not TICKET SIZE: a 71% real leg hit rate still
  // produced 0/67 ticket wins because big accumulators are mathematically
  // near-unwinnable regardless of how good the legs are. These settings
  // govern the rolling observed-vs-theoretical win-rate-by-leg-count-bracket
  // check (see computeLegBracketSurvival) and the resulting build-time cap.
  legBracketRollingDays: 14,      // how many of the most recent settled scoreboard days to roll up
  legBracketMinSample: 30,        // minimum SETTLED tickets in a bracket before its win rate is trusted enough to cap or comment on
  legBracketCapThreshold: 0.02,   // observed ticket win rate at/below which a bracket is "historically near-impossible" (2%)
  allowBeyondProvenLegCount: false, // "Build tickets beyond the historically-proven-viable leg count" override — default OFF (capped)

  // v15 §1 — UNIVERSAL HARD FLOOR: replaces every prior per-section minimum
  // as the one non-bypassable gate. Enforced INSIDE generateTicketCode
  // itself (the single chokepoint every section calls through) so it can
  // never be skipped by a caller forgetting a pre-check — same
  // "impossible to forget" pattern v11 established for the Moonshot floor.
  // minPunterSlipOdds (500) is kept as Section A's PREFERRED removal-budget
  // stopping target (the "aim for" number), not the hard gate anymore —
  // this is the hard gate, and it is always lower than every other section
  // target in this file, so it never weakens anything, only backstops it.
  universalMinOdds: 100,
  // v38 — output-architecture redesign removed the old per-punter multi-
  // variant cap (maxVariantsSectionA) and the odds-band-coverage rebalance
  // system (oddsBands) entirely: Section A now always builds exactly ONE
  // ticket per eligible punter (see buildSectionA), and GLOBAL sections are
  // never built or padded to hit a target odds band (see buildGlobalSections
  // / spec §G — "do not use arbitrary odds targets to force tickets into
  // existence"). Nothing reads either key anymore; removed rather than left
  // as dead config that would misleadingly suggest they still do something.
};

// v6 — Generator Settings modal: persisted overrides layered under
// DEFAULT_CONFIG, and themselves overridden by an explicit per-run
// options.config (see runGenerator's cfg construction). Only the keys the
// settings UI actually exposes are meaningful here — saving is a full
// replace of this file, not a merge, so stale keys can't linger.
function loadSettings() { return safeJSON(SETTINGS_FILE, {}); }
function saveSettings(s) { saveJSON(SETTINGS_FILE, s); }

// ─── SMALL LOCAL DUPLICATES of intelligence-engine's non-exported helpers ──
// (punterLeagueHR / punterMarketHR read punter-specializations.json exactly
// like intelligence-engine.js does internally, but aren't exported — these
// mirror them exactly rather than re-deriving new logic.)
function punterLeagueHR(specMap, name, league) {
  const sp = specMap[name]; if (!sp) return null;
  const d = sp.byLeague?.[league];
  if (d && (d.w + d.l) >= 3) return d.hr;
  return sp.global || null;
}
function punterMarketHR(specMap, name, marketName) {
  const sp = specMap[name]; if (!sp) return null;
  const mn = (marketName || '').toLowerCase();
  const key = Object.keys(sp.byMarket || {}).find(k => mn.includes(k.toLowerCase().split(' ')[0]) || k.toLowerCase() === mn);
  if (key) { const d = sp.byMarket[key]; if ((d.w + d.l) >= 3) return d.hr; }
  return sp.global || null;
}

// ─── RUN REGISTRY (in-memory, backed by disk for resumability) ─────────────
const RUNS = new Map(); // runId -> { state, events: [], listeners: Set<res> }
const MAX_RUNS = 20;
const MAX_EVENTS_PER_RUN = 1000;

function newRunId() {
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function runStateFile(runId) { return path.join(AG_DIR, `run-state-${runId}.json`); }

function persistRunState(rec) {
  saveJSON(runStateFile(rec.state.runId), { state: rec.state, events: rec.events });
}

// True mid-flight resumption after a hard process crash/restart isn't
// implemented — the run's actual progress lives in this Node process's
// in-memory async call stack, which a restart destroys regardless of what's
// checkpointed to disk. Without this, a run interrupted by a restart would
// sit at status 'running' on disk forever: no process is left to ever move it
// to 'done' or 'error', so a reconnecting client would poll/retry endlessly
// against a run that's actually dead. On every server boot, any run-state
// file still claiming 'running'/'starting' is therefore, by definition,
// orphaned — finalize it honestly so the client gets a real terminal state
// ("interrupted by a server restart") instead of a false hang or a false
// "error" misattributed to the run's own logic.
function reconcileOrphanedRuns() {
  let files = [];
  try { files = fs.readdirSync(AG_DIR).filter(f => f.startsWith('run-state-') && f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const full = path.join(AG_DIR, f);
    const disk = safeJSON(full, null);
    if (!disk?.state) continue;
    if (disk.state.status === 'running' || disk.state.status === 'starting') {
      disk.state.status = 'error';
      disk.state.error = 'Interrupted by a server restart — this run did not complete. Please start a new one.';
      disk.state.finishedAt = disk.state.finishedAt || new Date().toISOString();
      disk.events = disk.events || [];
      disk.events.push({ seq: disk.events.length, type: 'run-error', data: { message: disk.state.error, seq: disk.events.length }, ts: new Date().toISOString() });
      saveJSON(full, disk);
    }
  }
}
reconcileOrphanedRuns();

function createRun(options) {
  const runId = newRunId();
  const rec = {
    state: {
      runId,
      status: 'starting', // starting|running|done|error
      startedAt: new Date().toISOString(),
      finishedAt: null,
      options,
      progressPct: 0,
      currentPhase: 'init',
      summary: null,
      error: null,
    },
    events: [],       // full replay log: {seq, type, data, ts}
    listeners: new Set(),
    stopRequested: false, // v6 — in-memory only; a process restart already resolves via reconcileOrphanedRuns
  };
  RUNS.set(runId, rec);
  while (RUNS.size > MAX_RUNS) {
    const oldest = RUNS.keys().next().value;
    const old = RUNS.get(oldest);
    if (old?.state?.status === 'running') break;
    RUNS.delete(oldest);
  }
  persistRunState(rec);
  return rec;
}

// v6 — graceful stop: sets a flag checked between loop iterations in Phases
// 1 and 3 (the only long-running ones). In-flight API calls already
// dispatched are allowed to finish; no NEW work is picked up after. The run
// then proceeds through its normal section-building/persist path using
// whatever was collected/scored so far, and finishes with status 'stopped'
// instead of 'done' — never an orphaned or silently-discarded partial run.
function requestStop(runId) {
  const rec = getRun(runId);
  if (!rec || rec.state.status !== 'running') return false;
  rec.stopRequested = true;
  log(rec, '⏹ Stop requested — finishing in-flight work, then building final output from what has been collected so far.');
  return true;
}

function emit(rec, type, data) {
  const ev = { seq: rec.events.length, type, data, ts: new Date().toISOString() };
  rec.events.push(ev);
  if (rec.events.length > MAX_EVENTS_PER_RUN) rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_RUN);
  // trim in-memory buffer softly, keep disk copy authoritative
  if (rec.events.length % 10 === 0) persistRunState(rec);
  const payload = `event: ${type}\ndata: ${JSON.stringify({ ...data, seq: ev.seq })}\n\n`;
  for (const res of rec.listeners) { try { res.write(payload); } catch {} }
}

function log(rec, msg) {
  emit(rec, 'log', { msg });
  console.log(`[adv-gen ${rec.state.runId}]`, msg);
}

function setPhase(rec, phase, pct) {
  rec.state.currentPhase = phase;
  if (pct != null) rec.state.progressPct = pct;
  emit(rec, 'phase', { phase, pct: rec.state.progressPct });
}

function getRun(runId) {
  if (RUNS.has(runId)) return RUNS.get(runId);
  // Reload from disk for resumability across restarts
  const disk = safeJSON(runStateFile(runId), null);
  if (!disk) return null;
  const rec = { state: disk.state, events: disk.events || [], listeners: new Set() };
  RUNS.set(runId, rec);
  while (RUNS.size > MAX_RUNS) RUNS.delete(RUNS.keys().next().value);
  return rec;
}

function getLatestRunId() {
  try {
    const files = fs.readdirSync(AG_DIR).filter(f => f.startsWith('run-state-') && f.endsWith('.json'));
    if (!files.length) return null;
    files.sort((a, b) => fs.statSync(path.join(AG_DIR, b)).mtimeMs - fs.statSync(path.join(AG_DIR, a)).mtimeMs);
    const disk = safeJSON(path.join(AG_DIR, files[0]), null);
    return disk?.state?.runId || null;
  } catch { return null; }
}

function subscribe(runId, res) {
  const rec = getRun(runId);
  if (!rec) return false;
  rec.listeners.add(res);
  res.once('close', () => rec.listeners.delete(res));
  return true;
}

// ─── NETWORK HELPERS ─────────────────────────────────────────────────────────
// v46 — REAL BUG: SportyBet's CloudFront WAF started 403-blocking the bare
// "Mozilla/5.0" User-Agent (confirmed live 2026-09-09 in server.js's
// fetchJSON — same endpoint, fuller UA string, 403 vs 200 back to back).
// That fix never made it here: this function is a locally-defined duplicate
// rather than a reuse of server.js's already-fixed fetchJSON, so every
// Advanced Generator run was silently getting a CloudFront HTML error page
// for every single punter code ("Unexpected token '<' ... is not valid
// JSON"), which then tripped the "not enough legs collected" abort. Matches
// the fuller UA + Referer combo fetchJSONWithStatus already uses.
function sbGetBooking(code) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'www.sportybet.com',
      path: '/api/ng/orders/share/' + encodeURIComponent(code),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sportybet.com/ng/',
      },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Loopback call into this same server's own /api/h2h and /api/scan endpoints —
// reuses the exact same H2H/verdict logic already live in server.js instead
// of re-implementing API-Football / TheSportsDB / scan calls a second time.
// v25 — REAL BUG: /api/h2h is gated by checkApiLimit at 50 calls/day per IP
// (meant to protect the public-facing H2H lookup from abuse). This loopback
// call has no admin auth, so on a day with hundreds of legs to score, it
// silently exhausted that SAME public budget within the first ~50 legs —
// every leg scored after that got h2h.available=false and never actually
// used real head-to-head data, no matter how the FinalScore weights were
// tuned. Sending the admin key here (loopback-only, never leaves the box)
// makes checkApiLimit treat it like the other admin routes: uncapped.
function internalGet(baseUrl, pathAndQuery) {
  return new Promise((resolve) => {
    try {
      const url = new URL(pathAndQuery, baseUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = process.env.ADMIN_PASSWORD ? { 'x-admin-key': process.env.ADMIN_PASSWORD } : {};
      const req = mod.get(url, { timeout: 8000, headers }, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ─── DATA LOADERS ────────────────────────────────────────────────────────────
// v41 — REAL BUG (user report: "today generator shouldn't mix with
// yesterday"): server.js's OWN loadPunterCodes() (used by the admin
// punter-codes editor) already checks `raw._date !== today` and returns
// blanks when the file is stale — but this engine had its own SEPARATE
// loader that only stripped the `_date` key itself and returned every
// other field regardless of age. If a punter's code was never resubmitted
// today (admin editor shows them correctly as blank), the generator would
// still silently fetch and use yesterday's — or older — code as if it were
// today's input, bounded only by the 5-day maxKickoffDaysAhead window. Now
// mirrors the exact same staleness check the admin UI already uses, so
// "what the punter-codes panel shows" and "what the generator actually
// uses" can never diverge again.
function loadPunterMap() {
  const raw = safeJSON(PUNTER_CODES_FILE, {});
  const today = localToday();
  if (raw._date !== today) return {}; // stale file — nothing was submitted today
  const map = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || k.startsWith('_')) continue;
    if (!v) continue;
    map[k] = v;
  }
  return map;
}

// v3.1 §2 — two-tier blacklist. HARD = proven killers, always excluded.
// SOFT = volatile-but-huge categories (friendlies) that get a score penalty
// and a per-ticket cap instead of exclusion — hard-banning friendlies during
// preseason (Jun-Aug) deletes half the pool; penalty+cap keeps volume while
// containing the risk. Auto-migrates the v2 single-list shape on first load.
const FRIENDLY_RE = /friendly|friendlies/i;
function loadBlacklist() {
  const raw = safeJSON(BLACKLIST_FILE, null);
  if (raw && Array.isArray(raw.hard) && Array.isArray(raw.soft)) return raw;

  const legacyLeagues = raw?.leagues || [
    'Kolmonen', 'USL League Two', 'Club Friendly Women', 'Club Friendly Games',
    'International Friendly Games', 'Friendlies', '3. deild', '4. deild', '5. deild',
  ];
  const migrated = {
    hard: legacyLeagues.filter(l => !FRIENDLY_RE.test(l)),
    soft: legacyLeagues.filter(l => FRIENDLY_RE.test(l)),
    note: 'HARD = always excluded (proven killers). SOFT = penalty + per-ticket cap, not excluded — preseason friendlies dominate the pool Jun-Aug; hard-banning them deletes half the pool, penalty+cap keeps volume while containing risk.',
    updatedAt: new Date().toISOString(),
  };
  saveBlacklist(migrated);
  return migrated;
}
function saveBlacklist(list) { saveJSON(BLACKLIST_FILE, list); }

function loadFloorState() {
  return safeJSON(FLOOR_STATE_FILE, { floor: DEFAULT_CONFIG.confidenceFloor, lastCoverage: null, updatedAt: null });
}
function saveFloorState(s) { saveJSON(FLOOR_STATE_FILE, s); }

function loadDropLearning() { return safeJSON(DROP_LEARNING_FILE, {}); }
function saveDropLearning(d) { saveJSON(DROP_LEARNING_FILE, d); }

function tallyVerdicts(legs, verdictByKey) {
  let won = 0, lost = 0;
  for (const l of legs) {
    const v = verdictByKey[`${l.eventId}|${l.marketId}|${l.specifier}|${l.outcomeId}`];
    if (v === 'WON') won++; else if (v === 'LOST') lost++;
  }
  return { won, lost };
}

// v21 — REAL BUG (forensic audit, ugochukwu 2026-07-25): late-leg-drop
// ("drop the last N legs by kickoff — they're riskier") was a day-one
// hypothesis that was NEVER actually validated, and the per-punter learning
// loop meant to adapt it — dl.n, per punter — had silently never worked:
// every punter sat at the hardcoded default (n=3) with an empty history
// despite hundreds of settled runs recorded. The old code only incremented
// a counter inside the LOST-leg loop; it never touched dl.n and never
// recorded which legs were even in the "dropped" position. This rebuilds
// the real thing: for each punter, reconstruct the FULL (kept+dropped)
// leg list sorted by kickoff, get real settled verdicts for ALL of it
// (including the legs that were dropped and never made it into any built
// ticket — they don't exist in any ticket's own scan, so this scans the
// punter's ORIGINAL code directly), and tests whether the actual last-1/
// last-2/last-3 legs by kickoff really do lose more than the rest — using
// a rolling window of real days, not a single day's noise, and requiring
// both a minimum sample AND a meaningful (not tiny) margin before trusting
// a nonzero N. Overall audit across all history: dropped legs won 75.7%
// (n=218) vs kept legs 69.1% (n=2435) — the assumption is backwards on
// aggregate — so most punters should end up at n=0 once real evidence
// accumulates, and that's the correct, evidence-driven outcome, not a bug.
async function updateDropLearningForDate(dateStr, todaysRuns, internalBaseUrl, dropLearning, logger) {
  const bySourceCode = new Map();
  for (const run of todaysRuns) {
    const raw = safeJSON(path.join(AG_DIR, `raw-${run.runId}.json`), null);
    if (!raw) continue;
    for (const src of (raw.perSourceLegs || [])) {
      const key = src.source + '|' + src.code;
      if (!bySourceCode.has(key)) bySourceCode.set(key, { source: src.source, code: src.code, legs: [...(src.legs || []), ...(src.droppedLegs || [])] });
    }
  }
  if (!bySourceCode.size) return;

  const uniqueCodes = [...new Set([...bySourceCode.values()].map(e => e.code))];
  const scanCache = {};
  for (const code of uniqueCodes) {
    const scan = await internalGet(internalBaseUrl, `/api/scan/${encodeURIComponent(code)}`);
    if (scan && scan.results) scanCache[code] = scan;
    await new Promise(r => setTimeout(r, 150)); // rate-limit, same courtesy as leg collection
  }

  const perPunterToday = {};
  for (const { source, code, legs } of bySourceCode.values()) {
    const scan = scanCache[code];
    if (!scan) continue;
    const verdictByKey = {};
    for (const r of scan.results) verdictByKey[`${r.eventId}|${r.marketId}|${r.specifier}|${r.outcomeId}`] = r.verdict;
    const sorted = [...legs].sort((a, b) => a.kick - b.kick);
    const n = sorted.length;
    if (n < 4) continue; // too few legs to test a 1-3 leg drop meaningfully
    if (!perPunterToday[source]) perPunterToday[source] = { last1: { won: 0, lost: 0 }, last2: { won: 0, lost: 0 }, last3: { won: 0, lost: 0 }, total: { won: 0, lost: 0 } };
    const agg = perPunterToday[source];
    const t1 = tallyVerdicts(sorted.slice(Math.max(0, n - 1)), verdictByKey);
    const t2 = tallyVerdicts(sorted.slice(Math.max(0, n - 2)), verdictByKey);
    const t3 = tallyVerdicts(sorted.slice(Math.max(0, n - 3)), verdictByKey);
    const tAll = tallyVerdicts(sorted, verdictByKey);
    agg.last1.won += t1.won; agg.last1.lost += t1.lost;
    agg.last2.won += t2.won; agg.last2.lost += t2.lost;
    agg.last3.won += t3.won; agg.last3.lost += t3.lost;
    agg.total.won += tAll.won; agg.total.lost += tAll.lost;
  }

  const MIN_SAMPLE = 15, MARGIN_PCT = 8; // require both real sample size AND a meaningfully lower win rate, not just any gap
  for (const [source, agg] of Object.entries(perPunterToday)) {
    const dl = dropLearning[source] || { n: DEFAULT_CONFIG.lateLegDropDefaultN, settledRuns: 0, history: [] };
    dl.history = (dl.history || []).filter(h => h.date !== dateStr);
    dl.history.push({ date: dateStr, last1: agg.last1, last2: agg.last2, last3: agg.last3, total: agg.total });
    dl.history = dl.history.slice(-45); // rolling ~45-day window

    const sumField = (field) => dl.history.reduce((s, h) => ({ won: s.won + (h[field]?.won || 0), lost: s.lost + (h[field]?.lost || 0) }), { won: 0, lost: 0 });
    const totalAgg = sumField('total');
    let chosenN = 0, evidence = null;
    for (const N of [3, 2, 1]) {
      const lastAgg = sumField('last' + N);
      const lastSample = lastAgg.won + lastAgg.lost;
      const restWon = totalAgg.won - lastAgg.won, restLost = totalAgg.lost - lastAgg.lost;
      const restSample = restWon + restLost;
      if (lastSample < MIN_SAMPLE || restSample < MIN_SAMPLE) continue;
      const lastRate = lastAgg.won / lastSample, restRate = restWon / restSample;
      if ((restRate - lastRate) * 100 >= MARGIN_PCT) { chosenN = N; evidence = { lastRatePct: Math.round(lastRate * 1000) / 10, restRatePct: Math.round(restRate * 1000) / 10, lastSample, restSample }; break; }
    }
    dl.n = chosenN;
    dl.settledRuns = dl.history.length; // v21 — now genuinely "days of real evidence in the rolling window", not a per-lost-leg counter that never meant anything
    dropLearning[source] = dl;
    logger(`  [drop-learning] ${source}: n=${chosenN}${evidence ? ` (last-${chosenN} legs win ${evidence.lastRatePct}% vs rest ${evidence.restRatePct}%, n=${evidence.lastSample}/${evidence.restSample})` : ' (no N showed a real, meaningful edge — dropping nothing)'}`);
  }
}

function loadConversionLearning() { return safeJSON(CONVERSION_LEARNING_FILE, {}); }
function saveConversionLearning(d) { saveJSON(CONVERSION_LEARNING_FILE, d); }

function loadDownweights() { return safeJSON(DOWNWEIGHTS_FILE, { punters: {}, leagues: {}, markets: {} }); }
function saveDownweights(d) { saveJSON(DOWNWEIGHTS_FILE, d); }

// Dynamic community-source trust: hit-rate computed from that source's own
// settled community-codes entries. Sources with < 3 settled codes, or below
// the configured floor, are excluded — never hardcoded by name (spec §6).
function communitySourceHitRates() {
  const rows = safeJSON(COMMUNITY_CODES_FILE, []);
  const bySource = {};
  for (const r of rows) {
    if (!r.source) continue;
    const sr = r.scanResult;
    if (!sr || typeof sr.won !== 'number' || typeof sr.lost !== 'number') continue;
    const settled = sr.won + sr.lost;
    if (settled === 0) continue;
    if (!bySource[r.source]) bySource[r.source] = { won: 0, lost: 0, codes: 0 };
    bySource[r.source].won += sr.won;
    bySource[r.source].lost += sr.lost;
    bySource[r.source].codes++;
  }
  const out = {};
  for (const [src, d] of Object.entries(bySource)) {
    if (d.codes < 3) continue; // not enough settled history to trust yet
    out[src] = Math.round((d.won / (d.won + d.lost)) * 100);
  }
  return out;
}

// v41 — REAL BUG (same class as loadPunterMap, same user report): every row
// in community-codes.json was treated as live input for EVERY future run,
// forever — nothing ever checked `dateAdded` against today. Confirmed on
// real data: 28 stored rows, zero from today, several over a month old
// (2026-07-08 through 2026-07-31) — every one of them was silently being
// re-fetched as if freshly submitted, on every single run, bounded only by
// the 5-day kickoff window and the source's hit-rate bar. Note
// communitySourceHitRates() (above) deliberately still reads ALL historical
// rows regardless of date — that's legitimate, intentional trust-scoring
// (the same kind of historical learning league-intelligence.json already
// does), not a leak; only THIS function (which decides which CODES actually
// get fetched as today's input) needed the freshness gate.
function loadCommunityMap(minHitRate) {
  const rows = safeJSON(COMMUNITY_CODES_FILE, []);
  const today = localToday();
  const hrBySource = communitySourceHitRates();
  const trusted = [];
  for (const r of rows) {
    if (!r.code || !r.source) continue;
    if (r.dateAdded !== today) continue; // stale — not submitted today, never live input
    const hr = hrBySource[r.source];
    if (hr == null || hr < minHitRate) continue; // untrusted or not enough settled history
    trusted.push({ source: r.source, code: r.code, sourceHitRate: hr });
  }
  return trusted;
}

// ─── PHASE 1 — COLLECT ───────────────────────────────────────────────────────
async function collectRawLegs(punterMap, communityList, cfg, dropLearning, rec) {
  const now = Date.now();
  const cutoff = now + cfg.maxKickoffDaysAhead * 86400000;
  const allSources = [
    ...Object.entries(punterMap).map(([name, code]) => ({ name, code, kind: 'punter' })),
    ...communityList.map(c => ({ name: c.source, code: c.code, kind: 'community', sourceHitRate: c.sourceHitRate })),
  ];

  const perSourceLegs = []; // { source, kind, legs: [...] }
  const nonFootballLegs = []; // v7 §3 — collected separately, never mixed into the football pipeline (different sport = different calibration)
  let idx = 0;
  for (const src of allSources) {
    if (rec.stopRequested) { log(rec, `  ⏹ Stop honored during collection — ${idx}/${allSources.length} sources fetched; using those.`); break; }
    idx++;
    setPhase(rec, 'collect', Math.round((idx / allSources.length) * 15));
    let codeList = [];
    if (Array.isArray(src.code)) codeList = src.code.map(c => String(c).trim().toUpperCase()).filter(Boolean);
    else if (typeof src.code === 'string' && src.code.includes(',')) codeList = src.code.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    else if (typeof src.code === 'string' && src.code.trim()) codeList = [src.code.trim().toUpperCase()];
    if (!codeList.length) continue;

    for (const codeStr of codeList) {
      try {
        const j = await sbGetBooking(codeStr);
        if (!j || j.bizCode !== 10000 || !j.data) {
          log(rec, `  ✗ ${src.name} [${codeStr}]: ${j?.message || j?.innerMsg || 'invalid/expired code'} — skipped`);
          continue;
        }
        const outcomes = j.data.outcomes || [];
        const ticketSels = j.data.ticket?.selections || [];
        const ticketMap = new Map(ticketSels.map(ts => [ts.eventId, ts]));

        const legs = [];
        for (const o of outcomes) {
          const ms = (o.matchStatus || '').toLowerCase();
          if (['ended', 'h1', 'h2', 'ht', 'p1', 'p2', 'inprogress'].includes(ms)) continue;
          const kick = o.estimateStartTime || 0;
          if (!kick || kick <= now || kick > cutoff) continue; // §0.5 — started or >5 days out
          if (o.sport?.id && o.sport.id !== 'sr:sport:1') {
            // v7 §3 — non-football (table tennis/Setka, basketball, etc.).
            // Never runs through the football-calibrated scoring pipeline
            // (team-form/league-intel/market-safety table are all football-
            // specific) — collected separately for the lightweight Non-
            // football ticket, per the original spec's own warning: "tt-*.js
            // engines are Table Tennis (Setka) only. Never run football
            // codes through them or vice versa."
            const mktNF = (o.markets || [])[0] || {};
            const pickNF = (mktNF.outcomes || [])[0] || {};
            const tsNF = ticketMap.get(o.eventId) || {};
            nonFootballLegs.push({
              source: src.name, sourceKind: src.kind, code: codeStr, sourceHitRate: src.sourceHitRate || null,
              eventId: String(o.eventId), homeTeam: o.homeTeamName || '', awayTeam: o.awayTeamName || '',
              league: o.sport?.category?.tournament?.name || o.sport?.category?.name || '',
              sportName: o.sport?.name || 'Non-football', kickoff: new Date(kick).toISOString(), kick,
              marketId: String(tsNF.marketId || mktNF.id || ''), marketName: mktNF.desc || ('Mkt' + (tsNF.marketId || mktNF.id || '')),
              specifier: tsNF.specifier || mktNF.specifier || '', outcomeId: String(tsNF.outcomeId || pickNF.id || ''),
              outcomeName: pickNF.desc || '', odds: parseFloat(tsNF.odds || pickNF.odds || 1),
              productId: tsNF.productId || mktNF.product || 3, sportId: String(o.sport?.id || ''),
            });
            continue;
          }

          const mkt  = (o.markets || [])[0] || {};
          const pick = (mkt.outcomes || [])[0] || {};
          const ts   = ticketMap.get(o.eventId) || {};

          legs.push({
            source: src.name, sourceKind: src.kind, code: codeStr,
            sourceHitRate: src.sourceHitRate || null,
            eventId: String(o.eventId),
            homeTeam: o.homeTeamName || '', awayTeam: o.awayTeamName || '',
            league: o.sport?.category?.tournament?.name || o.sport?.category?.name || '',
            category: o.sport?.category?.name || '',
            kickoff: new Date(kick).toISOString(), kick,
            marketId: String(ts.marketId || mkt.id || ''),
            marketName: mkt.desc || ('Mkt' + (ts.marketId || mkt.id || '')),
            specifier: ts.specifier || mkt.specifier || '',
            outcomeId: String(ts.outcomeId || pick.id || ''),
            outcomeName: pick.desc || '',
            odds: parseFloat(ts.odds || pick.odds || 1),
            productId: ts.productId || mkt.product || 3,
            sportId: String(o.sport?.id || 'sr:sport:1'),
          });
        }
        // ── Late-leg removal (§1) — sort by kickoff ascending, drop last N ──
        legs.sort((a, b) => a.kick - b.kick);
        const learned = dropLearning[src.name];
        const dropN = (learned && learned.settledRuns >= 5) ? learned.n : cfg.lateLegDropDefaultN;
        const kept = dropN > 0 ? legs.slice(0, Math.max(0, legs.length - dropN)) : legs;
        const dropped = legs.slice(kept.length);
        for (const l of kept) l._dropN = dropN; // tag for drop-learning comparison later
        for (const l of dropped) l._droppedLate = true;

        log(rec, `  ${src.name} (${codeStr}): ${legs.length} upcoming, dropped last ${dropped.length} legs (N=${dropN}) → ${kept.length} kept`);
        perSourceLegs.push({ source: src.name, kind: src.kind, code: codeStr, legs: kept, droppedLegs: dropped });
        await new Promise(r => setTimeout(r, 150)); // rate-limit
      } catch (e) {
        log(rec, `  ✗ ${src.name} [${codeStr}]: ERROR — ${e.message}`);
      }
    }
  }
  return { perSourceLegs, nonFootballLegs };
}

// v38 — PUNTER_POOL grouping. perSourceLegs stays exactly per-CODE (drop-
// learning in updateDropLearningForDate and the raw-<runId>.json persistence
// are both keyed by source+code and must not change shape). But treating
// each of a punter's comma-separated codes as an independent "source" was
// the actual root cause of the reported variant explosion: a punter who
// submitted 2 codes today produced 2 fully independent Section A entries —
// each with its own up-to-3 variants — for what is really ONE punter's
// picks for the day. This groups perSourceLegs back into one pool PER
// PUNTER (their multiple codes are inputs to that pool, not separate final
// tickets), deduping a punter's own repeated pick across their own codes to
// count once. Section A now builds from this grouped view, not from
// perSourceLegs directly.
function groupPerSourceLegsByPunter(perSourceLegs) {
  const bySource = new Map();
  for (const src of perSourceLegs) {
    if (src.kind !== 'punter') continue;
    if (!bySource.has(src.source)) bySource.set(src.source, { source: src.source, kind: 'punter', codes: [], legs: [], droppedLegs: [] });
    const g = bySource.get(src.source);
    g.codes.push(src.code);
    g.legs.push(...src.legs);
    g.droppedLegs.push(...src.droppedLegs);
  }
  for (const g of bySource.values()) {
    const seen = new Set();
    const deduped = [];
    let dupesWithinPunter = 0;
    for (const l of g.legs) {
      const k = `${l.eventId}|${l.marketId}|${l.specifier}|${l.outcomeId}`;
      if (seen.has(k)) { dupesWithinPunter++; continue; }
      seen.add(k);
      deduped.push(l);
    }
    g.legs = deduped;
    g.dupesWithinPunter = dupesWithinPunter;
  }
  return [...bySource.values()];
}

// v7 §3 — lightweight non-football scoring: odds-value + community/punter
// consensus only. Deliberately does NOT use team-form, league-intel, or the
// market-safety table — those are all calibrated from football settled
// history and would be dishonest to apply to a different sport. Ranked and
// filtered on this narrower basis, then built into one ticket if the pool
// supports it.
async function buildNonFootballTicket(nonFootballLegs, deps, cfg, exposure, rec) {
  if (!nonFootballLegs.length) { log(rec, '  [Non-football] No non-football legs from tracked punters today.'); return null; }
  const byMatchOutcome = {};
  for (const l of nonFootballLegs) {
    const k = `${l.eventId}|${l.marketId}|${l.specifier}|${l.outcomeId}`;
    (byMatchOutcome[k] = byMatchOutcome[k] || []).push(l);
  }
  const scored = nonFootballLegs.map(l => {
    const k = `${l.eventId}|${l.marketId}|${l.specifier}|${l.outcomeId}`;
    const cc = communityConsensusComponent(l, byMatchOutcome[k] || [l]);
    const ov = oddsValueComponent(l);
    const pa = punterAccuracyComponent(l, deps);
    const score = Math.round(pa.score * 0.5 + cc.score * 0.2 + ov.score * 0.3);
    return { ...l, matchKey: k, finalScore: score, avgConfidence: score, sourceCount: (byMatchOutcome[k] || [l]).length, reasons: ['Non-football — lightweight scoring (odds-value + consensus + punter accuracy only; full risk model is football-calibrated)'], components: {}, converted: false };
  });
  const gameMap = {};
  for (const p of scored) { if (!gameMap[p.eventId] || p.finalScore > gameMap[p.eventId].finalScore) gameMap[p.eventId] = p; }
  const ranked = Object.values(gameMap).sort((a, b) => b.finalScore - a.finalScore);
  if (ranked.length < 8) { log(rec, `  [Non-football] Only ${ranked.length} distinct non-football games available — need ≥8 for a ticket. No non-football ticket built today.`); return null; }

  const usedEventIds = new Set();
  const picks = selectPicksForTicket(ranked, Math.min(20, ranked.length), cfg, exposure, usedEventIds);
  if (picks.length < 8) { log(rec, `  [Non-football] Only ${picks.length} picks survived exposure caps — skipped.`); return null; }
  const gen = await generateTicketCode(picks, m => log(rec, m));
  if (!gen) { log(rec, '  [Non-football] Code generation failed.'); return null; }
  const { code, picks: finalPicks } = gen;
  const odds = computeOdds(finalPicks);
  const sports = [...new Set(finalPicks.map(p => p.sportName))];
  const entry = {
    section: 'B', tier: 'Non-Football', mode: 'Non-football', code, legCount: finalPicks.length,
    odds: Math.round(odds * 100) / 100, avgConfidence: Math.round(finalPicks.reduce((s, p) => s + p.finalScore, 0) / finalPicks.length),
    sports, picks: finalPicks,
  };
  emit(rec, 'code', entry);
  log(rec, `  ✓ [Non-Football] ${code} | ${finalPicks.length}g | ${fmtOdds(odds)} | sports: ${sports.join(', ')}`);
  return entry;
}

// ─── PHASE 2 — SCORE (7-factor weighted FinalScore) ─────────────────────────
// League-goal-environment proxy: since league-intelligence.json only stores
// {won,lost,hitRate} (no raw match scores), a genuine 0-0 rate can't be
// computed. Instead we compute a real, honestly-labelled proxy — the
// historical hit rate of goals markets (Over/Under, GG/NG) in that league,
// pulled from data/reports/*.json leagueWatch.markets — and use that to
// flag "goals markets underperform here" rather than inventing a 0-0%.
function buildLeagueGoalsProxy(logger) {
  const cached = safeJSON(LEAGUE_EXT_FILE, null);
  if (cached && cached.builtDate === localToday()) return cached.leagues;

  const leagues = {};
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-30);
    for (const f of files) {
      const rpt = safeJSON(path.join(REPORTS_DIR, f), null);
      const lw = rpt?.analysis?.leagueWatch;
      if (!lw) continue;
      for (const [league, d] of Object.entries(lw)) {
        if (!leagues[league]) leagues[league] = { goalsWon: 0, goalsLost: 0, homeWon: 0, homeLost: 0, awayWon: 0, awayLost: 0, drawWon: 0, drawLost: 0 };
        for (const [mktName, m] of Object.entries(d.markets || {})) {
          const mn = mktName.toLowerCase();
          if (mn.includes('over/under') || mn.includes('gg/ng')) {
            leagues[league].goalsWon += m.won || 0; leagues[league].goalsLost += m.lost || 0;
          }
        }
      }
    }
  } catch (e) { logger && logger(`  League goals-proxy build warning: ${e.message}`); }

  const out = {};
  for (const [league, d] of Object.entries(leagues)) {
    const total = d.goalsWon + d.goalsLost;
    out[league] = total >= 5 ? { goalsMarketHitRate: Math.round((d.goalsWon / total) * 100), samples: total } : null;
  }
  saveJSON(LEAGUE_EXT_FILE, { builtDate: localToday(), leagues: out });
  return out;
}

// v10 §2 — per-day per-league hit rate, for the blacklist-candidate
// variance signal. A league should only be flagged as suspect (possible
// fixing/manipulation, not just "unlucky") when it has BOTH a low overall
// hit rate AND its DAY-TO-DAY hit rate swings wildly — a merely mediocre
// but stable league (~55% every day) is not suspicious, it's just moderate.
function buildLeagueDailyStats(logger) {
  const dailyRates = {}; // league -> [{date, won, lost, hitRate}]
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-30);
    for (const f of files) {
      const rpt = safeJSON(path.join(REPORTS_DIR, f), null);
      const lw = rpt?.analysis?.leagueWatch;
      if (!lw) continue;
      const date = f.replace('.json', '');
      for (const [league, d] of Object.entries(lw)) {
        let won = 0, lost = 0;
        for (const m of Object.values(d.markets || {})) { won += m.won || 0; lost += m.lost || 0; }
        const settled = won + lost;
        if (settled < 3) continue; // too thin a day to say anything about that league
        (dailyRates[league] = dailyRates[league] || []).push({ date, won, lost, hitRate: won / settled });
      }
    }
  } catch (e) { logger && logger(`  League daily-variance build warning: ${e.message}`); }
  return dailyRates;
}

// Population variance of day-level hit rates. Needs several distinct days
// to mean anything — returns null (not a fabricated 0) below that.
function leagueVariance(dayRows) {
  if (!dayRows || dayRows.length < 4) return null;
  const rates = dayRows.map(d => d.hitRate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length;
  return { stdDev: Math.sqrt(variance), days: dayRows.length, mean: Math.round(mean * 100) };
}

// v3.1 §1 — "available" now means real settled samples clear the threshold;
// when unavailable, this factor drops out of the weighted sum entirely
// (scoreLeg redistributes its weight) rather than anchoring the leg at a
// crushing neutral 55 that no market-safety/punter-accuracy score can offset.
function teamFormComponent(leg, teamIntel, cfg) {
  const h = teamIntel[leg.homeTeam], a = teamIntel[leg.awayTeam];
  const scores = [];
  if (h?.home?.hitRate != null && (h.home.won + h.home.lost) >= cfg.minSettledForTeamForm) scores.push(h.home.hitRate);
  if (a?.away?.hitRate != null && (a.away.won + a.away.lost) >= cfg.minSettledForTeamForm) scores.push(a.away.hitRate);
  if (!scores.length) return { score: null, available: false };
  return { score: Math.round(scores.reduce((s, v) => s + v, 0) / scores.length), available: true };
}

function leagueIntelComponent(leg, leagueIntel, goalsProxy, cfg) {
  const li = leagueIntel[leg.league];
  const available = !!(li && (li.won + li.lost) >= cfg.minSettledForLeagueIntel);
  let score = available ? li.hitRate : null;
  const gp = goalsProxy[leg.league];
  const isGoalsMarket = /over\/under|gg\/ng/i.test(leg.marketName);
  const reasons = [];
  if (available && isGoalsMarket && gp && gp.samples >= 8 && gp.goalsMarketHitRate < 50) {
    score = Math.round(score * 0.85); // low-scoring-league penalty for goals markets specifically
    reasons.push(`Goals markets hit only ${gp.goalsMarketHitRate}% historically in ${leg.league} (${gp.samples} samples) — treated as elevated 0-0/low-scoring risk`);
  }
  return { score: available ? Math.max(0, Math.min(100, score)) : null, available, reasons };
}

function punterAccuracyComponent(leg, deps) {
  const { lbMap, profMap, specMap } = deps;
  const pd = getPunterData(lbMap, profMap, leg.source);
  const leagueHR = punterLeagueHR(specMap, leg.source, leg.league);
  const marketHR = punterMarketHR(specMap, leg.source, leg.marketName);
  const parts = [pd.formScore];
  if (leagueHR != null) parts.push(leagueHR);
  if (marketHR != null) parts.push(marketHR);
  const score = Math.round(parts.reduce((s, v) => s + v, 0) / parts.length);
  return { score, tier: pd.tier, formScore: pd.formScore };
}

// v36 — REAL BUG: this checked `ks.homeWinPct`/`ks.awayWinPct`, field names
// no data source anywhere in the codebase ever produces (the real field,
// set by apiFootballH2H in server.js, is `homeWinRate`) — always undefined,
// so every Home/Away-shaped pick silently fell through to the hardcoded
// `score = 55` default while still being reported as `available: true`.
// That's worse than just missing data: it told FinalScore "real H2H backs
// this pick" (full weight, activeFactors includes 'h2h', no thin-data
// penalty) when it was actually a meaningless constant every time — for a
// factor worth 10% of the whole score (cfg.weights.h2h). Fixed to read the
// real field, and to correctly report `available: false` (weight properly
// redistributes to the other real factors, per the thin-data penalty logic
// above) for any market shape H2H data genuinely can't speak to, instead of
// silently faking a neutral score for it. Also added the BTTS/GG-NG branch,
// which had no H2H mapping at all before.
async function h2hComponent(leg, internalBaseUrl) {
  if (!internalBaseUrl) return { score: null, available: false };
  const j = await internalGet(internalBaseUrl, `/api/h2h?eventId=${encodeURIComponent(leg.eventId)}&home=${encodeURIComponent(leg.homeTeam)}&away=${encodeURIComponent(leg.awayTeam)}`);
  if (!j || !j.found || !j.keyStats) return { score: null, available: false };
  const ks = j.keyStats;
  const out = (leg.outcomeName || '').toLowerCase();
  const mkt = (leg.marketName || '').toLowerCase();

  if ((out.includes('home') || out.includes('away')) && typeof ks.homeWinRate === 'number') {
    const rate = out.includes('home') ? ks.homeWinRate : (100 - ks.homeWinRate);
    return { score: Math.max(0, Math.min(100, Math.round(rate))), available: true };
  }
  if (typeof ks.avgGoals === 'number' && /over|under/.test(out)) {
    const line = getLine(leg.marketName, leg.specifier, leg.outcomeName);
    const score = out.includes('over') ? (ks.avgGoals > line ? 65 : 45) : (ks.avgGoals < line ? 65 : 45);
    return { score, available: true };
  }
  if (typeof ks.bttsPct === 'number' && (mkt.includes('gg') || mkt.includes('both teams'))) {
    if (out === 'yes') return { score: ks.bttsPct >= 65 ? 70 : ks.bttsPct <= 25 ? 30 : 50, available: true };
    if (out === 'no')  return { score: ks.bttsPct <= 25 ? 70 : ks.bttsPct >= 65 ? 30 : 50, available: true };
  }
  // Real H2H data exists for this match, but doesn't map to this pick's
  // market shape (e.g. Double Chance, Draw No Bet, Handicap) — honestly
  // unavailable rather than a faked neutral score.
  return { score: null, available: false };
}

function communityConsensusComponent(leg, allLegsForEvent) {
  // Count distinct sources (punters + trusted community) backing this exact
  // event+market+outcome. Capped, diminishing returns — never the dominant factor.
  const n = allLegsForEvent.length;
  if (n <= 1) return { score: 50, count: n };
  const bonus = Math.min(35, (n - 1) * 10);
  return { score: 50 + bonus, count: n };
}

function oddsValueComponent(leg) {
  const o = leg.odds;
  if (!o || o <= 1.0) return { score: 40 };
  if (o >= 1.80 && o <= 2.20) return { score: 75 };
  if (o >= 1.45) return { score: 65 };
  if (o >= 1.25) return { score: 55 };
  if (o > 1.10) return { score: 40 };
  return { score: 30 }; // near-certainty prices carry poor accumulator value
}

// v3.1 §1 — generalized missing-data weight redistribution. Any subset of
// {teamForm, leagueIntel, h2h} can be unavailable (not just h2h); FinalScore
// is computed only from factors that have real data behind them, with their
// combined weight redistributed proportionally across whatever remains.
// A leg scored on fewer factors is inherently less certain, so a small
// "thin data" penalty is applied per missing major factor — enough to rank
// thin-data legs below well-evidenced ones without the crushing anchor of
// pretending every unknown is a neutral 55.
async function scoreLeg(leg, deps, cfg, internalBaseUrl, goalsProxy, eventGroup, downweights) {
  const tf = teamFormComponent(leg, deps.teamIntel, cfg);
  const lg = leagueIntelComponent(leg, deps.leagueIntel, goalsProxy, cfg);
  const pa = punterAccuracyComponent(leg, deps);
  const h2h = await h2hComponent(leg, internalBaseUrl);
  const safety = marketSafety(leg.marketName, leg.specifier, leg.outcomeName, leg.homeTeam, leg.awayTeam);
  const cc = communityConsensusComponent(leg, eventGroup);
  const ov = oddsValueComponent(leg);

  const w = cfg.weights;
  const reasons = [];
  reasons.push(...lg.reasons);

  // Always-available factors (computed from real data every time)
  const alwaysOn = [
    { key: 'punterAccuracy', score: pa.score, weight: w.punterAccuracy },
    { key: 'marketSafety', score: Math.max(0, safety), weight: w.marketSafety },
    { key: 'communityConsensus', score: cc.score, weight: w.communityConsensus },
    { key: 'oddsValue', score: ov.score, weight: w.oddsValue },
  ];
  // Conditionally-available major factors — this is what §1 redistributes
  const conditional = [
    { key: 'teamForm', available: tf.available, score: tf.score, weight: w.teamForm },
    { key: 'leagueIntel', available: lg.available, score: lg.score, weight: w.leagueIntel },
    { key: 'h2h', available: h2h.available, score: h2h.score, weight: w.h2h },
  ];

  const activeFactors = alwaysOn.map(f => f.key);
  const activeWeight = alwaysOn.reduce((s, f) => s + f.weight, 0);
  let usedWeight = activeWeight;
  let weightedSum = alwaysOn.reduce((s, f) => s + f.score * f.weight, 0);
  let missingMajorCount = 0;
  for (const f of conditional) {
    if (f.available) { activeFactors.push(f.key); usedWeight += f.weight; weightedSum += f.score * f.weight; }
    else missingMajorCount++;
  }
  // Scale up so the ACTIVE weights sum to 1.0 (proportional redistribution)
  let final = usedWeight > 0 ? (weightedSum / usedWeight) : 0;

  // Thin-data penalty — ranks thin-data legs below well-evidenced ones
  // without anchoring them at a fixed neutral score.
  final -= missingMajorCount * cfg.thinDataPenalty;

  // SOFT-league penalty (v3.1 §2) — not excluded, just penalized + capped later
  if (leg.isSoftLeague) {
    final -= cfg.softLeaguePenalty;
    reasons.push(`SOFT-list league (${leg.league}): −${cfg.softLeaguePenalty} penalty, capped at ${Math.round(cfg.softLeagueTicketCapPct * 100)}% of any ticket instead of excluded`);
  }

  // Down-weight punters/leagues/markets demoted by daily self-review (§5)
  const dwP = downweights.punters?.[leg.source] || 0;
  const dwL = downweights.leagues?.[leg.league] || 0;
  const dwM = downweights.markets?.[leg.marketName] || 0;
  if (dwP) reasons.push(`Punter ${leg.source} down-weighted ${dwP}% — recent settled misses`);
  if (dwL) reasons.push(`${leg.league} down-weighted ${dwL}% — killed tickets recently`);
  if (dwM) reasons.push(`${leg.marketName} down-weighted ${dwM}% — recent conversion pattern underperformed`);
  final = final * (1 - (dwP + dwL + dwM) / 300);

  if (cc.count >= 2) reasons.push(`${cc.count} independent sources backed this exact pick`);
  if (tf.available) reasons.push(`Team form: ${tf.score}%`);
  else reasons.push('Team form: unavailable (< settled-sample threshold) — weight redistributed');
  if (!lg.available) reasons.push(`League intel unavailable for ${leg.league} (< settled-sample threshold) — weight redistributed`);
  if (safety < 0) reasons.push('Market hard-removed by safety table');

  return {
    finalScore: Math.max(0, Math.min(100, Math.round(final))),
    components: { teamForm: tf.available ? tf.score : null, leagueIntel: lg.available ? lg.score : null, punterAccuracy: pa.score, h2h: h2h.available ? h2h.score : null, marketSafety: safety, communityConsensus: cc.score, oddsValue: ov.score },
    activeFactors, missingMajorCount,
    h2hAvailable: h2h.available,
    safety,
    reasons,
  };
}

// ─── PHASE 3 — CONVERSION ENGINE ─────────────────────────────────────────────
function findForcedUnderShift(avail, currentLine, homeTeam, awayTeam) {
  const targetLine = currentLine + 1;
  for (const m of avail) {
    if (!m.odds || m.odds <= 1.01) continue;
    if (isTeamScopedMarket(m.marketName, homeTeam, awayTeam)) continue;
    const mn = (m.marketName || '').toLowerCase();
    if (!mn.includes('over/under') || mn.includes('half')) continue;
    const on = (m.outcomeName || '').toLowerCase();
    if (!on.includes('under')) continue;
    const line = getLine(m.marketName, m.specifier, m.outcomeName);
    if (Math.abs(line - targetLine) < 0.1) return m;
  }
  return null;
}

// Candidate ladders beyond intelligence-engine's SAFE_CONVERSIONS (Over 2.5
// via OR-markets, per §3). OR-market outcomes are verified live off the
// board — never guessed from the label (rule §0.3).
function findOrMarketCandidate(avail, homeTeam, awayTeam) {
  for (const m of avail) {
    if (!m.odds || m.odds <= 1.01 || m.odds > 2.5) continue;
    if (isTeamScopedMarket(m.marketName, homeTeam, awayTeam)) continue;
    const mn = (m.marketName || '').toLowerCase();
    const on = (m.outcomeName || '').toLowerCase();
    if ((mn.includes('&') || mn.includes(' and ')) ) continue; // AND-combo — never eligible (§0.3)
    if (/home or over|draw or over/.test(on) && mn.includes('over')) return m;
  }
  return null;
}

// v19 §7 — PROFILING: a live full run measured the conversion phase (this
// function's live market-board fetch) at ~62.5s of a ~90.7s total run —
// roughly 69% of all wall-clock time. Many legs — often from DIFFERENT
// punters — reference the SAME match; re-fetching that match's live market
// board on every single leg check has no real benefit when the last fetch
// for that event happened moments ago, since odds/market availability
// doesn't meaningfully change inside a ~15-minute window. This is a pure
// cache in front of the network call — the actual conversion DECISION logic
// below (classifyRisk/findSafeMarket/scoring) is untouched and still runs
// fresh for every leg; only the expensive fetch is reused.
const EVENT_BOARD_CACHE_TTL_MS = 15 * 60 * 1000;
const eventBoardCache = new Map(); // eventId -> { data: [...markets], ts: number }
async function fetchEventMarketBoard(eventId) {
  const cached = eventBoardCache.get(eventId);
  if (cached && (Date.now() - cached.ts) < EVENT_BOARD_CACHE_TTL_MS) return cached.data;
  const j = await sbGetEvent(eventId);
  if (!j || j.bizCode !== 10000 || !j.data) return null;
  const avail = (j.data.markets || []).flatMap(m =>
    (m.outcomes || []).filter(o => o.isActive === 1).map(o => ({
      marketId: m.id, marketName: m.desc || '', specifier: m.specifier || '',
      outcomeId: o.id, outcomeName: o.desc || '', odds: parseFloat(o.odds) || 0,
      productId: m.product || 3,
    }))
  );
  eventBoardCache.set(eventId, { data: avail, ts: Date.now() });
  return avail;
}

// v36 — pure gate, extracted out of runGenerator's Phase-3 split loop and
// exported for test-conversion-safety.js. A leg may skip convertLeg (and
// therefore classifyRisk-driven conversion) ONLY when its composite score
// already clears riskBandLeave AND its market isn't REMOVE-risk (correct
// score/HT-FT/corners/cards/scorer/handicap-style) — REMOVE has no entry in
// SAFE_CONVERSIONS at all, so no score can ever make it legitimately safe to
// leave untouched. See the REAL BUG note at this function's call site.
function canLeaveAsIs(risk, finalScore, cfg) {
  return risk !== 'REMOVE' && finalScore >= cfg.riskBandLeave;
}

async function convertLeg(leg, finalScoreOfLeg, deps, cfg, conversionLearning, reasons) {
  // v37 — risk is now classified up front (was previously computed after the
  // forced-under-shift check) so EVERY return path below — including the
  // market-board-unavailable and forced-shift ones — can report it and an
  // (empty, where not applicable) candidatesConsidered list for the audit
  // report. Behavior is unchanged; this only widens what gets reported.
  const risk = classifyRisk(leg.marketName, leg.specifier, leg.outcomeName);
  let avail;
  try {
    avail = await fetchEventMarketBoard(leg.eventId);
    if (!avail) return { converted: false, dropped: true, reason: 'Live market board unavailable', risk, candidatesConsidered: [] };
  } catch (e) {
    return { converted: false, dropped: true, reason: `Market board fetch error: ${e.message}`, risk, candidatesConsidered: [] };
  }

  // ── Forced Under X.5 → Under (X+1).5, EVERY matching leg, any risk band ──
  // v7 §4 — now a Generator Settings toggle (was unconditional).
  // Settings are persisted/merged through a numeric-coercing route (checkbox
  // false -> stored as 0), so both representations must count as "off".
  if (cfg.forcedUnderShift !== false && cfg.forcedUnderShift !== 0) {
    const mn = (leg.marketName || '').toLowerCase();
    const on = (leg.outcomeName || '').toLowerCase();
    if (mn.includes('over/under') && !mn.includes('half') && on.includes('under')) {
      const line = getLine(leg.marketName, leg.specifier, leg.outcomeName);
      const shifted = findForcedUnderShift(avail, line, leg.homeTeam, leg.awayTeam);
      if (shifted && shifted.odds <= leg.odds) {
        return applyConversion(leg, shifted, `Forced Under ${line}→${line + 1} shift (edition rule)`, null, [`FORCED_UNDER_SHIFT: ${shifted.marketName}: ${shifted.outcomeName} @${shifted.odds}`], finalScoreOfLeg, risk);
      }
    }
  }

  if (risk === 'OK') return { converted: false, keep: true, risk, candidatesConsidered: [] };

  // v7 §4 — only legs BELOW the mandatory-convert cutoff (riskBandConvertIfBetter,
  // i.e. <=60) still face "convert or drop". Legs in the 61-71 maybe-band get
  // to keep their original pick when no candidate clears the improvement bar.
  // v36 — REAL BUG: that maybe-band leniency was also firing for REMOVE-risk
  // legs (correct score/HT-FT/corners/cards/scorer/handicap) scoring 61-71 —
  // "keep original when no better replacement found" only makes sense for a
  // market that DOES have a real safer alternative in principle (Over 2.5,
  // Home Win, etc.); REMOVE has no SAFE_CONVERSIONS entry at all, so `best`
  // is always null for it and the old code was unconditionally keeping a
  // genuinely unconvertible risky market whenever its composite score
  // cleared 61. REMOVE is now always treated as mandatory-band, regardless
  // of finalScoreOfLeg, so the no-conversion-found path below always drops it.
  const isMandatoryBand = risk === 'REMOVE' || finalScoreOfLeg < cfg.riskBandConvertIfBetter;

  // Correct score / HT-FT / streak / corners / cards / anytime-scorer style
  // markets never have a safe stand-in — always convert to the safest
  // available whole-match market, or drop.
  // v36 — item 9: track every candidate type actually evaluated (found on
  // the live board or not, and why a found one was rejected) so a rejected/
  // dropped leg's log line says what was actually checked, not just "no safe
  // conversion found" with no visibility into what was tried.
  const convTypes = SAFE_CONVERSIONS[risk] || [];
  let best = null, bestType = null;
  const candidatesConsidered = [];
  for (const cType of convTypes) {
    const alt = findSafeMarket(avail, cType, leg.homeTeam, leg.awayTeam);
    if (!alt) { candidatesConsidered.push(`${cType}: not offered on live board`); continue; }
    if (alt.odds > leg.odds) { candidatesConsidered.push(`${cType}: ${alt.marketName} @${alt.odds} rejected — odds exceed original @${leg.odds}`); continue; } // §0.9 — replacement odds must never exceed original
    const newSafety = marketSafety(alt.marketName, alt.specifier, alt.outcomeName, leg.homeTeam, leg.awayTeam);
    if (newSafety < 0) { candidatesConsidered.push(`${cType}: ${alt.marketName} @${alt.odds} rejected — fails its own safety check`); continue; }
    candidatesConsidered.push(`${cType}: ${alt.marketName}: ${alt.outcomeName} @${alt.odds} (safety ${newSafety})`);
    if (!best || newSafety > best._newSafety) { best = { ...alt, _newSafety: newSafety }; bestType = cType; }
  }
  // Try OR-market fallback for Over 2.5-style risk
  if (!best && (risk === 'OVER_2.5' || risk === 'OVER_3.5')) {
    const orAlt = findOrMarketCandidate(avail, leg.homeTeam, leg.awayTeam);
    if (orAlt && orAlt.odds <= leg.odds) { best = { ...orAlt, _newSafety: 70 }; bestType = 'OR_MARKET'; candidatesConsidered.push(`OR_MARKET: ${orAlt.marketName}: ${orAlt.outcomeName} @${orAlt.odds} (safety 70)`); }
  }

  if (!best) {
    const triedNote = candidatesConsidered.length ? ` — tried: ${candidatesConsidered.join('; ')}` : ` — ${risk} has no defined safe-conversion ladder`;
    if (isMandatoryBand) return { converted: false, dropped: true, reason: `No safe conversion found on live board${triedNote}`, risk, candidatesConsidered };
    reasons.push(`No safe conversion found on live board — kept original (already above the mandatory-convert band)${triedNote}`);
    return { converted: false, keep: true, risk, candidatesConsidered };
  }

  // v7 §4 — maybe-band restraint: only accept if the projected score gain
  // clears conversionMinImprovement. Uses the exact same delta formula the
  // caller applies post-conversion (newSafety-oldSafety, scaled by the
  // marketSafety weight) so the accept/reject decision and the actual score
  // update stay consistent with each other.
  if (!isMandatoryBand) {
    const scoreDelta = Math.max(0, best._newSafety - (leg.safety || 0)) * (cfg.weights?.marketSafety || 0.10);
    if (scoreDelta < cfg.conversionMinImprovement) {
      reasons.push(`Replacement found (${risk} → ${bestType}) but improvement too marginal (+${scoreDelta.toFixed(1)} pts < ${cfg.conversionMinImprovement} threshold) — kept original`);
      return { converted: false, keep: true, risk, candidatesConsidered };
    }
  }

  // Conversion-outcome-learning priority nudge: if this exact pattern has
  // historically underperformed the original, prefer keeping the original
  // when its own score already clears the "leave as-is" band.
  const patternKey = `${risk}->${bestType}|${leg.league}`;
  const learned = conversionLearning[patternKey];
  if (learned && learned.settled >= 5 && learned.winRate < 45 && finalScoreOfLeg >= cfg.riskBandLeave) {
    reasons.push(`Conversion pattern ${patternKey} underperforms historically (${learned.winRate}% over ${learned.settled}) — kept original`);
    return { converted: false, keep: true, risk, candidatesConsidered };
  }

  return applyConversion(leg, best, `${risk} → ${bestType}`, patternKey, candidatesConsidered, finalScoreOfLeg, risk);
}

function applyConversion(leg, alt, ruleLabel, patternKey, candidatesConsidered, originalScore, risk) {
  const before = { marketName: leg.marketName, outcomeName: leg.outcomeName, odds: leg.odds };
  const updated = {
    ...leg,
    marketId: String(alt.marketId), marketName: alt.marketName, specifier: alt.specifier || '',
    outcomeId: String(alt.outcomeId), outcomeName: alt.outcomeName, odds: alt.odds, productId: alt.productId || 3,
    converted: true,
    conversionReason: {
      original: `${before.marketName}: ${before.outcomeName} @${before.odds}`,
      originalScore: originalScore ?? null,
      replacement: `${alt.marketName}: ${alt.outcomeName} @${alt.odds}`,
      rule: ruleLabel, patternKey: patternKey || null,
      candidatesConsidered: candidatesConsidered || [],
    },
  };
  return { converted: true, leg: updated, risk: risk || null, candidatesConsidered: candidatesConsidered || [] };
}

// ─── PHASE 5 — MONTH-LOSSES BUILDER ─────────────────────────────────────────
function tagFailureCause(sel) {
  const league = (sel.league || '').toLowerCase();
  const market = (sel.market || '').toLowerCase();
  const outcome = (sel.outcome || '').toLowerCase();
  if (/u1[6-9]|u2[0-3]|youth|reserves?/i.test(league)) return 'reserve/youth league';
  if (/women|female|ladies/i.test(league)) return 'women\'s league';
  if (/cup/i.test(league)) return 'cup match';
  if (market.includes('over/under') && outcome.includes('over')) return 'low-scoring match (Over missed)';
  if (market === '1x2' || market === 'match winner') return 'favorite upset';
  if (market.includes('double chance') || market.includes('draw no bet')) return 'unexpected result (DC/DNB missed)';
  return 'unspecified';
}

function buildMonthLosses(logger) {
  const buckets = {}; // `${league}|${market}|${oddsBand}` -> {count, overWins, causes:{}}
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-31);
    for (const f of files) {
      const rpt = safeJSON(path.join(REPORTS_DIR, f), null);
      for (const sel of (rpt?.analysis?.allSelections || [])) {
        // v21 — REAL BUG: this used to `continue` past every non-LOST
        // selection, so month-losses.json only ever recorded loss COUNTS
        // with no corresponding win data — isToxicPattern below had no way
        // to compute a real fail rate and used a bare count threshold
        // instead, the exact base-rate fallacy already fixed for the
        // league/market blacklist elsewhere. Now tracking wins too (scoped
        // to the same "bet Over, did it hit" direction as the loss cause
        // being measured, so numerator and denominator stay comparable).
        if (sel.verdict !== 'LOST' && sel.verdict !== 'WON') continue;
        const odds = sel.originalOdds || sel.odds || 0;
        const band = odds < 1.3 ? '<1.30' : odds < 1.6 ? '1.30-1.59' : odds < 2.0 ? '1.60-1.99' : '2.0+';
        const key = `${sel.league}|${sel.market}|${band}`;
        if (!buckets[key]) buckets[key] = { league: sel.league, market: sel.market, oddsBand: band, count: 0, overWins: 0, causes: {} };
        const isOverBet = (sel.market || '').toLowerCase().includes('over/under') && (sel.outcome || '').toLowerCase().includes('over');
        if (sel.verdict === 'WON') { if (isOverBet) buckets[key].overWins++; continue; }
        buckets[key].count++;
        const cause = tagFailureCause(sel);
        buckets[key].causes[cause] = (buckets[key].causes[cause] || 0) + 1;
      }
    }
  } catch (e) { logger && logger(`Month-losses build warning: ${e.message}`); }

  const out = { builtAt: new Date().toISOString(), buckets: Object.values(buckets).sort((a, b) => b.count - a.count).slice(0, 300) };
  saveJSON(MONTH_LOSSES_FILE, out);
  return out;
}

// v4 §1 — TOXIC pattern check for Section A's light-touch editing: a
// proven killer, not a generic low score. Deliberately narrow (goals
// markets only, real recorded kill count from month-loss data) — Section A
// must not become a second pool-floor filter wearing a different name.
// v21 — REAL BUG (forensic audit, ugochukwu 2026-07-25 ticket RGYG5X): this
// used to flag "toxic" on a bare loss count (≥3 recorded Over-missed
// losses), the same base-rate fallacy already fixed twice before for the
// league/market blacklist — a league/market/band picked 3 times and lost
// all 3 looked identical to one picked 300 times and lost 3. Now requires
// both a minimum sample AND a real fail rate (losses / (losses+wins)),
// matching the blacklistCandidateFailRate pattern used elsewhere.
function isToxicPattern(leg, monthLosses, cfg) {
  const isGoalsOver = /over\/under/i.test(leg.marketName || '') && /over/i.test(leg.outcomeName || '');
  if (!isGoalsOver) return false;
  const odds = leg.odds || 0;
  const band = odds < 1.3 ? '<1.30' : odds < 1.6 ? '1.30-1.59' : odds < 2.0 ? '1.60-1.99' : '2.0+';
  const bucket = (monthLosses.buckets || []).find(b => b.league === leg.league && b.market === leg.marketName && b.oddsBand === band);
  if (!bucket) return false;
  const losses = bucket.causes?.['low-scoring match (Over missed)'] || 0;
  const wins = bucket.overWins || 0;
  const sample = losses + wins;
  if (sample < (cfg?.toxicMinKillCount ?? 8)) return false; // not enough data for this league/market/band to trust the rate
  const failRate = losses / sample;
  return failRate >= (cfg?.toxicFailRateThreshold ?? 0.45);
}

// ─── v3.1 §4 — INTELLIGENCE BACKFILL ─────────────────────────────────────────
// Replays every settled leg found in data/reports/*.json (the only source
// that actually carries per-leg verdict + team + league — checked and
// confirmed: data/_accas-*.json and data/_longshot*-final.json are
// unsettled candidate pools with no verdict field, so they carry no real
// win/loss signal and are correctly excluded rather than guessed from).
// Additive and idempotent: tracks which report files have already been
// ingested in backfill-state.json, so re-running only picks up new settled
// days — never double-counts. Merges INTO the existing shared
// league-intelligence.json / team-intelligence.json shapes rather than
// replacing them, since other features (main pipeline, Strategy Engine)
// depend on those same files.
function backfillIntelligenceFromHistory(logger = () => {}) {
  const state = safeJSON(BACKFILL_STATE_FILE, { processedFiles: [] });
  let files = [];
  try { files = fs.readdirSync(REPORTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {}
  const newFiles = files.filter(f => !state.processedFiles.includes(f));

  const leagueIntel = safeJSON(LEAGUE_INTEL_FILE, {});
  const teamIntel = safeJSON(TEAM_INTEL_FILE, {});
  const before = {
    leaguesCovered: Object.values(leagueIntel).filter(d => (d.won + d.lost) >= 4).length,
    teamsCovered: Object.values(teamIntel).filter(t => (t.home?.won + t.home?.lost) >= 3 || (t.away?.won + t.away?.lost) >= 3).length,
  };

  if (!newFiles.length) {
    logger('No new settled report files since last backfill.');
    return { success: true, filesProcessed: 0, legsIngested: 0, before, after: before, skippedSources: ['_accas-*.json / _longshot*-final.json — candidate pools, no settled verdict field'] };
  }

  let legsIngested = 0;
  for (const f of newFiles) {
    const rpt = safeJSON(path.join(REPORTS_DIR, f), null);
    for (const sel of (rpt?.analysis?.allSelections || [])) {
      if (sel.verdict !== 'WON' && sel.verdict !== 'LOST') continue; // VOID/PENDING carry no signal
      const win = sel.verdict === 'WON';
      if (sel.league) {
        if (!leagueIntel[sel.league]) leagueIntel[sel.league] = { won: 0, lost: 0, hitRate: 0 };
        leagueIntel[sel.league][win ? 'won' : 'lost']++;
        const d = leagueIntel[sel.league];
        d.hitRate = Math.round((d.won / (d.won + d.lost)) * 100);
      }
      if (sel.homeTeam) {
        if (!teamIntel[sel.homeTeam]) teamIntel[sel.homeTeam] = { home: { won: 0, lost: 0, hitRate: null }, away: { won: 0, lost: 0, hitRate: null } };
        const h = teamIntel[sel.homeTeam].home;
        h[win ? 'won' : 'lost']++;
        h.hitRate = Math.round((h.won / (h.won + h.lost)) * 100);
      }
      if (sel.awayTeam) {
        if (!teamIntel[sel.awayTeam]) teamIntel[sel.awayTeam] = { home: { won: 0, lost: 0, hitRate: null }, away: { won: 0, lost: 0, hitRate: null } };
        const a = teamIntel[sel.awayTeam].away;
        a[win ? 'won' : 'lost']++;
        a.hitRate = Math.round((a.won / (a.won + a.lost)) * 100);
      }
      legsIngested++;
    }
    state.processedFiles.push(f);
  }

  saveJSON(LEAGUE_INTEL_FILE, leagueIntel);
  saveJSON(TEAM_INTEL_FILE, teamIntel);
  saveJSON(BACKFILL_STATE_FILE, state);

  const after = {
    leaguesCovered: Object.values(leagueIntel).filter(d => (d.won + d.lost) >= 4).length,
    teamsCovered: Object.values(teamIntel).filter(t => (t.home?.won + t.home?.lost) >= 3 || (t.away?.won + t.away?.lost) >= 3).length,
  };
  logger(`Backfill: ${newFiles.length} report files, ${legsIngested} settled legs ingested. Leagues with ≥4 samples: ${before.leaguesCovered} → ${after.leaguesCovered}. Teams with ≥3 samples: ${before.teamsCovered} → ${after.teamsCovered}.`);
  return { success: true, filesProcessed: newFiles.length, legsIngested, before, after };
}

// ─── PHASE 6/7 — CONSENSUS DEDUP + EXPOSURE TRACKING ────────────────────────
function makeExposureTracker(cfg, seed) {
  const teamCount = seed ? { ...seed.teamCount } : {};   // team -> ticket count across whole run
  const consensusLegAppearances = seed ? { ...seed.consensusLegAppearances } : {}; // matchKey -> ticket count (for high-tier overlap rule)
  return {
    canAddTeam(team) { return (teamCount[team] || 0) < cfg.teamExposureCap; },
    registerTeam(team) { teamCount[team] = (teamCount[team] || 0) + 1; },
    canAddConsensusLeg(matchKey, isHighTierConsensus) {
      if (!isHighTierConsensus) return true;
      return (consensusLegAppearances[matchKey] || 0) < cfg.highTierOverlapCap;
    },
    registerConsensusLeg(matchKey) { consensusLegAppearances[matchKey] = (consensusLegAppearances[matchKey] || 0) + 1; },
    snapshot() { return { teamCount: { ...teamCount }, consensusLegAppearances: { ...consensusLegAppearances } }; },
  };
}

function leagueCapFor(cfg, ticketSize) { return ticketSize >= 15 ? cfg.leagueExposureCapBig : cfg.leagueExposureCapSmall; }

// v3.1 §2 — SOFT-league legs may not exceed softLeagueTicketCapPct of ANY
// ticket's legs, in addition to the score penalty already applied.
function selectPicksForTicket(pool, targetCount, cfg, exposure, usedEventIds) {
  const picks = [];
  const leagueCnt = {};
  const cap = leagueCapFor(cfg, targetCount);
  let softCount = 0;
  const softCap = Math.floor(targetCount * cfg.softLeagueTicketCapPct);
  for (const p of pool) {
    if (picks.length >= targetCount) break;
    if (usedEventIds.has(p.eventId)) continue;
    if (!exposure.canAddTeam(p.homeTeam) || !exposure.canAddTeam(p.awayTeam)) continue;
    const isHighTierConsensus = (p.sourceCount || 1) >= cfg.highTierConsensusThreshold;
    if (!exposure.canAddConsensusLeg(p.matchKey, isHighTierConsensus)) continue;
    if ((leagueCnt[p.league] || 0) >= cap) continue;
    if (p.isSoftLeague && softCount >= softCap) continue;
    picks.push(p);
    usedEventIds.add(p.eventId);
    leagueCnt[p.league] = (leagueCnt[p.league] || 0) + 1;
    exposure.registerTeam(p.homeTeam); exposure.registerTeam(p.awayTeam);
    if (isHighTierConsensus) exposure.registerConsensusLeg(p.matchKey);
    if (p.isSoftLeague) softCount++;
  }
  return picks;
}

// v15 §1 — the universal 100x floor is enforced HERE, unconditionally,
// regardless of what any caller passes or forgets to pre-check — same
// "impossible to forget" pattern v11 established for the Moonshot floor.
// A caller that already pre-checked its own (higher) target floor just
// never trips this; a caller that has NO pre-check at all (Section A,
// Non-Football, Mix, Max Builder before this patch) is now protected too,
// automatically, with zero changes required at the call site.
// v22 — REAL BUG (item 7): the same-match dedupe and (item 8) the universal
// 50-leg cap used to be, at best, per-category logic that individual
// builders could get right or wrong independently — exactly the kind of
// thing that could be (and evidently was, at least once — the 143-leg Max
// Builder incident) missed somewhere. Both guards now live here, at the
// ONE shared chokepoint every ticket-building path already calls before
// /api/generate, so neither can be skipped by a new or existing caller.
// Return shape changed from a bare code string to {code, picks} so callers
// can report the REAL final leg count/odds — the ones actually reflected
// in the generated code — instead of the pre-guard numbers they started
// with, which would otherwise silently mismatch after a dedupe or cap.
async function generateTicketCode(picks, logger, minLegs = 3, minOdds = DEFAULT_CONFIG.universalMinOdds) {
  // Item 7 — same-match guard: dedupe by eventId, keeping the higher-scoring
  // leg. Unconditional, for every ticket type, no exceptions.
  const byEvent = new Map();
  for (const p of picks) {
    const existing = byEvent.get(p.eventId);
    if (!existing || (p.finalScore ?? 0) > (existing.finalScore ?? 0)) byEvent.set(p.eventId, p);
  }
  let final = [...byEvent.values()];
  if (final.length !== picks.length) {
    logger && logger(`  Same-match guard: ${picks.length - final.length} duplicate-match leg(s) removed before code generation (kept the higher-scoring pick per match)`);
  }

  // Item 8 — universal hard cap: no ticket may exceed 50 legs, ever, for any
  // category, applied AFTER the same-match dedupe above. Best-scored 50 —
  // never a blind truncation by kickoff order or arbitrary cut.
  const UNIVERSAL_MAX_LEGS = 50;
  if (final.length > UNIVERSAL_MAX_LEGS) {
    const before = final.length;
    final = [...final].sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0)).slice(0, UNIVERSAL_MAX_LEGS);
    logger && logger(`  Universal 50-leg cap: ${before} legs → best ${UNIVERSAL_MAX_LEGS} by score (${before - UNIVERSAL_MAX_LEGS} dropped)`);
  }

  if (final.length < minLegs) return null;
  if (minOdds != null) {
    const odds = computeOdds(final);
    if (odds < minOdds) {
      logger && logger(`  REJECTED before code generation — ${fmtOdds(odds)} is below the universal ${fmtOdds(minOdds)}x floor. No API call made.`);
      return null;
    }
  }
  const payload = final.map(s => ({
    eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
    specifier: s.specifier || '', productId: parseInt(s.productId) || 3, sportId: s.sportId || 'sr:sport:1',
  }));
  try {
    const r = await sbPost(payload);
    if (r.bizCode !== 10000 || !r.data?.shareCode) return null;
    const code = r.data.shareCode;

    // v22 — REAL BUG: SportyBet's /orders/share endpoint can return
    // bizCode:10000 with a valid shareCode while silently accepting FEWER
    // selections than were submitted (a market going unavailable at the
    // exact moment of posting, most likely) — we were never checking this,
    // just trusting the submitted `final` list as if it were what actually
    // landed. Confirmed on 2 of 2 real tickets spot-checked live: one
    // showed 18 legs persisted vs 17 actually on the code, another 22 vs
    // 20. Every legCount/odds/avgConfidence downstream was silently wrong
    // whenever this happened. intelligence-engine.js's verifyAndPostTicket
    // already has this exact "post, then read back, trust only what's
    // confirmed" pattern for a different feature — this reuses the same
    // idea here, at the one shared chokepoint every ticket type calls.
    let confirmed = final;
    try {
      await new Promise(r2 => setTimeout(r2, 400));
      const readback = await sbGet(code);
      const ticketSels = readback?.data?.ticket?.selections;
      if (Array.isArray(ticketSels)) {
        const confirmedKeys = new Set(ticketSels.map(ts => `${ts.eventId}|${ts.marketId}`));
        const stillOn = final.filter(p => confirmedKeys.has(`${p.eventId}|${p.marketId}`));
        if (stillOn.length !== final.length) {
          const dropped = final.filter(p => !confirmedKeys.has(`${p.eventId}|${p.marketId}`));
          logger && logger(`  ⚠ SportyBet accepted only ${stillOn.length} of ${final.length} submitted legs on ${code} — dropped: ${dropped.map(p => `${p.homeTeam} v ${p.awayTeam}`).join(', ')}`);
          confirmed = stillOn;
        }
      }
    } catch (e) {
      // Readback failing is not itself a reason to discard a real, already-
      // placed code — fall back to the submitted list rather than losing a
      // ticket over a transient read error, but say so plainly.
      logger && logger(`  (could not verify ${code}'s actual leg count — readback failed: ${e.message})`);
    }
    if (confirmed.length < minLegs) {
      logger && logger(`  REJECTED after posting — only ${confirmed.length} of the required ${minLegs} legs actually landed on ${code}. No usable ticket.`);
      return null;
    }
    return { code, picks: confirmed };
  } catch (e) { logger && logger(`  Code gen error: ${e.message}`); return null; }
}

// Bounded-concurrency worker pool — Phase 3 was making a strictly serial live
// market-board fetch for every sub-75-score leg (400-500+ per real run),
// which measured out to 14+ minutes with ZERO code cards visible on-screen
// the entire time (confirmed from a real run's event timeline). That's not a
// bug in what it computes, but it reads as "the page is stuck" to anyone
// watching it. Running a handful of these fetches concurrently instead of
// one-at-a-time cuts that wall-clock time proportionally without changing a
// single scoring/conversion decision.
async function mapWithConcurrency(items, limit, worker, shouldStop) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      if (shouldStop && shouldStop()) return; // v6 — stop grabbing new work; in-flight calls already awaited elsewhere finish naturally
      const my = idx++;
      results[my] = await worker(items[my], my);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// Feeds the admin dashboard's "Codes Today" quick-stat (public/admin.html
// reads /api/generated-codes and flattens every {code,...} entry across all
// keys). That file already exists but had zero live writers — additive
// read-merge-write under our own key so we never clobber whatever else uses it.
function recordGeneratedCodes(runId, allTickets) {
  const withCodes = allTickets.filter(t => t && t.code);
  if (!withCodes.length) return 0;
  const existing = safeJSON(GENERATED_CODES_FILE, {});
  existing['advanced-generator'] = [
    ...(Array.isArray(existing['advanced-generator']) ? existing['advanced-generator'] : []),
    ...withCodes.map(t => ({ code: t.code, games: t.legCount, odds: t.odds, section: t.section || t.tier || 'A', runId, generatedAt: new Date().toISOString() })),
  ].slice(-500); // cap growth — this is a rolling recent-activity feed, not the source of truth (advanced-generator-results.json is)
  saveJSON(GENERATED_CODES_FILE, existing);
  return withCodes.length;
}

function computeOdds(picks) { return picks.reduce((t, p) => t * p.odds, 1); }
function fmtOdds(o) { return o >= 1e6 ? (o / 1e6).toFixed(2) + 'M' : o >= 1e3 ? (o / 1e3).toFixed(2) + 'K' : Math.round(o) + 'x'; }

// ─── PHASE 8 — TICKET BUILDER (Sections A-E) ────────────────────────────────
// v4 — Section A is a LIGHT TOUCH edit of each punter's own slip, not a
// re-filter through the pool's confidence floor. A leg is removed only for a
// specific, named reason (late-leg drop — already applied in Phase 1; HARD
// blacklist league — already excluded before pickMap; an always-replace
// market with no safe equivalent; or a proven TOXIC pattern). Everything
// else the punter picked stays, converted to a safer market where a valid
// one was found, flagged (not deleted) when its confidence is low. This is
// the only way Section A can plausibly land near the punter's own odds
// range (1,000x+ on a 30+-leg slip) instead of being capped by the same bar
// that governs the pool-wide Sections B-E.
// v15 §2 — one discretionary-removal PASS for a single ordering policy.
// Both discretionary categories ('always-replace' — no safe equivalent
// market exists at all — and 'toxic' — a proven ≥3-kill pattern from real
// month-loss data) are still budget-protected exactly as before: removal
// stops the instant one more would drop the slip below `stopFloor`, and
// whatever's left stays in, flagged keptDespiteRisk. What varies BETWEEN
// variants is which legs get sacrificed first when the budget runs out
// partway through — always-replace legs (structurally unsafe, no valid
// alternative market) are NEVER optional and are removed ahead of toxic
// legs in every policy; only the TOXIC group's treatment actually varies.
function buildSectionAVariant(allOfSrc, stopFloor, toxicPolicy, legBracketSurvival) {
  let picks = [...allOfSrc];
  const removedLegs = [];
  const alwaysReplace = allOfSrc.filter(p => p.discretionaryRemovalCategory === 'always-replace').sort((a, b) => a.finalScore - b.finalScore);
  const toxic = allOfSrc.filter(p => p.discretionaryRemovalCategory === 'toxic').sort((a, b) => a.finalScore - b.finalScore);

  function tryRemove(leg) {
    const oddsWithoutLeg = computeOdds(picks) / (leg.odds || 1);
    if (oddsWithoutLeg >= stopFloor) {
      picks = picks.filter(p => p !== leg);
      removedLegs.push({ homeTeam: leg.homeTeam, awayTeam: leg.awayTeam, league: leg.league, marketName: leg.marketName, outcomeName: leg.outcomeName, odds: leg.odds, reason: leg.discretionaryRemovalReason });
      return true;
    }
    leg.keptDespiteRisk = true;
    return false;
  }

  for (const leg of alwaysReplace) if (!tryRemove(leg)) break; // always mandatory, budget-protected as a last resort only

  if (toxicPolicy === 'never') {
    // Leg-Count-Max: only touch toxic legs if the slip is STILL below floor
    // after always-replace removal alone — otherwise leave them all in.
    if (computeOdds(picks) < stopFloor) {
      for (const leg of toxic) { if (computeOdds(picks) >= stopFloor) break; tryRemove(leg); }
    }
  } else {
    // 'always' (Balanced / Safety-Max): treat toxic same as always-replace.
    for (const leg of toxic) if (!tryRemove(leg)) break;
  }

  const stillFlagged = [...alwaysReplace, ...toxic].filter(p => picks.includes(p) && p.discretionaryRemovalCategory);
  for (const p of stillFlagged) p.keptDespiteRisk = true;

  // v22 — item 1: leg-count survival data becomes a genuine selection
  // input, not just a label. Previously this real evidence (patch 14/21)
  // only ever showed up as an amber "N-leg tickets: X/Y won historically"
  // note AFTER the ticket was already built — it never changed anything.
  // Now: if the slip's current leg count sits in a bracket with a REAL,
  // meaningful survival gap versus the bracket one leg smaller, and the
  // worst-scored remaining leg can be dropped without breaching stopFloor
  // or the 3-leg minimum, drop it too. Bounded three ways so this can never
  // repeat the earlier over-correction: (a) requires a real >=15pp gap, not
  // a marginal one, (b) the floor check is a hard stop regardless of how
  // many brackets could theoretically be crossed, (c) capped at 3 extra
  // removals per variant regardless. This only ever trims toward a
  // proven-better bracket at a real, checked cost — never an arbitrary cap.
  if (legBracketSurvival) {
    const bracketFor = n => (legBracketSurvival.brackets || []).find(b => n >= b.minLegs && (b.maxLegs == null || n <= b.maxLegs));
    const MEANINGFUL_GAP_PCT = 15;
    let survivalRemovals = 0;
    while (survivalRemovals < 3 && picks.length > 3) {
      const current = bracketFor(picks.length);
      const below = bracketFor(picks.length - 1);
      if (!current || !below || !current.sampleSize || !below.sampleSize) break;
      const gap = (below.observedWinRatePct ?? 0) - (current.observedWinRatePct ?? 0);
      if (gap < MEANINGFUL_GAP_PCT) break;
      const worst = [...picks].sort((a, b) => a.finalScore - b.finalScore)[0];
      if (!worst) break;
      const oddsWithoutLeg = computeOdds(picks) / (worst.odds || 1);
      if (oddsWithoutLeg < stopFloor) break;
      picks = picks.filter(p => p !== worst);
      removedLegs.push({
        homeTeam: worst.homeTeam, awayTeam: worst.awayTeam, league: worst.league, marketName: worst.marketName, outcomeName: worst.outcomeName, odds: worst.odds,
        reason: `Leg-count survival: ${picks.length + 1}→${picks.length} legs moves from the ${current.label} bracket (${current.observedWinRatePct}% historical win rate, n=${current.sampleSize}) to ${below.label} (${below.observedWinRatePct}%, n=${below.sampleSize})`,
      });
      survivalRemovals++;
    }
  }

  return { picks, removedLegs, keptDespiteRiskCount: picks.filter(p => p.keptDespiteRisk).length };
}

// v15 §1/§2 — Section A now: (a) never spends a generateTicketCode call on
// a punter whose slip structurally cannot clear the universal floor even
// with nothing removed (their legs already contribute to the shared pool
// used by Sections B-E regardless — nothing is lost, just not ALSO shown
// as a doomed Section A ticket), and (b) builds up to 3 real, differently-
// edited variants per punter instead of one, deduping any that converge to
// an identical leg set (a thin punter honestly only supports 1).
// v21 — patch 14 gave Section B/Tier1-4/Mix/Moonshot a real, evidence-based
// leg-count-viability check (computeLegBracketSurvival); Section A (punter
// slips) never got the same visibility. Per the "light touch, preserve the
// punter's real slip" principle (patch 4), this must NOT cap or alter what
// gets built for Section A — it only surfaces the same real survival data
// as an honest label on any ticket above sectionASurvivalLabelMinLegs legs,
// e.g. "37-leg tickets: 2/64 won historically (3%)". Purely informational.
function legCountSurvivalLabel(legCount, legBracketSurvival, cfg) {
  if (legCount < (cfg.sectionASurvivalLabelMinLegs ?? 25)) return null;
  const bracket = (legBracketSurvival?.brackets || []).find(b => legCount >= b.minLegs && (b.maxLegs == null || legCount <= b.maxLegs));
  if (!bracket || bracket.sampleSize < 1) return null;
  return `${bracket.label}-leg tickets: ${bracket.ticketsWon}/${bracket.sampleSize} won historically (${bracket.observedWinRatePct}%, last ${legBracketSurvival.windowDays}d)`;
}

// v39 — PUNTER_POOL (Section A). v38 cut this to exactly 1 ticket per
// punter, which fixed the multi-code duplication bug but over-corrected —
// user feedback: "bring back multiple tickets per punter" (up to 2, not the
// old 3-4). Both surviving policies always remove always-replace/toxic legs
// ('always' toxicPolicy on both — "just remove weak games and change to
// safer options", never the old Leg-Count-Max policy that kept toxic legs
// in to pad leg count). They differ only in how much odds the punter's
// preferred target is worth defending: 'Balanced' stops removing once the
// punter's own preferred odds (minPunterSlipOdds) would be breached;
// 'Safety-Max' keeps removing all the way down to the universal floor,
// trading leg count/odds for maximum safety. Top 10 Sure stays removed —
// that was a third, purely additive ticket, not a distinct editing policy.
async function buildSectionA(perSourceLegs, pickMap, cfg, exposure, rec, legBracketSurvival, codeGenFn = generateTicketCode) {
  const results = [], belowTarget = [], redirected = [];
  const punterPools = groupPerSourceLegsByPunter(perSourceLegs); // PUNTER_POOL: multi-code punters merged into one pool, not one ticket per code
  const VARIANT_POLICIES = [
    { label: 'Balanced',   stopFloor: cfg.minPunterSlipOdds, toxicPolicy: 'always' },
    { label: 'Safety-Max', stopFloor: cfg.universalMinOdds,  toxicPolicy: 'always' },
  ];
  const maxVariants = VARIANT_POLICIES.length;

  for (const src of punterPools) {
    if (src.dupesWithinPunter) log(rec, `  [Section A] ${src.source}: ${src.dupesWithinPunter} duplicate pick(s) across their own ${src.codes.length} codes — counted once`);
    const lateLegDropped = src.droppedLegs?.length || 0;
    const fetchedLegs = src.legs.length + lateLegDropped;
    const allOfSrc = src.legs.map(l => pickMap.get(l._pickKey)).filter(Boolean);
    const hardBlacklistRemoved = src.legs.length - allOfSrc.length;
    const originalOdds = src.legs.reduce((t, l) => t * (l.odds || 1), 1);
    const zeroRemovalOdds = computeOdds(allOfSrc);
    const zeroRemovalAvgLegOdds = allOfSrc.length ? allOfSrc.reduce((s, p) => s + (p.odds || 1), 0) / allOfSrc.length : 0;

    // v15 §1 — UNIVERSAL FLOOR, checked before attempting ANY variant. This is
    // the real ceiling (nothing discretionary removed yet) — if even that
    // can't clear the floor, no amount of editing will, so don't spend a
    // generateTicketCode call on this punter this run. Their legs still
    // feed GLOBAL_POOL via the shared pickMap regardless.
    if (zeroRemovalOdds < cfg.universalMinOdds) {
      redirected.push({ punter: src.source, zeroRemovalOdds: Math.round(zeroRemovalOdds * 100) / 100, legCount: allOfSrc.length });
      log(rec, `  [Section A] ${src.source}: zero-removal ceiling ${fmtOdds(zeroRemovalOdds)} is below the universal ${fmtOdds(cfg.universalMinOdds)} floor — SKIPPED (no code generated; legs still feed the GLOBAL pool)`);
      continue;
    }

    const seenLegSets = new Set();
    const letters = ['A', 'B'];
    const punterEntries = [];
    for (let vi = 0; vi < maxVariants; vi++) {
      const policy = VARIANT_POLICIES[vi];
      const { picks, removedLegs, keptDespiteRiskCount } = buildSectionAVariant(allOfSrc, policy.stopFloor, policy.toxicPolicy, legBracketSurvival);
      if (picks.length < 3) continue;

      // Dedupe — a thin punter's 2 policies often converge to the identical
      // set (nothing left to trade off); only ever emit genuinely distinct
      // slips, "1 of 2 — pool-limited" being the honest common case for a
      // small slip.
      const legSetKey = picks.map(p => p._pickKey).sort().join(',');
      if (seenLegSets.has(legSetKey)) continue;
      seenLegSets.add(legSetKey);

      const removeMarketCount = removedLegs.filter(l => l.reason?.startsWith('Always-replace')).length;
      const toxicCount = removedLegs.filter(l => l.reason?.startsWith('Proven killer')).length;
      const odds = computeOdds(picks);

      let oddsLabel = null;
      if (zeroRemovalOdds < cfg.minPunterSlipOdds) oddsLabel = 'short-odds-punter';
      else if (odds < cfg.minPunterSlipOdds) oddsLabel = 'capped-by-editing';

      log(rec, `  [Section A] ${src.source} (${src.codes.length} code${src.codes.length > 1 ? 's' : ''}: ${src.codes.join(', ')}) — Variant ${letters[punterEntries.length]} (${policy.label}): ${fetchedLegs} fetched → −${lateLegDropped} late-drop, −${hardBlacklistRemoved} hard-blacklist, −${removeMarketCount} always-replace-market, −${toxicCount} toxic-pattern${keptDespiteRiskCount ? `, ${keptDespiteRiskCount} risky legs kept ⚠` : ''} → ${picks.length} final legs @ ${fmtOdds(odds)} | zero-removal ceiling ${fmtOdds(zeroRemovalOdds)}${oddsLabel ? ` [${oddsLabel}]` : ''}`);

      // v15 §1 — universal floor is ALSO the hard gate generateTicketCode
      // itself enforces (its default), so this can never slip through even if
      // the above logic had a gap — belt and suspenders, per spec.
      const gen = await codeGenFn(picks, m => log(rec, m));
      await new Promise(r => setTimeout(r, 250));
      if (!gen) continue;
      const { code, picks: finalPicks } = gen;
      const finalOdds = computeOdds(finalPicks);

      const floorForLeg = p => p.isSoftLeague ? cfg.softLeagueFloor : cfg.confidenceFloor;
      punterEntries.push({
        section: 'A', punter: src.source, sourceCodes: src.codes, variant: letters[punterEntries.length], variantStrategy: policy.label,
        code, legCount: finalPicks.length, odds: Math.round(finalOdds * 100) / 100,
        originalLegCount: src.legs.length, originalOdds: Math.round(originalOdds * 100) / 100,
        avgConfidence: Math.round(finalPicks.reduce((s, p) => s + p.finalScore, 0) / finalPicks.length),
        convertedCount: finalPicks.filter(p => p.converted).length,
        lowConfidenceCount: finalPicks.filter(p => p.finalScore < floorForLeg(p)).length,
        keptDespiteRiskCount, belowMinOdds: finalOdds < cfg.minPunterSlipOdds,
        zeroRemovalOdds: Math.round(zeroRemovalOdds * 100) / 100, zeroRemovalAvgLegOdds: Math.round(zeroRemovalAvgLegOdds * 100) / 100, oddsLabel,
        removalCounts: { lateLegDropped, hardBlacklistRemoved, removeMarketCount, toxicCount },
        survivalLabel: legCountSurvivalLabel(finalPicks.length, legBracketSurvival, cfg),
        removedLegs, picks: finalPicks,
      });
    }
    for (const entry of punterEntries) { entry.variantsBuilt = punterEntries.length; entry.variantsTotal = maxVariants; results.push(entry); emit(rec, 'code', entry); log(rec, `  ✓ [Section A] ${src.source} — Variant ${entry.variant}: ${entry.code} | ${entry.legCount}g | ${fmtOdds(entry.odds)}`); }
    if (punterEntries.length < maxVariants && punterEntries.length > 0) {
      log(rec, `  [Section A] ${src.source}: ${punterEntries.length} of ${maxVariants} variants built — pool-limited (remaining policy converged to an identical slip or fell below 3 legs)`);
    } else if (punterEntries.length === 0) {
      log(rec, `  [Section A] ${src.source}: fewer than 3 legs survived risk-editing on every policy — no ticket built`);
    }
  }

  if (redirected.length) {
    // A punter's codes are already merged into one pool above, so each name
    // appears in `redirected` at most once now.
    const names = redirected.map(r => r.punter).join(', ');
    log(rec, `  [Section A] ${redirected.length} punter(s) below ${fmtOdds(cfg.universalMinOdds)} floor — legs still feed the GLOBAL pool (${names})`);
    emit(rec, 'section-a-redirect', { count: redirected.length, punters: redirected.map(r => r.punter), floor: cfg.universalMinOdds, redirected });
  }
  return { results, belowTarget, redirected };
}

// v7 §1 — builds every Section B tier TOGETHER so they're genuinely
// diversified instead of nesting. The old approach ran each tier through
// selectPicksForTicket independently with its own empty usedEventIds set —
// since every tier greedy-picked from the SAME score-ranked pool, Tier 2 was
// provably just "Tier 1 + more" (confirmed on a real run: Tier 2 and Tier 3
// selected the identical 32-leg set). This allocates the ranked pool across
// tiers with a weighted round-robin (proportional to each tier's target
// size, so no tier hoards the best games), then does a bounded top-up pass
// for under-filled tiers that only borrows a game if doing so never pushes
// pairwise overlap with any other tier above tierOverlapCapPct.
function buildDiversifiedTierPicks(rankedPool, tiers, cfg, exposure, overlapCapPct) {
  const cap = overlapCapPct != null ? overlapCapPct : cfg.tierOverlapCapPct;
  const n = tiers.length;
  const tierState = tiers.map(t => ({
    picks: [], eventIds: new Set(), leagueCnt: {}, softCount: 0,
    target: t.target, cap: leagueCapFor(cfg, t.target), softCap: Math.floor(t.target * cfg.softLeagueTicketCapPct),
  }));
  const totalWeight = tiers.reduce((s, t) => s + t.target, 0) || 1;
  const credit = tiers.map(() => 0);

  function canAccept(ti, p) {
    const st = tierState[ti];
    if (st.picks.length >= st.target) return false;
    if (st.eventIds.has(p.eventId)) return false;
    if (!exposure.canAddTeam(p.homeTeam) || !exposure.canAddTeam(p.awayTeam)) return false;
    const isHighTierConsensus = (p.sourceCount || 1) >= cfg.highTierConsensusThreshold;
    if (!exposure.canAddConsensusLeg(p.matchKey, isHighTierConsensus)) return false;
    if ((st.leagueCnt[p.league] || 0) >= st.cap) return false;
    if (p.isSoftLeague && st.softCount >= st.softCap) return false;
    return true;
  }
  function accept(ti, p) {
    const st = tierState[ti];
    st.picks.push(p); st.eventIds.add(p.eventId);
    st.leagueCnt[p.league] = (st.leagueCnt[p.league] || 0) + 1;
    const isHighTierConsensus = (p.sourceCount || 1) >= cfg.highTierConsensusThreshold;
    exposure.registerTeam(p.homeTeam); exposure.registerTeam(p.awayTeam);
    if (isHighTierConsensus) exposure.registerConsensusLeg(p.matchKey);
    if (p.isSoftLeague) st.softCount++;
  }

  // Pass 1 — weighted round-robin, exclusive assignment (each game goes to
  // at most one tier here, so pairwise overlap is 0% coming out of this pass).
  for (const p of rankedPool) {
    let bestTi = -1, bestCredit = -Infinity;
    for (let ti = 0; ti < n; ti++) {
      credit[ti] += tiers[ti].target / totalWeight;
      if (!canAccept(ti, p)) continue;
      if (credit[ti] > bestCredit) { bestCredit = credit[ti]; bestTi = ti; }
    }
    if (bestTi >= 0) { accept(bestTi, p); credit[bestTi] -= 1; }
  }

  // Pass 2 — bounded top-up: an under-filled tier may borrow a game already
  // used by another tier, but only while pairwise overlap stays ≤ the cap.
  function sharedCount(setA, setB) { let c = 0; for (const id of setA) if (setB.has(id)) c++; return c; }
  function overlapOk(ti, p) {
    for (let tj = 0; tj < n; tj++) {
      if (tj === ti || !tierState[tj].eventIds.has(p.eventId)) continue;
      const shared = sharedCount(tierState[ti].eventIds, tierState[tj].eventIds) + 1;
      const smaller = Math.min(tierState[ti].picks.length + 1, tierState[tj].picks.length);
      if (smaller > 0 && shared / smaller > cap) return false;
    }
    return true;
  }
  for (let ti = 0; ti < n; ti++) {
    if (tierState[ti].picks.length >= tierState[ti].target) continue;
    for (const p of rankedPool) {
      if (tierState[ti].picks.length >= tierState[ti].target) break;
      if (tierState[ti].eventIds.has(p.eventId)) continue;
      if (!canAccept(ti, p)) continue;
      if (!overlapOk(ti, p)) continue;
      accept(ti, p);
    }
  }

  // Overlap matrix — for logging/verification, computed from the final sets.
  const overlapMatrix = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = sharedCount(tierState[i].eventIds, tierState[j].eventIds);
      const smaller = Math.min(tierState[i].picks.length, tierState[j].picks.length) || 1;
      overlapMatrix.push({ a: tiers[i].name, b: tiers[j].name, shared, pct: Math.round((shared / smaller) * 100) });
    }
  }
  return { picksByTier: tierState.map(st => st.picks), overlapMatrix };
}

// v8 §1 — MULTI-VARIANT TICKETS: several diversified codes at the SAME
// target/odds band for one category, so the portfolio gets multiple
// semi-independent shots at the boom instead of one. Reuses the same
// round-robin + bounded-overlap machinery v7 built for cross-tier
// diversification (buildDiversifiedTierPicks doesn't care whether its
// "tiers" are actually different tiers or same-target variants) — finds the
// largest number of variants (1..maxVariants) the pool can support together
// under variantOverlapCapPct, using disposable exposure clones per trial so
// a failed attempt never consumes real team/league exposure, then builds
// only that many for real.
// v9 §2 — a variant that hits its leg-count target can still land under its
// odds target if the specific legs it drew skew low (e.g. falling back to
// sub-preferred-band odds). "viable" now means leg count AND real combined
// odds. To recover variants that a strict 40% overlap cap would otherwise
// kill, try progressively looser caps (40% -> up to 60%, in 5% steps) BEFORE
// giving up on a slot — more sharing between variants of the SAME category
// is acceptable; a sub-target ticket is not (spec's explicit priority).
function buildCategoryVariants(rankedPool, categoryLabel, target, maxVariants, cfg, exposure, minViableOverride, minOddsTarget, overlapCapMaxOverride) {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const capped = Math.max(0, Math.min(maxVariants, letters.length));
  if (capped === 0 || target <= 0) return { activeCount: 0, totalVariants: maxVariants, picksByVariant: [], overlapMatrix: [] };
  const slots = Array.from({ length: capped }, (_, i) => ({ name: `${categoryLabel} — Variant ${letters[i]}`, target }));
  const minViable = minViableOverride || Math.max(6, Math.round(target * 0.7));
  const isViable = picks => picks.length >= minViable && (!minOddsTarget || computeOdds(picks) >= minOddsTarget);

  // v24 — REAL BUG (user feedback: Moonshot "should come a lot, not just 1
  // or 2 codes... free to change market across all punters"): the shared
  // 60% overlap ceiling made sense for Tier 1-4/Consensus, where distinct
  // variants matter for real diversification. But history showed Moonshot
  // NEVER produced more than 2 variants (out of a max of 5 allowed) across
  // every single run that ever built one — its ~30-55-leg target is
  // typically much bigger than the master pool has room for 5x over, so
  // Pass 2's overlap-bounded top-up (the ONLY way a 2nd+ variant gets
  // filled at all) kept hitting the 60% ceiling and giving up. The user
  // explicitly doesn't mind Moonshot variants reusing the same games with
  // different markets/combinations — that's the whole point of "free to
  // change market across all punters" — so callers can now pass a higher
  // ceiling for categories where volume matters more than uniqueness.
  const capMin = cfg.variantOverlapCapPct, capMax = overlapCapMaxOverride ?? cfg.variantOverlapCapMax ?? 0.60, capStep = cfg.variantOverlapCapStep ?? 0.05;
  let best = { activeCount: 0, cap: capMin };
  for (let cap = capMin; cap <= capMax + 1e-9; cap += capStep) {
    let activeCount = 0;
    for (let n = 1; n <= slots.length; n++) {
      const trialExposure = makeExposureTracker(cfg, exposure.snapshot());
      const { picksByTier: trial } = buildDiversifiedTierPicks(rankedPool, slots.slice(0, n), cfg, trialExposure, cap);
      if (trial.every(isViable)) activeCount = n; else break;
    }
    if (activeCount > best.activeCount) best = { activeCount, cap };
    if (best.activeCount >= capped) break; // already maxed out, no need to relax further
  }
  if (best.activeCount === 0) return { activeCount: 0, totalVariants: capped, picksByVariant: [], overlapMatrix: [] };

  const { picksByTier, overlapMatrix } = buildDiversifiedTierPicks(rankedPool, slots.slice(0, best.activeCount), cfg, exposure, best.cap);
  return { activeCount: best.activeCount, totalVariants: capped, picksByVariant: picksByTier, overlapMatrix, overlapCapUsed: best.cap };
}

// v8 §3 — singles removed entirely. "Important Games Today" is read-only:
// no codes generated from it, it exists purely for transparency and feeds
// the daily review (where mistakes get noted against real picks).
function buildImportantGamesBoard(masterPool) {
  return [...masterPool].sort((a, b) => b.finalScore - a.finalScore);
}

// v7 §3 — mode badge derived from what a tier's picks actually are, never
// arbitrarily assigned. Only labels that map to real content.
function computeTicketMode(picks) {
  if (!picks.length) return 'Mixed';
  const overs = picks.filter(p => /over\/under/i.test(p.marketName || '')).length;
  const dc = picks.filter(p => /double chance|draw no bet/i.test(p.marketName || '')).length;
  if (overs / picks.length >= 0.6) return 'Overs';
  if (dc / picks.length >= 0.6) return 'DC/DNB';
  return 'Mixed';
}

// v8 §1 — each tier now independently attempts up to maxVariants diversified
// codes at ITS OWN target/odds band, against the FULL ranked pool (not a
// pre-sliced cross-tier allocation like v7 used) — cross-tier competition
// for the pool is left to the shared, cumulative team/league exposure caps
// (already tight: 3 tickets per team across the WHOLE run), which is enough
// duplication protection across DIFFERENT categories. The explicit overlap
// cap in this patch is scoped to variants of the SAME category, per spec.
// v14 — the single check-point every leg-count-choosing builder below calls
// before attempting a category: refuses (with an honest "not built" entry,
// same pattern as a too-shallow pool) when the category's target leg count
// exceeds the evidence-based cap, unless the user has explicitly overridden
// it in Settings. Returns null when it's fine to proceed.
function checkLegBracketCap(categoryLabel, sectionKey, targetLegCount, cfg, rec) {
  if (cfg.legBracketCap == null || targetLegCount <= cfg.legBracketCap) return null;
  const reason = `needs ~${targetLegCount} legs — exceeds the historically-proven-viable leg-count cap of ${cfg.legBracketCap} (see Portfolio Survival in Settings; override with "Build tickets beyond the historically-proven-viable leg count" if you want this anyway)`;
  log(rec, `  [${categoryLabel}] SKIPPED — ${reason}`);
  const notBuiltEntry = { section: sectionKey, tier: categoryLabel, notBuilt: true, notBuiltReason: reason, picksAvailable: 0, legBracketCapped: true };
  emit(rec, 'tier-not-built', notBuiltEntry);
  return notBuiltEntry;
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL_POOL — output-architecture redesign (v38)
// ═══════════════════════════════════════════════════════════════════════════
// The generator does two structurally different things: (1) show each
// punter's own edited slip (PUNTER_POOL — buildSectionA, above), and (2)
// build a SMALL number of genuinely aggregated "best of the pool"
// constructions from every eligible leg across ALL punter/community sources
// (GLOBAL_POOL, below). These must never be conflatable in code: every
// GLOBAL section is built from buildGlobalPool()/buildGlobalWidePool()
// ONLY — never from pickMap directly, never from perSourceLegs, never from
// a punter's raw booking code, never from a punter's own Section A ticket.
// A leg's `source` field survives into a global pick purely as a read-only
// label (used by the aggregation report below) — no global builder ever
// branches on which punter a leg came from.
//
// buildGlobalPool == the pipeline the spec asked for, verbatim:
//   ALL SOURCES → collect → remove late legs → score → classify risk →
//   convert where permitted → drop invalid/risky legs → blacklist filtering
//   → exposure controls (applied per-ticket by selectPicksForTicket/
//   buildDiversifiedTierPicks below, using the SAME exposure tracker every
//   global section shares) → deduplicate by event/market → GLOBAL_POOL.
// Every step up to "deduplicate by event" already happened in runGenerator's
// Phase 1-3 (collect/late-drop/score/risk-classify/convert/blacklist) before
// pickMap even exists in its final form — this function is purely the last
// step (dedupe-by-event) plus the risk-safety gate that must never be
// bypassed regardless of the floor setting (see riskCleared below).
function buildGlobalPool(pickMap, cfg, shortOddsPunters, { ignoreFloor = false } = {}) {
  const gm = {};
  for (const p of pickMap.values()) {
    // riskCleared is the non-bypassable safety gate — true only for risk-OK
    // legs, successfully converted legs, or non-REMOVE risky legs
    // legitimately kept in the maybe-band. False for every dropped/
    // REMOVE-risk/failed-conversion leg. Checked UNCONDITIONALLY, even when
    // ignoreFloor skips the pool-quality score floor for GLOBAL_WIDE_POOL —
    // ignoreFloor only ever relaxes the SCORE bar, never the safety gate.
    if (!p.riskCleared) continue;
    if (!ignoreFloor && !p.eligible) continue;
    const bonus = shortOddsPunters?.has(p.source) ? 3 : 0;
    const cur = gm[p.eventId];
    if (!cur) { gm[p.eventId] = p; continue; }
    const curBonus = shortOddsPunters?.has(cur.source) ? 3 : 0;
    const curInBand = cur.odds >= cfg.legOddsPreferredMin && cur.odds <= cfg.legOddsPreferredMax;
    const pInBand = p.odds >= cfg.legOddsPreferredMin && p.odds <= cfg.legOddsPreferredMax;
    if ((p.finalScore + bonus) > (cur.finalScore + curBonus)) gm[p.eventId] = p;
    else if (!curInBand && pInBand && ((cur.finalScore + curBonus) - (p.finalScore + bonus)) <= 5) gm[p.eventId] = p;
  }
  return Object.values(gm);
}

// v38 — item F: similarity check between global tickets. Jaccard overlap on
// exact (event, market, outcome) triples — the same identity key used
// everywhere else in this file for a "selection".
function pickIdentity(p) { return `${p.eventId}|${p.marketId}|${p.outcomeId}`; }
function jaccardOverlap(picksA, picksB) {
  if (!picksA?.length || !picksB?.length) return 0;
  const setA = new Set(picksA.map(pickIdentity));
  const setB = new Set(picksB.map(pickIdentity));
  let shared = 0;
  for (const k of setA) if (setB.has(k)) shared++;
  const union = setA.size + setB.size - shared;
  return union ? shared / union : 0;
}
const GLOBAL_SIMILARITY_DISCARD_THRESHOLD = 0.90; // spec §F — 90%+ identical selections

// v38 — item E: per-ticket aggregation-quality report, proving a GLOBAL
// ticket is actually aggregated rather than a relabeled punter slip. Never
// reads settlement/win-loss data — purely a structural trace of what's
// already on each pick from scoring/conversion.
function buildAggregationReport(picks, label, priorTickets, poolSize) {
  const sourcePunters = [...new Set(picks.map(p => p.source))];
  const sourceCodes = [...new Set(picks.map(p => p.code).filter(Boolean))];
  const leagues = [...new Set(picks.map(p => p.league))];
  const scores = picks.map(p => p.finalScore).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median = scores.length ? (scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2) : 0;
  const overlapWithOtherGlobalTickets = {};
  for (const t of priorTickets) {
    if (!t || t.notBuilt || !t.picks) continue;
    overlapWithOtherGlobalTickets[t.tier] = Math.round(jaccardOverlap(picks, t.picks) * 1000) / 10;
  }
  return {
    sourcePunters, sourcePunterCount: sourcePunters.length,
    sourceCodes, sourceCodeCount: sourceCodes.length,
    uniqueEvents: picks.length, uniqueLeagues: leagues.length,
    numSelections: picks.length, numConverted: picks.filter(p => p.converted).length,
    numDroppedCandidates: Math.max(0, (poolSize || 0) - picks.length),
    avgScore: picks.length ? Math.round(picks.reduce((s, p) => s + p.finalScore, 0) / picks.length) : 0,
    medianScore: Math.round(median),
    overlapWithOtherGlobalTickets,
    selections: picks.map(p => ({
      match: `${p.homeTeam} v ${p.awayTeam}`, market: `${p.marketName}: ${p.outcomeName}`, odds: p.odds, source: p.source,
      score: p.finalScore, converted: !!p.converted,
      reason: p.converted
        ? `Converted (${p.conversionReason?.rule || 'safer market'}); score ${p.finalScore}`
        : `Score ${p.finalScore}${(p.sourceCount || 1) > 1 ? `; backed by ${p.sourceCount} independent sources` : ''}`,
    })),
  };
}

// v38 — item D: the ONE chokepoint every global builder posts a ticket
// through. No caller-supplied odds target is ever enforced here — per spec
// §G, arbitrary odds targets must never force a ticket into existence.
// "Insufficient eligible selections" is returned, honestly, whenever there
// aren't enough real, already-risk-cleared picks — never manufactured.
// v38 — item I: codeGenFn defaults to the real generateTicketCode (so
// production behavior is exactly generateTicketCode's own chokepoint —
// same-match dedupe, universal 50-leg cap, universal 100x floor, post-and-
// readback verification), but is injectable so test-global-pool-
// architecture.js can exercise the full positive path (odds computed from
// final selections, source attribution, etc.) deterministically without a
// real network call — the same "network call only past the guard" safety
// property generateTicketCode already has, extended to be test-visible.
async function emitGlobalTicket(label, picks, cfg, rec, { poolSize, minLegs = 6, codeGenFn = generateTicketCode } = {}) {
  if (picks.length < minLegs) {
    log(rec, `  [${label}] Insufficient eligible selections — ${picks.length} available, need ≥${minLegs}`);
    const notBuiltEntry = { section: 'GLOBAL', tier: label, notBuilt: true, notBuiltReason: `Insufficient eligible selections (${picks.length} available, need ≥${minLegs})`, picksAvailable: picks.length };
    emit(rec, 'tier-not-built', notBuiltEntry);
    return notBuiltEntry;
  }
  // v40 — user feedback ("hope you use good metrics?"): the old merged
  // reason ("code generation failed, OR landed below the floor") forced you
  // to go dig the raw run log for the actual number. generateTicketCode
  // already computes and logs the real pre-guard odds before rejecting —
  // this now surfaces that same number directly on the notBuilt entry, so
  // it's visible without digging: "the pool's best N legs only reach X x,
  // short of the Y x floor" is a genuinely different, more useful message
  // than "failed for one of two possible reasons."
  const preGuardOdds = computeOdds(picks);
  const gen = await codeGenFn(picks, m => log(rec, m));
  await new Promise(r => setTimeout(r, 300));
  if (!gen) {
    const reason = preGuardOdds < cfg.universalMinOdds
      ? `The ${picks.length} best eligible selections only combine to ${fmtOdds(preGuardOdds)}, short of the universal ${fmtOdds(cfg.universalMinOdds)} floor — today's pool doesn't support this section, not a code-generation error`
      : `Selections cleared ${fmtOdds(preGuardOdds)} (above the ${fmtOdds(cfg.universalMinOdds)} floor) but code generation still failed — likely a live-market/network issue, see the run log`;
    log(rec, `  [${label}] ${reason}`);
    const notBuiltEntry = { section: 'GLOBAL', tier: label, notBuilt: true, notBuiltReason: reason, picksAvailable: picks.length, preGuardOdds: Math.round(preGuardOdds * 100) / 100 };
    emit(rec, 'tier-not-built', notBuiltEntry);
    return notBuiltEntry;
  }
  const { code, picks: finalPicks } = gen;
  const odds = computeOdds(finalPicks); // §G — always computed from the ACTUAL final selections, never the pre-guard list
  return {
    section: 'GLOBAL', tier: label, mode: computeTicketMode(finalPicks), code,
    legCount: finalPicks.length, odds: Math.round(odds * 100) / 100,
    avgConfidence: Math.round(finalPicks.reduce((s, p) => s + p.finalScore, 0) / finalPicks.length),
    picks: finalPicks, numDroppedCandidates: Math.max(0, (poolSize || 0) - finalPicks.length),
  };
}

// GLOBAL BEST — the strongest eligible combination from the complete
// GLOBAL_POOL: highest-scored pick per event, greedy, subject to the same
// team/league/consensus exposure caps every section has always respected.
// Never labeled "Guaranteed"/"Sure"/"Safe" — a high calculated score is not
// a guarantee, and the UI-facing label says only what it is: the pool's
// strongest available combination today.
async function buildGlobalBest(pool, cfg, exposure, rec, codeGenFn) {
  const ranked = [...pool].sort((a, b) => b.finalScore - a.finalScore);
  const target = Math.min(25, ranked.length);
  const capped = checkLegBracketCap('Global Best', 'GLOBAL', target, cfg, rec);
  if (capped) return capped;
  const picks = selectPicksForTicket(ranked, target, cfg, exposure, new Set());
  const entry = await emitGlobalTicket('Global Best', picks, cfg, rec, { poolSize: ranked.length, minLegs: 6, codeGenFn });
  if (!entry.notBuilt) log(rec, `  ✓ [Global Best] ${entry.code} | ${entry.legCount}g | ${fmtOdds(entry.odds)}`);
  return entry;
}

// GLOBAL SAFE — v39, added on user feedback ("the 5 mixture"): a smaller,
// structurally more conservative construction than the other 4 — fewer legs
// (so less compounding risk) drawn ONLY from legs whose market itself
// scored safe (marketSafety >= GLOBAL_SAFE_MIN_SAFETY), not just a
// high-score subset of the same pool. If too few legs clear that bar, this
// builds SMALLER rather than reaching down into less-safe markets to hit a
// leg-count target — never padded with a market that didn't actually clear
// the safety bar.
const GLOBAL_SAFE_MIN_SAFETY = 65;
const GLOBAL_SAFE_TARGET_LEGS = 12;
async function buildGlobalSafe(pool, cfg, exposure, rec, codeGenFn) {
  const safeCandidates = pool.filter(p => (p.safety ?? 0) >= GLOBAL_SAFE_MIN_SAFETY).sort((a, b) => b.finalScore - a.finalScore);
  const target = Math.min(GLOBAL_SAFE_TARGET_LEGS, safeCandidates.length);
  const capped = checkLegBracketCap('Global Safe', 'GLOBAL', target, cfg, rec);
  if (capped) return capped;
  const picks = selectPicksForTicket(safeCandidates, target, cfg, exposure, new Set());
  const entry = await emitGlobalTicket('Global Safe', picks, cfg, rec, { poolSize: safeCandidates.length, minLegs: 6, codeGenFn });
  if (!entry.notBuilt) log(rec, `  ✓ [Global Safe] ${entry.code} | ${entry.legCount}g | ${fmtOdds(entry.odds)} from ${safeCandidates.length} legs clearing the safety-≥${GLOBAL_SAFE_MIN_SAFETY} bar`);
  return entry;
}

// GLOBAL MIX — a genuinely different construction METHOD from Global Best
// (round-robin diversified across leagues/categories via
// buildDiversifiedTierPicks, not pure highest-score-first), so it is not
// simply "Global Best minus a few legs" — different selection logic
// producing a different, non-redundant combination, avoiding excessive
// duplication of the same event/team/league within itself via the existing
// per-ticket league/soft-league caps every builder already respects.
async function buildGlobalMix(pool, cfg, exposure, rec, codeGenFn) {
  const ranked = [...pool].sort((a, b) => b.finalScore - a.finalScore);
  const target = Math.min(20, ranked.length);
  const capped = checkLegBracketCap('Global Mix', 'GLOBAL', target, cfg, rec);
  if (capped) return capped;
  const { picksByTier } = buildDiversifiedTierPicks(ranked, [{ name: 'Global Mix', target }], cfg, exposure, cfg.tierOverlapCapPct);
  const picks = picksByTier[0] || [];
  const entry = await emitGlobalTicket('Global Mix', picks, cfg, rec, { poolSize: ranked.length, minLegs: 6, codeGenFn });
  if (!entry.notBuilt) log(rec, `  ✓ [Global Mix] ${entry.code} | ${entry.legCount}g | ${fmtOdds(entry.odds)}`);
  return entry;
}

// GLOBAL BUILDER — v40, user feedback ("global builder can be more than
// one... global builder 1,2,3,4,5... not same game, not same odds"): the
// widest genuinely eligible construction, now split into up to
// maxVariantsGlobalBuilder SEQUENTIAL, NON-OVERLAPPING chunks (best legs
// first, so Builder 1 is still the same "biggest/best" ticket as before) of
// GLOBAL_WIDE_POOL (floor-exempt for volume, but still 100% risk-cleared —
// see buildGlobalPool's riskCleared gate, which ignoreFloor never bypasses),
// capped per-source so no single punter's raw volume can dominate it, and
// each chunk capped at generateTicketCode's universal 50-leg ceiling.
// Sequential slicing guarantees zero event overlap between variants by
// construction — no separate similarity check needed, unlike Best/Safe/Mix/
// High-Risk. Exempt from team/league exposure caps by design (it IS the
// pool), same as the old Max Builder — but never exempt from risk/
// conversion/blacklist, which live upstream of GLOBAL_WIDE_POOL and cannot
// be skipped here. Returns an ARRAY (1 to maxVariantsGlobalBuilder entries,
// or a single notBuilt entry if the pool can't even support one).
// v42 — user feedback ("how is the confidence of the big odds more than the
// small... work confidence to free in global"): a real run showed Builder 1
// at scores 59-78 and Builder 2 at 33-78 — sequential chunking gives variant
// 1 first pick of the wide pool by construction (expected, that's "the plan
// is to hit big odds in one" from the prior request), but nothing stopped a
// later variant from scraping the genuine bottom of the floor-exempt wide
// pool (scores in the 30s) just because it happened to sort into that
// chunk. GLOBAL_BUILDER_MIN_SCORE excludes those low-confidence legs from
// EVERY Builder variant, not just later ones — derived from a real run's
// own score distribution (Builder 2's natural cliff sat around the
// high-40s/50), not picked arbitrarily. This can only ever REDUCE a
// variant's leg count (never re-admit anything, never lower any other
// threshold) — a variant that can no longer hit minLegs after this filter
// is honestly reported as not-built, same as any other insufficient-pool case.
const GLOBAL_BUILDER_MIN_SCORE = 45;
async function buildGlobalBuilder(widePool, cfg, rec, codeGenFn) {
  if (widePool.length < cfg.maxBuilderMinPoolSize) {
    log(rec, `  [Global Builder] SKIPPED — pool ${widePool.length} games, needs ≥${cfg.maxBuilderMinPoolSize}`);
    const notBuiltEntry = { section: 'GLOBAL', tier: 'Global Builder', notBuilt: true, notBuiltReason: `Insufficient eligible selections (${widePool.length} available, need ≥${cfg.maxBuilderMinPoolSize})`, picksAvailable: widePool.length };
    emit(rec, 'tier-not-built', notBuiltEntry);
    return [notBuiltEntry];
  }
  const perSourceCount = {};
  const sorted = [];
  const belowMinScore = [];
  for (const p of [...widePool].sort((a, b) => b.finalScore - a.finalScore)) {
    if (p.finalScore < GLOBAL_BUILDER_MIN_SCORE) { belowMinScore.push(p); continue; }
    const n = perSourceCount[p.source] || 0;
    if (n >= (cfg.maxBuilderPerSourceCap ?? 8)) continue;
    perSourceCount[p.source] = n + 1;
    sorted.push(p);
  }
  if (belowMinScore.length) log(rec, `  [Global Builder] ${belowMinScore.length} eligible-but-low-confidence leg(s) excluded (score < ${GLOBAL_BUILDER_MIN_SCORE}) — never used to pad any variant`);
  const maxVariants = cfg.maxVariantsGlobalBuilder ?? 5;
  const results = [];
  let offset = 0;
  for (let i = 0; i < maxVariants && offset < sorted.length; i++) {
    const chunk = sorted.slice(offset, offset + 50);
    offset += 50;
    if (chunk.length < cfg.maxBuilderMinPoolSize) break; // too thin left over for another real ticket — never pad with what's left
    const entry = await emitGlobalTicket(`Global Builder ${i + 1}`, chunk, cfg, rec, { poolSize: sorted.length, minLegs: cfg.maxBuilderMinPoolSize, codeGenFn });
    if (!entry.notBuilt) {
      log(rec, `  ✓ [Global Builder ${i + 1}] ${entry.code} | ${entry.legCount}g | ${fmtOdds(entry.odds)} (variant ${i + 1} of up to ${maxVariants}, non-overlapping with every other Builder variant)`);
      results.push(entry);
    } else {
      log(rec, `  [Global Builder ${i + 1}] ${entry.notBuiltReason}`);
    }
  }
  if (!results.length) {
    const notBuiltEntry = { section: 'GLOBAL', tier: 'Global Builder', notBuilt: true, notBuiltReason: `${sorted.length} eligible games post per-source cap, but no chunk cleared the universal odds floor or minimum leg count`, picksAvailable: sorted.length };
    emit(rec, 'tier-not-built', notBuiltEntry);
    return [notBuiltEntry];
  }
  log(rec, `  [Global Builder] ${results.length} of ${maxVariants} variants built from ${sorted.length} eligible games (post per-source cap)`);
  return results;
}

// GLOBAL HIGH-RISK — only built if enough genuinely distinct eligible
// selections exist for a real high-leg-count construction (>=15 legs);
// never padded with weak selections to reach a target, never relabeled to
// pretend a smaller pool is bigger than it is.
async function buildGlobalHighRisk(pool, cfg, exposure, rec, codeGenFn) {
  const MIN_HIGH_RISK_LEGS = 15;
  if (pool.length < MIN_HIGH_RISK_LEGS) {
    log(rec, `  [Global High-Risk] SKIPPED — pool ${pool.length} games, needs ≥${MIN_HIGH_RISK_LEGS} genuinely distinct eligible selections`);
    const notBuiltEntry = { section: 'GLOBAL', tier: 'Global High-Risk', notBuilt: true, notBuiltReason: `Insufficient eligible selections (${pool.length} available, need ≥${MIN_HIGH_RISK_LEGS})`, picksAvailable: pool.length };
    emit(rec, 'tier-not-built', notBuiltEntry);
    return notBuiltEntry;
  }
  const ranked = [...pool].sort((a, b) => b.finalScore - a.finalScore);
  const target = Math.min(50, pool.length);
  const capped = checkLegBracketCap('Global High-Risk', 'GLOBAL', target, cfg, rec);
  if (capped) return capped;
  const picks = selectPicksForTicket(ranked, target, cfg, exposure, new Set());
  const entry = await emitGlobalTicket('Global High-Risk', picks, cfg, rec, { poolSize: ranked.length, minLegs: MIN_HIGH_RISK_LEGS, codeGenFn });
  if (!entry.notBuilt) log(rec, `  ✓ [Global High-Risk] ${entry.code} | ${entry.legCount}g | ${fmtOdds(entry.odds)}`);
  return entry;
}

// v38/v39 — item C/F: runs all 5 GLOBAL builders in a fixed order (Best -> Safe -> Mix
// -> Builder -> High-Risk), checking each freshly-built ticket against
// every EARLIER accepted global ticket for >=90% selection overlap. A too-
// similar ticket is discarded and rebuilt EXACTLY ONCE, using only the pool
// with the overlapping events removed (spec §F: "attempt another
// construction only from the remaining eligible pool... if no sufficiently
// different construction exists, don't create another ticket") — never an
// unbounded retry loop, never a relaxed threshold to force a second ticket
// through.
// v38 — item F, extracted as a pure function (no I/O, no randomness) so
// test-global-pool-architecture.js can verify the discard decision directly
// against fake ticket entries, independent of code generation/network.
// Returns the first accepted entry that's >=90% identical, or null.
function findDuplicateGlobalTicket(candidatePicks, acceptedEntries, threshold = GLOBAL_SIMILARITY_DISCARD_THRESHOLD) {
  return acceptedEntries.find(a => a && !a.notBuilt && jaccardOverlap(candidatePicks, a.picks) >= threshold) || null;
}

async function buildGlobalSections(pickMap, cfg, exposure, rec, shortOddsPunters, codeGenFn) {
  const globalPool = buildGlobalPool(pickMap, cfg, shortOddsPunters);
  const globalWidePool = buildGlobalPool(pickMap, cfg, shortOddsPunters, { ignoreFloor: true });
  log(rec, `✓ GLOBAL_POOL: ${globalPool.length} unique eligible games (floor-gated) | GLOBAL_WIDE_POOL: ${globalWidePool.length} unique eligible games (floor-exempt, still fully risk-cleared)`);

  const builders = [
    { label: 'Global Best',      pool: globalPool,     build: p => buildGlobalBest(p, cfg, exposure, rec, codeGenFn) },
    { label: 'Global Safe',      pool: globalPool,     build: p => buildGlobalSafe(p, cfg, exposure, rec, codeGenFn) },
    { label: 'Global Mix',       pool: globalPool,     build: p => buildGlobalMix(p, cfg, exposure, rec, codeGenFn) },
    // v40 — Global Builder alone returns an ARRAY (up to 5 non-overlapping
    // numbered variants — see its own doc comment). Sequential slicing
    // already guarantees zero event overlap between its own variants, so it
    // skips the single-entry similarity-retry logic below entirely — that
    // logic exists to catch two DIFFERENT construction methods converging
    // on the same games, which structurally cannot happen here.
    { label: 'Global Builder',   pool: globalWidePool, multi: true, build: p => buildGlobalBuilder(p, cfg, rec, codeGenFn) },
    { label: 'Global High-Risk', pool: globalPool,     build: p => buildGlobalHighRisk(p, cfg, exposure, rec, codeGenFn) },
  ];

  const accepted = [];
  for (const b of builders) {
    if (b.multi) {
      const entries = await b.build(b.pool);
      for (const entry of entries) {
        if (!entry.notBuilt) {
          entry.aggregation = buildAggregationReport(entry.picks, entry.tier, accepted, entry.numDroppedCandidates + entry.picks.length);
          log(rec, `  [${entry.tier}] aggregation: ${entry.aggregation.sourcePunterCount} punter(s), ${entry.aggregation.sourceCodeCount} code(s), ${entry.aggregation.uniqueLeagues} league(s), ${entry.aggregation.numConverted} converted, ${entry.numDroppedCandidates} pool candidates not used, avg score ${entry.aggregation.avgScore} (median ${entry.aggregation.medianScore})`);
          emit(rec, 'code', entry);
        } else {
          emit(rec, 'tier-not-built', entry);
        }
        accepted.push(entry);
      }
      continue;
    }
    let entry = await b.build(b.pool);
    if (!entry.notBuilt) {
      const dup = findDuplicateGlobalTicket(entry.picks, accepted);
      if (dup) {
        const overlapPct = Math.round(jaccardOverlap(entry.picks, dup.picks) * 100);
        log(rec, `  [${b.label}] discarded — ${overlapPct}% identical to ${dup.tier}, not a meaningfully different construction`);
        const usedEventIds = new Set(entry.picks.map(p => p.eventId));
        const remainingPool = b.pool.filter(p => !usedEventIds.has(p.eventId));
        if (remainingPool.length >= 6) {
          entry = await b.build(remainingPool);
          if (!entry.notBuilt) {
            const dup2 = findDuplicateGlobalTicket(entry.picks, accepted);
            if (dup2) {
              const overlapPct2 = Math.round(jaccardOverlap(entry.picks, dup2.picks) * 100);
              log(rec, `  [${b.label}] retry also too similar to ${dup2.tier} (${overlapPct2}%) — no sufficiently different construction exists, not built`);
              entry = { section: 'GLOBAL', tier: b.label, notBuilt: true, notBuiltReason: `No sufficiently different construction exists from the remaining pool after removing ${dup.tier}'s events (retry was ${overlapPct2}% identical to ${dup2.tier})`, picksAvailable: entry.picks.length };
            }
          }
        } else {
          entry = { section: 'GLOBAL', tier: b.label, notBuilt: true, notBuiltReason: `Only a near-duplicate of ${dup.tier} could be constructed, and the remaining pool after removing its events is too small to try again (${remainingPool.length} left)`, picksAvailable: remainingPool.length };
        }
      }
    }
    if (!entry.notBuilt) {
      entry.aggregation = buildAggregationReport(entry.picks, b.label, accepted, entry.numDroppedCandidates + entry.picks.length);
      log(rec, `  [${b.label}] aggregation: ${entry.aggregation.sourcePunterCount} punter(s), ${entry.aggregation.sourceCodeCount} code(s), ${entry.aggregation.uniqueLeagues} league(s), ${entry.aggregation.numConverted} converted, ${entry.numDroppedCandidates} pool candidates not used, avg score ${entry.aggregation.avgScore} (median ${entry.aggregation.medianScore})`);
      emit(rec, 'code', entry);
    } else {
      emit(rec, 'tier-not-built', entry);
    }
    accepted.push(entry);
  }
  return accepted;
}

// ─── PHASE 9 — CONVERSION AUDIT (diagnostic only) ───────────────────────────
// v37 — user-requested evidence report. Pure read-only trace of what the
// risk/conversion pipeline actually did to every scored leg — NEVER feeds
// back into scoring, conversion, blacklist, or the learning loop (no
// win/loss data is read or used here at all). Cross-references every final
// ticket's `picks` (which still carry `_pickKey`) back onto pickMap so each
// row also shows every section/tier/variant the leg actually landed in — a
// leg CAN legitimately appear in more than one (e.g. a punter's own Section
// A slip AND the shared pool's Tier 1); that's by design, not a bug, and is
// reported as-is rather than collapsed to one.
function buildConversionAudit(pickMap, allTickets) {
  const sectionsByPickKey = new Map();
  for (const t of allTickets) {
    if (!t || !t.code || !Array.isArray(t.picks)) continue;
    const label = t.punter
      ? `A/${t.punter}${t.variant ? '-' + t.variant : ''}`
      : `${t.section || '?'}/${t.tier || 'Ticket'}${t.variant ? '-' + t.variant : ''}`;
    for (const pick of t.picks) {
      const key = pick._pickKey;
      if (!key) continue;
      if (!sectionsByPickKey.has(key)) sectionsByPickKey.set(key, []);
      sectionsByPickKey.get(key).push(label);
    }
  }

  const rows = [];
  for (const p of pickMap.values()) {
    const risk = p.preConversionRisk || 'OK';
    const finalSections = sectionsByPickKey.get(p._pickKey) || [];
    // "Dropped" = ground truth — did this leg end up in ANY real, generated
    // ticket, anywhere (Section A included)? Not just "did it clear the pool
    // floor", since Section A can carry a leg the pool floor rejected.
    const dropped = finalSections.length === 0;
    let dropReason = null;
    if (dropped) {
      if (p._dropReason) dropReason = p._dropReason;
      else if (!p.riskCleared) dropReason = 'risk-mandatory drop with no _dropReason recorded — investigate, should not happen';
      else if (!p.eligible) dropReason = 'below confidence floor (pool sections) and not part of any punter\'s own Section A slip';
      else dropReason = 'eligible for the pool but not selected into any built ticket (exposure cap, per-event dedup lost to a higher scorer, or no category needed it today)';
    }
    const candidateOutcome = p.converted ? 'accepted'
      : !p._conversionAttempted ? 'n/a (never risky, or never reached — see dropReason)'
      : (p._candidatesConsidered || []).length === 0 ? 'no candidate existed'
      : 'candidate(s) existed, rejected';
    rows.push({
      pickKey: p._pickKey, source: p.source, sourceKind: p.sourceKind,
      match: `${p.homeTeam} v ${p.awayTeam}`, league: p.league,
      originalMarket: `${p._origMarketName}: ${p._origOutcomeName}`, originalOdds: p._origOdds,
      originalScore: p.finalScore,
      riskClassification: risk,
      conversionAttempted: !!p._conversionAttempted,
      candidatesConsidered: p._candidatesConsidered || [],
      candidateOutcome,
      finalMarket: `${p.marketName}: ${p.outcomeName}`, finalOdds: p.odds,
      converted: !!p.converted, riskCleared: !!p.riskCleared, eligible: !!p.eligible,
      dropped, dropReason,
      finalSections,
    });
  }
  return rows;
}

function summarizeConversionAudit(rows) {
  const t = {
    totalLegsAudited: rows.length,
    okKept: 0, riskyConverted: 0, riskyKept: 0, riskyDropped: 0, removeDropped: 0,
    conversionsWithOddsLeOriginal: 0, conversionsWithOddsGtOriginal: 0,
    conversionsNoCandidateExisted: 0, conversionsCandidateRejected: 0,
    riskyLegsInBuilderOrMoonshotBypassingRiskPath: [],
  };
  for (const r of rows) {
    const risky = r.riskClassification !== 'OK';
    if (!risky && !r.dropped) t.okKept++;
    if (risky && r.converted) {
      t.riskyConverted++;
      if (r.finalOdds <= r.originalOdds) t.conversionsWithOddsLeOriginal++; else t.conversionsWithOddsGtOriginal++;
    }
    if (risky && !r.converted && r.riskCleared && !r.dropped) t.riskyKept++;
    if (risky && r.riskCleared === false) {
      t.riskyDropped++;
      if (r.riskClassification === 'REMOVE') t.removeDropped++;
    }
    if (risky && r.conversionAttempted && !r.converted) {
      if (r.candidatesConsidered.length === 0) t.conversionsNoCandidateExisted++;
      else t.conversionsCandidateRejected++;
    }
    // ── The integrity check: a risky leg in Global Builder/Global High-Risk
    // MUST have gone through conversionAttempted=true (or been genuinely OK-
    // risk). If canLeaveAsIs ever regresses to skip conversion for a risky
    // leg that still lands in one of these GLOBAL sections, this catches it
    // directly from real output instead of relying on a claim about the code path.
    const inBuilderOrMoonshot = r.finalSections.some(s => /Global Builder|Global High-Risk/i.test(s));
    if (risky && inBuilderOrMoonshot && !r.conversionAttempted) {
      t.riskyLegsInBuilderOrMoonshotBypassingRiskPath.push({ pickKey: r.pickKey, match: r.match, riskClassification: r.riskClassification, finalSections: r.finalSections });
    }
  }
  return t;
}

// ─── MAIN ORCHESTRATOR ────────────────────────────────────────────────────────
async function runGenerator(rec, options) {
  const persistedSettings = loadSettings(); // v6 — Generator Settings modal
  const cfg = { ...DEFAULT_CONFIG, ...persistedSettings, ...(options.config || {}), weights: { ...DEFAULT_CONFIG.weights, ...(options.config?.weights || {}) } };
  // v3.1 §3 — adaptive floor: an explicit config.confidenceFloor always wins;
  // otherwise use whatever the last daily review settled on.
  const floorState = loadFloorState();
  if (options.config?.confidenceFloor == null) cfg.confidenceFloor = floorState.floor;
  const internalBaseUrl = options.internalBaseUrl || null;
  // v14 — real, evidence-based leg-count ceiling: computed once per run from
  // the rolling settled-ticket history (see computeLegBracketSurvival), then
  // consulted by every tier/category builder below before it attempts a big
  // leg count. Never lowers odds targets by picking worse markets — it just
  // refuses to build a leg count that has actually proven itself unwinnable,
  // same honesty as any other "not built — pool-limited" entry.
  const legBracketSurvival = computeLegBracketSurvival(cfg);
  cfg.legBracketCap = cfg.allowBeyondProvenLegCount ? null : legBracketSurvival.effectiveCapLegCount;
  try {
    rec.state.status = 'running';
    setPhase(rec, 'init', 1);

    if (cfg.legBracketCap != null) {
      const capped = legBracketSurvival.brackets.find(b => b.flagged && b.minLegs === cfg.legBracketCap + 1);
      log(rec, `— Leg-count survival cap active: ${cfg.legBracketCap} legs (${capped?.label} bracket is ${capped?.observedWinRatePct}% win rate over ${capped?.sampleSize} settled tickets, last ${legBracketSurvival.windowDays}d) —`);
    }

    // ── Yesterday's lessons block (§5 mandatory) ──────────────────────────
    const lastLessons = safeJSON(LAST_LESSONS_FILE, null);
    if (lastLessons) {
      log(rec, `— Yesterday's lessons applied —`);
      for (const l of (lastLessons.changes || [])) log(rec, `  • ${l}`);
      emit(rec, 'lessons', lastLessons);
    } else {
      log(rec, 'No prior daily-review lessons on file yet (first run, or review not yet triggered).');
    }

    const blacklist = loadBlacklist();
    const dropLearning = loadDropLearning();
    const conversionLearning = loadConversionLearning();
    const downweights = loadDownweights();

    // ── Phase 1: Collect ───────────────────────────────────────────────────
    setPhase(rec, 'collect', 2);
    const punterMap = loadPunterMap();
    const communityList = loadCommunityMap(cfg.communityMinHitRate);
    log(rec, `Loaded ${Object.keys(punterMap).length} punters, ${communityList.length} trusted community sources (of configured min hit-rate ${cfg.communityMinHitRate}%)`);
    const { perSourceLegs, nonFootballLegs } = await collectRawLegs(punterMap, communityList, cfg, dropLearning, rec);
    log(rec, `  ${nonFootballLegs.length} non-football legs collected (table tennis/basketball/etc. — separate lightweight pipeline)`);

    const rawTotal = perSourceLegs.reduce((s, x) => s + x.legs.length, 0);
    if (rawTotal < 5) {
      rec.state.status = 'error'; rec.state.error = 'Not enough legs collected — check punter/community codes.';
      emit(rec, 'run-error', { message: rec.state.error });
      return;
    }
    saveJSON(path.join(AG_DIR, `raw-${rec.state.runId}.json`), { runId: rec.state.runId, generatedAt: new Date().toISOString(), perSourceLegs });
    log(rec, `✓ Phase 1 complete: ${rawTotal} raw legs from ${perSourceLegs.length} source/code combinations`);

    // v11 §2/§3 — identify short-odds punters (their own raw picks average
    // below the preferred-band floor — heavy favorites) from what they
    // actually fetched, before any editing. Computed here, early, so it can
    // both label Section A honestly AND give their legs a fair shot at
    // masterPool inclusion below — their per-leg confidence tends to be
    // genuinely high even though the label doesn't change scoring itself.
    const shortOddsPunters = new Set();
    for (const src of perSourceLegs) {
      if (src.kind !== 'punter' || !src.legs.length) continue;
      const avgOdds = src.legs.reduce((s, l) => s + (l.odds || 1), 0) / src.legs.length;
      if (avgOdds < cfg.legOddsPreferredMin) shortOddsPunters.add(src.source);
    }
    if (shortOddsPunters.size) log(rec, `  Short-odds punters (avg leg odds < ${cfg.legOddsPreferredMin}): ${[...shortOddsPunters].join(', ')}`);

    // ── Phase 2a: Analysing & Filtering (blacklist/league-tier exclusion) ──
    setPhase(rec, 'filter', 16);
    const deps = loadIntelDeps(m => log(rec, '  ' + m));
    const goalsProxy = buildLeagueGoalsProxy(m => log(rec, m));

    // Group legs by exact matchKey to compute community-consensus counts
    // MUST mutate the same objects perSourceLegs[i].legs already points to,
    // not spread-copy into new ones — buildSectionA later does
    // `src.legs.map(l => pickMap.get(l._pickKey))` against those original
    // objects. A spread copy here silently left _pickKey undefined on every
    // leg Section A actually reads, so pickMap.get(undefined) always missed
    // and Section A produced zero tickets on every run — not a genuine
    // "not enough eligible legs" data problem as it appeared from the
    // outside, a plain identity bug. Confirmed via the per-punter diagnostic
    // log added in buildSectionA, which showed "0 scored legs" for every
    // punter despite Phase 1 having collected 30+ legs each.
    const allLegs = perSourceLegs.flatMap(s => s.legs.map(l => {
      l._pickKey = `${l.eventId}|${l.marketId}|${l.specifier}|${l.outcomeId}|${l.source}|${l.code}`;
      return l;
    }));
    const byMatchOutcome = {};
    for (const l of allLegs) {
      const k = `${l.eventId}|${l.marketId}|${l.specifier}|${l.outcomeId}`;
      (byMatchOutcome[k] = byMatchOutcome[k] || []).push(l);
    }

    // v3.1 §2 — two-tier blacklist. HARD (ours) always excludes. intelligence-
    // engine's own BLACKLIST tier also excludes UNLESS the league has been
    // explicitly downgraded to our SOFT list (e.g. friendlies) — the admin's
    // SOFT override wins over the generic calibration tier for that league.
    const excludedByBlacklist = [];
    const dropsByLeague = {}; // v3.1 §5 — league -> {blacklist, floor, noConversion}
    function trackDrop(league, stage) {
      if (!dropsByLeague[league]) dropsByLeague[league] = { blacklist: 0, floor: 0, noConversion: 0 };
      dropsByLeague[league][stage]++;
    }
    const scorable = allLegs.filter(l => {
      const isSoft = blacklist.soft.includes(l.league);
      if (blacklist.hard.includes(l.league)) { excludedByBlacklist.push(l); trackDrop(l.league, 'blacklist'); return false; }
      const tier = leagueTier(l.league, deps.leagueIntel);
      if (tier === 'BLACKLIST' && !isSoft) { excludedByBlacklist.push(l); trackDrop(l.league, 'blacklist'); return false; }
      if (isSoft || (tier === 'BLACKLIST' && isSoft)) l.isSoftLeague = true;
      return true;
    });
    log(rec, `Blacklist exclusion: ${excludedByBlacklist.length} legs HARD-removed. ${scorable.filter(l => l.isSoftLeague).length} legs SOFT-penalized (kept, capped, not excluded).`);

    // ── Phase 2b: Risk Scoring (7-factor FinalScore, per leg) ───────────────
    setPhase(rec, 'score', 20);
    const pickMap = new Map();
    let scored = 0;
    for (const leg of scorable) {
      scored++;
      if (scored % 15 === 0) setPhase(rec, 'score', 20 + Math.round((scored / scorable.length) * 20));
      const key = `${leg.eventId}|${leg.marketId}|${leg.specifier}|${leg.outcomeId}`;
      const eventGroup = byMatchOutcome[key] || [leg];
      const result = await scoreLeg(leg, deps, cfg, internalBaseUrl, goalsProxy, eventGroup, downweights);
      pickMap.set(leg._pickKey, {
        ...leg, matchKey: `${leg.eventId}|${leg.marketId}|${leg.specifier}|${leg.outcomeId}`,
        finalScore: result.finalScore, components: result.components, h2hAvailable: result.h2hAvailable,
        activeFactors: result.activeFactors, missingMajorCount: result.missingMajorCount,
        safety: result.safety, reasons: result.reasons, sourceCount: eventGroup.length,
        eligible: false, converted: false, riskCleared: false,
        // v37 — pure diagnostic snapshot for the conversion audit report
        // (never read by scoring/conversion/learning — read-only evidence).
        // Captured HERE, before Phase 3 can mutate marketName/outcomeName/
        // odds via Object.assign on conversion, so the "original" columns in
        // the audit are always the actual as-fetched values, never whatever
        // convertLeg's own formatted conversionReason.original string says.
        _origMarketName: leg.marketName, _origOutcomeName: leg.outcomeName,
        _origSpecifier: leg.specifier, _origOdds: leg.odds,
        _conversionAttempted: false, _candidatesConsidered: [], _dropReason: null,
      });
    }
    // v3.1 §3 — data coverage: fraction of scored legs with "good" evidence
    // (>= minActiveFactorsForFullConfidence active factors, out of 7). Feeds
    // the adaptive floor decision in the next daily review.
    const wellEvidenced = [...pickMap.values()].filter(p => (p.activeFactors || []).length >= cfg.minActiveFactorsForFullConfidence).length;
    const dataCoverage = pickMap.size ? Math.round((wellEvidenced / pickMap.size) * 100) / 100 : 0;
    log(rec, `✓ Phase 2 complete: ${pickMap.size} legs scored — data coverage ${Math.round(dataCoverage * 100)}% (${wellEvidenced} legs with ≥${cfg.minActiveFactorsForFullConfidence} active factors)`);

    // ── Phase 3: Confidence floor + risk bands + conversion ────────────────
    // v3.2 — runs conversion attempts CONCURRENCY-limited-parallel rather than
    // one leg at a time. The strictly-serial version measured out to 14+
    // minutes of dead air (zero code cards, only a crawling percentage) on a
    // real 500-leg run — technically correct, but indistinguishable from
    // "stuck" to anyone watching the page. This changes only wall-clock time,
    // not a single scoring/conversion decision (mutations below are safe
    // under this pool because each callback's read-modify-write on shared
    // counters has no `await` in between — no interleaving is possible there).
    setPhase(rec, 'convert', 45);
    let convertedCount = 0, droppedFloor = 0, droppedNoConversion = 0, kept = 0;
    const toLeaveAsIs = [], toConvert = [];
    // v36 — REAL BUG: riskBandLeave was a pure composite-FinalScore cutoff —
    // a leg whose market classifies as REMOVE (correct score, HT-FT, corners/
    // cards, anytime scorer, handicap-style — see HARD_REMOVE_PATTERNS) gets
    // marketSafety hard-floored to -1 (clamped to 0 by scoreLeg's Math.max),
    // but that's only 10% of the weighted score — strong team-form/league-
    // intel/punter-accuracy on the other 90% could still push the composite
    // above riskBandLeave and skip convertLeg (and therefore classifyRisk)
    // entirely. That's the exact "blindly carry a risky leg through" failure
    // mode: a correct-score/anytime-scorer pick could reach eligible=true,
    // and therefore the master/wide pool and Sections B-E, purely because
    // its OTHER six factors looked good, with its market risk never actually
    // checked. REMOVE has no entry in SAFE_CONVERSIONS at all (Section A's
    // own always-replace handling already assumes this — see
    // discretionaryRemovalCategory below), so it can never be legitimately
    // "left as is" — it must always be routed through convertLeg, which (see
    // the isMandatoryBand fix inside convertLeg) now always drops it when no
    // safe alternative exists on the live board, regardless of finalScore.
    for (const p of pickMap.values()) {
      const risk = classifyRisk(p.marketName, p.specifier, p.outcomeName);
      p.preConversionRisk = risk;
      if (canLeaveAsIs(risk, p.finalScore, cfg)) toLeaveAsIs.push(p); else toConvert.push(p);
    }
    for (const p of toLeaveAsIs) { p.eligible = true; p.riskCleared = true; kept++; } // >=riskBandLeave AND not a REMOVE-risk market

    let processed = 0;
    await mapWithConcurrency(toConvert, cfg.conversionConcurrency, async (p) => {
      // 61-74: convert only if a replacement scores higher. <=60: conversion
      // is MANDATORY before a drop is allowed — never drop on score alone
      // without first checking whether a safer market rescues it (§2/§3).
      p._conversionAttempted = true; // v37 — audit: this leg actually went through convertLeg, not just canLeaveAsIs
      const conv = await convertLeg(p, p.finalScore, deps, cfg, conversionLearning, p.reasons);
      p._candidatesConsidered = conv.candidatesConsidered || [];
      await new Promise(r => setTimeout(r, 80)); // politeness spacing per worker, even under concurrency
      processed++;
      if (processed % 20 === 0 || processed === toConvert.length) {
        setPhase(rec, 'convert', 45 + Math.round((processed / toConvert.length) * 25));
        log(rec, `  Checking live market board… ${processed}/${toConvert.length} legs`);
      }
      // v3.2 — SOFT-league (friendly) legs already take a −12 score penalty;
      // rather than let that penalty plus the main floor combine to kill
      // nearly all of them (143/165 observed), they clear a separately
      // lower floor. Still fully excluded if HARD-blacklisted; never exempt
      // from scoring, conversion, or the per-ticket SOFT cap — just a lower bar.
      const floorForLeg = p.isSoftLeague ? cfg.softLeagueFloor : cfg.confidenceFloor;
      if (conv.keep) {
        p.riskCleared = true; p.eligible = p.finalScore >= floorForLeg;
        if (!p.eligible) { droppedFloor++; trackDrop(p.league, 'floor'); p._dropReason = `Below confidence floor (${p.finalScore} < ${floorForLeg}) after keeping original market`; }
        else kept++;
        return;
      }
      if (conv.converted) {
        const newSafety = marketSafety(conv.leg.marketName, conv.leg.specifier, conv.leg.outcomeName, conv.leg.homeTeam, conv.leg.awayTeam);
        Object.assign(p, conv.leg, { safety: newSafety, converted: true });
        // Re-run the safety component of FinalScore with the new market
        p.finalScore = Math.min(100, Math.round(p.finalScore + Math.max(0, newSafety - (p.components.marketSafety || 0)) * cfg.weights.marketSafety));
        p.riskCleared = true;
        p.eligible = p.finalScore >= floorForLeg;
        convertedCount++;
        if (p.eligible) kept++; else { droppedFloor++; trackDrop(p.league, 'floor'); p._dropReason = `Converted (${conv.leg.conversionReason?.rule}) but still below confidence floor (${p.finalScore} < ${floorForLeg})`; }
      } else {
        // v36 — REAL BUG: this branch (mandatory conversion required, none
        // found on the live board — e.g. a REMOVE-risk market, or any market
        // scoring <=60 with no safe alternative) left p.riskCleared at its
        // pickMap default of false, which correctly kept it out of the
        // score-floor-gated masterPool. But widePool (Max Builder) is built
        // with dedupBestPerEvent(true, true) — ignoreFloor=true skipped the
        // `!p.eligible` check ENTIRELY, and eligible/riskCleared were the
        // same flag before this patch, so a leg the pipeline had explicitly
        // decided MUST be dropped (no safe market exists) could still be
        // selected into Max Builder with its original, unconverted risky
        // market. riskCleared is now a separate flag that dedupBestPerEvent
        // always checks, regardless of ignoreFloor — see below.
        p.riskCleared = false;
        droppedNoConversion++;
        trackDrop(p.league, 'noConversion');
        p._dropReason = conv.reason || 'No safe conversion found on live board';
      }
    }, () => rec.stopRequested);
    if (rec.stopRequested) log(rec, `  ⏹ Stop honored — ${processed}/${toConvert.length} legs had been checked; building output from those now.`);
    const topDropLeagues = Object.entries(dropsByLeague)
      .map(([league, d]) => ({ league, total: d.blacklist + d.floor + d.noConversion, ...d }))
      .sort((a, b) => b.total - a.total).slice(0, 10);
    log(rec, `✓ Phase 3 complete: ${convertedCount} converted, ${kept} kept eligible, ${droppedFloor} dropped (confidence floor ${cfg.confidenceFloor}), ${droppedNoConversion} dropped (no safe conversion)`);
    log(rec, `  Top drop leagues: ${topDropLeagues.slice(0, 5).map(d => `${d.league} (${d.total})`).join(', ') || 'none'}`);

    // ── Phase 4/5: month-losses + killer-league context already loaded via deps.killerLeagues
    setPhase(rec, 'intelligence', 72);
    const monthLosses = buildMonthLosses(m => log(rec, m));
    log(rec, `Month-losses index: ${monthLosses.buckets.length} league/market/odds-band failure buckets tracked`);

    // v4 §1/§2 — Section A DISCRETIONARY removal classification, computed
    // once for every scored leg (independent of the pool floor/`eligible`).
    // Uses each leg's FINAL market (post-conversion, if any) — a leg
    // converted away from a risky market is no longer that risky market.
    // v9 §3 — this used to be an unconditional removal; it's now just a
    // CLASSIFICATION. buildSectionA decides per-punter-slip, worst-scored
    // first, whether to actually spend a removal against minPunterSlipOdds
    // — see the budgeted removal logic there. Two discretionary categories:
    //  - REMOVE-classified market (correct score/HT-FT/corners/cards/scorer/
    //    handicap-style) has no entry in SAFE_CONVERSIONS at all, so it can
    //    never have been successfully converted.
    //  - A proven TOXIC pattern from real month-loss data (≥3 recorded kills).
    // Everything else — including anything merely below the pool confidence
    // floor — is never a discretionary-removal candidate at all, per the
    // "light touch" concept: Section A edits the punter's slip, it doesn't
    // re-filter it through the pool's own bar.
    for (const p of pickMap.values()) {
      const risk = classifyRisk(p.marketName, p.specifier, p.outcomeName);
      if (risk === 'REMOVE') {
        p.discretionaryRemovalCategory = 'always-replace';
        p.discretionaryRemovalReason = 'Always-replace market with no safe equivalent on the board (correct score/HT-FT/corners/cards/scorer/handicap-style)';
      } else if (isToxicPattern(p, monthLosses, cfg)) {
        p.discretionaryRemovalCategory = 'toxic';
        p.discretionaryRemovalReason = 'Proven killer pattern — this league/market/odds-band has ≥3 recorded Over-missed losses in the last month';
      } else {
        p.discretionaryRemovalCategory = null;
      }
    }

    // ── Build master pool: best pick per event among eligible legs ─────────
    // v7 §2 — pool sections only (Section A pulls straight from pickMap via
    // each punter's own legs, entirely independent of this pool). When two
    // eligible legs exist for the same event with close scores, prefer the
    // one whose odds land in the preferred payout band instead of always
    // taking the single highest scorer regardless of odds — the score
    // already accounts for risk, the band controls payout density. A leg is
    // never swapped OUT of a live market it wasn't already scored on — this
    // only chooses AMONG candidates that genuinely exist in pickMap already,
    // never mutates a leg's market (which could otherwise leak into a
    // punter's own Section A ticket sharing that same pickMap object).
    // v11 §3 — a small (+3) scoring nudge for legs sourced from a
    // short-odds punter, so their favorite picks (genuinely high per-leg
    // confidence — that's WHY the punter played them short) aren't easily
    // displaced by a marginally-higher-scored pick from another source for
    // the same event. Bounded and transparent: it only swings a close call,
    // never overrides a real quality gap.
    // v38 — GLOBAL_POOL / GLOBAL_WIDE_POOL, built by the shared, top-level
    // buildGlobalPool() (see its doc comment for the full pipeline mapping).
    // This replaces the old inline dedupBestPerEvent closure — same dedupe
    // logic, now a named, testable, top-level function instead of a private
    // closure only runGenerator itself could call.
    const masterPool = buildGlobalPool(pickMap, cfg, shortOddsPunters);
    // One-time diagnostic comparison for the report — never built into two
    // real ticket sets, just measures whether the bonus actually changed
    // the pool's composition and by how much.
    if (shortOddsPunters.size) {
      const withoutBonus = buildGlobalPool(pickMap, cfg, null);
      const avg = arr => arr.length ? arr.reduce((s, p) => s + p.finalScore, 0) / arr.length : 0;
      const avgOdds = arr => arr.length ? arr.reduce((s, p) => s + p.odds, 0) / arr.length : 0;
      const swapped = masterPool.filter(p => shortOddsPunters.has(p.source) && !withoutBonus.some(q => q.eventId === p.eventId && q.source === p.source)).length;
      log(rec, `  Short-odds-punter pool bonus: ${swapped} event(s) now sourced from a short-odds punter that wouldn't be otherwise — avg confidence ${avg(withoutBonus).toFixed(1)}→${avg(masterPool).toFixed(1)}, avg leg odds ${avgOdds(withoutBonus).toFixed(2)}→${avgOdds(masterPool).toFixed(2)}`);
    }
    let lastResortCount = 0;
    for (const p of masterPool) {
      p.lastResortFiller = p.odds < cfg.legOddsHardFloor;
      if (p.lastResortFiller) { lastResortCount++; p.reasons.push(`Below odds floor (${p.odds.toFixed(2)} < ${cfg.legOddsHardFloor}) — used only as last-resort filler`); }
    }
    log(rec, `✓ GLOBAL_POOL: ${masterPool.length} unique games eligible (${lastResortCount} below odds floor ${cfg.legOddsHardFloor}, flagged as last-resort filler)`);
    emit(rec, 'pool', { count: masterPool.length, pool: masterPool.slice(0, 500) });

    // ── Phase 7/8: exposure-aware ticket building ───────────────────────────
    // Two distinct real phases (not one big "build") so the 7-stage UI strip
    // has genuine, separately-timestamped start/end points to show elapsed
    // time for "Building Slips" (PUNTER_POOL) vs "Final Optimisation"
    // (GLOBAL_POOL sections) rather than both appearing to start and finish
    // at the same instant.
    setPhase(rec, 'build', 80);
    const exposure = makeExposureTracker(cfg);
    const mode = options.mode || 'full'; // full | punters (Section A only) | mixtures (GLOBAL sections only — re-reads current punter results per §9)

    const sectionA = (mode !== 'mixtures') ? await buildSectionA(perSourceLegs, pickMap, cfg, exposure, rec, legBracketSurvival) : { results: [], belowTarget: [] };

    setPhase(rec, 'optimize', 88);
    const importantGamesBoard = buildImportantGamesBoard(masterPool); // v8 §3 — read-only, no codes
    // v38 — output-architecture redesign: the old Tier1-4/Consensus/Max
    // Builder/Moonshot(-Lite/Mini)/Sure Tier/Mix/Rebalance sprawl (up to ~20
    // near-duplicate pool tickets) is replaced by buildGlobalSections' 4
    // purposeful, deduplicated GLOBAL constructions (Best/Mix/Builder/
    // High-Risk) — see its own doc comment for the full architecture.
    const sectionB = (mode !== 'punters') ? await buildGlobalSections(pickMap, cfg, exposure, rec, shortOddsPunters) : [];
    const nonFootballTicket = (mode !== 'punters') ? await buildNonFootballTicket(nonFootballLegs, deps, cfg, exposure, rec) : null;
    if (nonFootballTicket) sectionB.push(nonFootballTicket);
    // v38 — sectionD/sectionE are now always empty: every pool-based ticket
    // lives in sectionB's 5 GLOBAL entries. Kept as empty arrays (not
    // removed) purely so the persisted-run shape and every downstream
    // consumer (funnel/summary/codesOf/recordGeneratedCodes/UI) keeps
    // working unchanged rather than needing a schema migration.
    const sectionD = [], sectionE = [];
    if (mode !== 'full') log(rec, `Mode: ${mode} — ${mode === 'punters' ? 'Section A only (punter slips)' : 'GLOBAL sections only, punter data re-read fresh'}`);

    // v37 — PHASE 9: conversion audit. Diagnostic only — computed from what
    // already happened above, changes nothing, feeds nothing back into
    // scoring/conversion/learning. allTickets deliberately includes every
    // real, code-bearing ticket: PUNTER_POOL (sectionA) and every GLOBAL
    // section (sectionB, which now holds Global Best/Safe/Mix/Builder/High-Risk
    // plus Non-Football; sectionD/E are always empty post-v38).
    const allTicketsForAudit = [...sectionA.results, ...sectionA.belowTarget, ...sectionB, ...sectionD, ...sectionE];
    const conversionAudit = buildConversionAudit(pickMap, allTicketsForAudit);
    const conversionAuditTotals = summarizeConversionAudit(conversionAudit);
    saveJSON(path.join(AG_DIR, `conversion-audit-${rec.state.runId}.json`), { runId: rec.state.runId, generatedAt: new Date().toISOString(), totals: conversionAuditTotals, rows: conversionAudit });
    log(rec, `  [Conversion Audit] ${conversionAuditTotals.totalLegsAudited} legs — OK kept ${conversionAuditTotals.okKept}, risky converted ${conversionAuditTotals.riskyConverted}, risky kept ${conversionAuditTotals.riskyKept}, risky dropped ${conversionAuditTotals.riskyDropped} (of which REMOVE ${conversionAuditTotals.removeDropped}), conversions odds<=original ${conversionAuditTotals.conversionsWithOddsLeOriginal}/${conversionAuditTotals.riskyConverted}, no-candidate-existed ${conversionAuditTotals.conversionsNoCandidateExisted}, candidate-rejected ${conversionAuditTotals.conversionsCandidateRejected}, integrity violations ${conversionAuditTotals.riskyLegsInBuilderOrMoonshotBypassingRiskPath.length}`);
    if (conversionAuditTotals.riskyLegsInBuilderOrMoonshotBypassingRiskPath.length) {
      log(rec, `  [Conversion Audit] ✗ INTEGRITY VIOLATION — risky leg(s) reached Max Builder/Moonshot without going through conversion: ${JSON.stringify(conversionAuditTotals.riskyLegsInBuilderOrMoonshotBypassingRiskPath)}`);
    }

    setPhase(rec, 'summary', 96); // Output & Save
    const allTicketOdds = [...sectionA.results, ...sectionB, ...sectionD, ...sectionE].filter(t => t && !t.notBuilt).map(t => t.odds);
    const totalLegsFetched = perSourceLegs.reduce((s, x) => s + x.legs.length + (x.droppedLegs?.length || 0), 0);
    const funnel = {
      totalLegsFetched,                          // every leg on every fetched code, before anything
      afterLateLegDrop: rawTotal,                 // after dropping last N legs per code
      afterHardBlacklist: scorable.length,        // after HARD blacklist (SOFT stays in, just penalized)
      afterConfidenceFloor: kept,                 // individual legs that cleared the floor
      finalPoolGames: masterPool.length,          // deduped best-pick-per-event
    };
    const summary = {
      runId: rec.state.runId, date: localToday(), finishedAt: new Date().toISOString(),
      puntersProcessed: Object.keys(punterMap).length, communityProcessed: communityList.length,
      funnel,
      matchesAnalysed: masterPool.length, // kept for backward compat — this is FINAL POOL SIZE, see `funnel` for the full breakdown
      marketsConverted: convertedCount,
      legsDropped: { blacklist: excludedByBlacklist.length, confidenceFloor: droppedFloor, noConversion: droppedNoConversion },
      topDropLeagues,
      floorToday: cfg.confidenceFloor, dataCoverage,
      highestConfidence: masterPool.length ? Math.max(...masterPool.map(p => p.finalScore)) : 0,
      lowestConfidence: masterPool.length ? Math.min(...masterPool.map(p => p.finalScore)) : 0,
      avgConfidence: masterPool.length ? Math.round(masterPool.reduce((s, p) => s + p.finalScore, 0) / masterPool.length) : 0, // v6 — real average across the final pool, for the dashboard's live summary bar
      topRiskyLeagues: Object.entries(deps.killerLeagues || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => ({ league: l, weight: n })),
      averageGeneratedOdds: allTicketOdds.length ? Math.round(allTicketOdds.reduce((s, o) => s + o, 0) / allTicketOdds.length) : 0,
      sections: {
        A: sectionA.results.length, A_belowTarget: sectionA.belowTarget.length,
        B: sectionB.filter(t => t.code).length, BnotBuilt: sectionB.filter(t => t.notBuilt).length,
        boardSize: importantGamesBoard.length,
        D: sectionD.filter(t => t.code).length, E: sectionE.filter(t => t.code).length,
      },
      exposureSnapshot: exposure.snapshot(),
      durationMs: Date.now() - new Date(rec.state.startedAt).getTime(),
      // v14 — the exact cap decision this run actually used, so a later
      // report/audit doesn't have to recompute the rolling window from
      // scratch and can't drift from what really happened at build time.
      legBracketCap: cfg.legBracketCap,
      legBracketSurvivalWindowDays: legBracketSurvival.windowDays,
      legBracketSurvivalDaysWithData: legBracketSurvival.daysWithData,
      // v38 — replaces the old oddsBandCoverage (which existed to justify
      // building a "Rebalance-<band>" ticket purely to fill an empty odds
      // band — exactly the arbitrary-odds-target-forcing-a-ticket pattern
      // the output-architecture redesign removed). This instead reports
      // what each real GLOBAL section's ACTUAL odds/leg-count landed at —
      // descriptive, never a target to be hit.
      globalSectionsSummary: sectionB.filter(t => t && t.section === 'GLOBAL').map(t => t.notBuilt
        ? { tier: t.tier, notBuilt: true, notBuiltReason: t.notBuiltReason }
        : { tier: t.tier, legCount: t.legCount, odds: t.odds, avgConfidence: t.avgConfidence }),
      sectionARedirected: sectionA.redirected || [],
      conversionAuditTotals, // v37 — diagnostic only, see conversion-audit-<runId>.json for the full per-leg trace
    };
    log(rec, `  Funnel: ${funnel.totalLegsFetched} fetched → ${funnel.afterLateLegDrop} after late-leg drop → ${funnel.afterHardBlacklist} after HARD blacklist → ${funnel.afterConfidenceFloor} after confidence floor → ${funnel.finalPoolGames} final pool games`);

    // v15 §4 — REGEN INTEGRITY CHECK, permanent and automatic on every save,
    // not a one-time test. Snapshot every PRIOR RUN's own stored entry that
    // OUGHT to survive this write's slice(-60) trim (i.e. excluding runs old
    // enough to be legitimately evicted), write the new history, then re-read
    // it from disk and confirm that exact prior run entry is still present,
    // byte-for-byte, keyed by runId. Any mismatch is real data loss — the run
    // is marked as an error immediately, loudly.
    //
    // IMPORTANT — this must compare PER-RUN, not via one code-keyed map
    // across all of history: SportyBet's booking codes are deterministic
    // (identical event/market/outcome selections produce the identical code
    // string), so the SAME code can legitimately reappear in a brand-new run
    // with fresher odds (the market moved between the two runs) without the
    // old run's own record being touched at all. A flat map keyed by code
    // would see that as "altered" — a false alarm on real, intact data. Only
    // a genuine change to a PRIOR run's own persisted object is a failure.
    function codesOf(run) {
      const map = new Map();
      for (const arr of [run.sectionA, run.sectionA_belowTarget, run.sectionB, run.sectionD, run.sectionE]) {
        if (!Array.isArray(arr)) continue;
        for (const t of arr) if (t && t.code) map.set(t.code, `${t.odds}|${t.legCount}`);
      }
      return map;
    }
    const preWriteHistory = safeJSON(RESULTS_FILE, []);
    const newEntry = { runId: rec.state.runId, timestamp: new Date().toISOString(), summary, sectionA: sectionA.results, sectionA_belowTarget: sectionA.belowTarget, sectionB, sectionD, sectionE };
    const combinedHistory = [...preWriteHistory, newEntry];
    const trimmedHistory = combinedHistory.slice(-60);
    const evictedCount = combinedHistory.length - trimmedHistory.length;
    const expectedSurvivorRuns = preWriteHistory.slice(evictedCount);

    saveJSON(RESULTS_FILE, trimmedHistory);

    const postWriteHistory = safeJSON(RESULTS_FILE, []);
    const postByRunId = new Map(postWriteHistory.map(r => [r.runId, r]));
    const integrityFailures = [];
    for (const run of expectedSurvivorRuns) {
      const post = postByRunId.get(run.runId);
      if (!post) { integrityFailures.push(`entire generation ${run.runId} missing`); continue; }
      const before = codesOf(run), after = codesOf(post);
      for (const [code, sig] of before) {
        const postSig = after.get(code);
        if (postSig === undefined) integrityFailures.push(`${code} (missing from generation ${run.runId})`);
        else if (postSig !== sig) integrityFailures.push(`${code} (altered in generation ${run.runId} — was ${sig}, now ${postSig})`);
      }
    }
    if (integrityFailures.length) {
      const msg = `INTEGRITY FAILURE: ${integrityFailures.length} code(s) from a prior generation missing or altered after this regen — ${integrityFailures.slice(0, 3).join(', ')}${integrityFailures.length > 3 ? `, +${integrityFailures.length - 3} more` : ''}`;
      log(rec, `  ✗ ${msg}`);
      rec.state.status = 'error';
      rec.state.error = msg;
      rec.state.finishedAt = new Date().toISOString();
      emit(rec, 'run-error', { message: msg, integrityFailures });
      persistRunState(rec);
      return;
    }
    const expectedSurvivorCodeCount = expectedSurvivorRuns.reduce((n, run) => n + codesOf(run).size, 0);
    log(rec, `  ✓ Regen integrity check: ${expectedSurvivorRuns.length} prior generation(s), ${expectedSurvivorCodeCount} code(s) verified intact after this write${evictedCount ? ` (${evictedCount} oldest run(s) legitimately rolled off the 60-run window)` : ''}`);

    saveJSON(path.join(AG_DIR, `pool-${rec.state.runId}.json`), { runId: rec.state.runId, masterPool, board: importantGamesBoard.slice(0, 400) });

    const codesRecorded = recordGeneratedCodes(rec.state.runId, [...sectionA.results, ...sectionA.belowTarget, ...sectionB, ...sectionD, ...sectionE]);
    log(rec, `  Recorded ${codesRecorded} real booking codes into the dashboard's Codes Today counter`);

    rec.state.summary = summary;
    rec.state.status = rec.stopRequested ? 'stopped' : 'done'; // v6 — graceful stop still builds/persists real output from whatever was collected
    rec.state.finishedAt = new Date().toISOString();
    rec.state.progressPct = 100;
    emit(rec, 'summary', summary);
    emit(rec, rec.stopRequested ? 'stopped' : 'done', { summary });
    persistRunState(rec);
    log(rec, `✓ Run complete in ${Math.round(summary.durationMs / 1000)}s`);
  } catch (e) {
    console.error('[adv-gen] fatal', e);
    rec.state.status = 'error';
    rec.state.error = e.message;
    emit(rec, 'run-error', { message: e.message });
    persistRunState(rec);
  }
}

function startRun(options) {
  const rec = createRun(options);
  // Fire and forget — progress streams via SSE/polling, response already returned
  runGenerator(rec, options).catch(e => console.error('[adv-gen] uncaught', e));
  return rec.state.runId;
}

// ─── DAILY SELF-REVIEW (§5) ───────────────────────────────────────────────────
function scoreboardFile(dateStr) { return path.join(AG_DIR, `scoreboard-${dateStr}.json`); }

// v14 — the learning loop up to v13 only corrected PICK QUALITY (league/
// punter/market down-weighting). It never asked whether a TICKET SIZE was
// winnable at all: 71% real leg hit rate still produced 0/67 ticket wins on
// 2026-07-23 because a 25-leg accumulator needs every one of those legs to
// land — that's a portfolio-construction problem, not a picks problem.
const LEG_BRACKETS = [
  { label: '1-10', min: 1, max: 10 },
  { label: '11-20', min: 11, max: 20 },
  { label: '21-30', min: 21, max: 30 },
  { label: '31+', min: 31, max: Infinity },
];

// Rolls up every stored scoreboard-*.json over the last cfg.legBracketRollingDays
// days and buckets every SETTLED ticket (won/lost, pending excluded — can't
// judge an unfinished ticket) by leg count. For each bracket: real observed
// ticket win rate, real observed leg hit rate, and the THEORETICAL win rate
// that leg hit rate would imply if legs were independent
// (legHitRate ^ avgLegCount) — the gap between observed and theoretical is
// exactly what "big accumulators are structurally hard" looks like in data.
// A bracket is "flagged" (historically near-impossible) once it has enough
// settled samples (legBracketMinSample) AND its observed win rate is at or
// below legBracketCapThreshold. effectiveCapLegCount is the leg count just
// below the smallest flagged bracket — null when nothing is flagged (either
// genuinely fine, or not enough data yet to say).
function computeLegBracketSurvival(cfg) {
  const days = cfg.legBracketRollingDays ?? 14;
  const minSample = cfg.legBracketMinSample ?? 30;
  const capThreshold = cfg.legBracketCapThreshold ?? 0.02;
  let files = [];
  try { files = fs.readdirSync(AG_DIR).filter(f => /^scoreboard-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-days); } catch {}

  const buckets = LEG_BRACKETS.map(b => ({ ...b, ticketsSettled: 0, ticketsWon: 0, legsWon: 0, legsSettled: 0, legCountSum: 0 }));
  const dateRange = [];
  for (const f of files) {
    const board = safeJSON(path.join(AG_DIR, f), null);
    if (!board || !Array.isArray(board.tickets)) continue;
    dateRange.push(board.date || f.replace(/^scoreboard-|\.json$/g, ''));
    for (const t of board.tickets) {
      if (!t || t.status === 'PENDING' || !t.legCount) continue;
      const bucket = buckets.find(b => t.legCount >= b.min && t.legCount <= b.max);
      if (!bucket) continue;
      bucket.ticketsSettled++;
      if (t.status === 'WON') bucket.ticketsWon++;
      bucket.legsWon += (t.won || 0);
      bucket.legsSettled += (t.won || 0) + (t.lost || 0);
      bucket.legCountSum += t.legCount;
    }
  }

  const brackets = buckets.map(b => {
    const observedWinRate = b.ticketsSettled ? b.ticketsWon / b.ticketsSettled : null;
    const legHitRate = b.legsSettled ? b.legsWon / b.legsSettled : null;
    const avgLegCount = b.ticketsSettled ? b.legCountSum / b.ticketsSettled : null;
    const theoreticalWinRate = (legHitRate != null && avgLegCount != null) ? Math.pow(legHitRate, avgLegCount) : null;
    const flagged = b.ticketsSettled >= minSample && observedWinRate != null && observedWinRate <= capThreshold;
    return {
      label: b.label, minLegs: b.min, maxLegs: Number.isFinite(b.max) ? b.max : null,
      sampleSize: b.ticketsSettled, ticketsWon: b.ticketsWon,
      observedWinRatePct: observedWinRate != null ? Math.round(observedWinRate * 1000) / 10 : null,
      legHitRatePct: legHitRate != null ? Math.round(legHitRate * 1000) / 10 : null,
      avgLegCount: avgLegCount != null ? Math.round(avgLegCount * 10) / 10 : null,
      theoreticalWinRatePct: theoreticalWinRate != null ? Math.round(theoreticalWinRate * 100000) / 1000 : null,
      flagged,
    };
  });
  const flaggedBrackets = brackets.filter(b => b.flagged);
  const effectiveCapLegCount = flaggedBrackets.length ? Math.min(...flaggedBrackets.map(b => b.minLegs)) - 1 : null;

  return {
    windowDays: days, daysWithData: dateRange.length, dateRange,
    minSample, capThresholdPct: Math.round(capThreshold * 1000) / 10,
    allowBeyondProvenLegCount: !!cfg.allowBeyondProvenLegCount,
    brackets, effectiveCapLegCount,
  };
}

// v7 §6 — collects every real ticket generated on a given date and scans
// each via /api/scan/CODE ONCE, caching the raw result. A ticket with zero
// pending legs is fully settled and can never change, so a re-open of the
// Performance tab (or the daily-review job) reuses that cached scan instead
// of hitting SportyBet again — "wire them to the same cache so scan happens
// once", per spec. runDailyReview (the learning loop) consumes this same
// cache rather than re-scanning independently.
async function buildScoreboard(dateStr, internalBaseUrl, logger = () => {}, forceRescan = false) {
  const history = safeJSON(RESULTS_FILE, []);
  const todaysRuns = history.filter(r => r.summary?.date === dateStr);
  if (!todaysRuns.length) return { success: false, error: `No runs found for ${dateStr}` };

  const allTickets = [];
  // v21 — REAL BUG: the exact same booking code can legitimately be rebuilt
  // by a LATER regen too, not just twice within one run — if the underlying
  // pool of upcoming games hasn't changed between two regens (e.g. nothing
  // new kicked off yet), SportyBet's deterministic codes mean the identical
  // ticket comes back out. That's not a new bet, it's the SAME real ticket,
  // so it must only ever be counted once for the day — otherwise one real
  // ticket triples up in ticketsGenerated/won/lost/pending and the Report
  // shows the exact same row (same code, same odds, same status) repeated
  // back to back. Dedupe spans the WHOLE day (todaysRuns is oldest-run-first,
  // so the earliest generation that produced a code keeps it — same
  // first-occurrence rule the Codes page already applies client-side).
  const seenCodesToday = new Set();
  for (const run of todaysRuns) {
    // sectionD/E are arrays of variants from v8 on; older persisted runs may
    // still have a single object or null — normalize both shapes the same way.
    const dArr = Array.isArray(run.sectionD) ? run.sectionD : [run.sectionD];
    const eArr = Array.isArray(run.sectionE) ? run.sectionE : [run.sectionE];
    const tickets = [...(run.sectionA || []), ...(run.sectionA_belowTarget || []), ...(run.sectionB || []), ...dArr, ...eArr].filter(t => {
      if (!t || !t.code || t.notBuilt) return false;
      if (seenCodesToday.has(t.code)) return false;
      seenCodesToday.add(t.code);
      return true;
    });
    for (const t of tickets) allTickets.push({ runId: run.runId, name: t.punter || t.tier || (t.section === 'D' ? 'Weekly Moonshot' : t.section === 'E' ? 'Sure Tier' : 'Ticket'), section: t.section, tier: t.tier, code: t.code, legCount: t.legCount, odds: t.odds, picks: t.picks || [] });
  }

  const cached = safeJSON(scoreboardFile(dateStr), null);
  const cachedByCode = {};
  if (cached && !forceRescan) for (const t of (cached.tickets || [])) cachedByCode[t.code] = t;

  const ticketResults = [];
  const killerCounts = {}; // eventId -> {count, matchLabel, league, market, score}
  const leagueStats = {}; // league -> {legs, won, lost}
  // v13 §2 — EVERY distinct (event, market, outcome) that appeared in any
  // ticket today, not just the ones that killed >=2 tickets (killerCounts
  // above stays as-is for that narrower view). Keyed on the same triple a
  // real leg is uniquely identified by, since two tickets can in principle
  // pick different markets on the same match.
  const gameLedger = {};
  let totalLegsW = 0, totalLegsL = 0, totalLegsV = 0, totalLegsP = 0, totalLegsUnverified = 0;

  // v21 — REAL BUG: on a date with many still-pending tickets (normal for
  // "today" — 127 of 131 tickets were pending when this was found), every
  // ticket was rescanned ONE AT A TIME, each with a 150ms courtesy delay on
  // success and up to ~16.5s of retry+timeout on failure. That's minutes of
  // pure serial wall-clock time — the Report page wasn't actually empty or
  // broken, the request just never finished within any request timeout a
  // human would wait for. Fixed by resolving scans in small concurrent
  // batches instead of strictly one at a time; the retry/fallback/cache
  // logic per ticket is unchanged, only "one at a time" is gone. Batch size
  // kept modest (not "all 131 at once") to stay gentle on SportyBet's API.
  // A wall-clock deadline below is the real fix, though: concurrency alone
  // still can't bound total time on a day with enough tickets or a flaky
  // upstream, and this endpoint must never hang indefinitely regardless.
  const SCAN_BATCH_SIZE = 12;
  const SCAN_DEADLINE_MS = 25000;
  const scanStartedAt = Date.now();
  async function resolveTicketScan(t) {
    const prior = cachedByCode[t.code];
    if (prior && prior._rawScan && prior.pending === 0) return { t, scan: prior._rawScan };
    // v19 §6 — REAL BUG: a transient scan failure (SportyBet timeout/rate
    // limit/hiccup) used to silently `continue` past the ticket entirely
    // — it never got counted, never got cached, and was retried live on
    // EVERY future view of this same date. Whether that retry happened to
    // succeed or fail depended purely on network conditions at that exact
    // moment, so the headline counts (ticketsGenerated/won/lost/pending)
    // could differ between two loads of the same, fully-settled date —
    // nothing about the underlying data had changed, only whether this
    // one HTTP call happened to work that particular time.
    // Fix: retry once immediately (transient blips usually clear within a
    // second), and if it still fails, fall back to the last cached scan
    // for this code if one exists (even mid-pending) rather than
    // dropping the ticket — a scan failure must never silently shrink
    // the denominator. Only a code with NO prior cache AND two failed
    // live attempts is skipped (logged loudly either way).
    let scan = await internalGet(internalBaseUrl, `/api/scan/${encodeURIComponent(t.code)}`);
    if (!scan || !scan.results) {
      logger(`  scan failed for ${t.code}, retrying once…`);
      await new Promise(r => setTimeout(r, 500));
      scan = await internalGet(internalBaseUrl, `/api/scan/${encodeURIComponent(t.code)}`);
    }
    if (!scan || !scan.results) {
      if (prior && prior._rawScan) {
        logger(`  scan failed twice for ${t.code} — reusing last known data instead of dropping it from the report`);
        return { t, scan: prior._rawScan };
      }
      logger(`  scan failed twice for ${t.code} with no prior data — skipped this load, will retry next time`);
      return { t, scan: null };
    }
    return { t, scan };
  }

  // v21 — REAL BUG: newest generations are appended LAST to allTickets (runs
  // are iterated oldest-first), so when the deadline below cut a load off
  // partway through, it was always the just-created tickets — the ones with
  // no prior cache yet — that got cut off. Scanning newest-first means a
  // tight deadline sacrifices stale/already-cached older tickets instead of
  // the generation the user is actually looking at right now.
  // v42 — REAL FEEDBACK ("make it drop 1 by 1 instead of waiting for all"):
  // this used to resolve EVERY scan batch first, then run all the
  // aggregation (won/lost/killer table/league table/etc.) in a single pass
  // only once the WHOLE scan finished — so the Report/Rescan view showed
  // nothing at all until the entire scan (up to the full deadline) had
  // completed. The aggregation-through-save logic below is unchanged
  // (identical output for identical input) — just extracted into its own
  // function so it can be called PROGRESSIVELY: once after every batch,
  // writing an ever-more-complete scoreboard to disk each time, and once
  // more at the very end for the final result this function returns. The
  // client already reads this same cached file via the plain (non-rescan)
  // GET endpoint elsewhere in this app — while a rescan is running, that
  // read now reflects real, growing progress instead of stale data, with
  // zero new client-side machinery needed. Tickets not yet reached by the
  // batch loop are passed in as honest `notYetScanned` placeholders on every
  // partial call too — same "never silently shrink the count" rule the v21
  // deadline-cutoff path below already established, so a mid-rescan view
  // shows the true total ticket count immediately, just with results still
  // filling in.
  function assembleScoreboard(resolvedSoFar) {
    const ticketResults = [];
    const killerCounts = {}; // eventId -> {count, matchLabel, league, market, score}
    const leagueStats = {}; // league -> {legs, won, lost}
    const gameLedger = {};
    let totalLegsW = 0, totalLegsL = 0, totalLegsV = 0, totalLegsP = 0, totalLegsUnverified = 0;

    for (const { t, scan } of resolvedSoFar) {
      if (!scan) {
        ticketResults.push({ runId: t.runId, name: t.name, section: t.section, tier: t.tier, code: t.code, legCount: t.legCount, odds: t.odds, won: 0, lost: 0, void: 0, pending: t.legCount || 0, legHitRate: null, status: 'PENDING', _rawScan: null, notYetScanned: true });
        continue;
      }
      const won = scan.results.filter(r => r.verdict === 'WON').length;
      const lost = scan.results.filter(r => r.verdict === 'LOST').length;
      const voided = scan.results.filter(r => r.verdict === 'VOID').length;
      const pending = scan.results.filter(r => r.verdict === 'PENDING').length;
      const unverified = scan.results.filter(r => r.verdict === 'UNVERIFIED').length;
      const settled = won + lost;
      const legHitRate = settled ? Math.round((won / settled) * 100) : null;
      const status = lost > 0 ? 'LOST' : ((pending > 0 || unverified > 0) ? 'PENDING' : 'WON');
      totalLegsW += won; totalLegsL += lost; totalLegsV += voided; totalLegsP += pending; totalLegsUnverified += unverified;

      for (const r of scan.results) {
        if (r.league) {
          const ls = (leagueStats[r.league] = leagueStats[r.league] || { legs: 0, won: 0, lost: 0 });
          ls.legs++;
          if (r.verdict === 'WON') ls.won++; else if (r.verdict === 'LOST') ls.lost++;
        }
        if (r.verdict === 'LOST') {
          const k = r.eventId;
          if (!killerCounts[k]) killerCounts[k] = { eventId: k, matchLabel: `${r.homeTeam} v ${r.awayTeam}`, league: r.league, market: r.market, score: r.score, count: 0, tickets: [] };
          killerCounts[k].count++;
          killerCounts[k].tickets.push(t.name);
        }

        const gKey = `${r.eventId}|${r.marketId}|${r.outcomeId}`;
        const gl = (gameLedger[gKey] = gameLedger[gKey] || {
          eventId: r.eventId, matchLabel: `${r.homeTeam} v ${r.awayTeam}`, league: r.league,
          market: `${r.market || ''}${r.specifier ? ' ' + r.specifier : ''} → ${r.outcome || ''}`,
          score: null, appeared: 0, won: 0, lost: 0, void: 0, pending: 0,
        });
        gl.appeared++;
        if (r.verdict === 'WON') gl.won++;
        else if (r.verdict === 'LOST') gl.lost++;
        else if (r.verdict === 'VOID') gl.void++;
        else gl.pending++;
        if (r.score && !gl.score) gl.score = r.score; // real score once the match has one, same for every appearance
      }

      ticketResults.push({ runId: t.runId, name: t.name, section: t.section, tier: t.tier, code: t.code, legCount: t.legCount, odds: t.odds, won, lost, void: voided, pending, unverified, legHitRate, status, _rawScan: scan });
    }

    const settledTickets = ticketResults.filter(t => t.status !== 'PENDING');
    const wonTickets = settledTickets.filter(t => t.status === 'WON');
    const lostTickets = settledTickets.filter(t => t.status === 'LOST');
    const bestTicket = ticketResults.length
      ? ticketResults.reduce((best, t) => (t.legHitRate != null && (best == null || t.legHitRate > best.legHitRate)) ? t : best, null)
      : null;
    const worstTicket = settledTickets.length
      ? settledTickets.reduce((worst, t) => (t.legHitRate != null && (worst == null || t.legHitRate < worst.legHitRate)) ? t : worst, null)
      : null;
    const overallLegSettled = totalLegsW + totalLegsL;
    const killerTable = Object.values(killerCounts).filter(k => k.count >= 2).sort((a, b) => b.count - a.count).slice(0, 30);
    const leagueTable = Object.entries(leagueStats).map(([league, s]) => ({ league, legs: s.legs, won: s.won, lost: s.lost, hitRate: (s.won + s.lost) ? Math.round((s.won / (s.won + s.lost)) * 100) : null })).sort((a, b) => b.legs - a.legs);
    const gameLedgerTable = Object.values(gameLedger).map(gl => ({
      ...gl, result: gl.lost > 0 ? 'L' : gl.won > 0 ? 'W' : gl.void > 0 ? 'V' : 'P',
    })).sort((a, b) => b.appeared - a.appeared);
    const overallLegHitRate = overallLegSettled ? Math.round((totalLegsW / overallLegSettled) * 100) : null;
    const ticketsGenerated = ticketResults.length, ticketsWon = wonTickets.length;
    const ticketWinRate = ticketsGenerated ? ticketsWon / ticketsGenerated : null;
    const showBanner = ticketWinRate != null && ticketWinRate <= 0.10 && overallLegHitRate != null && overallLegHitRate >= 60;
    let worstBigBracket = null;
    if (showBanner) {
      const survival = computeLegBracketSurvival(DEFAULT_CONFIG);
      const bigBrackets = survival.brackets.filter(b => b.minLegs >= 21 && b.sampleSize >= survival.minSample);
      worstBigBracket = bigBrackets.length ? bigBrackets.reduce((worst, b) => (worst == null || b.observedWinRatePct < worst.observedWinRatePct) ? b : worst, null) : null;
    }
    const banner = showBanner ? {
      ticketsWon, ticketsGenerated, overallLegHitRate,
      bestTicketLegHitRate: bestTicket ? bestTicket.legHitRate : null,
      bestTicketName: bestTicket ? bestTicket.name : null,
      bestTicketStatus: bestTicket ? bestTicket.status : null,
      worstBigBracket: worstBigBracket ? {
        label: worstBigBracket.label, observedWinRatePct: worstBigBracket.observedWinRatePct, sampleSize: worstBigBracket.sampleSize,
      } : null,
    } : null;

    const runOrder = todaysRuns.map((r, i) => ({ runId: r.runId, genNumber: i + 1, startedAt: r.summary?.finishedAt || r.timestamp }));
    const generations = runOrder.map(ro => ({
      genNumber: ro.genNumber, runId: ro.runId, startedAt: ro.startedAt,
      tickets: ticketResults.filter(t => t.runId === ro.runId).map(({ _rawScan, ...t }) => t),
    })).reverse(); // newest first

    const scoreboard = {
      date: dateStr, builtAt: new Date().toISOString(),
      headline: {
        ticketsGenerated: ticketResults.length, ticketsWon: wonTickets.length, ticketsLost: lostTickets.length, ticketsPending: ticketResults.length - settledTickets.length,
        bestTicket: bestTicket ? { name: bestTicket.name, code: bestTicket.code, odds: bestTicket.odds, legHitRate: bestTicket.legHitRate } : null,
        worstTicket: worstTicket ? { name: worstTicket.name, code: worstTicket.code, odds: worstTicket.odds, legHitRate: worstTicket.legHitRate } : null,
        totalLegsWon: totalLegsW, totalLegsLost: totalLegsL, totalLegsVoid: totalLegsV, totalLegsPending: totalLegsP, totalLegsUnverified: totalLegsUnverified,
        overallLegHitRate,
        generationCount: generations.length,
      },
      banner,
      tickets: ticketResults, killerTable, leagueTable, gameLedgerTable, generations,
    };
    saveJSON(scoreboardFile(dateStr), scoreboard);
    return { ...scoreboard, tickets: scoreboard.tickets.map(({ _rawScan, ...t }) => t) };
  }

  const scanOrder = [...allTickets].reverse();
  const resolvedScans = [];
  for (let i = 0; i < scanOrder.length; i += SCAN_BATCH_SIZE) {
    if (Date.now() - scanStartedAt > SCAN_DEADLINE_MS) {
      // v21 — REAL BUG: a ticket with no prior cache at all used to be
      // skipped here (`scan: null` → the aggregation loop below then
      // `continue`d past it entirely) — silently dropping it from
      // ticketsGenerated/generations for the whole load. On a day with many
      // generations, that meant "why is my result so few / i want all
      // generations": whole runs could vanish from the Report just because
      // their tickets hadn't been scanned yet when the clock ran out.
      // Every ticket must always be counted — one with no scan yet is
      // included as an honest not-yet-scanned placeholder instead.
      const remaining = scanOrder.slice(i);
      logger(`  scan deadline (${SCAN_DEADLINE_MS / 1000}s) reached — ${remaining.length} ticket(s) left, using cached/placeholder data for them instead of waiting further`);
      for (const t of remaining) {
        const prior = cachedByCode[t.code];
        resolvedScans.push({ t, scan: prior && prior._rawScan ? prior._rawScan : null });
      }
      break;
    }
    const batch = scanOrder.slice(i, i + SCAN_BATCH_SIZE);
    resolvedScans.push(...await Promise.all(batch.map(resolveTicketScan)));
    // v42 — progressive save: everything resolved so far, PLUS an honest
    // "notYetScanned" placeholder for every ticket the batch loop hasn't
    // reached yet — so a mid-rescan read shows the true total ticket count
    // immediately, with results genuinely filling in batch by batch, not a
    // slowly-growing-but-wrong-looking count.
    const notYetReached = scanOrder.slice(i + SCAN_BATCH_SIZE).map(t => ({ t, scan: null }));
    assembleScoreboard([...resolvedScans, ...notYetReached]);
  }

  return assembleScoreboard(resolvedScans);
}

async function runDailyReview(dateStr, internalBaseUrl, logger = () => {}) {
  const history = safeJSON(RESULTS_FILE, []);
  const todaysRuns = history.filter(r => r.summary?.date === dateStr);
  if (!todaysRuns.length) return { success: false, error: `No runs found for ${dateStr}` };

  const changes = [];
  const leagueFails = {}, marketFails = {}, punterFails = {}, leagueWins = {};
  const dropLearning = loadDropLearning();
  const conversionLearning = loadConversionLearning();

  // v7 §6 — reuse the scoreboard's scan cache (rebuilds it if missing) so
  // this and the Performance tab never scan the same code twice.
  const board = await buildScoreboard(dateStr, internalBaseUrl, logger);
  if (!board.tickets) return { success: false, error: board.error || 'Could not build scoreboard for this date' };
  const cachedBoard = safeJSON(scoreboardFile(dateStr), null);
  const scanByCode = {};
  for (const t of (cachedBoard?.tickets || [])) if (t._rawScan) scanByCode[t.code] = t._rawScan;

  for (const run of todaysRuns) {
    const dArr = Array.isArray(run.sectionD) ? run.sectionD : [run.sectionD];
    const eArr = Array.isArray(run.sectionE) ? run.sectionE : [run.sectionE];
    const allTickets = [...(run.sectionA || []), ...(run.sectionA_belowTarget || []), ...(run.sectionB || []), ...dArr, ...eArr].filter(Boolean);
    for (const t of allTickets) {
      if (!t.code || t.notBuilt) continue;
      const scan = scanByCode[t.code];
      if (!scan || !scan.results) { logger(`  no cached scan for ${t.code}`); continue; }
      const review = { code: t.code, section: t.section, won: scan.won, lost: scan.lost, hitRate: scan.hitRate, deadLegs: [] };
      for (const r of scan.results) {
        if (r.verdict !== 'LOST') continue;
        const pick = (t.picks || []).find(p => p.eventId === r.eventId);
        review.deadLegs.push({ league: r.league, market: r.market, converted: pick?.converted || false, source: pick?.source, punter: pick?.source });
        leagueFails[r.league] = (leagueFails[r.league] || 0) + 1;
        marketFails[r.market] = (marketFails[r.market] || 0) + 1;
        if (pick?.source) punterFails[pick.source] = (punterFails[pick.source] || 0) + 1;
        if (pick?.converted && pick?.conversionReason?.patternKey) {
          const cl = conversionLearning[pick.conversionReason.patternKey] || { settled: 0, wins: 0 };
          cl.settled++; conversionLearning[pick.conversionReason.patternKey] = cl;
        }
      }
      for (const r of scan.results) {
        if (r.verdict !== 'WON') continue;
        leagueWins[r.league] = (leagueWins[r.league] || 0) + 1; // v10 §2 — needed to compute a real fail RATE, not just a loss count
        const pick = (t.picks || []).find(p => p.eventId === r.eventId);
        if (pick?.converted && pick?.conversionReason?.patternKey) {
          const cl = conversionLearning[pick.conversionReason.patternKey] || { settled: 0, wins: 0 };
          cl.settled++; cl.wins++; conversionLearning[pick.conversionReason.patternKey] = cl;
        }
      }
    }
  }

  for (const [k, cl] of Object.entries(conversionLearning)) cl.winRate = cl.settled ? Math.round((cl.wins / cl.settled) * 100) : 0;
  saveConversionLearning(conversionLearning);
  await updateDropLearningForDate(dateStr, todaysRuns, internalBaseUrl, dropLearning, logger);
  saveDropLearning(dropLearning);

  const downweights = loadDownweights();
  const topLeagueFail = Object.entries(leagueFails).sort((a, b) => b[1] - a[1])[0];
  const topMarketFail = Object.entries(marketFails).sort((a, b) => b[1] - a[1])[0];
  const topPunterFail = Object.entries(punterFails).sort((a, b) => b[1] - a[1])[0];
  if (topLeagueFail && topLeagueFail[1] >= 3) { downweights.leagues[topLeagueFail[0]] = Math.min(60, (downweights.leagues[topLeagueFail[0]] || 0) + 15); changes.push(`${topLeagueFail[0]} down-weighted: killed ${topLeagueFail[1]} legs yesterday`); }
  if (topMarketFail && topMarketFail[1] >= 3) { downweights.markets[topMarketFail[0]] = Math.min(60, (downweights.markets[topMarketFail[0]] || 0) + 15); changes.push(`${topMarketFail[0]} down-weighted: killed ${topMarketFail[1]} legs yesterday`); }
  if (topPunterFail && topPunterFail[1] >= 4) { downweights.punters[topPunterFail[0]] = Math.min(40, (downweights.punters[topPunterFail[0]] || 0) + 10); changes.push(`${topPunterFail[0]} down-weighted: ${topPunterFail[1]} losing legs yesterday`); }
  saveDownweights(downweights);

  // v10 §2 — Repeat-offender leagues → blacklist CANDIDATE list (admin
  // confirms). Uses fail RATE + minimum sample (not raw loss count — a
  // high-volume 83%-hit-rate league was getting flagged purely for playing
  // a lot of games) AND requires day-to-day variance to also be high: a
  // league with a merely mediocre but STABLE rate (~55% every day) isn't
  // suspicious, it's just moderate. Every CURRENT candidate is re-checked
  // against this same rule each run and dropped the moment it no longer
  // qualifies — a candidate list is only as trustworthy as its expiry.
  const leagueDailyStats = buildLeagueDailyStats(logger);
  function evaluateLeagueCandidacy(league) {
    const won = leagueWins[league] || 0, lost = leagueFails[league] || 0;
    const sample = won + lost;
    if (sample < cfg_.blacklistCandidateMinSample) return null;
    const failRate = lost / sample;
    if (failRate < cfg_.blacklistCandidateFailRate) return null;
    const variance = leagueVariance(leagueDailyStats[league]);
    if (!variance || variance.stdDev < cfg_.leagueVarianceStdDevThreshold) return null; // low rate but STABLE — not suspect, just moderate
    return { league, hitRate: Math.round((won / sample) * 100), wins: won, losses: lost, sample, variance: Math.round(variance.stdDev * 100), days: variance.days };
  }
  const cfg_ = DEFAULT_CONFIG; // runDailyReview has no per-run cfg override today; uses live defaults
  const candidates = safeJSON(BLACKLIST_CANDIDATES_FILE, { entries: [] });
  if (!Array.isArray(candidates.entries)) candidates.entries = []; // migrate legacy {leagues:[...]} shape
  delete candidates.leagues; // drop the old raw-count list entirely — it's superseded, not merged
  const stillQualifying = new Map();
  // Re-check every league that failed at all today (covers both existing candidates and new ones)
  const allLeaguesToCheck = new Set([...Object.keys(leagueFails), ...candidates.entries.map(c => c.league)]);
  for (const league of allLeaguesToCheck) {
    const verdict = evaluateLeagueCandidacy(league);
    if (verdict) stillQualifying.set(league, verdict);
  }
  const previousLeagues = new Set(candidates.entries.map(c => c.league));
  for (const [league, verdict] of stillQualifying) {
    if (!previousLeagues.has(league)) changes.push(`${league} — ${verdict.hitRate}% hit rate (${verdict.wins}W/${verdict.losses}L), ${verdict.sample} samples, day-variance ${verdict.variance}% over ${verdict.days} days — added to blacklist CANDIDATE list (needs admin confirmation)`);
  }
  for (const league of previousLeagues) {
    if (!stillQualifying.has(league)) changes.push(`${league} — no longer meets the candidate bar (rate recovered or variance settled) — removed from CANDIDATE list`);
  }
  candidates.entries = [...stillQualifying.values()];
  saveJSON(BLACKLIST_CANDIDATES_FILE, candidates);

  // v14 §4 — ticket-SIZE learning surfaced in the same "lessons applied"
  // report as pick-QUALITY learning above — one unified self-correction
  // report, not two separate systems the user has to check separately.
  const legBracketSurvival = computeLegBracketSurvival(DEFAULT_CONFIG);
  for (const b of legBracketSurvival.brackets) {
    if (!b.flagged) continue;
    changes.push(`Leg-count bracket ${b.label} capped — ${b.ticketsWon}/${b.sampleSize} won over last ${legBracketSurvival.windowDays} days despite ${b.legHitRatePct}% leg accuracy`);
  }

  if (!changes.length) changes.push('No repeat-failure patterns strong enough to act on yet.');

  // v3.1 §3 — adaptive floor: raise +2 toward the max when coverage clears
  // the threshold; hold (never lower automatically) otherwise.
  const floorState = loadFloorState();
  const coverages = todaysRuns.map(r => r.summary?.dataCoverage).filter(c => typeof c === 'number');
  const avgCoverage = coverages.length ? coverages.reduce((s, c) => s + c, 0) / coverages.length : null;
  let floorNote;
  if (avgCoverage != null) {
    if (avgCoverage >= DEFAULT_CONFIG.adaptiveFloorCoverageThreshold && floorState.floor < DEFAULT_CONFIG.adaptiveFloorMax) {
      const newFloor = Math.min(DEFAULT_CONFIG.adaptiveFloorMax, floorState.floor + DEFAULT_CONFIG.adaptiveFloorStep);
      floorNote = `Coverage ${Math.round(avgCoverage * 100)}% (≥${Math.round(DEFAULT_CONFIG.adaptiveFloorCoverageThreshold * 100)}% threshold) — floor raised ${floorState.floor}→${newFloor}`;
      saveFloorState({ floor: newFloor, lastCoverage: avgCoverage, updatedAt: new Date().toISOString() });
    } else {
      floorNote = `Coverage ${Math.round(avgCoverage * 100)}% — floor held at ${floorState.floor}`;
      saveFloorState({ floor: floorState.floor, lastCoverage: avgCoverage, updatedAt: new Date().toISOString() });
    }
    changes.push(floorNote);
  }

  const lessons = { date: dateStr, generatedAt: new Date().toISOString(), changes, leagueFails, marketFails, punterFails, dataCoverage: avgCoverage, floorAfterReview: loadFloorState().floor, legBracketSurvival };
  saveJSON(path.join(AG_DIR, `daily-review-${dateStr}.json`), lessons);
  saveJSON(LAST_LESSONS_FILE, lessons);
  return { success: true, ...lessons };
}

module.exports = {
  startRun, getRun, getLatestRunId, subscribe, requestStop,
  runDailyReview, buildScoreboard,
  loadBlacklist, saveBlacklist,
  loadFloorState,
  loadSettings, saveSettings,
  backfillIntelligenceFromHistory,
  getLastLessons() { return safeJSON(LAST_LESSONS_FILE, null); }, // v8 §4 — so the morning banner can show this on page load, not just after a live run
  // v18 — Report page reads persisted lessons for an ARBITRARY selected
  // date. Read-only, no side effects — deliberately NOT calling
  // runDailyReview here, since that additively mutates downweights each
  // time it runs; viewing a report must never itself trigger (or repeat)
  // learning. The background auto-run schedule is what actually produces
  // these files — this just displays whatever it already computed, if any.
  getLessonsForDate(dateStr) { return safeJSON(path.join(AG_DIR, `daily-review-${dateStr}.json`), null); },
  getBlacklistCandidates() { const c = safeJSON(BLACKLIST_CANDIDATES_FILE, { entries: [] }); return Array.isArray(c.entries) ? c.entries : []; }, // v10 §2
  // v11 §1 — exported for test-moonshot-floor.js (the permanent regression
  // test). Both are pure/deterministic — no network calls — safe to unit test directly.
  buildCategoryVariants, makeExposureTracker, computeOdds,
  // v19 §1 — also exported for test-moonshot-floor.js: Mix/Max Builder/
  // Consensus don't go through buildCategoryVariants at all, so their ONLY
  // safety net is this function's own default `minOdds` parameter (the
  // universal floor). The rejection path returns before any network call,
  // so calling it directly with deliberately-fake below-floor picks is safe
  // to unit test — it can never reach sbPost.
  generateTicketCode,
  DEFAULT_CONFIG,
  deleteResults() { try { fs.writeFileSync(RESULTS_FILE, '[]'); } catch {} },
  // v14 — Portfolio Survival: exported so the Settings panel and any admin
  // route can get the rolling leg-bracket report without recomputing its
  // file-scanning logic elsewhere. Pure given a cfg object — no network calls.
  // checkLegBracketCap also exported for test-leg-bracket-cap.js.
  computeLegBracketSurvival, checkLegBracketCap,
  // v21 — exported for one-time/manual backfill of real drop-learning
  // history (see the forensic audit that found this had never actually run).
  loadDropLearning, saveDropLearning, updateDropLearningForDate,
  // v36 — exported for test-conversion-safety.js (permanent regression test
  // for the REMOVE-risk composite-score bypass). canLeaveAsIs is pure/
  // deterministic. convertLeg does make a network call via
  // fetchEventMarketBoard UNLESS the eventId is already in eventBoardCache —
  // exporting the cache Map lets a test prime it directly and exercise
  // convertLeg's real decision logic with zero network calls.
  canLeaveAsIs, convertLeg, eventBoardCache,
  // v38 — exported for test-global-pool-architecture.js (the output-
  // architecture redesign's permanent regression suite). All pure/
  // deterministic except the buildGlobal*/emitGlobalTicket family, which
  // accept an injectable codeGenFn (default: the real generateTicketCode)
  // specifically so tests can exercise the full positive path — including
  // odds computed from final selections and source/code attribution —
  // without a real network call.
  groupPerSourceLegsByPunter, buildSectionA, buildSectionAVariant, buildGlobalPool, jaccardOverlap, pickIdentity,
  buildAggregationReport, emitGlobalTicket, findDuplicateGlobalTicket,
  buildGlobalBest, buildGlobalSafe, buildGlobalMix, buildGlobalBuilder, buildGlobalHighRisk, buildGlobalSections,
  selectPicksForTicket,
};
