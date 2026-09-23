#!/usr/bin/env node
// tt-engine.js — Table Tennis (Setka Cup) persistent tracking + ranking engine
//
// Commands:
//   node tt-engine.js ingest <code> [<code2> ...]   pull resolved legs from real codes into permanent history
//   node tt-engine.js rebuild                        recompute player stats + per-market leaderboards from history
//   node tt-engine.js analyze <code> [sizes...]      rank an unplayed code's matches, build graduated combos
//   node tt-engine.js report                         print latest leaderboards + compare today's report to previous day

const fs = require("fs");
const path = require("path");
const http = require("http");

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "tt-history.json");
const PLAYERS_FILE = path.join(DATA_DIR, "tt-players.json");
const LEADERBOARDS_FILE = path.join(DATA_DIR, "tt-leaderboards.json");
const REPORTS_DIR = path.join(DATA_DIR, "tt-reports");
const PREDICTIONS_LOG_FILE = path.join(DATA_DIR, "tt-predictions-log.json");
const CALIBRATION_FILE = path.join(DATA_DIR, "tt-calibration.json");
const CALIBRATION_MIN_SAMPLES = 20;
const CALIBRATION_MAX_CORRECTION = 0.15; // bounded ±15% - "never overreact to one day"
const TARGETED_MIN_MATCHES = 5;
const TARGETED_G1_LINE = 17.5;
const TARGETED_FM_MIN_LINE = 74.5;
const TARGETED_FM_MAX_LINE = 78.5;
const TARGETED_COMBO_SIZES = [15, 16, 17, 18, 19];

// FM (full-match) totals (marketId 238) was SportyBet's most-tracked market historically, but
// as of 2026-07-29 it is no longer offered on Setka Cup (0 of 12 sampled live matches had it) -
// left in TRACKED_MARKETS so past history/leaderboard stays intact, but scoreMatchAllMarkets
// simply won't produce candidates for it since it only evaluates markets actually present in
// each match's live listing. In its place, SportyBet added marketId 900111 ("Extra points -
// 1st game", Yes/No) - a real market, not a guess: "Yes" only occurs when game 1 reaches deuce
// and is decided beyond 11 points (minimum resulting total 22, always even), so it's a direct
// function of the SAME g1 total distribution we already fit for G1_Under19.5/G1_Over17.5 - no
// new regression needed, just the existing model evaluated at a more extreme line (21.5).
const TRACKED_MARKETS = {
  "G1_Under19.5": { marketId: "247", specifier: "gamenr=1|total=19.5" },
  "G1_Over17.5": { marketId: "247", specifier: "gamenr=1|total=17.5" },
  "FM_Under77.5": { marketId: "238", specifier: "total=77.5" },
  "FM_Under78.5": { marketId: "238", specifier: "total=78.5" },
  "FM_Under79.5": { marketId: "238", specifier: "total=79.5" },
  "FM_Under80.5": { marketId: "238", specifier: "total=80.5" },
  "G1_ExtraPoints_No": { marketId: "900111", specifier: "gamenr=1", outcomePrefix: "No" },
  "G1_ExtraPoints_Yes": { marketId: "900111", specifier: "gamenr=1", outcomePrefix: "Yes" },
};
const EXTRA_POINTS_LINE = 21.5; // deuce-decided G1 games always resolve on an even total >=22

// Handicap (marketId 237) doesn't have fixed specifiers like the markets above - the
// cushion size varies match to match. We bucket real settled results by cushion size and
// by league so a blended overall rate never hides a specific league/bucket underperforming
// (see the Setka Cup finding: blended ~54-60% hid a real ~55-57% floor there while other
// leagues ran near 100% on a small sample).
const HANDICAP_MARKET_ID = "237";
const HANDICAP_BUCKETS = [
  { label: "0.5-2.5", min: 0.5, max: 2.5 },
  { label: "3.5-5.5", min: 3.5, max: 5.5 },
  { label: "6.5-9.5", min: 6.5, max: 9.5 },
  { label: "10.5+", min: 10.5, max: Infinity },
];
const HANDICAP_UNDERPERFORM_MIN_SAMPLES = 15;
const HANDICAP_UNDERPERFORM_GAP_PTS = 8; // percentage points below the blended overall rate

// Known-player preference threshold: prefer matches where BOTH sides have this many
// real settled matches on record over thin-data debutants (doesn't hard-exclude thin data,
// just deprioritizes it - see scoreMatchAllMarkets).
const KNOWN_PLAYER_MIN_N = 3;

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); }
function gt(hs) { const [a, b] = hs.split(":").map(Number); return a + b; }
// Real dedupe/lookup key for a history row or live selection. MUST include outcome: most
// markets have one outcome per specifier (e.g. G1 Under 19.5 vs Over 17.5 differ by specifier
// already), but marketId 900111 (Extra Points) has TWO outcomes ("Yes"/"No") sharing the exact
// same specifier ("gamenr=1") - without outcome in the key, ingesting a "Yes" bet and a "No" bet
// on the same match would collide and silently drop one of them.
function recordKey(r) { return r.eventId + "|" + r.marketId + "|" + r.specifier + "|" + (r.outcome || ""); }

function httpGet(urlPath) {
  return new Promise((ok, fail) => {
    http.get("http://localhost:3000" + urlPath, res => {
      let d = ""; res.on("data", c => (d += c));
      res.on("end", () => { try { ok(JSON.parse(d)); } catch (e) { fail(e); } });
    }).on("error", fail);
  });
}
function httpPost(urlPath, body) {
  return new Promise((ok, fail) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: "localhost", port: 3000, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, res => {
      let d = ""; res.on("data", c => (d += c)); res.on("end", () => { try { ok(JSON.parse(d)); } catch (e) { fail(e); } });
    });
    req.write(payload); req.end();
  });
}

function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(x, mu, sigma) { return 0.5 * (1 + erf((x - mu) / (sigma * Math.sqrt(2)))); }

// Blend a normal-distribution model estimate with the empirical (real settled) rate at
// the same line, shrunk toward the population-wide empirical rate when a player's own
// sample is thin. This is the same shrinkage pattern worked out across tonight's sessions.
function empRate(arr, line, under) {
  if (!arr.length) return 0.5;
  return (under ? arr.filter(x => x < line).length : arr.filter(x => x > line).length) / arr.length;
}
function shrunkRate(playerList, populationList, line, under) {
  if (!playerList || !playerList.length) return empRate(populationList, line, under);
  const n = playerList.length, k = 3;
  const playerRate = empRate(playerList, line, under);
  const popRate = empRate(populationList, line, under);
  return (n * playerRate + k * popRate) / (n + k);
}

