/**
 * SlipPilot — Full Punter Analysis + 50-Fold Code Generation
 * Run: node analyze.js (server must be running on port 3000)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const API_FOOTBALL_KEY = "f1739cfdacf78915c1b8a7eb2ad726ba";
const SERVER = "http://localhost:3000";
const DATA_DIR = path.join(__dirname, "data");

// ── HTTP helpers ──

function localGet(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`${SERVER}${endpoint}`, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`Bad JSON from ${endpoint}`)); } });
    }).on("error", reject);
  });
}

function localPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(`${SERVER}${endpoint}`);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`Bad JSON from POST ${endpoint}`)); } });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function apiFootball(endpoint) {
  return new Promise((resolve) => {
    https.get(`https://v3.football.api-sports.io${endpoint}`, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY, Accept: "application/json" }
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Punter definitions ──

const PUNTERS = [
  { name: "39 Billion", today: "HPS13S", history: ["PWFRFE", "Z1B4JE", "P5S61H"] },
  { name: "9Z", today: "LU84JS", history: ["N008GY", "Q4TXHP", "LLVRBH"] },
  { name: "Top Boy", today: "QU303D", history: ["WZCESW", "S5C59J"] },
  { name: "Ayo Jordan", today: "MDTXU3", history: ["Y3XBRC", "Q1BRJW"] },
  { name: "Bayo Bets", today: "RE9N9N", history: ["VRQY31"] },
];

// ── STEP 1: Fetch all codes ──

async function fetchCode(code) {
  try {
    const r = await localGet(`/api/booking/${code}`);
    if (r.error) { console.log(`  ✗ ${code}: ${r.error}`); return null; }
    return r;
  } catch (e) { console.log(`  ✗ ${code}: ${e.message}`); return null; }
}

async function scanCode(code) {
  try {
    const r = await localGet(`/api/scan/${code}`);
    if (r.error) { console.log(`  ✗ SCAN ${code}: ${r.error}`); return null; }
    return r;
  } catch (e) { console.log(`  ✗ SCAN ${code}: ${e.message}`); return null; }
}

// ── STEP 2: Build trust profiles ──

function buildProfile(name, scanResults) {
  const allPicks = [];
  let totalWon = 0, totalLost = 0, totalVoid = 0;
  const dayRates = [];
  const marketWins = {}, marketLosses = {};

  for (const scan of scanResults) {
    if (!scan) continue;
    const won = scan.results.filter(r => r.verdict === "WON").length;
    const lost = scan.results.filter(r => r.verdict === "LOST").length;
    const voided = scan.results.filter(r => r.verdict === "VOID").length;
    totalWon += won; totalLost += lost; totalVoid += voided;
    const settled = won + lost;
    if (settled > 0) dayRates.push(Math.round(won / settled * 100));

    for (const r of scan.results) {
      allPicks.push(r);
      const mkt = r.market || "Unknown";
      if (r.verdict === "WON") marketWins[mkt] = (marketWins[mkt] || 0) + 1;
      if (r.verdict === "LOST") marketLosses[mkt] = (marketLosses[mkt] || 0) + 1;
    }
  }

  const settled = totalWon + totalLost;
  const hitRate = settled > 0 ? Math.round(totalWon / settled * 100) : 0;
  const avgOdds = allPicks.length > 0 ? Math.round(allPicks.reduce((a, p) => a + (p.odds || 1), 0) / allPicks.length * 100) / 100 : 0;

  // Strong and weak markets
  const markets = new Set([...Object.keys(marketWins), ...Object.keys(marketLosses)]);
  const strongMarkets = [], weakMarkets = [], killerPicks = [];
  for (const m of markets) {
    const w = marketWins[m] || 0, l = marketLosses[m] || 0;
    const rate = w + l > 0 ? w / (w + l) : 0;
    if (rate > 0.7 && w >= 2) strongMarkets.push(m);
    if (rate < 0.4 && l >= 2) { weakMarkets.push(m); killerPicks.push(m); }
  }

  // Trust score
  let trustScore = hitRate;
  if (dayRates.length >= 3 && dayRates.every(r => r >= 50)) trustScore += 10;
  if (dayRates.some(r => r < 40)) trustScore -= 10;
  if (avgOdds < 1.60) trustScore += 5;
  if (killerPicks.some(k => k.includes("Correct Score") || k.includes("Both Halves"))) trustScore -= 5;
  trustScore = Math.max(0, Math.min(100, trustScore));

  return { name, hitRate, trustScore, strongMarkets, weakMarkets, killerPicks, avgOddsPerGame: avgOdds, totalGames: allPicks.length, won: totalWon, lost: totalLost, void: totalVoid };
}

// ── STEP 4: H2H Analysis ──

const h2hCache = new Map();

async function getH2HData(homeTeam, awayTeam) {
  const key = `${homeTeam}|${awayTeam}`.toLowerCase();
  if (h2hCache.has(key)) return h2hCache.get(key);

  try {
    const homeSearch = await apiFootball(`/teams?search=${encodeURIComponent(homeTeam)}`);
    const awaySearch = await apiFootball(`/teams?search=${encodeURIComponent(awayTeam)}`);
    const homeId = homeSearch?.response?.[0]?.team?.id;
    const awayId = awaySearch?.response?.[0]?.team?.id;

    if (!homeId || !awayId) {
      const result = { found: false, avgGoals: null, bttsRate: null, over25Rate: null, homeWinRate: null, homeForm: [], awayForm: [] };
      h2hCache.set(key, result);
      return result;
    }

    await sleep(200);
    const [h2hRes, homeFormRes, awayFormRes] = await Promise.all([
      apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=5`),
      apiFootball(`/fixtures?team=${homeId}&last=5&status=FT`),
      apiFootball(`/fixtures?team=${awayId}&last=5&status=FT`),
    ]);

    const h2hMatches = (h2hRes?.response || []).filter(f => f.fixture?.status?.short === "FT");
    const avgGoals = h2hMatches.length > 0 ? Math.round(h2hMatches.reduce((s, f) => s + (f.goals?.home || 0) + (f.goals?.away || 0), 0) / h2hMatches.length * 10) / 10 : null;
    const bttsRate = h2hMatches.length > 0 ? Math.round(h2hMatches.filter(f => (f.goals?.home || 0) > 0 && (f.goals?.away || 0) > 0).length / h2hMatches.length * 100) : null;
    const over25Rate = h2hMatches.length > 0 ? Math.round(h2hMatches.filter(f => (f.goals?.home || 0) + (f.goals?.away || 0) > 2.5).length / h2hMatches.length * 100) : null;
    const homeWinRate = h2hMatches.length > 0 ? Math.round(h2hMatches.filter(f => (f.goals?.home || 0) > (f.goals?.away || 0)).length / h2hMatches.length * 100) : null;

    const formOf = (fixtures, teamId) => (fixtures?.response || []).filter(f => f.fixture?.status?.short === "FT").slice(0, 5).map(f => {
      const isHome = f.teams?.home?.id === teamId;
      const gf = isHome ? f.goals?.home : f.goals?.away;
      const ga = isHome ? f.goals?.away : f.goals?.home;
      return gf > ga ? "W" : gf < ga ? "L" : "D";
    });

    const result = { found: true, avgGoals, bttsRate, over25Rate, homeWinRate, homeForm: formOf(homeFormRes, homeId), awayForm: formOf(awayFormRes, awayId), h2hMatches: h2hMatches.length };
    h2hCache.set(key, result);
    return result;
  } catch (e) {
    const result = { found: false, avgGoals: null, bttsRate: null, over25Rate: null, homeWinRate: null, homeForm: [], awayForm: [] };
    h2hCache.set(key, result);
    return result;
  }
}

function calculateSafetyScore(pick, h2h, consensus, punterTrust, killerMarkets) {
  let score = 50;
  const out = (pick.outcome || "").toLowerCase();
  const mkt = (pick.market || "").toLowerCase();
  const odds = pick.odds || 1;

  if (h2h.found && h2h.avgGoals !== null) {
    if (out.includes("over 1.5") && h2h.avgGoals > 1.5) score += 20;
    if (out.includes("over 1.5") && h2h.avgGoals < 1.5) score -= 15;
    if (out.includes("over 2.5") && h2h.avgGoals > 2.5) score += 20;
    if (out.includes("over 2.5") && h2h.avgGoals < 2.0) score -= 20;
    if (out.includes("yes") && mkt.includes("gg") && h2h.bttsRate > 60) score += 20;
    if (out.includes("yes") && mkt.includes("gg") && h2h.bttsRate < 40) score -= 25;
    if (out.includes("no") && mkt.includes("gg") && h2h.bttsRate < 40) score += 20;
    if (out === "home" && mkt === "1x2" && h2h.homeWinRate > 70) score += 25;
    if (out === "home" && mkt === "1x2" && h2h.homeWinRate < 30) score -= 25;
    if (mkt.includes("double chance") && out.includes("home") && h2h.homeWinRate > 40) score += 15;
  } else {
    // Odds-based fallback
    if (odds < 1.30) score = 70;
    else if (odds < 1.60) score = 55;
    else if (odds < 2.00) score = 40;
    else score = 25;
  }

  if (consensus) score += 15;
  if (punterTrust >= 75) score += 10;
  if (killerMarkets.some(k => mkt.includes(k.toLowerCase()))) score -= 20;

  return Math.max(0, Math.min(100, score));
}

// ── STEP 5: Smart Conversions ──

async function convertPick(pick, h2h) {
  const out = (pick.outcome || "").toLowerCase();
  const mkt = (pick.market || "").toLowerCase();
  let targetOutcome = null, targetMarket = null, reason = "";

  const overMatch = out.match(/^over (\d+\.?\d*)$/);
  if (overMatch) {
    const val = parseFloat(overMatch[1]);
    if (val >= 3.5) { targetMarket = "Over/Under"; targetOutcome = "Over 2.5"; reason = `Over ${val} → Over 2.5`; }
    else if (val >= 2.5 && h2h.found && h2h.avgGoals !== null && h2h.avgGoals < 2.0) { targetMarket = "Over/Under"; targetOutcome = "Over 1.5"; reason = `Over 2.5 → Over 1.5 (avgGoals: ${h2h.avgGoals})`; }
  }
  if (!targetOutcome && mkt.includes("gg") && out === "yes" && h2h.found && h2h.bttsRate !== null && h2h.bttsRate < 40) {
    targetMarket = "Over/Under"; targetOutcome = "Over 1.5"; reason = `BTTS Yes → Over 1.5 (bttsRate: ${h2h.bttsRate}%)`;
  }
  if (!targetOutcome && mkt === "1x2" && out === "home" && h2h.found && h2h.homeWinRate !== null && h2h.homeWinRate < 25) {
    targetMarket = "Double Chance"; targetOutcome = "Home or Draw"; reason = `Home Win → DC 1X (homeWinRate: ${h2h.homeWinRate}%)`;
  }
  if (!targetOutcome && mkt === "1x2" && out === "away" && h2h.found && h2h.homeWinRate !== null && h2h.homeWinRate > 75) {
    targetMarket = "Double Chance"; targetOutcome = "Draw or Away"; reason = `Away Win → DC X2 (homeWinRate: ${h2h.homeWinRate}%)`;
  }
  if (!targetOutcome && mkt.includes("correct score")) {
    targetMarket = "Over/Under"; targetOutcome = "Over 1.5"; reason = `Correct Score → Over 1.5`;
  }
  if (!targetOutcome && mkt.includes("both halves") && mkt.includes("under") && out === "no") {
    targetMarket = "Over/Under"; targetOutcome = "Over 2.5"; reason = `Both Halves U1.5 No → Over 2.5`;
  }
  // Asian Handicap -1.5 or worse → remove
  if (mkt.includes("handicap")) {
    const hcp = parseFloat((pick.specifier || "").match(/hcp=([-\d.]+)/)?.[1] || 0);
    if (hcp <= -1.5) return { ...pick, _removed: true, _reason: "Asian Handicap -1.5 or worse removed" };
  }

  if (!targetOutcome) return pick;

  // Fetch real market IDs
  try {
    const mkts = await localGet(`/api/markets/${encodeURIComponent(pick.eventId)}`);
    if (mkts.markets) {
      const found = mkts.markets.find(m => m.marketName.toLowerCase().includes(targetMarket.toLowerCase()) && m.outcomeName === targetOutcome);
      if (found) {
        console.log(`  ↳ ${pick.homeTeam} vs ${pick.awayTeam}: ${reason}`);
        return { ...pick, market: found.marketName, outcome: found.outcomeName, odds: found.odds, marketId: found.marketId, outcomeId: found.outcomeId, specifier: found.specifier || "", _converted: true, _reason: reason };
      }
    }
  } catch {}
  return pick;
}

// ── STEP 6: Code Generation ──

async function generateCode(selections) {
  const payload = selections.map(s => ({
    eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
    specifier: s.specifier || "", productId: s.productId || 3, sportId: s.sportId || ""
  }));
  try {
    const r = await localPost("/api/generate", { selections: payload });
    if (r.success && r.shareCode) return r.shareCode;
    return null;
  } catch { return null; }
}

function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

// ── MAIN ──

async function main() {
  console.log("\n══════════════════════════════════════════════");
  console.log("SLIPPILOT — FULL PUNTER ANALYSIS");
  console.log("══════════════════════════════════════════════\n");

  // STEP 1: Fetch all codes
  console.log("STEP 1: Fetching all booking codes...\n");
  const punterData = {};

  for (const p of PUNTERS) {
    console.log(`▸ ${p.name}`);
    punterData[p.name] = { today: null, history: [] };

    // Fetch today's code
    console.log(`  Today: ${p.today}`);
    punterData[p.name].today = await fetchCode(p.today);
    await sleep(500);

    // Fetch and scan history
    for (const code of p.history) {
      console.log(`  History: ${code}`);
      const scan = await scanCode(code);
      if (scan) punterData[p.name].history.push(scan);
      await sleep(500);
    }
  }

  // STEP 2: Build trust profiles
  console.log("\n\nSTEP 2: Building punter trust profiles...\n");
  const profiles = {};
  for (const p of PUNTERS) {
    profiles[p.name] = buildProfile(p.name, punterData[p.name].history);
    const pr = profiles[p.name];
    console.log(`  ${pr.name}: Hit ${pr.hitRate}% | Trust ${pr.trustScore}/100 | ${pr.totalGames} games`);
  }

  // STEP 3: Build master pool
  console.log("\n\nSTEP 3: Building master pool from today's games...\n");
  const masterPool = new Map(); // eventId -> { picks: [{pick, punter}], consensus, ... }

  for (const p of PUNTERS) {
    const data = punterData[p.name].today;
    if (!data || !data.selections) { console.log(`  ✗ ${p.name}: no today data`); continue; }
    console.log(`  ${p.name}: ${data.selections.length} games`);
    for (const sel of data.selections) {
      if (!masterPool.has(sel.eventId)) {
        masterPool.set(sel.eventId, { ...sel, picks: [] });
      }
      masterPool.get(sel.eventId).picks.push({ ...sel, punter: p.name, trustScore: profiles[p.name].trustScore });
    }
  }

  console.log(`\n  Total unique games: ${masterPool.size}`);

  // Determine consensus
  const pool = [...masterPool.values()];
  const consensusPicks = [];
  const soloPicks = [];
  for (const game of pool) {
    if (game.picks.length >= 2) {
      game.consensus = true;
      consensusPicks.push(game);
    } else {
      game.consensus = false;
      soloPicks.push(game);
    }
  }
  console.log(`  Consensus (2+ punters): ${consensusPicks.length}`);
  console.log(`  Solo picks: ${soloPicks.length}`);

  // STEP 4: H2H Analysis
  console.log("\n\nSTEP 4: Running H2H analysis (API-Football)...\n");
  const allGames = [...pool];
  let batchCount = 0;

  for (let i = 0; i < allGames.length; i += 5) {
    const batch = allGames.slice(i, i + 5);
    batchCount++;
    process.stdout.write(`  Batch ${batchCount} (games ${i + 1}-${Math.min(i + 5, allGames.length)} of ${allGames.length})...`);

    await Promise.all(batch.map(async (game) => {
      const h2h = await getH2HData(game.homeTeam, game.awayTeam);
      game.h2h = h2h;

      // Best pick for this game (highest trust punter's pick)
      const bestPick = game.picks.sort((a, b) => (b.trustScore || 0) - (a.trustScore || 0))[0];
      const killerMkts = profiles[bestPick.punter]?.killerPicks || [];
      game.safetyScore = calculateSafetyScore(bestPick, h2h, game.consensus, bestPick.trustScore, killerMkts);
      game.bestPick = bestPick;
    }));

    console.log(` done (${h2hCache.size} cached)`);
    if (i + 5 < allGames.length) await sleep(1000);
  }

  // STEP 5: Smart conversions
  console.log("\n\nSTEP 5: Applying smart conversions...\n");
  let convCount = 0, removeCount = 0;

  for (const game of allGames) {
    const converted = await convertPick(game.bestPick, game.h2h || { found: false });
    if (converted._removed) { game._removed = true; removeCount++; }
    else if (converted._converted) { game.bestPick = converted; game.converted = true; convCount++; }
    game.finalPick = converted._removed ? null : converted;
  }

  console.log(`\n  Converted: ${convCount} picks`);
  console.log(`  Removed: ${removeCount} picks`);

  const activePool = allGames.filter(g => !g._removed && g.finalPick);
  console.log(`  Active pool: ${activePool.length} games`);

  // STEP 6: Generate 50 codes
  console.log("\n\nSTEP 6: Generating 50 booking codes...\n");

  const safePool = activePool.filter(g => g.safetyScore >= 65).sort((a, b) => b.safetyScore - a.safetyScore);
  const balancedPool = activePool.filter(g => g.safetyScore >= 45).sort((a, b) => b.safetyScore - a.safetyScore);
  const valuePool = activePool.filter(g => g.safetyScore >= 35).sort((a, b) => b.safetyScore - a.safetyScore);
  const consensusPool = activePool.filter(g => g.consensus).sort((a, b) => b.safetyScore - a.safetyScore);

  const allCodes = { A: [], B: [], C: [], D: [], E: [], F: [] };
  let totalGenerated = 0;

  // Group A: Safe (10 codes, 8-12 games each)
  console.log("  Group A — Safe Accumulators (10 codes)...");
  for (let i = 0; i < 10; i++) {
    const n = 8 + Math.floor(Math.random() * 5);
    const sels = pickRandom(safePool.length >= n ? safePool : balancedPool, n);
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.A.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPick: sels[0] });
    if (code) totalGenerated++;
    process.stdout.write(`    ${i + 1}/10 ${code || "FAILED"} (${sels.length} games, ${odds.toFixed(0)}x)\n`);
    await sleep(300);
  }

  // Group B: Balanced (15 codes, 12-20 games)
  console.log("  Group B — Balanced Mix (15 codes)...");
  for (let i = 0; i < 15; i++) {
    const n = 12 + Math.floor(Math.random() * 9);
    const sels = pickRandom(balancedPool, n);
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.B.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPick: sels[0] });
    if (code) totalGenerated++;
    process.stdout.write(`    ${i + 1}/15 ${code || "FAILED"} (${sels.length} games, ${odds.toFixed(0)}x)\n`);
    await sleep(300);
  }

  // Group C: Value (10 codes, 15-25 games)
  console.log("  Group C — Value Shots (10 codes)...");
  for (let i = 0; i < 10; i++) {
    const n = 15 + Math.floor(Math.random() * 11);
    const sels = pickRandom(valuePool, n);
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.C.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPick: sels[0] });
    if (code) totalGenerated++;
    process.stdout.write(`    ${i + 1}/10 ${code || "FAILED"} (${sels.length} games, ${odds.toFixed(0)}x)\n`);
    await sleep(300);
  }

  // Group D: Consensus Bankers (5 codes, 5-10 games)
  console.log("  Group D — Consensus Bankers (5 codes)...");
  for (let i = 0; i < 5; i++) {
    const n = 5 + Math.floor(Math.random() * 6);
    const sels = pickRandom(consensusPool.length >= n ? consensusPool : safePool, n);
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.D.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPick: sels[0] });
    if (code) totalGenerated++;
    process.stdout.write(`    ${i + 1}/5 ${code || "FAILED"} (${sels.length} games, ${odds.toFixed(0)}x)\n`);
    await sleep(300);
  }

  // Group E: Full Pool Flex (5 codes, 30-50 games)
  console.log("  Group E — Full Pool Flex (5 codes)...");
  for (let i = 0; i < 5; i++) {
    const n = 30 + Math.floor(Math.random() * 21);
    const sels = pickRandom(activePool, Math.min(n, activePool.length));
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.E.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPick: sels[0] });
    if (code) totalGenerated++;
    process.stdout.write(`    ${i + 1}/5 ${code || "FAILED"} (${sels.length} games, ${odds.toFixed(0)}x)\n`);
    await sleep(300);
  }

  // Group F: Permutation Mix (5 codes, 15-20 games with consensus bankers)
  console.log("  Group F — Permutation Mix (5 codes)...");
  const topConsensus = consensusPool.slice(0, 5);
  for (let i = 0; i < 5; i++) {
    const extraN = 10 + Math.floor(Math.random() * 6);
    const extras = pickRandom(activePool.filter(g => !topConsensus.includes(g)), extraN);
    const sels = [...topConsensus, ...extras];
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.F.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPick: sels[0] });
    if (code) totalGenerated++;
    process.stdout.write(`    ${i + 1}/5 ${code || "FAILED"} (${sels.length} games, ${odds.toFixed(0)}x)\n`);
    await sleep(300);
  }

  // STEP 7: Output
  console.log("\n\n");
  const output = buildOutput(profiles, consensusPicks, activePool, allCodes, totalGenerated);
  console.log(output);

  // Save to file
  fs.writeFileSync(path.join(DATA_DIR, "codes-today.txt"), output);
  fs.writeFileSync(path.join(DATA_DIR, "punter-profiles.json"), JSON.stringify(profiles, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "generated-codes.json"), JSON.stringify(allCodes, null, 2));

  console.log(`\n\nFiles saved:`);
  console.log(`  data/codes-today.txt`);
  console.log(`  data/punter-profiles.json`);
  console.log(`  data/generated-codes.json`);
}

function buildOutput(profiles, consensusPicks, activePool, allCodes, totalGenerated) {
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  let out = "";

  out += "══════════════════════════════════════════════\n";
  out += "SLIPPILOT — TODAY'S ANALYSIS\n";
  out += `${date} | 5 Punters | ${activePool.length}+ Games\n`;
  out += "══════════════════════════════════════════════\n\n";

  out += "PUNTER TRUST RANKINGS\n";
  out += "─────────────────────\n";
  const ranked = Object.values(profiles).sort((a, b) => b.trustScore - a.trustScore);
  ranked.forEach((p, i) => {
    out += `${i + 1}. ${p.name} — Hit Rate: ${p.hitRate}% | Trust: ${p.trustScore}/100\n`;
    out += `   Strong: [${p.strongMarkets.join(", ") || "N/A"}] | Avoid: [${p.weakMarkets.join(", ") || "N/A"}]\n`;
    out += `   Killer picks: [${p.killerPicks.join(", ") || "None identified"}]\n`;
    out += `   Avg odds/game: ${p.avgOddsPerGame} | Games tracked: ${p.totalGames}\n\n`;
  });

  out += "\n══════════════════════════════════════════════\n";
  out += "CONSENSUS PICKS (Multiple punters agree)\n";
  out += "─────────────────────────────────────────\n";
  for (const g of consensusPicks.slice(0, 20)) {
    const punters = g.picks.map(p => p.punter).join(", ");
    out += `${g.homeTeam} vs ${g.awayTeam} — ${g.bestPick?.outcome || "?"} (${g.picks.length} punters: ${punters})\n`;
    out += `  Safety: ${g.safetyScore} | H2H avg: ${g.h2h?.avgGoals ?? "N/A"} goals\n`;
  }

  out += "\n══════════════════════════════════════════════\n";
  out += "DANGER PICKS (Avoid these)\n";
  out += "────────────────────────────\n";
  const dangers = activePool.filter(g => g.safetyScore < 30).slice(0, 10);
  if (dangers.length === 0) out += "None identified below threshold 30\n";
  for (const g of dangers) {
    out += `${g.homeTeam} vs ${g.awayTeam} — ${g.bestPick?.outcome} — Score: ${g.safetyScore}\n`;
  }

  const groupInfo = [
    { key: "A", title: "GROUP A — SAFE ACCUMULATORS", sub: "Stake ₦50 each | Target: 100x-2,000x" },
    { key: "B", title: "GROUP B — BALANCED MIX", sub: "Stake ₦20 each | Target: 2,000x-50,000x" },
    { key: "C", title: "GROUP C — VALUE SHOTS", sub: "Stake ₦10 each | Target: 50,000x-500,000x" },
    { key: "D", title: "GROUP D — CONSENSUS BANKERS", sub: "Stake ₦50 each | Highest confidence" },
    { key: "E", title: "GROUP E — FULL POOL FLEX (Moonshot)", sub: "Stake ₦10 each | Play for fun" },
    { key: "F", title: "GROUP F — PERMUTATION MIX", sub: "Stake ₦10-20 each" },
  ];

  for (const gi of groupInfo) {
    out += `\n\n══════════════════════════════════════════════\n`;
    out += `${gi.title}\n${gi.sub}\n`;
    out += "─────────────────────────────────────────\n";
    allCodes[gi.key].forEach((c, i) => {
      out += `${i + 1}. ${c.code || "FAILED"} — ${c.games} games — ${c.odds.toLocaleString()}x odds\n`;
    });
  }

  const totalStake = (10 * 50) + (15 * 20) + (10 * 10) + (5 * 50) + (5 * 10) + (5 * 15);
  out += "\n\n══════════════════════════════════════════════\n";
  out += `TOTAL CODES: ${totalGenerated}/50 generated successfully\n`;
  out += `TOTAL STAKE IF ALL PLAYED: ₦${totalStake}\n`;
  out += "ONE OF THESE SHOULD BOOM. GOOD LUCK.\n";
  out += "══════════════════════════════════════════════\n";

  return out;
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
