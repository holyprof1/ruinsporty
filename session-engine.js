// session-engine.js — SlipPilot Daily Session Intelligence Engine
// Called by server endpoint or CLI. All data from real API calls only.

const http = require("http");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "data");
const SESSION_FILE = path.join(DATA, "session-today.json");
const HISTORY_FILE = path.join(DATA, "session-history.json");
const LEADER_FILE = path.join(DATA, "leaderboard.json");
const CODES_TXT = path.join(DATA, "codes-today.txt");
const GENERATED_FILE = path.join(DATA, "generated-today.json");

// ── HTTP to local server ──
function get(p) {
  return new Promise((ok, fail) => {
    http.get("http://localhost:3000" + p, { headers: { "x-admin-key": process.env.ADMIN_PASSWORD || "" } }, r => {
      let d = ""; r.on("data", c => d += c);
      r.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json: " + p)); } });
    }).on("error", fail);
  });
}
function post(p, body) {
  return new Promise((ok, fail) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "localhost", port: 3000, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, r => {
      let d = ""; r.on("data", c => d += c);
      r.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json POST " + p)); } });
    });
    req.on("error", fail); req.write(payload); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── File helpers ──
function readJSON(f, fallback) { try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch { return fallback; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

// ══════════════════════════════════════════════════════════════
//  MARKET OPTIMIZER — the core differentiator
// ══════════════════════════════════════════════════════════════

const MARKET_RISK = {
  "Double Chance": 1,
  "Draw No Bet": 2,
  "2nd Half - Double Chance": 2,
  "Home Team to Win Either Half": 2,
  "Home Team or Over 2.5": 3,
  "2nd Half - Multigoals": 2,
  "Any Team To Score 3 or More Goals in a Row": 2,
};

function marketRiskLevel(name, outcome) {
  if (MARKET_RISK[name] != null) return MARKET_RISK[name];
  const m = (name || "").toLowerCase();
  const o = (outcome || "").toLowerCase();
  if (m.includes("double chance")) return 1;
  if (m.includes("draw no bet")) return 2;
  if (m.includes("over/under")) {
    if (o.includes("over 0.5")) return 1;
    if (o.includes("over 1.5")) return 2;
    if (o.includes("over 2.5")) return 4;
    if (o.includes("over 3")) return 6;
    if (o.includes("over 3.5")) return 8;
    if (o.includes("under 3.5")) return 2;
    if (o.includes("under 2.5")) return 3;
    return 4;
  }
  if (m.includes("gg/ng") || m.includes("btts")) return o.includes("no") ? 3 : 5;
  if (m === "1x2" || m.includes("1x2")) return 6;
  if (m.includes("handicap")) return 7;
  if (m.includes("correct score")) return 9;
  if (m.includes("both halves over")) return o.includes("no") ? 2 : 7;
  if (m.includes("both halves under")) return o.includes("no") ? 3 : 6;
  return 5;
}

// Score a single market outcome: lower = safer
function scoreMarketOption(mkt) {
  const risk = marketRiskLevel(mkt.marketName, mkt.outcomeName);
  const impliedWin = 1 / mkt.odds;
  // Combined: high implied probability + low risk = best
  // Range roughly 0-100 where higher = better
  return Math.round(impliedWin * 70 + (10 - risk) * 3);
}

// Hard conversion rules: given a punter's raw pick, find the optimal market
function optimizeSelection(rawPick, allMarkets) {
  if (!allMarkets || allMarkets.length === 0) return { optimized: rawPick, changed: false, reason: "no markets available" };

  const rm = (rawPick.market || "").toLowerCase();
  const ro = (rawPick.outcome || "").toLowerCase();
  let candidates = [];

  // RULE: 1X2 → Double Chance or Draw No Bet
  if (rm === "1x2" || (rm.includes("1x2") && !rm.includes("&"))) {
    if (ro.includes("home")) {
      candidates = allMarkets.filter(m =>
        (m.marketName === "Double Chance" && m.outcomeName === "Home or Draw") ||
        (m.marketName === "Draw No Bet" && m.outcomeName === "Home") ||
        (m.marketName === "Home Team to Win Either Half" && m.outcomeName === "Yes")
      );
    } else if (ro.includes("away")) {
      candidates = allMarkets.filter(m =>
        (m.marketName === "Double Chance" && m.outcomeName === "Draw or Away") ||
        (m.marketName === "Draw No Bet" && m.outcomeName === "Away")
      );
    }
    if (candidates.length) {
      candidates.sort((a, b) => scoreMarketOption(b) - scoreMarketOption(a));
      const best = candidates[0];
      return { optimized: best, changed: true, reason: `1X2 ${rawPick.outcome} → ${best.marketName}: ${best.outcomeName} @${best.odds}` };
    }
  }

  // RULE: BTTS Yes → Over 2.0 or Over 2.5
  if ((rm.includes("gg/ng") || rm.includes("btts")) && ro.includes("yes")) {
    candidates = allMarkets.filter(m =>
      m.marketName === "Over/Under" && (m.outcomeName === "Over 2.5" || m.outcomeName === "Over 2")
    );
    if (candidates.length) {
      candidates.sort((a, b) => scoreMarketOption(b) - scoreMarketOption(a));
      const best = candidates[0];
      return { optimized: best, changed: true, reason: `BTTS Yes → ${best.outcomeName} @${best.odds}` };
    }
  }

  // RULE: Over 3.5 → Over 2.5
  if (rm.includes("over/under") && ro.includes("over 3.5")) {
    const alt = allMarkets.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 2.5" && m.specifier.includes("total=2.5"));
    if (alt) return { optimized: alt, changed: true, reason: `Over 3.5 → Over 2.5 @${alt.odds}` };
  }

  // RULE: Over 3 → Over 2.5 (removes push risk)
  if (rm.includes("over/under") && /over 3($|\s)/.test(ro) && !ro.includes("3.5")) {
    const alt = allMarkets.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 2.5" && m.specifier.includes("total=2.5"));
    if (alt) return { optimized: alt, changed: true, reason: `Over 3.0 → Over 2.5 @${alt.odds}` };
  }

  // RULE: Both Halves Over 1.5 → Over 2.5
  if (rm.includes("both halves over") && ro.includes("yes")) {
    const alt = allMarkets.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 2.5" && m.specifier.includes("total=2.5"));
    if (alt) return { optimized: alt, changed: true, reason: `Both Halves Over 1.5 → Over 2.5 @${alt.odds}` };
  }

  // RULE: Correct Score → Over 1.5
  if (rm.includes("correct score")) {
    const alt = allMarkets.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 1.5" && m.specifier.includes("total=1.5"));
    if (alt) return { optimized: alt, changed: true, reason: `Correct Score → Over 1.5 @${alt.odds}` };
  }

  // RULE: Handicap → Double Chance
  if (rm.includes("handicap") && !rm.includes("asian")) {
    if (ro.includes("home")) {
      const alt = allMarkets.find(m => m.marketName === "Double Chance" && m.outcomeName === "Home or Draw");
      if (alt) return { optimized: alt, changed: true, reason: `Handicap Home → DC Home/Draw @${alt.odds}` };
    }
  }

  // No conversion needed — but still pick the safest version of the same market
  const sameMarket = allMarkets.filter(m =>
    m.marketName === rawPick.market && m.outcomeName === rawPick.outcome &&
    (!rawPick.specifier || m.specifier === rawPick.specifier)
  );
  if (sameMarket.length) {
    return { optimized: sameMarket[0], changed: false, reason: "kept original" };
  }

  // Fallback: return raw pick as-is
  return { optimized: rawPick, changed: false, reason: "no conversion available" };
}

// ══════════════════════════════════════════════════════════════
//  SAFETY SCORE
// ══════════════════════════════════════════════════════════════
const LEAGUE_TIER = {
  "World Cup": 8, "Champions League": 7, "Premier League": 5, "La Liga": 6,
  "Bundesliga": 6, "Serie A": 6, "Ligue 1": 5, "Liga ACB": 3, "Superettan": 2,
  "Premier Division": 3, "Besta deild": 1, "Virsliga": 1, "Erovnuli Liga": 1,
  "Copa de la Liga": 1, "Brasileiro Serie C": 1, "Super League": 1,
  "Esiliiga": 0, "Esiliiga B": -1, "Erovnuli Liga 2": -1, "Division 2": -1,
  "3. Division": -2, "II Lyga": -2, "Tercera Division, Reserves": -3,
  "U20 Catarinense": -2, "Svenska Cup": 0, "Latvijas Kauss": 0, "U21": -3,
};
function leagueTier(lg) { for (const [p, s] of Object.entries(LEAGUE_TIER)) if ((lg || "").includes(p)) return s; return 0; }

let PROFILES = {};
try { PROFILES = readJSON(path.join(DATA, "punter-profiles.json"), {}); } catch {}
function punterTrust(n) { return PROFILES[n]?.trustScore || ({ "Top Boy": 70, "King Eric": 65, "Mr Lantern": 68, "39 Billion": 92, "9Z": 93 }[n] || 50); }

function safetyScore(odds, consensusCount, punterNames, league, riskLevel) {
  let s = 0;
  s += (1 / odds) * 55;                              // implied probability
  s += Math.max(0, consensusCount - 1) * 14;         // consensus
  s += (10 - riskLevel) * 2;                          // market safety
  const avgTrust = punterNames.reduce((a, n) => a + punterTrust(n), 0) / punterNames.length;
  s += avgTrust * 0.10;                               // punter trust
  s += leagueTier(league);                            // league
  return Math.max(0, Math.min(100, Math.round(s)));
}

// ══════════════════════════════════════════════════════════════
//  SLIP BUILDER with diversification
// ══════════════════════════════════════════════════════════════
function fisherYates(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

function buildSlips(pool, cfg) {
  const { count, min, max, threshold } = cfg;
  const eligible = pool.filter(s => s.score >= threshold);
  const slips = [];
  const usage = new Map();
  const maxAppearances = Math.ceil(count * 0.20 * (max / 10)); // 20% rule scaled

  for (let i = 0; i < count; i++) {
    const target = min + Math.floor(Math.random() * (max - min + 1));
    const slip = [];
    const used = new Set();

    // Weight: score * inverse-usage * jitter
    const weighted = eligible
      .filter(s => (usage.get(s.eventId) || 0) < maxAppearances)
      .map(s => ({ ...s, _w: s.score * (1 / (1 + (usage.get(s.eventId) || 0) * 1.5)) * (0.6 + Math.random() * 0.8) }))
      .sort((a, b) => b._w - a._w);

    // Seed with rotated consensus anchors
    const anchors = weighted.filter(s => s.consensus >= 3);
    const start = (i * 3) % Math.max(1, anchors.length);
    const rotated = [...anchors.slice(start), ...anchors.slice(0, start)];
    const maxAnchors = Math.ceil(target * 0.45);
    for (const s of rotated) {
      if (slip.length >= maxAnchors || slip.length >= target) break;
      if (used.has(s.eventId)) continue;
      slip.push(s); used.add(s.eventId);
    }

    // Fill with shuffled remainder
    for (const s of fisherYates(weighted.filter(s => !used.has(s.eventId)))) {
      if (slip.length >= target) break;
      slip.push(s); used.add(s.eventId);
    }

    for (const s of slip) usage.set(s.eventId, (usage.get(s.eventId) || 0) + 1);
    const totalOdds = slip.reduce((a, s) => a * s.odds, 1);
    slips.push({
      idx: i + 1, games: slip.length,
      odds: +totalOdds.toFixed(2),
      avgScore: slip.length ? +(slip.reduce((a, s) => a + s.score, 0) / slip.length).toFixed(1) : 0,
      avgConsensus: slip.length ? +(slip.reduce((a, s) => a + s.consensus, 0) / slip.length).toFixed(1) : 0,
      picks: slip,
    });
  }
  return slips;
}

// ══════════════════════════════════════════════════════════════
//  MAIN PIPELINE — exported for server use
// ══════════════════════════════════════════════════════════════
async function run(punterMap, onLog) {
  const log = onLog || console.log;
  const t0 = Date.now();
  const date = new Date().toISOString().slice(0, 10);

  log("══ SESSION ENGINE START — " + date + " ══");

  // ── PHASE 1-2: Load punters + fetch bookings ──
  log("\n▸ Phase 1-2: Loading punter bookings...");
  const punterData = {};  // name → selections[]
  const allRaw = [];
  let fetchErrors = 0;

  for (const [name, codes] of Object.entries(punterMap)) {
    punterData[name] = [];
    const codeList = Array.isArray(codes) ? codes : [codes];
    for (const code of codeList) {
      if (!code) continue;
      try {
        const res = await get("/api/booking/" + code.trim().toUpperCase());
        if (res.error) { log(`  ✗ ${name} [${code}]: ${res.error}`); fetchErrors++; continue; }
        for (const s of res.selections) {
          s.punter = name; s.sourceCode = code;
          punterData[name].push(s);
          allRaw.push(s);
        }
        log(`  ✓ ${name} [${code}]: ${res.selections.length} sels`);
      } catch (e) { log(`  ✗ ${name} [${code}]: ${e.message}`); fetchErrors++; }
      await sleep(120);
    }
  }
  log(`  Raw total: ${allRaw.length} selections from ${Object.keys(punterMap).length} punters (${fetchErrors} errors)`);

  // ── PHASE 5: Filter started + build event map ──
  log("\n▸ Phase 5: Building master pool...");
  const ts = Date.now();
  const eventMap = new Map();

  for (const s of allRaw) {
    if (!s.kickoff || new Date(s.kickoff).getTime() <= ts) continue;
    if ((s.sport || "").toLowerCase() !== "football") continue;
    if (!eventMap.has(s.eventId)) {
      eventMap.set(s.eventId, {
        eventId: s.eventId, homeTeam: s.homeTeam, awayTeam: s.awayTeam,
        league: s.league, category: s.category, kickoff: s.kickoff,
        sportId: s.sportId, rawPicks: [],
      });
    }
    eventMap.get(s.eventId).rawPicks.push({
      punter: s.punter, code: s.sourceCode,
      market: s.market, marketId: s.marketId,
      outcome: s.outcome, outcomeId: s.outcomeId,
      specifier: s.specifier || "", odds: s.odds,
      productId: s.productId, sportId: s.sportId,
    });
  }
  log(`  Future football matches: ${eventMap.size}`);
  const consensusMatches = [...eventMap.values()].filter(e => new Set(e.rawPicks.map(p => p.punter)).size >= 2);
  log(`  Consensus (2+ punters): ${consensusMatches.length}`);
  const strongConsensus = consensusMatches.filter(e => new Set(e.rawPicks.map(p => p.punter)).size >= 3);
  log(`  Strong consensus (3+): ${strongConsensus.length}`);

  // ── PHASE 4: Market optimization for each event ──
  log("\n▸ Phase 4: Market optimization...");
  const pool = [];          // final optimized selections
  const conversions = [];   // log of changes made
  let optimized = 0, kept = 0, marketFetchFails = 0;

  const events = [...eventMap.values()];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const punters = [...new Set(ev.rawPicks.map(p => p.punter))];
    const consensus = punters.length;

    // Find majority pick (most backers, then highest trust)
    const groups = {};
    for (const p of ev.rawPicks) {
      const k = `${p.market}|${p.outcome}|${p.specifier}`;
      if (!groups[k]) groups[k] = { ...p, backers: [], cnt: 0 };
      groups[k].backers.push(p.punter); groups[k].cnt++;
    }
    const majority = Object.values(groups).sort((a, b) =>
      b.cnt - a.cnt || (b.backers.reduce((s, n) => s + punterTrust(n), 0) / b.backers.length) - (a.backers.reduce((s, n) => s + punterTrust(n), 0) / a.backers.length)
    )[0];

    // Fetch all available markets for this event
    let allMarkets = [];
    try {
      const mkts = await get("/api/markets/" + ev.eventId);
      if (mkts.markets) allMarkets = mkts.markets;
    } catch { marketFetchFails++; }

    // Run optimizer
    const result = optimizeSelection(majority, allMarkets);
    const opt = result.optimized;

    if (result.changed) {
      optimized++;
      conversions.push({
        match: ev.homeTeam + " vs " + ev.awayTeam,
        from: majority.market + " → " + majority.outcome + " @" + majority.odds,
        to: (opt.marketName || opt.market) + " → " + (opt.outcomeName || opt.outcome) + " @" + opt.odds,
        reason: result.reason,
      });
    } else { kept++; }

    const finalOdds = opt.odds || majority.odds;
    const riskLvl = marketRiskLevel(opt.marketName || opt.market || majority.market, opt.outcomeName || opt.outcome || majority.outcome);
    const score = safetyScore(finalOdds, consensus, punters, ev.league, riskLvl);

    pool.push({
      eventId: ev.eventId,
      homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
      league: ev.league, category: ev.category, kickoff: ev.kickoff,
      market: opt.marketName || opt.market || majority.market,
      marketId: opt.marketId || majority.marketId,
      outcome: opt.outcomeName || opt.outcome || majority.outcome,
      outcomeId: opt.outcomeId || majority.outcomeId,
      specifier: opt.specifier ?? majority.specifier ?? "",
      odds: finalOdds,
      productId: opt.productId || majority.productId || 3,
      sportId: opt.sportId || ev.sportId || "sr:sport:1",
      score, consensus, punters,
      rawPick: majority.market + " → " + majority.outcome,
      wasOptimized: result.changed,
    });

    if ((i + 1) % 10 === 0) log(`  ${i + 1}/${events.length} events processed...`);
    await sleep(80);
  }

  pool.sort((a, b) => b.score - a.score);
  log(`  Optimized: ${optimized}, Kept: ${kept}, Market fetch fails: ${marketFetchFails}`);
  log(`  Top conversions:`);
  for (const c of conversions.slice(0, 5)) log(`    ${c.match}: ${c.reason}`);

  // ── PHASE 7: Generate slips ──
  log("\n▸ Phase 7: Generating 50 slips...");
  const GROUPS = {
    A: { label: "Consensus Bankers", count: 10, min: 8,  max: 15, threshold: 55, stake: 50 },
    B: { label: "Safety First",      count: 10, min: 15, max: 20, threshold: 50, stake: 20 },
    C: { label: "Balanced",          count: 10, min: 20, max: 30, threshold: 40, stake: 20 },
    D: { label: "Aggressive",        count: 10, min: 25, max: 40, threshold: 30, stake: 10 },
    E: { label: "Moonshot",          count: 10, min: 35, max: Math.min(50, pool.length), threshold: 0, stake: 10 },
  };

  const allSlips = {};
  for (const [g, cfg] of Object.entries(GROUPS)) {
    allSlips[g] = buildSlips(pool, cfg);
    log(`  Group ${g} (${cfg.label}): ${allSlips[g].length} slips, sizes [${allSlips[g].map(s => s.games).join(",")}]`);
  }

  // ── Generate booking codes ──
  log("\n▸ Generating booking codes via SportyBet...");
  let codeOk = 0, codeFail = 0;
  for (const [g, slips] of Object.entries(allSlips)) {
    for (const slip of slips) {
      const payload = slip.picks.map(s => {
        const entry = { eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, productId: s.productId || 3, sportId: s.sportId || "sr:sport:1", parentBetBuilderMarketId: "" };
        if (s.specifier) entry.specifier = s.specifier;
        return entry;
      });
      try {
        const res = await post("/api/generate", { selections: payload });
        if (res.success && res.shareCode) { slip.code = res.shareCode; slip.url = res.shareURL || ""; codeOk++; }
        else { slip.code = "FAILED"; slip.error = res.error || "unknown"; codeFail++; log(`  ✗ ${g}#${slip.idx}: ${slip.error}`); }
      } catch (e) { slip.code = "ERROR"; slip.error = e.message; codeFail++; }
      await sleep(200);
    }
  }
  log(`  Codes: ${codeOk} ok, ${codeFail} failed`);

  // ── AI PUNTERS + SLIPPILOT ──
  log("\n▸ Assigning AI punter codes + SlipPilot pick...");

  const AI_MAP = { "AI (Safe)": "A", "AI (Balanced)": "C", "AI (Moonshot)": "E" };
  for (const [aiName, groupKey] of Object.entries(AI_MAP)) {
    const slips = allSlips[groupKey] || [];
    const best = slips.filter(s => s.code && s.code !== "FAILED" && s.code !== "ERROR").sort((a, b) => b.avgScore - a.avgScore)[0];
    if (best) {
      if (!allSlips._ai) allSlips._ai = {};
      allSlips._ai[aiName] = { code: best.code, games: best.games, odds: best.odds, avgScore: best.avgScore, group: groupKey };
      log(`  ${aiName} → ${best.code} (${best.games}g, ${best.odds}x, safety ${best.avgScore})`);
    }
  }

  // SlipPilot punter: top 3 highest-confidence picks
  const weakMatches = readJSON(path.join(DATA, "weak-matches.json"), {});
  const slipPilotPicks = pool
    .filter(p => {
      const wm = weakMatches[p.eventId];
      return !wm || wm.losses < 10 || wm.failureRate < 60;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  let slipPilotCode = null;
  if (slipPilotPicks.length === 3) {
    const payload = slipPilotPicks.map(s => {
      const e = { eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, productId: s.productId || 3, sportId: s.sportId || "sr:sport:1", parentBetBuilderMarketId: "" };
      if (s.specifier) e.specifier = s.specifier;
      return e;
    });
    try {
      const res = await post("/api/generate", { selections: payload });
      if (res.success && res.shareCode) { slipPilotCode = res.shareCode; log(`  SlipPilot → ${slipPilotCode} (3g, top picks)`); }
    } catch {}
  }
  if (!slipPilotCode) log("  SlipPilot: could not generate (not enough safe picks)");

  // ── Save code history ──
  const CODE_HIST = path.join(DATA, "code-history.json");
  const codeHistory = readJSON(CODE_HIST, []);
  for (const [g, slips] of Object.entries(allSlips)) {
    if (g === "_ai") continue;
    for (const slip of slips) {
      if (!slip.code || slip.code === "FAILED" || slip.code === "ERROR") continue;
      codeHistory.push({
        code: slip.code, date, group: g, games: slip.games,
        odds: slip.odds, avgScore: slip.avgScore,
        punter: "Generated", status: "pending",
        picks: slip.picks.map(p => ({ eventId: p.eventId, home: p.homeTeam, away: p.awayTeam, market: p.market, outcome: p.outcome })),
      });
    }
  }
  // AI codes
  for (const [aiName, info] of Object.entries(allSlips._ai || {})) {
    codeHistory.push({ code: info.code, date, group: info.group, games: info.games, odds: info.odds, avgScore: info.avgScore, punter: aiName, status: "pending" });
  }
  if (slipPilotCode) {
    codeHistory.push({ code: slipPilotCode, date, group: "SP", games: 3, odds: +(slipPilotPicks.reduce((a, s) => a * s.odds, 1).toFixed(2)), avgScore: +(slipPilotPicks.reduce((a, s) => a + s.score, 0) / 3).toFixed(1), punter: "SlipPilot", status: "pending" });
  }
  // Keep last 500
  if (codeHistory.length > 500) codeHistory.splice(0, codeHistory.length - 500);
  writeJSON(CODE_HIST, codeHistory);

  // Update weak match appearance counts
  for (const p of pool) {
    if (!weakMatches[p.eventId]) weakMatches[p.eventId] = { eventId: p.eventId, match: p.homeTeam + " vs " + p.awayTeam, appearances: 0, losses: 0, failureRate: 0 };
    weakMatches[p.eventId].appearances++;
    weakMatches[p.eventId].failureRate = weakMatches[p.eventId].appearances > 0 ? Math.round(weakMatches[p.eventId].losses / weakMatches[p.eventId].appearances * 100) : 0;
  }
  writeJSON(path.join(DATA, "weak-matches.json"), weakMatches);

  // ── PHASE 8: Update leaderboard ──
  log("\n▸ Phase 8: Updating leaderboard...");
  const leaderboard = readJSON(LEADER_FILE, []);
  for (const [name, sels] of Object.entries(punterData)) {
    const futureFtb = sels.filter(s => s.kickoff && new Date(s.kickoff).getTime() > ts && (s.sport || "").toLowerCase() === "football");
    let entry = leaderboard.find(l => l.punter === name);
    if (!entry) { entry = { punter: name, daysActive: 0, totalGames: 0, consensusHits: 0, conversionRate: 0, riskProfile: "medium", lastActive: "" }; leaderboard.push(entry); }
    entry.daysActive = (entry.daysActive || 0) + 1;
    entry.totalGames = (entry.totalGames || 0) + futureFtb.length;
    entry.lastActive = date;
    // Count how many of this punter's picks landed in consensus matches
    const myEvents = new Set(futureFtb.map(s => s.eventId));
    const consensusIds = new Set(consensusMatches.map(c => c.eventId));
    const hits = [...myEvents].filter(e => consensusIds.has(e)).length;
    entry.consensusHits = (entry.consensusHits || 0) + hits;
    entry.consensusRate = entry.totalGames > 0 ? Math.round(entry.consensusHits / entry.totalGames * 100) : 0;
    // Conversion rate: how often their raw picks were optimized
    const myInPool = pool.filter(p => p.punters.includes(name));
    const converted = myInPool.filter(p => p.wasOptimized).length;
    entry.conversionRate = myInPool.length > 0 ? Math.round(converted / myInPool.length * 100) : 0;
    const avgOdds = sels.length > 0 ? sels.reduce((a, s) => a + s.odds, 0) / sels.length : 0;
    entry.riskProfile = avgOdds > 1.6 ? "high" : avgOdds > 1.4 ? "medium" : "low";
    entry.avgOdds = +avgOdds.toFixed(3);
    entry.todaySelections = futureFtb.length;
  }
  // Add AI punters + SlipPilot to leaderboard
  for (const [aiName, info] of Object.entries(allSlips._ai || {})) {
    let entry = leaderboard.find(l => l.punter === aiName);
    if (!entry) { entry = { punter: aiName, daysActive: 0, totalGames: 0, wins: 0, losses: 0, roi: 0, isAI: true, lastActive: "" }; leaderboard.push(entry); }
    entry.daysActive = (entry.daysActive || 0) + 1;
    entry.lastActive = date;
    entry.todayCode = info.code;
    entry.todayGames = info.games;
    entry.todayOdds = info.odds;
    entry.avgOdds = info.odds > 0 ? +(Math.log(info.odds) / info.games + 1).toFixed(3) : 0;
    entry.riskProfile = aiName.includes("Safe") ? "low" : aiName.includes("Moon") ? "high" : "medium";
  }
  if (slipPilotCode) {
    let spEntry = leaderboard.find(l => l.punter === "SlipPilot");
    if (!spEntry) { spEntry = { punter: "SlipPilot", daysActive: 0, totalGames: 0, wins: 0, losses: 0, roi: 0, isAI: true, lastActive: "" }; leaderboard.push(spEntry); }
    spEntry.daysActive = (spEntry.daysActive || 0) + 1;
    spEntry.lastActive = date;
    spEntry.todayCode = slipPilotCode;
    spEntry.todayGames = 3;
    spEntry.riskProfile = "low";
    spEntry.avgOdds = +(slipPilotPicks.reduce((a, s) => a + s.odds, 0) / 3).toFixed(3);
  }

  writeJSON(LEADER_FILE, leaderboard);
  log(`  Leaderboard: ${leaderboard.length} punters tracked`);

  // ── PHASE 9: Save outputs ──
  log("\n▸ Phase 9: Saving outputs...");

  // session-today.json
  const session = {
    date, generatedAt: new Date().toISOString(),
    punters: Object.fromEntries(Object.entries(punterMap).map(([n, c]) => [n, { codes: Array.isArray(c) ? c : [c], selections: (punterData[n] || []).length }])),
    masterPool: { total: pool.length, consensus: consensusMatches.length, strongConsensus: strongConsensus.length },
    conversions: conversions.length,
    topConversions: conversions.slice(0, 10),
    groups: Object.fromEntries(Object.entries(allSlips).filter(([g]) => g !== "_ai").map(([g, slips]) => [g, slips.map(s => ({
      code: s.code, games: s.games, odds: s.odds,
      avgScore: s.avgScore, avgConsensus: s.avgConsensus,
      group: g, timestamp: new Date().toISOString(),
    }))])),
    ai: allSlips._ai || {},
    slipPilot: slipPilotCode ? { code: slipPilotCode, picks: slipPilotPicks.map(p => ({ home: p.homeTeam, away: p.awayTeam, market: p.market, outcome: p.outcome, odds: p.odds })) } : null,
    pool: pool.map(p => ({
      eventId: p.eventId, home: p.homeTeam, away: p.awayTeam,
      league: p.league, market: p.market, outcome: p.outcome,
      odds: p.odds, score: p.score, consensus: p.consensus,
      punters: p.punters, optimized: p.wasOptimized,
    })),
  };
  writeJSON(SESSION_FILE, session);
  writeJSON(GENERATED_FILE, session);

  // Also write generated-codes.json in the format the admin Codes tab expects
  const GEN_CODES_FILE = path.join(DATA, "generated-codes.json");
  const adminCodes = {};
  for (const [g, slips] of Object.entries(allSlips)) {
    if (g === "_ai") continue;
    adminCodes[g] = slips.map(s => ({ code: s.code || null, games: s.games, odds: s.odds, topPicks: [] }));
  }
  writeJSON(GEN_CODES_FILE, adminCodes);

  // codes-today.txt
  const lines = [];
  lines.push("SLIPPILOT DAILY INTELLIGENCE — " + date);
  lines.push("Generated: " + new Date().toISOString());
  lines.push("═".repeat(60));

  lines.push("\nPUNTERS TODAY:\n");
  for (const [name, sels] of Object.entries(punterData)) {
    const codes = Array.isArray(punterMap[name]) ? punterMap[name] : [punterMap[name]];
    lines.push(`  ${name}: ${codes.filter(Boolean).join(", ")} — ${sels.length} selections`);
  }

  lines.push("\nMASTER POOL:\n");
  lines.push(`  Total matches: ${pool.length}`);
  lines.push(`  Consensus (2+): ${consensusMatches.length}`);
  lines.push(`  Strong consensus (3+): ${strongConsensus.length}`);

  if (conversions.length) {
    lines.push("\nTOP CONVERSIONS:\n");
    for (const c of conversions.slice(0, 15))
      lines.push(`  ${c.match}\n    ${c.from} → ${c.to}\n    Reason: ${c.reason}`);
  }

  lines.push("\n" + "═".repeat(60));

  const GLABELS = { A: "Consensus Bankers", B: "Safety First", C: "Balanced", D: "Aggressive", E: "Moonshot" };
  const GSTAKES = { A: 50, B: 20, C: 20, D: 10, E: 10 };

  for (const [g, slips] of Object.entries(allSlips)) {
    if (g === "_ai") continue;
    lines.push(`\nGROUP ${g} — ${GLABELS[g]} (stake ₦${GSTAKES[g]})\n`);
    for (const s of slips) {
      lines.push(`  ${s.code || "FAIL"}  |  ${s.games}g  |  ${s.odds.toLocaleString()}x  |  safety ${s.avgScore}  |  consensus ${s.avgConsensus}`);
    }
  }

  // AI + SlipPilot section
  lines.push(`\nAI PUNTERS + SLIPPILOT\n`);
  for (const [aiName, info] of Object.entries(allSlips._ai || {})) {
    lines.push(`  ${aiName}: ${info.code}  |  ${info.games}g  |  ${info.odds.toLocaleString()}x  |  safety ${info.avgScore}`);
  }
  if (slipPilotCode) {
    const spOdds = +(slipPilotPicks.reduce((a, s) => a * s.odds, 1).toFixed(2));
    lines.push(`  SlipPilot: ${slipPilotCode}  |  3g  |  ${spOdds}x  |  TOP 3 picks`);
    for (const p of slipPilotPicks) lines.push(`    ${p.homeTeam} vs ${p.awayTeam} — ${p.market}: ${p.outcome} @${p.odds}`);
  }

  lines.push("\n" + "═".repeat(60));
  lines.push("\nTOTAL SUMMARY:\n");
  const allCodes = Object.entries(allSlips).filter(([g]) => g !== "_ai").flatMap(([, s]) => s);
  const okCodes = allCodes.filter(s => s.code && s.code !== "FAILED" && s.code !== "ERROR");
  lines.push(`  Codes generated: ${okCodes.length} / ${allCodes.length}`);
  lines.push(`  Total stake: ₦${Object.entries(allSlips).filter(([g]) => g !== "_ai").reduce((a, [g, s]) => a + s.length * (GSTAKES[g]||0), 0)}`);

  // Exposure stats
  const expo = new Map();
  for (const s of allCodes) for (const p of s.picks) expo.set(p.eventId, (expo.get(p.eventId) || 0) + 1);
  const maxExpo = Math.max(...expo.values(), 0);
  const totalUnique = expo.size;
  lines.push(`  Unique matches used: ${totalUnique}`);
  lines.push(`  Max exposure: ${maxExpo} slips (${Math.round(maxExpo / allCodes.length * 100)}% of codes)`);

  lines.push("\n" + "═".repeat(60));

  const codeTxt = lines.join("\n");
  fs.writeFileSync(CODES_TXT, codeTxt);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\n══ DONE in ${elapsed}s — ${okCodes.length} codes saved ══`);

  return { session, codeTxt, codesOk: codeOk, codesFail: codeFail, elapsed };
}

// ── SESSION RESET ──
function resetSession() {
  const current = readJSON(SESSION_FILE, null);
  if (current) {
    const history = readJSON(HISTORY_FILE, []);
    current.archivedAt = new Date().toISOString();
    history.push(current);
    writeJSON(HISTORY_FILE, history);
  }
  writeJSON(SESSION_FILE, { date: new Date().toISOString().slice(0, 10), punters: {}, groups: {}, pool: [], status: "empty" });
  return { ok: true, archived: !!current };
}

module.exports = { run, resetSession };

// CLI mode
if (require.main === module) {
  const codes = readJSON(path.join(DATA, "punter-codes.json"), {});
  const punterMap = {};
  for (const [name, code] of Object.entries(codes)) {
    if (code) punterMap[name] = code;
  }
  run(punterMap).catch(e => { console.error("FATAL:", e); process.exit(1); });
}