// Parse a handicap cushion value off a stored/live outcome label, e.g. "Home (+6.5)" -> 6.5.
// Only positive-cushion values are meaningful for our "underdog receives points" bet type -
// negative (favorite lays points) is a structurally different, riskier bet we don't score here.
function parseHandicapCushion(outcomeLabel) {
  const m = String(outcomeLabel || "").match(/\(([+-]?\d+\.?\d*)\)/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return val > 0 ? val : null;
}
function handicapBucketFor(cushion) {
  return HANDICAP_BUCKETS.find(b => cushion >= b.min && cushion <= b.max) || null;
}

// ---------------- HANDICAP RATES (cushion + league bucketed, underperformance-flagged) ----------------
// Underperformance is judged leave-one-out (each league/bucket vs. every OTHER settled bet),
// not against the self-inclusive blended rate. When one league dominates the sample (e.g.
// Setka Cup is ~97% of it), comparing it to "blended" compares it to itself and the gap can
// never trigger - this was caught and fixed before shipping.
function winRateOf(rows) {
  if (!rows.length) return null;
  return +((rows.filter(h => h.isWinning === 1).length / rows.length) * 100).toFixed(1);
}
function computeHandicapRates() {
  const history = loadJSON(HISTORY_FILE, []);
  const settled = history.filter(h => h.marketId === HANDICAP_MARKET_ID && (h.isWinning === 0 || h.isWinning === 1));
  const positive = settled.map(h => ({ ...h, cushion: parseHandicapCushion(h.outcome) })).filter(h => h.cushion !== null);

  const overall = { plays: positive.length, wins: positive.filter(h => h.isWinning === 1).length, winRate: winRateOf(positive) };

  const byBucket = {};
  const underperformingBuckets = [];
  for (const b of HANDICAP_BUCKETS) {
    const rows = positive.filter(h => h.cushion >= b.min && h.cushion <= b.max);
    const others = positive.filter(h => !(h.cushion >= b.min && h.cushion <= b.max));
    const winRate = winRateOf(rows);
    const othersRate = winRateOf(others);
    byBucket[b.label] = { plays: rows.length, wins: rows.filter(h => h.isWinning === 1).length, winRate };
    if (rows.length >= HANDICAP_UNDERPERFORM_MIN_SAMPLES && others.length >= HANDICAP_UNDERPERFORM_MIN_SAMPLES && winRate !== null && othersRate !== null && (othersRate - winRate) >= HANDICAP_UNDERPERFORM_GAP_PTS) {
      underperformingBuckets.push({ bucket: b.label, plays: rows.length, winRate, othersWinRate: othersRate, gapPts: +(othersRate - winRate).toFixed(1) });
    }
  }

  const byLeagueRows = {};
  for (const h of positive) (byLeagueRows[h.league || "Unknown"] ||= []).push(h);
  const byLeague = {};
  const underperformingLeagues = [];
  for (const [league, rows] of Object.entries(byLeagueRows)) {
    const others = positive.filter(h => (h.league || "Unknown") !== league);
    const winRate = winRateOf(rows);
    const othersRate = winRateOf(others);
    byLeague[league] = { plays: rows.length, wins: rows.filter(h => h.isWinning === 1).length, winRate };
    if (rows.length >= HANDICAP_UNDERPERFORM_MIN_SAMPLES && others.length >= HANDICAP_UNDERPERFORM_MIN_SAMPLES && winRate !== null && othersRate !== null && (othersRate - winRate) >= HANDICAP_UNDERPERFORM_GAP_PTS) {
      underperformingLeagues.push({ league, plays: rows.length, winRate, othersWinRate: othersRate, gapPts: +(othersRate - winRate).toFixed(1) });
    }
  }

  const result = { overall, byBucket, byLeague, underperformingLeagues, underperformingBuckets, updatedAt: new Date().toISOString() };
  saveJSON(path.join(DATA_DIR, "tt-handicap-rates.json"), result);
  return result;
}

function buildPlayerSnapshot(home, away, h, a) {
  return {
    home: {
      name: home,
      n: h.n,
      g1mean: h.g1mean,
      fmmean: h.fmmean,
      g1std: h.g1std,
      fmstd: h.fmstd,
      deciderPct: h.deciderPct,
    },
    away: {
      name: away,
      n: a.n,
      g1mean: a.g1mean,
      fmmean: a.fmmean,
      g1std: a.g1std,
      fmstd: a.fmstd,
      deciderPct: a.deciderPct,
    },
  };
}

function scoreCandidate(candidate) {
  const prob = candidate.prob ?? candidate.confidence ?? 0;
  const ev = typeof candidate.ev === "number" ? candidate.ev : prob * (candidate.odds || 1) - 1;
  return { prob, ev };
}

// ---------------- INGEST ----------------
async function ingest(codes) {
  const history = loadJSON(HISTORY_FILE, []);
  const seen = new Set(history.map(recordKey));
  let totalAdded = 0;
  for (const code of codes) {
    const j = await httpGet("/api/booking/" + code);
    if (j.error) { console.log("  ERROR fetching", code, ":", j.error); continue; }
    let added = 0;
    for (const s of j.selections || []) {
      if (s.matchStatus !== "Ended") continue;
      const key = recordKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      history.push({
        eventId: s.eventId, home: s.homeTeam, away: s.awayTeam, league: s.league, category: s.category,
        kickoff: s.kickoff, marketId: s.marketId, specifier: s.specifier, market: s.market, outcome: s.outcome,
        odds: s.odds, isWinning: s.isWinning, score: s.score, halfScores: s.halfScores,
        sourceCode: code, ingestedAt: new Date().toISOString(),
      });
      added++;
    }
    console.log("  ingested", code, "-> +" + added, "resolved legs");
    totalAdded += added;
  }
  saveJSON(HISTORY_FILE, history);
  console.log("Total history records:", history.length, "(+" + totalAdded + " this run)");
  return totalAdded;
}

// ---------------- REBUILD (players + leaderboards) ----------------
function rebuild() {
  const history = loadJSON(HISTORY_FILE, []);
  const byEvent = new Map();
  for (const h of history) {
    if (h.score && h.halfScores && h.halfScores.length >= 3 && !byEvent.has(h.eventId)) byEvent.set(h.eventId, h);
  }
  const matches = [...byEvent.values()];

  const byPlayer = {};
  for (const m of matches) {
    const g1 = gt(m.halfScores[0]);
    const fm = m.halfScores.reduce((s, hs) => s + gt(hs), 0);
    const sets = m.halfScores.length;
    for (const hs of m.halfScores) {
      const [a, b] = hs.split(":").map(Number);
      (byPlayer[m.home] ||= { g1: [], fm: [], sets: [], results: [], matches: [], ptDiff: [] }).ptDiff.push(a - b);
      (byPlayer[m.away] ||= { g1: [], fm: [], sets: [], results: [], matches: [], ptDiff: [] }).ptDiff.push(b - a);
    }
    for (const p of [m.home, m.away]) {
      (byPlayer[p] ||= { g1: [], fm: [], sets: [], results: [], matches: [], ptDiff: [] });
      byPlayer[p].g1.push(g1); byPlayer[p].fm.push(fm); byPlayer[p].sets.push(sets);
      const isHome = m.home === p;
      const [h, a] = m.score.split(":").map(Number);
      byPlayer[p].results.push(isHome ? `${h}:${a}` : `${a}:${h}`);
      byPlayer[p].matches.push({ eventId: m.eventId, opponent: isHome ? m.away : m.home, kickoff: m.kickoff });
    }
  }
  const players = {};
  for (const [p, d] of Object.entries(byPlayer)) {
    players[p] = {
      n: d.g1.length,
      g1mean: +mean(d.g1).toFixed(2), g1std: d.g1.length >= 2 ? +std(d.g1).toFixed(2) : null,
      fmmean: +mean(d.fm).toFixed(2), fmstd: d.fm.length >= 2 ? +std(d.fm).toFixed(2) : null,
      straightPct: Math.round(d.sets.filter(s => s === 3).length / d.sets.length * 100),
      fourGamePct: Math.round(d.sets.filter(s => s === 4).length / d.sets.length * 100),
      deciderPct: Math.round(d.sets.filter(s => s === 5).length / d.sets.length * 100),
      results: d.results,
      g1list: d.g1, fmlist: d.fm,
      strength: d.ptDiff && d.ptDiff.length >= 6 ? +mean(d.ptDiff).toFixed(2) : null,
    };
  }
  saveJSON(PLAYERS_FILE, players);

  // exact head-to-head pairings (both players faced each other directly)
  const pairHistory = {};
  for (const m of matches) {
    const key = [m.home, m.away].sort().join(" ||| ");
    (pairHistory[key] ||= []).push({ eventId: m.eventId, score: m.score, g1: gt(m.halfScores[0]), fm: m.halfScores.reduce((s,hs)=>s+gt(hs),0), kickoff: m.kickoff });
  }
  saveJSON(path.join(DATA_DIR, "tt-pairhistory.json"), pairHistory);

  const leaderboards = {};
  for (const [name, def] of Object.entries(TRACKED_MARKETS)) {
    const plays = history.filter(h => h.marketId === def.marketId && h.specifier === def.specifier && (!def.outcomePrefix || (h.outcome || "").startsWith(def.outcomePrefix)) && (h.isWinning === 0 || h.isWinning === 1));
    const wins = plays.filter(p => p.isWinning === 1).length;
    const losses = plays.filter(p => p.isWinning === 0).length;
    const settled = wins + losses;
    const roiUnits = plays.reduce((sum, p) => sum + (p.isWinning === 1 ? p.odds - 1 : -1), 0);
    const avgOdds = plays.length ? mean(plays.map(p => p.odds)) : null;
    const sorted = [...plays].sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));
    leaderboards[name] = {
      plays: plays.length, wins, losses,
      winRate: settled ? +((wins / settled) * 100).toFixed(1) : null,
      roiPct: plays.length ? +((roiUnits / plays.length) * 100).toFixed(1) : null,
      avgOdds: avgOdds ? +avgOdds.toFixed(2) : null,
      last20: sorted.slice(0, 20).map(p => ({ match: p.home + " vs " + p.away, date: p.kickoff, result: p.isWinning === 1 ? "WON" : "LOST", odds: p.odds })),
    };
  }
  const withEnough = Object.entries(leaderboards).filter(([, l]) => l.plays >= 3);
  let bestMarket = null, worstMarket = null;
  if (withEnough.length) {
    bestMarket = withEnough.reduce((a, b) => (b[1].roiPct > a[1].roiPct ? b : a))[0];
    worstMarket = withEnough.reduce((a, b) => (b[1].roiPct < a[1].roiPct ? b : a))[0];
  }
  leaderboards._meta = { bestMarket, worstMarket, updatedAt: new Date().toISOString(), totalHistoryRecords: history.length, uniqueCompletedMatches: matches.length };
  saveJSON(LEADERBOARDS_FILE, leaderboards);

  console.log("Rebuilt. Players tracked:", Object.keys(players).length, "| Unique completed matches:", matches.length);
  for (const [name, l] of Object.entries(leaderboards)) {
    if (name === "_meta") continue;
    console.log(`  ${name}: ${l.plays} plays | ${l.wins}W-${l.losses}L | winRate ${l.winRate}% | ROI ${l.roiPct}% | avgOdds ${l.avgOdds}`);
  }
  console.log("  best market:", leaderboards._meta.bestMarket, "| worst market:", leaderboards._meta.worstMarket);

  const handicapRates = computeHandicapRates();
  console.log(`  Handicap (237): ${handicapRates.overall.plays} plays | winRate ${handicapRates.overall.winRate}%`);
  for (const u of handicapRates.underperformingLeagues) {
    console.log(`    FLAG: ${u.league} handicap underperforming - ${u.winRate}% real vs ${u.othersWinRate}% everywhere else (${u.plays} samples, -${u.gapPts}pts)`);
  }
  for (const u of handicapRates.underperformingBuckets) {
    console.log(`    FLAG: cushion ${u.bucket} handicap underperforming - ${u.winRate}% real vs ${u.othersWinRate}% at other cushion sizes (${u.plays} samples, -${u.gapPts}pts)`);
  }

  const calibration = computeCalibration();
  const calibrated = Object.entries(calibration.byMarket).filter(([, c]) => c.plays >= CALIBRATION_MIN_SAMPLES && c.correction !== 1);
  console.log(`  Calibration: ${calibration.totalPredictionsLogged} predictions logged total.`);
  for (const [market, c] of calibrated) {
    console.log(`    SELF-CORRECTING ${market}: predicted ${c.avgPredictedPct}% vs actual ${c.avgActualPct}% (${c.plays} samples) -> confidence now ${c.correction}x`);
  }

  return { players, leaderboards, handicapRates, calibration };
}

