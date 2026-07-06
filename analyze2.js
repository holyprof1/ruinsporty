/**
 * SlipPilot — Full Punter Network Analysis + High Odds Code Generation
 * Run: node analyze2.js (server must be running on port 3000)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const API_FOOTBALL_KEY = "f1739cfdacf78915c1b8a7eb2ad726ba";
const SERVER = "http://localhost:3000";
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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
    req.write(payload); req.end();
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
  { name: "39 Billion", handle: "@39billion", tier: "primary", today: ["HPS13S"], history: ["PWFRFE", "Z1B4JE", "P5S61H", "X62NBJ", "QDZBEG", "M3ZNHX", "K8YFL4"] },
  { name: "9Z", handle: "@9zerobillion", tier: "primary", today: ["LU84JS"], history: ["N008GY", "Q4TXHP", "LLVRBH"] },
  { name: "Big Strategic", handle: "@Big_Strategic", tier: "primary", today: ["QU303D"], history: ["WZCESW"] },
  { name: "Ayo Jordan", handle: "@AyoJordan", tier: "primary", today: ["MDTXU3"], history: ["Y3XBRC", "Q1BRJW"] },
  { name: "Bayo Bets", handle: "@BayoBets", tier: "primary", today: ["RE9N9N"], history: ["VRQY31"] },
  { name: "OY", handle: "@OyAi_dev", tier: "secondary", today: ["M9J9KV"], history: ["WTV2UC", "M3Z2JF"] },
  { name: "Princewill", handle: "@90Princewill", tier: "secondary", today: ["V3XV6K"], history: ["JT8QZY", "5HVRBLQ", "5HHGRWL"] },
  { name: "Sirtee", handle: "@Sirtee", tier: "secondary", today: ["HXQH8Q"], history: ["L2HN4B", "R8RV49"] },
];

// ── STEP 1: Fetch ──

async function fetchCode(code) {
  try {
    const r = await localGet(`/api/booking/${code}`);
    if (r.error) { console.log(`    ✗ ${code}: ${r.error}`); return null; }
    return r;
  } catch (e) { console.log(`    ✗ ${code}: ${e.message}`); return null; }
}

async function scanCode(code) {
  try {
    const r = await localGet(`/api/scan/${code}`);
    if (r.error) { console.log(`    ✗ SCAN ${code}: ${r.error}`); return null; }
    return r;
  } catch (e) { console.log(`    ✗ SCAN ${code}: ${e.message}`); return null; }
}

// ── STEP 2: Profiles ──

function buildProfile(punter, scanResults, todayData) {
  const allPicks = [];
  let totalWon = 0, totalLost = 0, totalVoid = 0;
  const codeRates = [];
  const marketWins = {}, marketLosses = {};
  let bestCode = { code: "", rate: 0 }, worstCode = { code: "", rate: 100 };

  for (const scan of scanResults) {
    if (!scan) continue;
    const won = scan.results.filter(r => r.verdict === "WON").length;
    const lost = scan.results.filter(r => r.verdict === "LOST").length;
    const voided = scan.results.filter(r => r.verdict === "VOID").length;
    totalWon += won; totalLost += lost; totalVoid += voided;
    const settled = won + lost;
    const rate = settled > 0 ? Math.round(won / settled * 100) : 0;
    codeRates.push(rate);
    if (rate > bestCode.rate) bestCode = { code: scan.shareCode || "", rate };
    if (rate < worstCode.rate) worstCode = { code: scan.shareCode || "", rate };

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

  const markets = new Set([...Object.keys(marketWins), ...Object.keys(marketLosses)]);
  const strongMarkets = [], weakMarkets = [], killerMarkets = [];
  for (const m of markets) {
    const w = marketWins[m] || 0, l = marketLosses[m] || 0;
    const rate = w + l > 0 ? w / (w + l) : 0;
    if (rate > 0.7 && w >= 2) strongMarkets.push(m);
    if (rate < 0.4 && l >= 2) { weakMarkets.push(m); killerMarkets.push(m); }
  }

  // Consistency: variance of code rates
  const avgRate = codeRates.length > 0 ? codeRates.reduce((a, r) => a + r, 0) / codeRates.length : 0;
  const variance = codeRates.length > 1 ? Math.round(Math.sqrt(codeRates.reduce((a, r) => a + Math.pow(r - avgRate, 2), 0) / codeRates.length)) : 0;

  let trustScore = hitRate;
  if (codeRates.length >= 3 && variance < 15) trustScore += 10;
  if (killerMarkets.some(k => k.toLowerCase().includes("correct score"))) trustScore -= 15;
  if (killerMarkets.some(k => k.toLowerCase().includes("both halves"))) trustScore -= 10;
  if (avgOdds > 0 && avgOdds < 1.60) trustScore += 5;
  if (codeRates.some(r => r >= 80)) trustScore += 10;
  if (codeRates.some(r => r < 40)) trustScore -= 10;
  trustScore = Math.max(0, Math.min(100, trustScore));

  return {
    name: punter.name, handle: punter.handle, tier: punter.tier,
    totalGames: allPicks.length, won: totalWon, lost: totalLost, void: totalVoid,
    hitRate, trustScore, strongMarkets: strongMarkets.slice(0, 5), weakMarkets: weakMarkets.slice(0, 5),
    killerMarkets: killerMarkets.slice(0, 5), avgOddsPerGame: avgOdds,
    bestCode: bestCode.code, worstCode: worstCode.code,
    consistency: 100 - variance
  };
}

// ── STEP 4: H2H ──

const h2hCache = new Map();

async function getH2H(homeTeam, awayTeam) {
  const key = `${homeTeam}|${awayTeam}`.toLowerCase();
  if (h2hCache.has(key)) return h2hCache.get(key);

  try {
    const homeSearch = await apiFootball(`/teams?search=${encodeURIComponent(homeTeam)}`);
    const awaySearch = await apiFootball(`/teams?search=${encodeURIComponent(awayTeam)}`);
    const homeId = homeSearch?.response?.[0]?.team?.id;
    const awayId = awaySearch?.response?.[0]?.team?.id;

    if (!homeId || !awayId) {
      const r = { found: false }; h2hCache.set(key, r); return r;
    }

    await sleep(300);
    const [h2hRes, hfRes, afRes] = await Promise.all([
      apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
      apiFootball(`/fixtures?team=${homeId}&last=5&status=FT`),
      apiFootball(`/fixtures?team=${awayId}&last=5&status=FT`),
    ]);

    const matches = (h2hRes?.response || []).filter(f => f.fixture?.status?.short === "FT");
    const total = matches.length || 1;
    const goals = matches.map(f => (f.goals?.home || 0) + (f.goals?.away || 0));
    const avgGoals = matches.length > 0 ? Math.round(goals.reduce((a, g) => a + g, 0) / total * 10) / 10 : null;
    const bttsRate = matches.length > 0 ? Math.round(matches.filter(f => (f.goals?.home || 0) > 0 && (f.goals?.away || 0) > 0).length / total * 100) : null;
    const over25Rate = matches.length > 0 ? Math.round(goals.filter(g => g > 2.5).length / total * 100) : null;
    const over15Rate = matches.length > 0 ? Math.round(goals.filter(g => g > 1.5).length / total * 100) : null;
    const homeWinRate = matches.length > 0 ? Math.round(matches.filter(f => (f.goals?.home || 0) > (f.goals?.away || 0)).length / total * 100) : null;

    const formOf = (fixtures, teamId) => (fixtures?.response || []).filter(f => f.fixture?.status?.short === "FT").slice(0, 5).map(f => {
      const isH = f.teams?.home?.id === teamId;
      const gf = isH ? f.goals?.home : f.goals?.away;
      const ga = isH ? f.goals?.away : f.goals?.home;
      return gf > ga ? "W" : gf < ga ? "L" : "D";
    }).join("");

    const result = { found: true, avgGoals, bttsRate, over25Rate, over15Rate, homeWinRate, homeForm: formOf(hfRes, homeId), awayForm: formOf(afRes, awayId), matchCount: matches.length };
    h2hCache.set(key, result);
    return result;
  } catch {
    const r = { found: false }; h2hCache.set(key, r); return r;
  }
}

function calcSafety(pick, h2h, consensus, strongConsensus, punterTrust, killerMkts) {
  let score = 50;
  const out = (pick.outcome || "").toLowerCase();
  const mkt = (pick.market || "").toLowerCase();
  const odds = pick.odds || 1;

  if (h2h.found && h2h.avgGoals !== null) {
    if (out.includes("over 0.5")) score += 25;
    if (out.includes("over 1.5") && h2h.over15Rate > 70) score += 25;
    if (out.includes("over 1.5") && h2h.over15Rate !== null && h2h.over15Rate < 50) score -= 15;
    if (out.includes("over 2.5") && h2h.over25Rate > 60) score += 20;
    if (out.includes("over 2.5") && h2h.avgGoals < 2.0) score -= 25;
    if (out.match(/over [3-9]/) && h2h.avgGoals < 3.0) score -= 30;
    if (out.includes("yes") && mkt.includes("gg") && h2h.bttsRate > 65) score += 20;
    if (out.includes("yes") && mkt.includes("gg") && h2h.bttsRate !== null && h2h.bttsRate < 40) score -= 25;
    if (out.includes("no") && mkt.includes("gg") && h2h.bttsRate !== null && h2h.bttsRate < 35) score += 20;
    if (out === "home" && mkt === "1x2" && h2h.homeWinRate > 70) score += 25;
    if (out === "home" && mkt === "1x2" && h2h.homeWinRate !== null && h2h.homeWinRate < 30) score -= 25;
    if (out === "away" && mkt === "1x2" && h2h.homeWinRate !== null && h2h.homeWinRate < 30) score += 20;
    if (mkt.includes("double chance") && out.includes("home") && h2h.homeWinRate > 40) score += 15;
    if (mkt.includes("draw no bet") && out.includes("home") && h2h.homeWinRate > 55) score += 20;
    if (mkt.includes("goal bounds") && h2h.avgGoals > 2.5) score += 15;
  } else {
    if (odds < 1.25) score = 75;
    else if (odds < 1.40) score = 60;
    else if (odds < 1.60) score = 45;
    else if (odds < 1.80) score = 35;
    else score = 20;
  }

  if (strongConsensus) score += 25;
  else if (consensus) score += 15;
  if (punterTrust >= 75) score += 10;
  if (punterTrust < 50) score -= 5;
  if (killerMkts.some(k => mkt.includes(k.toLowerCase()))) score -= 20;

  return Math.max(0, Math.min(100, score));
}

// ── STEP 5: Conversions ──

async function convertPick(pick, h2h) {
  const out = (pick.outcome || "").toLowerCase();
  const mkt = (pick.market || "").toLowerCase();
  let targets = null, reason = "";

  const overMatch = out.match(/^over (\d+\.?\d*)$/);
  if (overMatch) {
    const v = parseFloat(overMatch[1]);
    if (v >= 4.5 || v >= 3.0) {
      targets = [
        { markets: ["Double Chance & Over/Under 2.5", "Double Chance"], outcomes: ["Home/Draw & Over 2.5", "Draw/Away & Over 2.5", "Home or Draw", "Draw or Away"] },
        { markets: ["Over/Under"], outcomes: ["Over 2.5"] },
      ];
      reason = `Over ${v} → safer goal-line / double chance`;
    } else if (v >= 2.5 && h2h.found && h2h.avgGoals !== null && h2h.avgGoals < 2.0) {
      targets = [{ markets: ["Over/Under"], outcomes: ["Over 1.5"] }];
      reason = `Over 2.5 → Over 1.5 (avg ${h2h.avgGoals}g)`;
    }
  }
  if (!targets && mkt.includes("gg") && out === "yes" && h2h.found && h2h.bttsRate !== null && h2h.bttsRate < 40) {
    targets = [{ markets: ["Over/Under"], outcomes: ["Over 1.5"] }];
    reason = `BTTS Yes → Over 1.5 (btts ${h2h.bttsRate}%)`;
  }
  if (!targets && mkt.includes("gg") && out === "yes" && h2h.found && h2h.bttsRate !== null && h2h.bttsRate >= 40) {
    targets = [
      { markets: ["Double Chance & Over/Under 2.5", "Double Chance"], outcomes: ["Home/Draw & Over 2.5", "Draw/Away & Over 2.5", "Home or Draw", "Draw or Away"] },
      { markets: ["Over/Under"], outcomes: ["Over 2.5"] },
    ];
    reason = `BTTS Yes → draw or over 2.5 option (btts ${h2h.bttsRate}%)`;
  }
  if (!targets && mkt.includes("gg") && out === "no" && h2h.found && h2h.bttsRate !== null && h2h.bttsRate > 60) {
    return { ...pick, _removed: true, _reason: `BTTS No removed (btts ${h2h.bttsRate}%)` };
  }
  if (!targets && mkt === "1x2" && out === "home" && h2h.found && h2h.homeWinRate !== null && h2h.homeWinRate < 25) {
    targets = [
      { markets: ["Double Chance & Over/Under 2.5", "Double Chance"], outcomes: ["Home/Draw & Over 2.5", "Home or Draw"] },
    ];
    reason = `Home → DC 1X (hw ${h2h.homeWinRate}%)`;
  }
  if (!targets && mkt === "1x2" && out === "away" && h2h.found && h2h.homeWinRate !== null && h2h.homeWinRate > 75) {
    targets = [
      { markets: ["Double Chance & Over/Under 2.5", "Double Chance"], outcomes: ["Draw/Away & Over 2.5", "Draw or Away"] },
    ];
    reason = `Away → DC X2 (hw ${h2h.homeWinRate}%)`;
  }
  if (!targets && mkt.includes("correct score")) {
    targets = [{ markets: ["Over/Under"], outcomes: ["Over 1.5"] }];
    reason = "Correct Score → Over 1.5";
  }
  if (!targets && mkt.includes("both halves") && mkt.includes("under") && out === "no") {
    targets = [{ markets: ["Over/Under"], outcomes: ["Over 2.5"] }];
    reason = "Both Halves U1.5 No → Over 2.5";
  }
  if (mkt.includes("handicap")) {
    const hcp = parseFloat((pick.specifier || "").match(/hcp=([-\d.]+)/)?.[1] || 0);
    if (hcp <= -2.0) return { ...pick, _removed: true, _reason: `AH ${hcp} removed` };
  }

  if (!targets) return pick;

  const resolved = await resolveTarget(pick, targets, reason);
  if (resolved) return resolved;
  return pick;
}

// ── STEP 6: Code Generation ──

function gamesNeededForOdds(targetOdds, avgOddsPerGame) {
  return Math.ceil(Math.log(targetOdds) / Math.log(avgOddsPerGame || 1.4));
}

async function generateCode(selections) {
  if (!selections.length) return null;
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

function pickTopN(arr, n) {
  return [...arr].sort((a, b) => b.safetyScore - a.safetyScore).slice(0, Math.min(n, arr.length));
}

function getLagosHour(dateLike) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(dateLike));
    const hourPart = parts.find(p => p.type === "hour");
    return hourPart ? parseInt(hourPart.value, 10) : null;
  } catch {
    return null;
  }
}

function isSafeKickoff(kickoff) {
  if (!kickoff) return false;
  const when = new Date(kickoff);
  if (Number.isNaN(when.getTime())) return false;
  if (when.getTime() <= Date.now() + 20 * 60 * 1000) return false;
  const hour = getLagosHour(when);
  return hour !== null && hour >= 14 && hour <= 23;
}

async function resolveTarget(pick, targets, reason) {
  try {
    const mkts = await localGet(`/api/markets/${encodeURIComponent(pick.eventId)}`);
    if (mkts.markets) {
      for (const target of targets) {
        const found = mkts.markets.find(m => {
          const marketName = (m.marketName || "").toLowerCase();
          const outcomeName = m.outcomeName || "";
          return target.markets.some(name => marketName.includes(name.toLowerCase())) && target.outcomes.includes(outcomeName);
        });
        if (found) {
          return {
            ...pick,
            market: found.marketName,
            outcome: found.outcomeName,
            odds: found.odds,
            marketId: found.marketId,
            outcomeId: found.outcomeId,
            specifier: found.specifier || "",
            _converted: true,
            _reason: reason,
          };
        }
      }
    }
  } catch {}
  return null;
}

// ── MAIN ──

async function main() {
  const startTime = Date.now();
  console.log("\n══════════════════════════════════════════════════");
  console.log("SLIPPILOT — FULL PUNTER NETWORK ANALYSIS");
  console.log("══════════════════════════════════════════════════\n");

  // STEP 1
  console.log("STEP 1: Fetching all codes from all punters...\n");
  const punterData = {};

  for (const p of PUNTERS) {
    console.log(`  ▸ ${p.name} (${p.handle})`);
    punterData[p.name] = { today: [], history: [] };

    for (const code of p.today) {
      process.stdout.write(`    Today ${code}... `);
      const r = await fetchCode(code);
      if (r) { punterData[p.name].today.push(r); console.log(`${r.selections?.length || 0} games`); }
      else console.log("failed");
      await sleep(400);
    }

    for (const code of p.history) {
      process.stdout.write(`    Scan ${code}... `);
      const r = await scanCode(code);
      if (r) { punterData[p.name].history.push(r); console.log(`${r.results?.length || 0} games (${r.hitRate}% hit)`); }
      else console.log("failed");
      await sleep(400);
    }
  }

  // STEP 2
  console.log("\n\nSTEP 2: Building punter profiles...\n");
  const profiles = {};
  for (const p of PUNTERS) {
    profiles[p.name] = buildProfile(p, punterData[p.name].history, punterData[p.name].today);
    const pr = profiles[p.name];
    console.log(`  ${pr.name}: Hit ${pr.hitRate}% | Trust ${pr.trustScore}/100 | ${pr.totalGames} games | Consistency ${pr.consistency}%`);
  }

  // STEP 3
  console.log("\n\nSTEP 3: Building master pool...\n");
  const masterPool = new Map();

  for (const p of PUNTERS) {
    for (const data of punterData[p.name].today) {
      if (!data?.selections) continue;
      for (const sel of data.selections) {
        if (!masterPool.has(sel.eventId)) {
          masterPool.set(sel.eventId, { ...sel, picks: [], punters: [] });
        }
        const game = masterPool.get(sel.eventId);
        game.picks.push({ ...sel, punterName: p.name, punterTrust: profiles[p.name].trustScore, punterTier: p.tier });
        if (!game.punters.includes(p.name)) game.punters.push(p.name);
      }
    }
  }

  const pool = [...masterPool.values()];
  let strongConsensusCount = 0, consensusCount = 0;

  for (const game of pool) {
    const primaryPicks = game.picks.filter(p => p.punterTier === "primary");
    if (primaryPicks.length >= 3) { game.flag = "strong"; strongConsensusCount++; }
    else if (game.picks.length >= 2) { game.flag = "consensus"; consensusCount++; }
    else game.flag = "solo";
    // Best pick = highest trust punter's pick
    game.bestPick = game.picks.sort((a, b) => b.punterTrust - a.punterTrust)[0];
  }

  console.log(`  Total unique games: ${pool.length}`);
  console.log(`  🔥 Strong consensus (3+ primary): ${strongConsensusCount}`);
  console.log(`  ✓ Consensus (2+): ${consensusCount}`);
  console.log(`  Solo: ${pool.length - strongConsensusCount - consensusCount}`);

  // STEP 4
  console.log("\n\nSTEP 4: H2H analysis (API-Football)...\n");
  for (let i = 0; i < pool.length; i += 5) {
    const batch = pool.slice(i, i + 5);
    const batchNum = Math.floor(i / 5) + 1;
    process.stdout.write(`  Batch ${batchNum} (${i + 1}-${Math.min(i + 5, pool.length)} of ${pool.length})...`);

    await Promise.all(batch.map(async game => {
      game.h2h = await getH2H(game.homeTeam, game.awayTeam);
      const killers = profiles[game.bestPick.punterName]?.killerMarkets || [];
      game.safetyScore = calcSafety(game.bestPick, game.h2h, game.flag === "consensus" || game.flag === "strong", game.flag === "strong", game.bestPick.punterTrust, killers);
    }));

    console.log(` done`);
    if (i + 5 < pool.length) await sleep(1500);
  }

  // STEP 5
  console.log("\n\nSTEP 5: Smart conversions...\n");
  let convCount = 0, rmCount = 0;

  for (const game of pool) {
    const conv = await convertPick(game.bestPick, game.h2h || { found: false });
    if (conv._removed) { game._removed = true; rmCount++; if (conv._reason) console.log(`  ✗ ${game.homeTeam} vs ${game.awayTeam}: ${conv._reason}`); }
    else if (conv._converted) { game.bestPick = conv; game.converted = true; convCount++; console.log(`  ↳ ${game.homeTeam} vs ${game.awayTeam}: ${conv._reason}`); }
    if (!conv._removed && !isSafeKickoff(conv.kickoff)) {
      game._removed = true;
      rmCount++;
      console.log(`  ✗ ${game.homeTeam} vs ${game.awayTeam}: kickoff outside 2pm-11pm Lagos or too close/live`);
    }
    if (!conv._removed && (conv.odds || 0) > 2) {
      game._removed = true;
      rmCount++;
      console.log(`  ✗ ${game.homeTeam} vs ${game.awayTeam}: odds ${conv.odds} above 2.0 cap`);
    }
    game.finalPick = conv._removed ? null : conv;
  }

  const activePool = pool.filter(g => !g._removed && g.finalPick && isSafeKickoff(g.finalPick.kickoff) && (g.finalPick.odds || 0) <= 2);
  console.log(`\n  Converted: ${convCount} | Removed: ${rmCount} | Active: ${activePool.length}`);

  // STEP 6
  console.log("\n\nSTEP 6: Generating 60 booking codes...\n");

  const safePool = activePool.filter(g => g.safetyScore >= 65).sort((a, b) => b.safetyScore - a.safetyScore);
  const balPool = activePool.filter(g => g.safetyScore >= 50).sort((a, b) => b.safetyScore - a.safetyScore);
  const valPool = activePool.filter(g => g.safetyScore >= 35).sort((a, b) => b.safetyScore - a.safetyScore);
  const conPool = activePool.filter(g => g.flag === "consensus" || g.flag === "strong").filter(g => g.safetyScore >= 60).sort((a, b) => b.safetyScore - a.safetyScore);
  const strongPool = activePool.filter(g => g.flag === "strong").sort((a, b) => b.safetyScore - a.safetyScore);

  const avgSafeOdds = safePool.length > 0 ? safePool.reduce((a, g) => a + g.finalPick.odds, 0) / safePool.length : 1.4;
  console.log(`  Avg safe odds: ${avgSafeOdds.toFixed(2)} | Games needed for 1000x: ${gamesNeededForOdds(1000, avgSafeOdds)}`);

  const allCodes = { A: [], B: [], C: [], D: [], E: [], F: [], G: [], H: [] };
  let totalGen = 0, totalFail = 0;

  async function genGroup(key, label, pool, count, minGames, maxGames, targetDesc) {
    console.log(`\n  ${label} (${count} codes, ${minGames}-${maxGames} games)...`);
    for (let i = 0; i < count; i++) {
      const n = minGames + Math.floor(Math.random() * (maxGames - minGames + 1));
      const sels = pickRandom(pool, Math.min(n, pool.length));
      const code = await generateCode(sels.map(g => g.finalPick));
      const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
      allCodes[key].push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPicks: sels.slice(0, 3).map(g => `${g.homeTeam} vs ${g.awayTeam} (${g.safetyScore})`) });
      if (code) totalGen++; else totalFail++;
      process.stdout.write(`    ${i + 1}/${count} ${code || "FAIL"} (${sels.length}g, ${odds >= 1000000 ? (odds / 1000000).toFixed(1) + "M" : odds >= 1000 ? (odds / 1000).toFixed(1) + "K" : odds.toFixed(0)}x)\n`);
      await sleep(250);
    }
  }

  // Group A: Safe 1K+ (24-30 games to hit 1000x with ~1.35 avg)
  await genGroup("A", "Group A — Safe 1K+", safePool, 10, 22, 30, "1,000x-10,000x");
  // Group B: Balanced 10K+
  await genGroup("B", "Group B — Balanced 10K+", balPool, 10, 28, 38, "10,000x-100,000x");
  // Group C: Value 100K+
  await genGroup("C", "Group C — Value 100K+", valPool, 10, 35, 45, "100,000x-1,000,000x");
  // Group D: Consensus 1K+
  await genGroup("D", "Group D — Consensus Bankers", conPool.length >= 10 ? conPool : safePool, 5, 20, 28, "1,000x-50,000x");
  // Group E: Moonshot 1M+
  await genGroup("E", "Group E — Moonshot 1M+", activePool, 5, 45, 60, "1,000,000x+");
  // Group F: Permutation
  console.log("\n  Group F — Permutation Mix (10 codes)...");
  const bankers = strongPool.slice(0, 5);
  for (let i = 0; i < 10; i++) {
    const fill = pickRandom(activePool.filter(g => !bankers.includes(g)), 20 + Math.floor(Math.random() * 10));
    const sels = [...bankers, ...fill];
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.F.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPicks: bankers.slice(0, 3).map(g => `${g.homeTeam} vs ${g.awayTeam} (${g.safetyScore})`) });
    if (code) totalGen++; else totalFail++;
    process.stdout.write(`    ${i + 1}/10 ${code || "FAIL"} (${sels.length}g, ${odds >= 1000000 ? (odds / 1000000).toFixed(1) + "M" : odds >= 1000 ? (odds / 1000).toFixed(1) + "K" : odds.toFixed(0)}x)\n`);
    await sleep(250);
  }

  // Group G: Pure Merge (best 5 from each primary punter)
  console.log("\n  Group G — Pure Merge (5 codes)...");
  const primaryNames = PUNTERS.filter(p => p.tier === "primary").map(p => p.name);
  for (let i = 0; i < 5; i++) {
    let sels = [];
    for (const name of primaryNames) {
      const punterGames = activePool.filter(g => g.picks.some(p => p.punterName === name));
      sels.push(...pickTopN(punterGames, 5));
    }
    // Dedupe by eventId
    const seen = new Set(); sels = sels.filter(g => { if (seen.has(g.eventId)) return false; seen.add(g.eventId); return true; });
    // Add consensus on top
    const extra = pickRandom(conPool.filter(g => !seen.has(g.eventId)), 5 + Math.floor(Math.random() * 6));
    sels.push(...extra);
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.G.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPicks: [] });
    if (code) totalGen++; else totalFail++;
    process.stdout.write(`    ${i + 1}/5 ${code || "FAIL"} (${sels.length}g, ${odds >= 1000000 ? (odds / 1000000).toFixed(1) + "M" : odds >= 1000 ? (odds / 1000).toFixed(1) + "K" : odds.toFixed(0)}x)\n`);
    await sleep(250);
  }

  // Group H: 2-Punter Merge
  console.log("\n  Group H — 2-Punter Merge (5 codes)...");
  const pairs = [["39 Billion", "Big Strategic"], ["9Z", "Ayo Jordan"], ["39 Billion", "9Z"], ["Big Strategic", "Bayo Bets"], ["Ayo Jordan", "Big Strategic"]];
  for (let i = 0; i < 5; i++) {
    const [a, b] = pairs[i] || pairs[0];
    const aGames = activePool.filter(g => g.picks.some(p => p.punterName === a));
    const bGames = activePool.filter(g => g.picks.some(p => p.punterName === b));
    let sels = [...pickTopN(aGames, 10), ...pickTopN(bGames, 10)];
    const seen = new Set(); sels = sels.filter(g => { if (seen.has(g.eventId)) return false; seen.add(g.eventId); return true; });
    const code = await generateCode(sels.map(g => g.finalPick));
    const odds = sels.reduce((a, g) => a * (g.finalPick.odds || 1), 1);
    allCodes.H.push({ code, games: sels.length, odds: Math.round(odds * 100) / 100, topPicks: [`${a} + ${b}`] });
    if (code) totalGen++; else totalFail++;
    process.stdout.write(`    ${i + 1}/5 ${code || "FAIL"} (${sels.length}g, ${a}+${b}, ${odds >= 1000 ? (odds / 1000).toFixed(1) + "K" : odds.toFixed(0)}x)\n`);
    await sleep(250);
  }

  // STEP 7: Output
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const output = buildOutput(profiles, pool, activePool, allCodes, totalGen, totalFail, convCount, strongConsensusCount, consensusCount, elapsed);
  console.log("\n\n" + output);

  fs.writeFileSync(path.join(DATA_DIR, "codes-today.txt"), output);
  fs.writeFileSync(path.join(DATA_DIR, "punter-profiles.json"), JSON.stringify(profiles, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "generated-codes.json"), JSON.stringify(allCodes, null, 2));
  console.log(`\nFiles saved to data/`);
}

function buildOutput(profiles, pool, activePool, allCodes, totalGen, totalFail, convCount, strongCon, normCon, elapsed) {
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  let o = "";
  o += "══════════════════════════════════════════════════\n";
  o += "SLIPPILOT — FULL NETWORK ANALYSIS\n";
  o += `${date} | 8 Punters | ${activePool.length}+ Games | ${totalGen} Codes\n`;
  o += `Minimum odds: 1,000x | Top flex: 100,000,000x\n`;
  o += `Analysis time: ${elapsed}s\n`;
  o += "══════════════════════════════════════════════════\n\n";

  o += "PUNTER TRUST RANKINGS\n──────────────────────\n";
  const ranked = Object.values(profiles).sort((a, b) => b.trustScore - a.trustScore);
  ranked.forEach((p, i) => {
    o += `${i + 1}. ${p.name} [${p.handle}] — Hit: ${p.hitRate}% | Trust: ${p.trustScore}/100\n`;
    o += `   Strong: [${p.strongMarkets.slice(0, 3).join(", ") || "N/A"}] | Killer: [${p.killerMarkets.slice(0, 3).join(", ") || "None"}]\n`;
    o += `   Best: ${p.bestCode || "-"} | Consistency: ${p.consistency}% | Avg odds: ${p.avgOddsPerGame}\n\n`;
  });

  o += "\n══════════════════════════════════════════════════\n";
  o += "🔥 STRONG CONSENSUS (3+ primary punters agree)\n──────────────────────────────────────────────────\n";
  pool.filter(g => g.flag === "strong").forEach(g => {
    o += `${g.homeTeam} vs ${g.awayTeam} — ${g.bestPick?.outcome} — ${g.punters.length} punters\n`;
    o += `  Score: ${g.safetyScore} | H2H: avg ${g.h2h?.avgGoals ?? "N/A"}g | BTTS: ${g.h2h?.bttsRate ?? "N/A"}% | O2.5: ${g.h2h?.over25Rate ?? "N/A"}%\n`;
  });

  o += "\n✓ CONSENSUS (2+ punters agree)\n──────────────────────────────\n";
  pool.filter(g => g.flag === "consensus").slice(0, 15).forEach(g => {
    o += `${g.homeTeam} vs ${g.awayTeam} — ${g.bestPick?.outcome} — Score: ${g.safetyScore}\n`;
  });

  const dangers = activePool.filter(g => g.safetyScore < 30);
  o += `\n⚠ AVOID THESE (Score below 30)\n─────────────────────────────────────────────\n`;
  if (dangers.length === 0) o += "None — all picks above danger threshold\n";
  dangers.slice(0, 10).forEach(g => { o += `${g.homeTeam} vs ${g.awayTeam} — ${g.bestPick?.outcome} — Score: ${g.safetyScore}\n`; });

  const groups = [
    { key: "A", title: "GROUP A — SAFE 1K+", sub: "Stake ₦50 each" },
    { key: "B", title: "GROUP B — BALANCED 10K+", sub: "Stake ₦20 each" },
    { key: "C", title: "GROUP C — VALUE 100K+", sub: "Stake ₦10 each" },
    { key: "D", title: "GROUP D — CONSENSUS BANKERS", sub: "Stake ₦50 each ⭐ BEST BET" },
    { key: "E", title: "GROUP E — MOONSHOT 1M+", sub: "Stake ₦10 each" },
    { key: "F", title: "GROUP F — PERMUTATION", sub: "Stake ₦10-20 each" },
    { key: "G", title: "GROUP G — PURE MERGE", sub: "Stake ₦20 each" },
    { key: "H", title: "GROUP H — 2-PUNTER MERGE", sub: "Stake ₦20 each" },
  ];

  for (const gi of groups) {
    o += `\n\n══════════════════════════════════════════════════\n${gi.title} | ${gi.sub}\n────────────────────────────────────────────────\n`;
    allCodes[gi.key].forEach((c, i) => {
      const oddsStr = c.odds >= 1000000 ? (c.odds / 1000000).toFixed(1) + "M" : c.odds >= 1000 ? Math.round(c.odds / 1000) + "K" : c.odds.toFixed(0);
      o += `${i + 1}. ${c.code || "FAILED"} — ${c.games} games — ${oddsStr}x odds\n`;
      if (c.topPicks?.length && c.topPicks[0]) o += `   Top: ${c.topPicks[0]}\n`;
    });
  }

  const totalStake = (10 * 50) + (10 * 20) + (10 * 10) + (5 * 50) + (5 * 10) + (10 * 15) + (5 * 20) + (5 * 20);
  o += "\n\n══════════════════════════════════════════════════\n";
  o += `TOTAL CODES: ${totalGen}/${totalGen + totalFail} generated\n`;
  o += `TOTAL STAKE ALL CODES: ₦${totalStake}\n`;
  o += `STRONG CONSENSUS PICKS: ${strongCon} games\n`;
  o += `CONVERSIONS APPLIED: ${convCount} picks changed\n\n`;
  o += "TOP RECOMMENDATION:\n";
  o += "Play Group D first — highest confidence.\n";
  o += "Flex Group E with ₦10 — one might boom.\n";
  o += "══════════════════════════════════════════════════\n";

  return o;
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