// ---------------- ANALYZE (rank + graduated combos) ----------------
async function analyze(code, sizes) {
  const players = loadJSON(PLAYERS_FILE, {});
  const hist = loadJSON(HISTORY_FILE, []);
  const byEvent = new Map();
  for (const h of hist) if (h.score && h.halfScores && h.halfScores.length >= 3 && !byEvent.has(h.eventId)) byEvent.set(h.eventId, h);
  const completedMatches = [...byEvent.values()];
  const g1All = completedMatches.map(m => gt(m.halfScores[0]));
  const fmAllVals = completedMatches.map(m => m.halfScores.reduce((s, hs) => s + gt(hs), 0));
  const G1_MEAN = mean(g1All), G1_STD = std(g1All);
  const FM_MEAN = mean(fmAllVals), FM_STD = std(fmAllVals);

  const j = await httpGet("/api/booking/" + code);
  if (j.error) { console.log("ERROR:", j.error); return; }
  const notStart = j.selections.filter(s => s.matchStatus === "Not start");
  console.log("Analyzing", code, "-", notStart.length, "unplayed matches out of", j.selections.length);

  const analyzed = [];
  for (const s of notStart) {
    const m = await httpGet("/api/markets/" + encodeURIComponent(s.eventId));
    const markets = m.markets || [];
    const g1 = markets.find(mk => mk.marketId === "247" && mk.specifier === "gamenr=1|total=19.5" && mk.outcomeName.startsWith("Under"));
    const fmAll = markets.filter(mk => mk.marketId === "238" && mk.outcomeName.startsWith("Under"))
      .map(mk => ({ line: parseFloat(mk.specifier.split("=")[1]), odds: mk.odds, specifier: mk.specifier, outcomeId: mk.outcomeId }));

    const h = players[s.homeTeam], a = players[s.awayTeam];
    const hOk = h && h.n >= 2, aOk = a && a.n >= 2;
    const dataPoints = (hOk ? 1 : 0) + (aOk ? 1 : 0);
    const g1pred = hOk && aOk ? (h.g1mean + a.g1mean) / 2 : hOk ? (h.g1mean + G1_MEAN) / 2 : aOk ? (a.g1mean + G1_MEAN) / 2 : G1_MEAN;
    const fmpred = hOk && aOk ? (h.fmmean + a.fmmean) / 2 : hOk ? (h.fmmean + FM_MEAN) / 2 : aOk ? (a.fmmean + FM_MEAN) / 2 : FM_MEAN;
    const g1sigma = dataPoints === 2 ? G1_STD * 0.95 : dataPoints === 1 ? G1_STD : G1_STD * 1.1;
    const fmsigma = dataPoints === 2 ? FM_STD * 0.95 : dataPoints === 1 ? FM_STD : FM_STD * 1.1;

    const candidates = [];
    if (g1) candidates.push({ type: "G1 Under 19.5", odds: g1.odds, marketId: "247", specifier: "gamenr=1|total=19.5", outcomeId: "13", prob: normalCDF(19.5, g1pred, g1sigma) });
    for (const fm of fmAll) candidates.push({ type: "FM Under " + fm.line, odds: fm.odds, marketId: "238", specifier: fm.specifier, outcomeId: fm.outcomeId, prob: normalCDF(fm.line, fmpred, fmsigma) });
    candidates.sort((x, y) => y.prob - x.prob);
    const best = candidates[0];
    if (!best) continue;

    analyzed.push({
      home: s.homeTeam, away: s.awayTeam, eventId: s.eventId, sportId: s.sportId, kickoff: s.kickoff,
      dataPoints, g1pred: +g1pred.toFixed(1), fmpred: +fmpred.toFixed(1), best, allCandidates: candidates,
    });
    await new Promise(r => setTimeout(r, 120));
  }
  analyzed.sort((x, y) => y.best.prob - x.best.prob);

  // graduated combos with rotation so they aren't nested copies of each other
  function rotatedSlice(list, size, rotation) {
    const arr = [...list.slice(rotation), ...list.slice(0, rotation)];
    return arr.slice(0, size);
  }
  const comboSizes = sizes && sizes.length ? sizes : [6, 8, 10, 12, 15, 18, 20, 22, 25, 30, 35, 40, analyzed.length];
  const combos = [];
  for (let i = 0; i < comboSizes.length; i++) {
    const size = Math.min(comboSizes[i], analyzed.length);
    const rotation = (i * 2) % Math.max(1, analyzed.length - size + 1); // vary starting point each size
    const list = rotatedSlice(analyzed, size, rotation);
    const selections = list.map(m => ({ eventId: m.eventId, marketId: m.best.marketId, outcomeId: m.best.outcomeId, specifier: m.best.specifier, productId: 3, sportId: m.sportId || "sr:sport:20" }));
    const combinedOdds = list.reduce((p, m) => p * m.best.odds, 1);
    const jointConfidence = list.reduce((p, m) => p * m.best.prob, 1);
    const res = await httpPost("/api/generate", { selections });
    combos.push({ size, rotation, shareCode: res.shareCode, legs: list.length, combinedOdds, jointConfidence, matches: list.map(m => ({ match: m.home + " vs " + m.away, market: m.best.type, odds: m.best.odds, confidence: +(m.best.prob * 100).toFixed(1) })) });
    console.log(`  size ${size} (rotation ${rotation}) -> ${res.shareCode} | odds ${combinedOdds.toExponential(3)} | joint conf ${(jointConfidence * 100).toPrecision(3)}%`);
    await new Promise(r => setTimeout(r, 250));
  }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const report = {
    date: today, code, totalUnplayed: notStart.length,
    top10: analyzed.slice(0, 10).map(m => ({ match: m.home + " vs " + m.away, market: m.best.type, odds: m.best.odds, confidence: +(m.best.prob * 100).toFixed(1), dataPoints: m.dataPoints })),
    top20: analyzed.slice(0, 20).map(m => ({ match: m.home + " vs " + m.away, market: m.best.type, odds: m.best.odds, confidence: +(m.best.prob * 100).toFixed(1) })),
    flaggedNoData: analyzed.filter(m => m.dataPoints === 0).length,
    combos,
    avgTop10Confidence: +mean(analyzed.slice(0, 10).map(m => m.best.prob * 100)).toFixed(1),
    avgTop20Confidence: +mean(analyzed.slice(0, 20).map(m => m.best.prob * 100)).toFixed(1),
  };
  saveJSON(path.join(REPORTS_DIR, today + ".json"), report);
  saveJSON(path.join(REPORTS_DIR, "latest.json"), report);
  return report;
}

// ---------------- TARGETED ANALYZE (verified players + requested markets) ----------------
async function analyzeTargeted(code, sizes) {
  const players = loadJSON(PLAYERS_FILE, {});
  const hist = loadJSON(HISTORY_FILE, []);
  const byEvent = new Map();
  for (const h of hist) if (h.score && h.halfScores && h.halfScores.length >= 3 && !byEvent.has(h.eventId)) byEvent.set(h.eventId, h);
  const completedMatches = [...byEvent.values()];
  const g1All = completedMatches.map(m => gt(m.halfScores[0]));
  const fmAllVals = completedMatches.map(m => m.halfScores.reduce((s, hs) => s + gt(hs), 0));
  const G1_MEAN = mean(g1All), G1_STD = std(g1All);
  const FM_MEAN = mean(fmAllVals), FM_STD = std(fmAllVals);

  const j = await httpGet("/api/booking/" + code);
  if (j.error) { console.log("ERROR:", j.error); return; }
  const notStart = j.selections.filter(s => s.matchStatus === "Not start");
  console.log("Targeted analysis for", code, "- treating only verified players and live markets");
  console.log("Allowed market families: G1 Over 17.5 and FM Under", TARGETED_FM_MIN_LINE + " to " + TARGETED_FM_MAX_LINE);

  const analyzed = [];
  for (const s of notStart) {
    const m = await httpGet("/api/markets/" + encodeURIComponent(s.eventId));
    const markets = m.markets || [];
    const h = players[s.homeTeam], a = players[s.awayTeam];
    const hOk = h && h.n >= TARGETED_MIN_MATCHES;
    const aOk = a && a.n >= TARGETED_MIN_MATCHES;
    if (!hOk || !aOk) continue;

    const g1pred = (h.g1mean + a.g1mean) / 2;
    const fmpred = (h.fmmean + a.fmmean) / 2;
    const g1sigma = G1_STD * 0.95;
    const fmsigma = FM_STD * 0.95;
    const snapshot = buildPlayerSnapshot(s.homeTeam, s.awayTeam, h, a);
    const pairKey = [s.homeTeam, s.awayTeam].sort().join(" ||| ");
    const pairHist = loadJSON(path.join(DATA_DIR, "tt-pairhistory.json"), {})[pairKey] || [];

    const candidates = [];
    const g1 = markets.find(mk => mk.marketId === "247" && mk.specifier === "gamenr=1|total=17.5" && mk.outcomeName.startsWith("Over"));
    if (g1) {
      const prob = 1 - normalCDF(TARGETED_G1_LINE, g1pred, g1sigma);
      candidates.push({
        type: "G1 Over 17.5",
        odds: g1.odds,
        marketId: "247",
        specifier: "gamenr=1|total=17.5",
        outcomeId: g1.outcomeId,
        prob,
        confidence: prob,
        dist: "g1",
        dir: "Over",
        line: TARGETED_G1_LINE,
      });
    }

    for (const mk of markets) {
      if (mk.marketId !== "238") continue;
      if (!/^total=/.test(mk.specifier)) continue;
      if (!mk.outcomeName.startsWith("Under")) continue;
      const line = parseFloat(mk.specifier.split("total=")[1]);
      if (!Number.isFinite(line)) continue;
      if (line < TARGETED_FM_MIN_LINE || line > TARGETED_FM_MAX_LINE) continue;
      const prob = normalCDF(line, fmpred, fmsigma);
      candidates.push({
        type: "FM Under " + line,
        odds: mk.odds,
        marketId: "238",
        specifier: mk.specifier,
        outcomeId: mk.outcomeId,
        prob,
        confidence: prob,
        dist: "fm",
        dir: "Under",
        line,
      });
    }

    if (!candidates.length) continue;
    candidates.forEach(c => { c.ev = +(c.confidence * c.odds - 1).toFixed(3); });
    const positive = candidates.filter(c => c.ev > 0);
    const ranked = (positive.length ? positive : candidates).sort((x, y) => (y.confidence - x.confidence) || (y.ev - x.ev));
    const best = ranked[0];
    analyzed.push({
      home: s.homeTeam,
      away: s.awayTeam,
      eventId: s.eventId,
      sportId: s.sportId,
      kickoff: s.kickoff,
      pairMeetings: pairHist.length,
      dataPoints: 2,
      players: snapshot,
      best,
      candidates,
    });
    await new Promise(r => setTimeout(r, 120));
  }

  analyzed.sort((x, y) => (y.best.confidence - x.best.confidence) || (y.best.ev - x.best.ev));
  saveJSON(path.join(REPORTS_DIR, "targeted-" + code + ".json"), analyzed);

  console.log("\n=== VERIFIED BEST BETS ===");
  analyzed.slice(0, 10).forEach((m, i) => {
    console.log(`${i + 1}. ${m.home} vs ${m.away} | ${m.best.type} @${m.best.odds} | conf ${(m.best.confidence * 100).toFixed(1)}% | EV ${(m.best.ev >= 0 ? "+" : "")}${(m.best.ev * 100).toFixed(1)}% | players ${m.players.home.n}/${m.players.away.n}`);
  });

  if (!analyzed.length) {
    console.log("No verified matches found with the requested market families.");
    return { analyzed: [], combos: [] };
  }

  const comboSizes = sizes && sizes.length ? sizes : TARGETED_COMBO_SIZES;
  function buildCombo(size, startIdx) {
    const playerCount = {};
    const legs = [];
    let idx = startIdx;
    let scanned = 0;
    while (legs.length < size && scanned < analyzed.length * 3) {
      const m = analyzed[idx % analyzed.length];
      idx++;
      scanned++;
      const hc = playerCount[m.home] || 0;
      const ac = playerCount[m.away] || 0;
      const strongOverride = m.best.confidence >= 0.68 && m.best.ev > 0;
      if ((hc >= 2 || ac >= 2) && !strongOverride) continue;
      if (legs.some(l => l.eventId === m.eventId)) continue;
      legs.push(m);
      playerCount[m.home] = hc + 1;
      playerCount[m.away] = ac + 1;
    }
    return legs;
  }

  const combos = [];
  const seen = new Set();
  for (let start = 0; combos.length < TARGETED_COMBO_SIZES.length && start < analyzed.length * 3; start++) {
    const size = Math.min(comboSizes[start % comboSizes.length], analyzed.length);
    const legs = buildCombo(size, start);
    if (!legs.length) continue;
    const key = legs.map(l => l.eventId + "|" + l.best.marketId + "|" + l.best.specifier + "|" + l.best.dir).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const selections = legs.map(l => ({
      eventId: l.eventId,
      marketId: l.best.marketId,
      outcomeId: l.best.outcomeId,
      specifier: l.best.specifier,
      productId: 3,
      sportId: l.sportId || "sr:sport:20",
    }));
    const combinedOdds = legs.reduce((p, l) => p * l.best.odds, 1);
    const jointConfidence = legs.reduce((p, l) => p * l.best.confidence, 1);
    const res = await httpPost("/api/generate", { selections });
    combos.push({
      shareCode: res.shareCode,
      legs: legs.length,
      combinedOdds: +combinedOdds.toFixed(2),
      jointConfidence: +jointConfidence.toFixed(6),
      highestRiskLeg: [...legs].sort((a, b) => b.best.odds - a.best.odds)[0].home + " vs " + [...legs].sort((a, b) => b.best.odds - a.best.odds)[0].away,
      matches: legs.map(l => ({
        match: l.home + " vs " + l.away,
        market: l.best.type,
        odds: l.best.odds,
        confidence: +(l.best.confidence * 100).toFixed(1),
        players: l.players,
      })),
    });
    console.log(`  code ${combos.length}: ${res.shareCode} | legs ${legs.length} | odds ${combinedOdds.toExponential(3)} | joint conf ${(jointConfidence * 100).toFixed(3)}%`);
    await new Promise(r => setTimeout(r, 250));
    if (combos.length >= TARGETED_COMBO_SIZES.length) break;
  }

  const bestBet = analyzed[0];
  const today = new Date().toISOString().slice(0, 10);
  const report = {
    date: today,
    code,
    bestBet: {
      match: bestBet.home + " vs " + bestBet.away,
      market: bestBet.best.type,
      odds: bestBet.best.odds,
      confidence: +(bestBet.best.confidence * 100).toFixed(1),
      ev: +(bestBet.best.ev * 100).toFixed(1),
      players: bestBet.players,
    },
    top10: analyzed.slice(0, 10).map(m => ({
      match: m.home + " vs " + m.away,
      market: m.best.type,
      odds: m.best.odds,
      confidence: +(m.best.confidence * 100).toFixed(1),
      ev: +(m.best.ev * 100).toFixed(1),
      players: m.players,
    })),
    combos,
  };
  saveJSON(path.join(REPORTS_DIR, "targeted-" + today + ".json"), report);
  saveJSON(path.join(REPORTS_DIR, "targeted-latest.json"), report);
  return report;
}

// ---------------- OPPONENT-STRENGTH ADJUSTMENT (fitted from real data, not guessed) ----------------
// Every prediction below was previously built from a player's OWN flat historical average,
// blended with the opponent's own flat average - with no correction for how mismatched THIS
// specific pairing is. Real data (1158 completed matches with known strength for both sides)
// shows that matters a lot:
//   - FM total drops ~2.9 points for every 1.0 increase in |strength gap| (r-fit from real data:
//     fmtotal ≈ 79.8 - 2.93*gap) - bigger mismatches sweep more often (20.7%→100% straight-win
//     rate across the gap range), which mechanically means fewer total points played.
//   - G1 total barely moves with gap (≈19.0 - 0.18*gap) - game 1 alone doesn't shorten much
//     just because the match overall is lopsided.
//   - Handicap: "excess cushion" (cushion minus the actual signed strength gap between the two
//     players) predicts real hit rate almost linearly - 35.7% at excess 0-3, up to 74.1% at
//     excess 6-10 (176 real settled bets). This replaces the earlier guessed if/else thresholds
//     entirely with a lookup fitted to real outcomes.
function linreg(xs, ys) {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b1 = den ? num / den : 0;
  return { b0: my - b1 * mx, b1, meanX: mx };
}
const HANDICAP_EXCESS_BUCKETS = [
  { min: -Infinity, max: 0, label: "<0" },
  { min: 0, max: 3, label: "0-3" },
  { min: 3, max: 6, label: "3-6" },
  { min: 6, max: 10, label: "6-10" },
  { min: 10, max: Infinity, label: "10+" },
];
function computeOpponentAdjustment(players, completed) {
  const g1Pts = [], fmPts = [];
  for (const m of completed) {
    const h = players[m.home], a = players[m.away];
    if (!h || !a || h.strength == null || a.strength == null) continue;
    const gap = Math.abs(h.strength - a.strength);
    g1Pts.push({ x: gap, y: gt(m.halfScores[0]) });
    fmPts.push({ x: gap, y: m.halfScores.reduce((s, hs) => s + gt(hs), 0) });
  }
  const g1Reg = g1Pts.length >= 30 ? linreg(g1Pts.map(p => p.x), g1Pts.map(p => p.y)) : null;
  const fmReg = fmPts.length >= 30 ? linreg(fmPts.map(p => p.x), fmPts.map(p => p.y)) : null;

  const history = loadJSON(HISTORY_FILE, []);
  const hcpSettled = history.filter(r => r.marketId === HANDICAP_MARKET_ID && (r.isWinning === 0 || r.isWinning === 1));
  const excessRows = [];
  for (const r of hcpSettled) {
    const cushion = parseHandicapCushion(r.outcome);
    if (cushion === null) continue;
    const isHome = r.outcome.startsWith("Home");
    const favPlayer = isHome ? r.home : r.away, oppPlayer = isHome ? r.away : r.home;
    const fp = players[favPlayer], op = players[oppPlayer];
    if (!fp || !op || fp.strength == null || op.strength == null) continue;
    const signedGap = op.strength - fp.strength;
    excessRows.push({ excess: cushion - signedGap, won: r.isWinning === 1 });
  }
  const handicapExcessRates = {};
  for (const b of HANDICAP_EXCESS_BUCKETS) {
    const rows = excessRows.filter(r => r.excess >= b.min && r.excess < b.max);
    handicapExcessRates[b.label] = rows.length ? { plays: rows.length, winRate: +(rows.filter(r => r.won).length / rows.length * 100).toFixed(1) } : null;
  }
  return { g1Reg, fmReg, handicapExcessRates, sampleSize: g1Pts.length };
}

// ---------------- PREDICTION LOGGING + CALIBRATION (the real "learning engine") ----------------
// Every time a match gets scored during a scan, we log what confidence we actually gave the
// pick that was made. Once that match resolves, computeCalibration() joins the logged
// prediction against the real result and asks: when we said X% confidence, how often were we
// actually right? If there's a real, sustained gap (not a one-day blip - CALIBRATION_MIN_SAMPLES
// gates this), a bounded correction factor (capped at CALIBRATION_MAX_CORRECTION, i.e. ±15%) is
// applied to future confidence for that market. This is a real, honest, rolling recalibration -
// not a claim to be running gradient descent on a few hundred data points.
//
// IMPORTANT CAVEAT (disclosed, not hidden): this can only calibrate against predictions made
// FROM THE POINT THIS WAS BUILT ONWARD. Confidence values from earlier in tonight's session
// were never persisted to a queryable log, so there's no way to retroactively backtest exact
// per-match predictions from before now - the loop starts here, it doesn't rewrite history.
function logPrediction(eventId, marketId, specifier, market, confidence, homeTeam, awayTeam, outcome) {
  const log = loadJSON(PREDICTIONS_LOG_FILE, []);
  const key = recordKey({ eventId, marketId, specifier, outcome });
  const idx = log.findIndex(p => p.key === key);
  const entry = { key, eventId, marketId, specifier, outcome: outcome || null, market, predictedConfidence: confidence, homeTeam, awayTeam, predictedAt: new Date().toISOString() };
  if (idx >= 0) log[idx] = entry; else log.push(entry);
  saveJSON(PREDICTIONS_LOG_FILE, log.length > 20000 ? log.slice(-20000) : log);
}

function computeCalibration() {
  const predictions = loadJSON(PREDICTIONS_LOG_FILE, []);
  const history = loadJSON(HISTORY_FILE, []);
  const byKey = new Map();
  for (const h of history) {
    if (h.isWinning !== 0 && h.isWinning !== 1) continue;
    byKey.set(recordKey(h), h);
  }
  const byMarket = {};
  for (const p of predictions) {
    const result = byKey.get(p.key);
    if (!result) continue; // still unplayed or not yet ingested
    (byMarket[p.market] ||= []).push({ predicted: p.predictedConfidence, actual: result.isWinning === 1 });
  }
  const calibration = {};
  for (const [market, rows] of Object.entries(byMarket)) {
    const avgPredicted = mean(rows.map(r => r.predicted));
    const avgActual = mean(rows.map(r => r.actual ? 1 : 0));
    let correction = 1;
    let note = `Only ${rows.length} resolved predictions logged for ${market} - below the ${CALIBRATION_MIN_SAMPLES}-sample minimum, no correction applied yet.`;
    if (rows.length >= CALIBRATION_MIN_SAMPLES && avgPredicted > 0) {
      const rawRatio = avgActual / avgPredicted;
      correction = Math.min(1 + CALIBRATION_MAX_CORRECTION, Math.max(1 - CALIBRATION_MAX_CORRECTION, rawRatio));
      note = `${rows.length} resolved predictions: predicted ${(avgPredicted * 100).toFixed(1)}% avg, actual ${(avgActual * 100).toFixed(1)}% avg -> correction ${correction.toFixed(3)}x` + (correction !== rawRatio ? ` (capped from raw ${rawRatio.toFixed(3)}x)` : "");
    }
    calibration[market] = { plays: rows.length, avgPredictedPct: +(avgPredicted * 100).toFixed(1), avgActualPct: +(avgActual * 100).toFixed(1), correction: +correction.toFixed(3), note };
  }
  const result = { byMarket: calibration, totalPredictionsLogged: predictions.length, updatedAt: new Date().toISOString() };
  saveJSON(CALIBRATION_FILE, result);
  return result;
}

// ---------------- LOSS ANALYSIS (formalized post-match review) ----------------
// For every real settled loss, explain WHY - not just that it lost. G1/FM losses get judged
// as close-miss (normal variance around a fair line) vs way-off (something the model should
// have seen coming). Handicap losses get the sweep-bust vs close-miss diagnosis worked out
// earlier tonight, expressed as a real number (how many points the cushion was missed by).
// sourceCodes: optional array to scope to specific codes; omit to analyze all history.
function analyzeLosses(sourceCodes) {
  const history = loadJSON(HISTORY_FILE, []);
  const scoped = sourceCodes && sourceCodes.length ? history.filter(h => sourceCodes.includes(h.sourceCode)) : history;
  const settled = scoped.filter(h => h.isWinning === 0 || h.isWinning === 1);
  const seen = new Set(); const uniq = [];
  for (const r of settled) { const k = recordKey(r); if (seen.has(k)) continue; seen.add(k); uniq.push(r); }

  const won = uniq.filter(r => r.isWinning === 1).length;
  const lost = uniq.filter(r => r.isWinning === 0);

  const byMarket = {};
  for (const r of uniq) {
    let mkey;
    if (r.marketId === "247") mkey = r.specifier.includes("19.5") ? "G1_Under19.5" : r.specifier.includes("17.5") ? "G1_Over17.5" : "G1_other";
    else if (r.marketId === "238") mkey = "FM_Under" + r.specifier.split("=")[1];
    else if (r.marketId === HANDICAP_MARKET_ID) mkey = "Handicap";
    else if (r.marketId === "900111") mkey = "G1_ExtraPoints_" + (r.outcome || "other");
    else mkey = r.market || "other";
    (byMarket[mkey] ||= { won: 0, lost: 0 }).won += r.isWinning === 1 ? 1 : 0;
    byMarket[mkey].lost += r.isWinning === 0 ? 1 : 0;
  }
  const marketBreakdown = Object.entries(byMarket).map(([market, d]) => ({ market, plays: d.won + d.lost, won: d.won, lost: d.lost, winRate: +((d.won / (d.won + d.lost)) * 100).toFixed(1) })).sort((a, b) => b.plays - a.plays);

  const lossDetail = lost.map(r => {
    if (r.marketId === HANDICAP_MARKET_ID) {
      const cushion = parseHandicapCushion(r.outcome);
      const isHome = r.outcome.startsWith("Home");
      const diffs = (r.halfScores || []).map(hs => { const [a, b] = hs.split(":").map(Number); return a - b; });
      const totalDiff = diffs.reduce((x, y) => x + y, 0);
      const effectiveDiff = isHome ? totalDiff : -totalDiff;
      const deficit = cushion !== null ? +(effectiveDiff + cushion).toFixed(1) : null;
      const diagnosis = deficit === null ? "unparseable" : deficit < -3 ? "sweep-bust (missed by 3+ pts, not a close call)" : deficit < 0 ? "close miss (missed by under 3 pts)" : "unexpected loss despite apparent cover - check settlement";
      return { match: r.home + " vs " + r.away, market: "Handicap +" + cushion, score: r.score, league: r.league, diagnosis, missedByPts: deficit !== null ? Math.abs(deficit) : null };
    }
    if (r.marketId === "247" || r.marketId === "238") {
      const total = (r.halfScores || []).reduce((s, hs) => s + gt(hs), 0);
      const g1total = r.halfScores && r.halfScores[0] ? gt(r.halfScores[0]) : null;
      const isUnder = r.outcome.startsWith("Under");
      const line = parseFloat(r.specifier.split("=").pop());
      const relevantTotal = r.marketId === "247" ? g1total : total;
      const missedBy = relevantTotal !== null ? +Math.abs(relevantTotal - line).toFixed(1) : null;
      const diagnosis = missedBy === null ? "unparseable" : missedBy <= 3 ? "close miss (normal variance around a fair line)" : "missed by a wide margin - worth a second look";
      return { match: r.home + " vs " + r.away, market: r.market + " " + r.outcome, score: r.score, league: r.league, diagnosis, missedByPts: missedBy };
    }
    return { match: r.home + " vs " + r.away, market: r.market + " " + r.outcome, score: r.score, league: r.league, diagnosis: "market type not covered by automated diagnosis", missedByPts: null };
  });

  const handicapLosses = lossDetail.filter(l => l.market.startsWith("Handicap"));
  const sweepBusts = handicapLosses.filter(l => l.diagnosis.startsWith("sweep-bust")).length;

  return {
    totalPlays: uniq.length, won, lost: lost.length,
    hitRatePct: uniq.length ? +((won / uniq.length) * 100).toFixed(1) : null,
    marketBreakdown,
    lossDetail,
    summary: handicapLosses.length ? `${sweepBusts} of ${handicapLosses.length} handicap losses (${((sweepBusts / handicapLosses.length) * 100).toFixed(0)}%) were sweep-busts, not close misses.` : null,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------- CROSS-MARKET PER-MATCH SCORING ----------------
// Loads everything needed to score matches against G1 Under19.5, G1 Over17.5, FM Under
// (any offered line), and Handicap - once - so scoring many matches doesn't re-read disk
// or recompute the population distribution per match.
function buildScoringContext() {
  const players = loadJSON(PLAYERS_FILE, {});
  const history = loadJSON(HISTORY_FILE, []);
  const byEvent = new Map();
  for (const h of history) if (h.score && h.halfScores && h.halfScores.length >= 3 && !byEvent.has(h.eventId)) byEvent.set(h.eventId, h);
  const completed = [...byEvent.values()];
  const g1All = completed.map(m => gt(m.halfScores[0]));
  const fmAll = completed.map(m => m.halfScores.reduce((s, hs) => s + gt(hs), 0));
  const handicapRates = loadJSON(path.join(DATA_DIR, "tt-handicap-rates.json"), computeHandicapRates());
  const pairHistory = loadJSON(path.join(DATA_DIR, "tt-pairhistory.json"), {});
  const opponentAdjustment = computeOpponentAdjustment(players, completed);
  const calibration = loadJSON(CALIBRATION_FILE, { byMarket: {} });
  return {
    players, g1All, fmAll,
    G1_MEAN: mean(g1All), G1_STD: std(g1All),
    FM_MEAN: mean(fmAll), FM_STD: std(fmAll),
    handicapRates, pairHistory, opponentAdjustment, calibration,
  };
}

// Evaluate every market we track for one match's live market listing, and return them all
// ranked by real confidence - the top of the list is the honest "best pick", not whichever
// market historically scores highest overall. Handicap candidates carry an underperforming
// flag when their league has a track record notably below the blended rate.
function scoreMatchAllMarkets(homeTeam, awayTeam, markets, ctx, league) {
  const { players, g1All, fmAll, G1_MEAN, G1_STD, FM_MEAN, FM_STD, handicapRates, pairHistory, opponentAdjustment, calibration } = ctx;
  const h = players[homeTeam], a = players[awayTeam];
  const hOk = h && h.n >= 2, aOk = a && a.n >= 2;
  const dataPoints = (hOk ? 1 : 0) + (aOk ? 1 : 0);
  const knownPlayers = !!(h && a && h.n >= KNOWN_PLAYER_MIN_N && a.n >= KNOWN_PLAYER_MIN_N);

  const g1predRaw = hOk && aOk ? (h.g1mean + a.g1mean) / 2 : hOk ? (h.g1mean + G1_MEAN) / 2 : aOk ? (a.g1mean + G1_MEAN) / 2 : G1_MEAN;
  const fmpredRaw = hOk && aOk ? (h.fmmean + a.fmmean) / 2 : hOk ? (h.fmmean + FM_MEAN) / 2 : aOk ? (a.fmmean + FM_MEAN) / 2 : FM_MEAN;
  const g1sigma = dataPoints === 2 ? G1_STD * 0.95 : G1_STD;
  const fmsigma = dataPoints === 2 ? FM_STD * 0.95 : FM_STD;
  const maxDecider = Math.max(h?.deciderPct ?? 0, a?.deciderPct ?? 0);
  const gap = (h?.strength != null && a?.strength != null) ? Math.abs(h.strength - a.strength) : null;

  // Opponent-strength adjustment: a player's own flat average reflects the field they've
  // usually faced, not THIS opponent. Shift the player-based prediction by how much this
  // specific gap deviates from the population's average gap, using the real fitted
  // regression (fmtotal ≈ 79.8 - 2.93*gap, g1total ≈ 19.0 - 0.18*gap) - so a big mismatch
  // pulls the predicted total down even if neither player's own history suggested it.
  const { g1Reg, fmReg } = opponentAdjustment;
  const g1pred = (gap !== null && g1Reg) ? g1predRaw + g1Reg.b1 * (gap - g1Reg.meanX) : g1predRaw;
  const fmpred = (gap !== null && fmReg) ? fmpredRaw + fmReg.b1 * (gap - fmReg.meanX) : fmpredRaw;

  // Head-to-head: the single most specific signal available. When these two exact players
  // have met before, fold those results into the shrinkage lists at 2x weight (duplicated)
  // so shrunkRate() leans on real head-to-head history over generic population data without
  // needing a separate blending mechanism.
  const pairKey = [homeTeam, awayTeam].sort().join(" ||| ");
  const h2h = (pairHistory && pairHistory[pairKey]) || [];
  const h2hG1 = h2h.map(m => m.g1);
  const h2hFm = h2h.map(m => m.fm);
  const g1list = [...(h?.g1list || []), ...(a?.g1list || []), ...h2hG1, ...h2hG1];
  const fmlist = [...(h?.fmlist || []), ...(a?.fmlist || []), ...h2hFm, ...h2hFm];

  const candidates = [];

  for (const mk of markets.filter(x => x.marketId === "247" && /^gamenr=1\|total=(17\.5|19\.5)$/.test(x.specifier))) {
    const line = parseFloat(mk.specifier.split("total=")[1]);
    const modelUnder = normalCDF(line, g1pred, g1sigma);
    if (mk.outcomeName.startsWith("Under") && line === 19.5) {
      const conf = (modelUnder + shrunkRate(g1list, g1All, line, true)) / 2;
      candidates.push({ type: "G1 Under 19.5", market: "G1_Under19.5", odds: mk.odds, marketId: "247", specifier: mk.specifier, outcomeId: mk.outcomeId, outcome: mk.outcomeName, confidence: Math.min(conf, 0.95), knownPlayers, strengthGap: gap });
    }
    if (mk.outcomeName.startsWith("Over") && line === 17.5) {
      const conf = ((1 - modelUnder) + shrunkRate(g1list, g1All, line, false)) / 2;
      candidates.push({ type: "G1 Over 17.5", market: "G1_Over17.5", odds: mk.odds, marketId: "247", specifier: mk.specifier, outcomeId: mk.outcomeId, outcome: mk.outcomeName, confidence: Math.min(conf, 0.95), knownPlayers, strengthGap: gap });
    }
  }

  // Extra Points - 1st game (marketId 900111): direct function of the same G1 total
  // distribution already fitted above, evaluated at the deuce threshold (21.5) instead of the
  // usual 17.5/19.5 lines - see TRACKED_MARKETS comment for why this needs no new regression.
  for (const mk of markets.filter(x => x.marketId === "900111")) {
    const modelNo = normalCDF(EXTRA_POINTS_LINE, g1pred, g1sigma);
    if (mk.outcomeName === "No") {
      const conf = (modelNo + shrunkRate(g1list, g1All, EXTRA_POINTS_LINE, true)) / 2;
      candidates.push({ type: "Extra Points - No (G1)", market: "G1_ExtraPoints_No", odds: mk.odds, marketId: "900111", specifier: mk.specifier, outcomeId: mk.outcomeId, outcome: mk.outcomeName, confidence: Math.min(conf, 0.95), knownPlayers, strengthGap: gap });
    } else if (mk.outcomeName === "Yes") {
      const conf = ((1 - modelNo) + shrunkRate(g1list, g1All, EXTRA_POINTS_LINE, false)) / 2;
      candidates.push({ type: "Extra Points - Yes (G1)", market: "G1_ExtraPoints_Yes", odds: mk.odds, marketId: "900111", specifier: mk.specifier, outcomeId: mk.outcomeId, outcome: mk.outcomeName, confidence: Math.min(conf, 0.95), knownPlayers, strengthGap: gap });
    }
  }

  for (const mk of markets.filter(x => x.marketId === "238" && /^total=/.test(x.specifier) && x.outcomeName.startsWith("Under"))) {
    const line = parseFloat(mk.specifier.split("total=")[1]);
    let conf = normalCDF(line, fmpred, fmsigma);
    let penalty = 0;
    if (maxDecider > 60) penalty = 0.30; else if (maxDecider > 45) penalty = 0.15;
    if (line === 78.5) penalty += 0.12;
    if (line === 79.5) penalty += 0.15;
    if (line <= 74.5) penalty += 0.20;
    if (String(league || "").startsWith("TT Elite")) penalty += 0.15;
    conf = (conf + shrunkRate(fmlist, fmAll, line, true)) / 2 * (1 - penalty);
    if (line === 77.5) conf *= 1.06;
    candidates.push({ type: "FM Under " + line, market: "FM_Under" + line, odds: mk.odds, marketId: "238", specifier: mk.specifier, outcomeId: mk.outcomeId, outcome: mk.outcomeName, confidence: Math.min(Math.max(conf, 0), 0.95), knownPlayers });
  }

  // Evaluate EVERY offered handicap line for this match (both sides, every cushion size the
  // bookmaker lists - typically 3-6 lines per match), not just the biggest cushion. Each one
  // gets scored independently through the same real, fitted model; they compete against each
  // other (and against G1/FM) via the confidence sort below - the market score literally
  // decides which single line, if any, survives for this match.
  const handicapLines = [];
  for (const row of markets.filter(x => x.marketId === HANDICAP_MARKET_ID)) {
    const cushion = parseHandicapCushion(row.outcomeName);
    if (cushion === null) continue;
    handicapLines.push({ cushion, odds: row.odds, specifier: row.specifier, outcomeId: row.outcomeId, outcomeName: row.outcomeName, isHome: row.outcomeName.startsWith("Home") });
  }
  for (const line of handicapLines) {
    const bucket = handicapBucketFor(line.cushion);
    const bucketRate = bucket && handicapRates.byBucket[bucket.label];
    const leagueRate = handicapRates.byLeague[league];
    const flagged = handicapRates.underperformingLeagues.find(u => u.league === league);
    let confidence, confidenceSource;
    if (leagueRate && leagueRate.plays >= HANDICAP_UNDERPERFORM_MIN_SAMPLES) { confidence = leagueRate.winRate / 100; confidenceSource = "league rate"; }
    else if (bucketRate && bucketRate.plays >= 10) { confidence = bucketRate.winRate / 100; confidenceSource = "cushion-size rate"; }
    else { confidence = (handicapRates.overall.winRate ?? 54) / 100; confidenceSource = "overall blended rate"; }

    // Opponent-adjusted override: "excess cushion" (cushion size minus the actual signed
    // strength gap between these two specific players) is a real, near-linear predictor of
    // real hit rate fitted from 176 settled bets (35.7% at excess 0-3 up to 74.1% at excess
    // 6-10) - a materially better signal than the league/bucket-blended rate above, since it
    // accounts for WHICH two players are on this specific cushion. Used whenever we have
    // enough real samples in the matching excess bucket; falls back to the blended rate
    // above otherwise (e.g. one/both players too new to have a strength rating yet).
    let gapAdjustNote = null;
    if (h?.strength != null && a?.strength != null) {
      // signedGap: positive when the side RECEIVING the cushion is the weaker player by our
      // strength metric (the normal case - matches how the fit was computed); negative when
      // our metric disagrees with the bookmaker and the "underdog" cushion is actually going
      // to the stronger player - in that case excess should be treated as even bigger (safer),
      // which falls out correctly since we subtract the signed value, not the magnitude.
      const favStrength = line.isHome ? h.strength : a.strength;
      const oppStrength = line.isHome ? a.strength : h.strength;
      const signedGap = oppStrength - favStrength;
      const excess = line.cushion - signedGap;
      const excessBucket = HANDICAP_EXCESS_BUCKETS.find(b => excess >= b.min && excess < b.max);
      const excessRate = excessBucket && opponentAdjustment.handicapExcessRates[excessBucket.label];
      if (excessRate && excessRate.plays >= 15) {
        confidence = excessRate.winRate / 100;
        confidenceSource = "opponent-adjusted (excess cushion " + excessBucket.label + ")";
        gapAdjustNote = `Cushion +${line.cushion} vs signed strength gap ${signedGap.toFixed(1)} = excess ${excess.toFixed(1)} -> real hit rate ${excessRate.winRate}% across ${excessRate.plays} similar bets.`;
      }
    }
    confidence = Math.min(Math.max(confidence, 0.05), 0.95);

    candidates.push({
      type: "Handicap +" + line.cushion, market: "Handicap", odds: line.odds, marketId: HANDICAP_MARKET_ID,
      specifier: line.specifier, outcomeId: line.outcomeId, outcome: line.outcomeName, confidence, knownPlayers, cushion: line.cushion,
      cushionBucket: bucket?.label || null, league, strengthGap: gap, gapAdjustNote, confidenceSource,
      h2hMeetings: h2h.length,
      underperformingLeague: !!flagged, underperformNote: flagged ? `${league} handicap real rate ${flagged.winRate}% vs ${flagged.othersWinRate}% everywhere else (${flagged.plays} samples)` : null,
    });
  }

  // Bounded self-correction from the real learning loop (see computeCalibration): if a
  // market's logged predictions have been running consistently over/under real results,
  // nudge confidence toward reality - capped at ±15%, only applied once a market has
  // CALIBRATION_MIN_SAMPLES resolved predictions on record, so a single bad night can't
  // swing anything.
  for (const c of candidates) {
    const cal = calibration?.byMarket?.[c.market];
    if (cal && cal.plays >= CALIBRATION_MIN_SAMPLES) {
      c.confidence = Math.min(0.97, Math.max(0.03, c.confidence * cal.correction));
      c.calibrationApplied = cal.correction;
    }
  }

  candidates.sort((x, y) => y.confidence - x.confidence);
  return { home: homeTeam, away: awayTeam, dataPoints, knownPlayers, strengthGap: gap, h2hMeetings: h2h.length, candidates, best: candidates[0] || null };
}

// ---------------- SELECTION BUILDER (odds-floor ladder, hard-capped at SportyBet's real 50-leg max) ----------------
// analyzedMatches: array of {home, away, eventId, sportId, best:{...}} already deduped one-per-match.
// Never produces a "best" tier below MIN_FLOOR - the old confidencePicks tier (flat top-5,
// no floor) is what produced a 6x code and got called "best," which is exactly what's fixed
// here: EVERY tier below is built by extending the confidence-sorted pool leg-by-leg until it
// clears that tier's floor, same honest-disclosure rule as before (never substitutes a weak
// pick in quietly - only ever ADDS more legs from the same confidence-ordered pool).
const MAX_LEGS = 50; // SportyBet's real hard per-slip cap
const MIN_FLOOR = 1000;
const DEFAULT_TIER_FLOORS = [1000, 10000, 100000, 1000000];

function buildSelections(analyzedMatches, opts = {}) {
  const maxLegs = Math.max(1, Math.min(opts.maxLegs || MAX_LEGS, MAX_LEGS));
  const tierFloors = (opts.tiers && opts.tiers.length ? opts.tiers : DEFAULT_TIER_FLOORS).filter(f => f >= MIN_FLOOR);

  const byEvent = new Map();
  for (const m of analyzedMatches) { if (m.best && !byEvent.has(m.eventId)) byEvent.set(m.eventId, m); }
  const pool = [...byEvent.values()].sort((x, y) => y.best.confidence - x.best.confidence);

  function toSelection(m) { return { eventId: m.eventId, marketId: m.best.marketId, outcomeId: m.best.outcomeId, specifier: m.best.specifier, productId: 3, sportId: m.sportId || "sr:sport:20" }; }
  function summarize(list) {
    const odds = list.reduce((p, m) => p * m.best.odds, 1);
    const win = list.reduce((p, m) => p * m.best.confidence, 1);
    const avgConf = list.length ? mean(list.map(m => m.best.confidence)) : 0;
    return {
      legs: list.length,
      combinedOdds: list.length ? +odds.toFixed(2) : null,
      straightWinPct: list.length ? +(win * 100).toPrecision(4) : null,
      avgConfidencePct: list.length ? +(avgConf * 100).toFixed(1) : null,
      selections: list.map(toSelection),
      matches: list.map(m => ({ match: m.home + " vs " + m.away, market: m.best.type, odds: m.best.odds, confidencePct: +(m.best.confidence * 100).toFixed(1), knownPlayers: m.knownPlayers, strengthGap: m.best.strengthGap ?? m.strengthGap ?? null, gapAdjustNote: m.best.gapAdjustNote || null, underperformingLeague: m.best.underperformingLeague || false, underperformNote: m.best.underperformNote || null })),
    };
  }
  const emptyNote = "No matches available to build any selection.";

  if (!pool.length) {
    const empty = { legs: 0, combinedOdds: null, straightWinPct: null, avgConfidencePct: null, selections: [], matches: [], floorMet: false };
    return {
      maxLegs,
      tiers: tierFloors.map(floor => ({ floor, ...empty, tradeoffNote: emptyNote })),
      maxTier: { ...empty, tradeoffNote: emptyNote },
    };
  }

  // Build one tier: extend the confidence-sorted pool leg-by-leg until combined odds clears
  // `floorOdds`, capped at maxLegs. Always at least 1 leg if the pool has anything.
  function buildTier(floorOdds) {
    const list = [];
    let odds = 1, i = 0;
    while (i < pool.length && list.length < maxLegs && (odds < floorOdds || list.length === 0)) {
      list.push(pool[i]);
      odds *= pool[i].best.odds;
      i++;
    }
    const s = summarize(list);
    const floorMet = s.combinedOdds >= floorOdds;
    return {
      floor: floorOdds,
      ...s,
      floorMet,
      tradeoffNote: floorMet
        ? `${s.legs} legs (avg confidence ${s.avgConfidencePct}%) clears the ${floorOdds.toLocaleString()}x floor - real straight-win chance ${s.straightWinPct}%.`
        : `Used the maximum available legs from this pool (${s.legs}, capped at ${maxLegs}) and only reached ${s.combinedOdds}x - short of the ${floorOdds.toLocaleString()}x target honestly. Pool too thin/high-confidence for this floor; merge more codes for a bigger pool.`,
    };
  }

  const tiers = tierFloors.map(buildTier);

  // MAX tier: the ceiling this pool can produce - every usable match, capped at maxLegs
  // (SportyBet's real per-slip limit), sorted by confidence so the strongest legs are always
  // included first. Not a "floor" tier - it's disclosed as the honest ceiling, not a target.
  const maxList = pool.slice(0, maxLegs);
  const maxSummary = summarize(maxList);
  const bestTierAvg = tiers[0]?.avgConfidencePct ?? maxSummary.avgConfidencePct;
  const maxTier = {
    ...maxSummary,
    floor: null,
    tradeoffNote: `Ceiling code using all ${maxSummary.legs} usable matches from this pool (capped at ${maxLegs} legs, SportyBet's real per-slip max). Average per-leg confidence ${maxSummary.avgConfidencePct}% (vs ${bestTierAvg}% on the ${tierFloors[0]?.toLocaleString()}x tier). Real straight-win chance at this size: ${maxSummary.straightWinPct}%. This is the ceiling this pool can produce, not a recommendation to stake it as a straight bet.`,
  };

  return { maxLegs, tiers, maxTier };
}

// ---------------- BATCH BUILDER (5-10 diversified codes in one run) ----------------
// A single confidence-sorted pool produces nested/near-identical tiers (item above). This
// instead builds N genuinely DIFFERENT codes by rotating the starting point through the pool
// and capping how many times any one player can appear across a single code - the same
// correlation-aware pattern worked out by hand earlier this session (a single dominant
// repeat player caused a real loss - code QBS3TN). Each code still only uses real
// confidence-ranked picks; rotation changes WHICH real picks are included, never fabricates one.
const BATCH_MAX_PLAYER_REPEATS = 3;
function buildBatch(analyzedMatches, opts = {}) {
  const count = Math.max(1, Math.min(opts.count || 8, 10));
  const maxLegs = Math.max(1, Math.min(opts.maxLegs || MAX_LEGS, MAX_LEGS));
  const minLegs = Math.max(1, Math.min(opts.minLegs || 5, maxLegs));
  const floor = opts.floor && opts.floor >= MIN_FLOOR ? opts.floor : MIN_FLOOR;

  const byEvent = new Map();
  for (const m of analyzedMatches) { if (m.best && !byEvent.has(m.eventId)) byEvent.set(m.eventId, m); }
  const pool = [...byEvent.values()].sort((x, y) => y.best.confidence - x.best.confidence);
  if (!pool.length) return { requested: count, floor, maxLegs, minLegs, codes: [], note: "No usable matches - nothing scored across the submitted codes." };

  function summarize(list) {
    const odds = list.reduce((p, m) => p * m.best.odds, 1);
    const win = list.reduce((p, m) => p * m.best.confidence, 1);
    const avgConf = mean(list.map(m => m.best.confidence));
    return {
      legs: list.length,
      combinedOdds: +odds.toFixed(2),
      straightWinPct: +(win * 100).toPrecision(4),
      avgConfidencePct: +(avgConf * 100).toFixed(1),
      selections: list.map(m => ({ eventId: m.eventId, marketId: m.best.marketId, outcomeId: m.best.outcomeId, specifier: m.best.specifier, productId: 3, sportId: m.sportId || "sr:sport:20" })),
      matches: list.map(m => ({ match: m.home + " vs " + m.away, market: m.best.type, odds: m.best.odds, confidencePct: +(m.best.confidence * 100).toFixed(1) })),
    };
  }

  const codes = [];
  const seenKeys = new Set();
  for (let rotation = 0; codes.length < count && rotation < pool.length + count * 3; rotation++) {
    const playerCount = {};
    const legs = [];
    let idx = rotation % pool.length;
    let scanned = 0;
    let odds = 1;
    while (legs.length < maxLegs && scanned < pool.length * 2) {
      const m = pool[idx % pool.length];
      idx++; scanned++;
      if (legs.some(l => l.eventId === m.eventId)) continue;
      const hc = playerCount[m.home] || 0, ac = playerCount[m.away] || 0;
      if (hc >= BATCH_MAX_PLAYER_REPEATS || ac >= BATCH_MAX_PLAYER_REPEATS) continue;
      legs.push(m);
      playerCount[m.home] = hc + 1; playerCount[m.away] = ac + 1;
      odds *= m.best.odds;
      if (legs.length >= minLegs && odds >= floor) break;
    }
    if (legs.length < minLegs) continue;
    const key = legs.map(l => l.eventId).sort().join(",");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const s = summarize(legs);
    codes.push({ ...s, floorMet: s.combinedOdds >= floor, rotation });
  }

  return { requested: count, built: codes.length, floor, maxLegs, minLegs, codes };
}

// ---------------- MARKET-SPECIFIC GENERATOR ("gen X, under 78.5" / "highest handicap") ----------------
// scoreMatchAllMarkets already scores EVERY offered market per match, not just the winner -
// this just re-selects from that same real candidate list by a specific market instead of by
// whichever market happened to score highest for each match. "Handicap_Highest" is a special
// case: among a match's offered handicap lines, take the biggest cushion rather than the
// highest-confidence one (a deliberately different, more aggressive request than the default
// Handicap candidate, which picks by real confidence).
const MARKET_SELECT_KEYS = ["G1_Under19.5", "G1_Over17.5", "FM_Under77.5", "FM_Under78.5", "FM_Under79.5", "FM_Under80.5", "Handicap", "Handicap_Highest", "G1_ExtraPoints_No", "G1_ExtraPoints_Yes"];
function buildMarketSelection(analyzedMatches, marketKey, opts = {}) {
  const maxLegs = Math.max(1, Math.min(opts.maxLegs || MAX_LEGS, MAX_LEGS));
  const byEvent = new Map();
  for (const m of analyzedMatches) {
    if (byEvent.has(m.eventId)) continue;
    const pool = m.candidates || m.allCandidates || [];
    let cand = null;
    if (marketKey === "Handicap_Highest") {
      const hcp = pool.filter(c => c.market === "Handicap" && c.cushion != null);
      if (hcp.length) cand = hcp.reduce((a, b) => (b.cushion > a.cushion ? b : a));
    } else {
      cand = pool.find(c => c.market === marketKey) || null;
    }
    if (cand) byEvent.set(m.eventId, { ...m, best: cand });
  }
  const list = [...byEvent.values()].sort((x, y) => y.best.confidence - x.best.confidence).slice(0, maxLegs);
  if (!list.length) return { market: marketKey, legs: 0, combinedOdds: null, straightWinPct: null, avgConfidencePct: null, selections: [], matches: [], note: `No matches in this pool currently offer ${marketKey}.` };

  const odds = list.reduce((p, m) => p * m.best.odds, 1);
  const win = list.reduce((p, m) => p * m.best.confidence, 1);
  return {
    market: marketKey,
    legs: list.length,
    combinedOdds: +odds.toFixed(2),
    straightWinPct: +(win * 100).toPrecision(4),
    avgConfidencePct: +(mean(list.map(m => m.best.confidence)) * 100).toFixed(1),
    selections: list.map(m => ({ eventId: m.eventId, marketId: m.best.marketId, outcomeId: m.best.outcomeId, specifier: m.best.specifier, productId: 3, sportId: m.sportId || "sr:sport:20" })),
    matches: list.map(m => ({ match: m.home + " vs " + m.away, market: m.best.type, odds: m.best.odds, confidencePct: +(m.best.confidence * 100).toFixed(1) })),
  };
}

module.exports = {
  ingest, rebuild, analyze, analyzeTargeted,
  computeHandicapRates, buildScoringContext, scoreMatchAllMarkets, buildSelections, buildBatch, buildMarketSelection,
  logPrediction, computeCalibration, analyzeLosses,
  loadJSON, saveJSON, recordKey,
  HISTORY_FILE, PLAYERS_FILE, LEADERBOARDS_FILE, DATA_DIR, CALIBRATION_FILE, PREDICTIONS_LOG_FILE, MAX_LEGS, MARKET_SELECT_KEYS,
};

// ---------------- CLI ----------------
// Only runs when this file is executed directly (`node tt-engine.js ...`), not when
// required as a module (e.g. by server.js for the Table Tennis workspace routes).
if (require.main === module) {
  (async () => {
    const [, , cmd, ...args] = process.argv;
    if (cmd === "ingest") await ingest(args);
    else if (cmd === "rebuild") rebuild();
    else if (cmd === "analyze") {
      const code = args[0];
      const sizes = args.slice(1).map(Number).filter(n => !isNaN(n));
      await analyze(code, sizes);
    } else if (cmd === "targeted") {
      const code = args[0];
      const sizes = args.slice(1).map(Number).filter(n => !isNaN(n));
      await analyzeTargeted(code, sizes);
    } else if (cmd === "report") {
      const lb = loadJSON(LEADERBOARDS_FILE, {});
      console.log(JSON.stringify(lb, null, 2));
    } else {
      console.log("Usage: node tt-engine.js <ingest|rebuild|analyze|targeted|report> ...");
    }
  })();
}
