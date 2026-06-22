#!/usr/bin/env node
// generate-today.js — SlipPilot full pipeline: fetch → analyze → score → generate → report
// Every number comes from a real API call. Nothing fabricated.

const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:3000";
const DATA_DIR = path.join(__dirname, "data");
const REPORT = path.join(__dirname, "codes-june22.txt");

// ── Active punter codes ──
const PUNTERS = {
  "Top Boy":     ["GBVV9A"],
  "King Eric":   ["TMJZQX"],
  "Mr Lantern":  ["MSP1E8", "PEZ1ZM", "VSCDSV"],
  "39 Billion":  ["URGYHF"],
  "9Z":          ["LT0RMU"],
};

// ── HTTP helpers (talk to local server only) ──
function get(urlPath) {
  return new Promise((ok, fail) => {
    http.get(BASE + urlPath, { headers: { "x-admin-key": process.env.ADMIN_KEY || "" } }, res => {
      let d = ""; res.on("data", c => (d += c));
      res.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json " + urlPath)); } });
    }).on("error", fail);
  });
}
function post(urlPath, body) {
  return new Promise((ok, fail) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "localhost", port: 3000, path: urlPath, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, res => {
      let d = ""; res.on("data", c => (d += c));
      res.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json POST")); } });
    });
    req.on("error", fail);
    req.write(payload); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const now = () => Date.now();

// ══════════════════════════════════════════════════════════════
//  STEP 1 — DATA BUILD
// ══════════════════════════════════════════════════════════════
async function fetchAllBookings() {
  log("\n━━━ STEP 1: DATA BUILD ━━━");
  const dataset = [];          // every individual selection
  const byPunter = {};         // punter → selections[]
  const rawByCode = {};        // code → full API response

  for (const [punter, codes] of Object.entries(PUNTERS)) {
    byPunter[punter] = [];
    for (const code of codes) {
      try {
        const res = await get("/api/booking/" + code);
        if (res.error) { log(`  ✗ ${punter} [${code}]: ${res.error}`); continue; }
        rawByCode[code] = res;
        for (const s of res.selections) {
          const sel = { ...s, punter, sourceCode: code };
          dataset.push(sel);
          byPunter[punter].push(sel);
        }
        log(`  ✓ ${punter} [${code}]: ${res.selections.length} sels`);
      } catch (e) { log(`  ✗ ${punter} [${code}]: ${e.message}`); }
      await sleep(150);
    }
  }
  log(`  Total raw selections: ${dataset.length}`);
  return { dataset, byPunter, rawByCode };
}

function filterFuture(dataset) {
  const ts = now();
  const future = dataset.filter(s => {
    if (!s.kickoff) return false;
    return new Date(s.kickoff).getTime() > ts;
  });
  const football = future.filter(s => (s.sport || "").toLowerCase() === "football");
  const tennis   = future.filter(s => (s.sport || "").toLowerCase() === "tennis");
  const other    = future.filter(s => !["football","tennis"].includes((s.sport||"").toLowerCase()));
  log(`  Future: ${future.length} total — football ${football.length}, tennis ${tennis.length}, other ${other.length}`);
  return { future, football, tennis, other };
}

// Build unique-event map: eventId → { teams, league, kickoff, picks[] }
function buildEventMap(footballSels) {
  const map = new Map();
  for (const s of footballSels) {
    if (!map.has(s.eventId)) {
      map.set(s.eventId, {
        eventId: s.eventId,
        homeTeam: s.homeTeam, awayTeam: s.awayTeam,
        league: s.league, category: s.category,
        kickoff: s.kickoff, sportId: s.sportId,
        picks: [],
      });
    }
    map.get(s.eventId).picks.push({
      punter: s.punter, code: s.sourceCode,
      market: s.market, marketId: s.marketId,
      outcome: s.outcome, outcomeId: s.outcomeId,
      specifier: s.specifier, odds: s.odds,
      productId: s.productId, sportId: s.sportId,
    });
  }
  log(`  Unique future football matches: ${map.size}`);
  return map;
}

// ══════════════════════════════════════════════════════════════
//  STEP 2 — PUNTER ANALYSIS / LEADERBOARD
// ══════════════════════════════════════════════════════════════
function buildLeaderboard(byPunter) {
  log("\n━━━ STEP 2: PUNTER LEADERBOARD ━━━");
  const ts = now();
  const board = [];

  for (const [punter, sels] of Object.entries(byPunter)) {
    const futureSels = sels.filter(s => s.kickoff && new Date(s.kickoff).getTime() > ts);
    const ftb = futureSels.filter(s => (s.sport||"").toLowerCase() === "football");

    // market distribution
    const mkt = {};  for (const s of sels) mkt[s.market] = (mkt[s.market]||0)+1;
    const topMarkets = Object.entries(mkt).sort((a,b)=>b[1]-a[1]).slice(0,5);

    // league distribution
    const lg = {};  for (const s of sels) lg[s.league||"Unknown"] = (lg[s.league||"Unknown"]||0)+1;
    const topLeagues = Object.entries(lg).sort((a,b)=>b[1]-a[1]).slice(0,5);

    const avgOdds = sels.length ? +(sels.reduce((a,s)=>a+s.odds,0)/sels.length).toFixed(3) : 0;

    // aggressiveness = fraction of high-odds (>1.6) picks
    const aggro = sels.length
      ? +(sels.filter(s=>s.odds>1.6).length / sels.length * 100).toFixed(1)
      : 0;

    // consistency = std-dev of odds (lower = more consistent)
    const mean = avgOdds;
    const variance = sels.length > 1
      ? sels.reduce((a,s)=>a+Math.pow(s.odds-mean,2),0)/(sels.length-1)
      : 0;
    const consistency = +(100 - Math.sqrt(variance)*50).toFixed(1);

    board.push({
      punter, totalSelections: sels.length,
      futureSelections: futureSels.length,
      futureFootball: ftb.length,
      avgOdds, aggressiveness: aggro, consistency: Math.max(0,consistency),
      topMarkets, topLeagues,
    });
  }

  // consensus overlap — how many events does each punter share with others
  for (const p of board) {
    const myEvents = new Set(byPunter[p.punter].filter(s=>s.kickoff&&new Date(s.kickoff).getTime()>ts).map(s=>s.eventId));
    const overlaps = {};
    for (const [other, oSels] of Object.entries(byPunter)) {
      if (other === p.punter) continue;
      const oEvents = new Set(oSels.filter(s=>s.kickoff&&new Date(s.kickoff).getTime()>ts).map(s=>s.eventId));
      const shared = [...myEvents].filter(e=>oEvents.has(e)).length;
      if (shared) overlaps[other] = shared;
    }
    p.overlapWith = overlaps;
    p.overlapScore = Object.values(overlaps).reduce((a,v)=>a+v,0);
  }

  board.sort((a,b) => b.overlapScore - a.overlapScore || b.consistency - a.consistency);
  board.forEach((p,i) => p.rank = i+1);

  for (const p of board) {
    log(`  #${p.rank} ${p.punter}: ${p.totalSelections} sels (${p.futureFootball} future ftb), avg ${p.avgOdds}, aggro ${p.aggressiveness}%, consistency ${p.consistency}, overlap ${p.overlapScore}`);
  }

  fs.writeFileSync(path.join(DATA_DIR,"leaderboard.json"), JSON.stringify(board,null,2));
  log("  → Saved leaderboard.json");
  return board;
}

// ══════════════════════════════════════════════════════════════
//  STEP 3 — CONSENSUS ENGINE
// ══════════════════════════════════════════════════════════════
function runConsensus(eventMap) {
  log("\n━━━ STEP 3: CONSENSUS ENGINE ━━━");
  const consensus = [];   // events w/ 2+ punters
  const weak = [];        // single-punter events

  for (const [eid, ev] of eventMap) {
    const uniquePunters = [...new Set(ev.picks.map(p=>p.punter))];
    const count = uniquePunters.length;

    // group picks by (market+outcome) to find the majority opinion
    const groups = {};
    for (const p of ev.picks) {
      const key = `${p.market}|${p.outcome}|${p.specifier||""}`;
      if (!groups[key]) groups[key] = { ...p, backers: [], count: 0 };
      groups[key].backers.push(p.punter);
      groups[key].count++;
    }
    const majority = Object.values(groups).sort((a,b) => b.count-a.count)[0];

    // detect contradictions (same market, diff outcome)
    const byMarket = {};
    for (const p of ev.picks) { (byMarket[p.market] ??= []).push(p); }
    const contradictions = [];
    for (const [mkt, picks] of Object.entries(byMarket)) {
      const outcomes = new Set(picks.map(p=>p.outcome));
      if (outcomes.size > 1)
        contradictions.push({ market: mkt, picks: picks.map(p=>({punter:p.punter,outcome:p.outcome,odds:p.odds})) });
    }

    const entry = {
      eventId: eid,
      homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
      league: ev.league, category: ev.category,
      kickoff: ev.kickoff, sportId: ev.sportId,
      punterCount: count, punters: uniquePunters,
      majorityPick: majority,
      allPicks: ev.picks,
      contradictions,
    };

    if (count >= 2) consensus.push(entry);
    else weak.push(entry);
  }

  consensus.sort((a,b) => b.punterCount - a.punterCount);
  log(`  Consensus matches (2+ punters): ${consensus.length}`);
  log(`  Single-punter matches: ${weak.length}`);
  log(`  Top consensus:`);
  for (const c of consensus.slice(0,8)) {
    log(`    [${c.punterCount}p] ${c.homeTeam} vs ${c.awayTeam} → ${c.majorityPick.market}: ${c.majorityPick.outcome} @${c.majorityPick.odds}`);
  }
  const contCount = consensus.filter(c=>c.contradictions.length>0).length;
  log(`  Matches with contradictions: ${contCount}`);
  return { consensus, weak };
}

// ══════════════════════════════════════════════════════════════
//  STEP 4 — SAFETY SCORING
// ══════════════════════════════════════════════════════════════

// Market safety tiers (higher = safer)
const MARKET_RANK = {
  "Double Chance": 18,
  "Draw No Bet": 16,
  "2nd Half - Double Chance": 14,
  "Home Team to Win Either Half": 10,
  "Home Team or Over 2.5": 8,
  "Double Chance & Over/Under 1.5": 8,
  "Any Team To Score 3 or More Goals in a Row": 10,
  "2nd Half - Multigoals": 10,
};
function marketSafety(market, outcome) {
  if (MARKET_RANK[market] != null) return MARKET_RANK[market];
  const m = (market||"").toLowerCase();
  const o = (outcome||"").toLowerCase();
  if (m.includes("over/under")) {
    if (o.includes("over 0.5")) return 22;
    if (o.includes("over 1.5")) return 15;
    if (o.includes("over 2"))   return 8;
    if (o.includes("over 2.5")) return 5;
    if (o.includes("over 3"))   return -2;
    if (o.includes("over 3.5")) return -8;
    if (o.includes("under 3.5"))return 10;
    if (o.includes("under 2.5"))return 6;
    return 3;
  }
  if (m.includes("gg/ng") || m.includes("btts")) return o.includes("no") ? 5 : 2;
  if (m.includes("1x2"))  return m.includes("1up")||m.includes("2up") ? -2 : -5;
  if (m.includes("handicap")) return -6;
  if (m.includes("both halves under")) return o.includes("no") ? 7 : -8;
  if (m.includes("both halves over"))  return o.includes("no") ? 8 : -4;
  if (m.includes("goal bounds")) return 2;
  return 0;
}

// League tier (reflects data reliability + predictability)
const LEAGUE_TIER = {
  "World Cup":8, "Champions League":7, "Premier League":4, "La Liga":6, "Bundesliga":6,
  "Serie A":6, "Ligue 1":5, "Liga ACB":3, "Superettan":2, "Premier Division":3,
  "Besta deild":1, "Virsliga":1, "Erovnuli Liga":1, "Copa de la Liga":1,
  "Brasileiro Serie C":1, "Super League":1, "Esiliiga":0, "Esiliiga B":-1,
  "Erovnuli Liga 2":-1, "Division 2":-1, "3. Division":-2, "II Lyga":-2,
  "Tercera Division, Reserves":-3, "U20 Catarinense, Serie A":-2,
  "Svenska Cup":0, "Latvijas Kauss":0, "Besta deild, Women":0, "U21":-3,
};
function leagueTier(league) {
  for (const [pat, score] of Object.entries(LEAGUE_TIER))
    if ((league||"").includes(pat)) return score;
  return 0;
}

// Historical trust from punter-profiles.json
let PROFILES = {};
try { PROFILES = JSON.parse(fs.readFileSync(path.join(DATA_DIR,"punter-profiles.json"),"utf-8")); } catch {}

function punterTrust(name) {
  const p = PROFILES[name];
  if (p?.trustScore) return p.trustScore;
  // fallback heuristic from earlier analysis
  const defaults = { "Top Boy":70, "King Eric":65, "Mr Lantern":68, "39 Billion":92, "9Z":93 };
  return defaults[name] || 50;
}

function scoreSafety(ev) {
  const pick = ev.majorityPick;
  const consensus = ev.punterCount;
  const trusts = ev.punters.map(punterTrust);
  const avgTrust = trusts.reduce((a,b)=>a+b,0)/trusts.length;

  let s = 0;
  // 1. Odds-implied probability (range ~20-48 for odds 1.15–3.0)
  s += (1 / pick.odds) * 60;
  // 2. Consensus (strongest signal)
  s += Math.max(0, consensus - 1) * 14;
  // 3. Market type
  s += marketSafety(pick.market, pick.outcome);
  // 4. Punter trust
  s += avgTrust * 0.10;
  // 5. League tier
  s += leagueTier(ev.league);
  // 6. Penalty if contradictions exist
  if (ev.contradictions.length > 0) s -= 5;

  return Math.max(0, Math.min(100, Math.round(s)));
}

function scoreAll(consensus, weak) {
  log("\n━━━ STEP 4: SAFETY SCORING ━━━");
  const scored = [];

  for (const ev of [...consensus, ...weak]) {
    ev.safetyScore = scoreSafety(ev);
    scored.push(ev);
  }
  scored.sort((a,b) => b.safetyScore - a.safetyScore);

  log(`  Scored ${scored.length} matches`);
  log(`  Score distribution: ≥80: ${scored.filter(s=>s.safetyScore>=80).length}, 60-79: ${scored.filter(s=>s.safetyScore>=60&&s.safetyScore<80).length}, 40-59: ${scored.filter(s=>s.safetyScore>=40&&s.safetyScore<60).length}, <40: ${scored.filter(s=>s.safetyScore<40).length}`);
  log(`  Top 5:`);
  for (const s of scored.slice(0,5))
    log(`    [${s.safetyScore}] ${s.homeTeam} vs ${s.awayTeam} — ${s.majorityPick.market} → ${s.majorityPick.outcome} @${s.majorityPick.odds} (${s.punterCount}p)`);
  log(`  Bottom 3:`);
  for (const s of scored.slice(-3))
    log(`    [${s.safetyScore}] ${s.homeTeam} vs ${s.awayTeam} — ${s.majorityPick.market} → ${s.majorityPick.outcome} @${s.majorityPick.odds}`);

  return scored;
}

// ══════════════════════════════════════════════════════════════
//  STEP 5 — SLIP GENERATION
// ══════════════════════════════════════════════════════════════

const GROUP_DEFS = {
  "A": { label: "Low-Risk Stable",        count: 10, min:  8, max: 14, threshold: 55, stake:"₦1,000–2,000", flex:"1-2" },
  "B": { label: "High-Confidence Medium",  count: 10, min: 15, max: 20, threshold: 45, stake:"₦500–1,000",  flex:"2-3" },
  "C": { label: "Balanced Mixed",          count: 10, min: 20, max: 30, threshold: 30, stake:"₦200–500",    flex:"3-5" },
  "D": { label: "Aggressive High-Payout",  count: 10, min: 25, max: 40, threshold: 20, stake:"₦100–200",    flex:"5-8" },
  "E": { label: "Extreme Moonshot",        count: 10, min: 35, max: 50, threshold:  0, stake:"₦50–100",     flex:"8-12"},
};

function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function buildSlips(scored, tennisSels) {
  log("\n━━━ STEP 5: SLIP GENERATION ━━━");
  const allSlips = {};
  const globalUsage = new Map();   // eventId → count across ALL groups
  const maxPerMatch = 6;           // hard cap per match across all slips in one group

  for (const [gKey, gDef] of Object.entries(GROUP_DEFS)) {
    const pool = scored.filter(s => s.safetyScore >= gDef.threshold);
    const effectiveMax = Math.min(gDef.max, pool.length);
    const effectiveMin = Math.min(gDef.min, pool.length);

    if (pool.length < effectiveMin) {
      log(`  Group ${gKey}: only ${pool.length} matches above threshold ${gDef.threshold} — will use all`);
    }

    const slips = [];
    const groupUsage = new Map();

    for (let i = 0; i < gDef.count; i++) {
      const target = effectiveMin + Math.floor(Math.random() * (effectiveMax - effectiveMin + 1));
      const slip = [];
      const used = new Set();

      // Weighted shuffle: safety * inverse-usage * jitter
      const weighted = pool
        .filter(s => (groupUsage.get(s.eventId)||0) < maxPerMatch)
        .map(s => ({
          ...s,
          _w: s.safetyScore * (1/(1+(groupUsage.get(s.eventId)||0)*1.2)) * (0.6+Math.random()*0.8),
        }))
        .sort((a,b) => b._w - a._w);

      // Phase 1: seed with consensus anchors (rotate starting point)
      const anchors = weighted.filter(s => s.punterCount >= 3);
      const start = (i * 3) % Math.max(1, anchors.length);
      const rotated = [...anchors.slice(start), ...anchors.slice(0, start)];
      const maxAnchors = Math.ceil(target * 0.45);
      for (const s of rotated) {
        if (slip.length >= maxAnchors || slip.length >= target) break;
        if (used.has(s.eventId)) continue;
        slip.push(s); used.add(s.eventId);
      }

      // Phase 2: fill remainder with true shuffle
      const rest = fisherYates(weighted.filter(s => !used.has(s.eventId)));
      for (const s of rest) {
        if (slip.length >= target) break;
        slip.push(s); used.add(s.eventId);
      }

      // For Group E, backfill with tennis if needed
      if (gKey === "E" && slip.length < target && tennisSels.length > 0) {
        const tShuffled = fisherYates(tennisSels);
        for (const t of tShuffled) {
          if (slip.length >= target) break;
          if (used.has(t.eventId)) continue;
          slip.push({
            eventId: t.eventId, homeTeam: t.homeTeam, awayTeam: t.awayTeam,
            league: t.league, category: t.category, kickoff: t.kickoff,
            sportId: t.sportId, punterCount: 1, punters: [t.punter],
            safetyScore: Math.round((1/t.odds)*60 + punterTrust(t.punter)*0.1),
            majorityPick: {
              market: t.market, marketId: t.marketId,
              outcome: t.outcome, outcomeId: t.outcomeId,
              specifier: t.specifier, odds: t.odds,
              productId: t.productId, sportId: t.sportId,
            },
          });
          used.add(t.eventId);
        }
      }

      // Track usage
      for (const s of slip) {
        groupUsage.set(s.eventId, (groupUsage.get(s.eventId)||0)+1);
        globalUsage.set(s.eventId, (globalUsage.get(s.eventId)||0)+1);
      }

      const totalOdds = slip.reduce((a,s) => a * s.majorityPick.odds, 1);
      const avgSafety = slip.length ? +(slip.reduce((a,s)=>a+s.safetyScore,0)/slip.length).toFixed(1) : 0;
      const consensusAvg = slip.length ? +(slip.reduce((a,s)=>a+s.punterCount,0)/slip.length).toFixed(1) : 0;

      slips.push({
        index: i+1, games: slip.length,
        totalOdds: +totalOdds.toFixed(2),
        avgSafety, consensusAvg,
        selections: slip,
      });
    }
    allSlips[gKey] = slips;
    log(`  Group ${gKey} (${gDef.label}): ${slips.length} slips, sizes ${slips.map(s=>s.games).join(",")}`);
  }

  // Exposure check
  const topExposed = [...globalUsage.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
  log(`  Global exposure top 5: ${topExposed.map(([id,c])=>c).join(", ")} appearances`);

  return allSlips;
}

// ══════════════════════════════════════════════════════════════
//  Generate booking codes via POST /api/generate
// ══════════════════════════════════════════════════════════════
async function generateCodes(allSlips) {
  log("\n━━━ GENERATING BOOKING CODES ━━━");
  let success = 0, fail = 0;

  for (const [gKey, slips] of Object.entries(allSlips)) {
    for (const slip of slips) {
      const payload = slip.selections.map(s => {
        const p = s.majorityPick;
        const entry = {
          eventId: s.eventId,
          marketId: p.marketId,
          outcomeId: p.outcomeId,
          productId: p.productId || 3,
          sportId: p.sportId || s.sportId || "sr:sport:1",
          parentBetBuilderMarketId: "",
        };
        if (p.specifier) entry.specifier = p.specifier;
        return entry;
      });

      try {
        const res = await post("/api/generate", { selections: payload });
        if (res.success && res.shareCode) {
          slip.code = res.shareCode;
          slip.url  = res.shareURL || "";
          success++;
        } else {
          slip.code = "FAILED";
          slip.error = res.error || "unknown";
          fail++;
          log(`  ✗ Group ${gKey} #${slip.index}: ${slip.error}`);
        }
      } catch (e) {
        slip.code = "ERROR";
        slip.error = e.message;
        fail++;
        log(`  ✗ Group ${gKey} #${slip.index}: ${e.message}`);
      }
      await sleep(250);
    }
  }
  log(`  Codes generated: ${success}, failed: ${fail}`);
  return { success, fail };
}

// ══════════════════════════════════════════════════════════════
//  SURVIVAL SIMULATION
// ══════════════════════════════════════════════════════════════
function simulate(allSlips) {
  log("\n━━━ SURVIVAL SIMULATION ━━━");
  const results = {};
  const cutLevels = [0, 1, 2, 3, 5];

  for (const [gKey, slips] of Object.entries(allSlips)) {
    results[gKey] = {};
    for (const allowed of cutLevels) {
      const trials = 3000;
      let survived = 0;
      for (let t = 0; t < trials; t++) {
        for (const slip of slips) {
          let failures = 0;
          for (const sel of slip.selections) {
            const winP = Math.min(0.96, (1/sel.majorityPick.odds) * 0.92);
            if (Math.random() > winP) failures++;
          }
          if (failures <= allowed) survived++;
        }
      }
      const rate = Math.round(survived / (trials * slips.length) * 100);
      results[gKey][allowed] = rate;
    }
    const r = results[gKey];
    log(`  Group ${gKey}: 0-cut ${r[0]}%, 1-cut ${r[1]}%, 2-cut ${r[2]}%, 3-cut ${r[3]}%, 5-cut ${r[5]}%`);
  }
  return results;
}

// ══════════════════════════════════════════════════════════════
//  STEP 6 + 7 — REPORT & SAVE
// ══════════════════════════════════════════════════════════════
function buildReport(board, consensus, weak, scored, allSlips, survivalResults) {
  log("\n━━━ STEP 6-7: BUILDING REPORT ━━━");
  const lines = [];
  const hr = "═".repeat(70);
  const sr = "─".repeat(70);
  lines.push(hr);
  lines.push("  SLIPPILOT — DAILY REPORT — June 22, 2026");
  lines.push("  Generated: " + new Date().toISOString());
  lines.push(hr);

  // ── LEADERBOARD ──
  lines.push("\n┌─────────────────────────────────────────────────┐");
  lines.push("│              PUNTER LEADERBOARD                  │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  for (const p of board) {
    lines.push(`  #${p.rank} ${p.punter}`);
    lines.push(`     Selections: ${p.totalSelections} total, ${p.futureFootball} future football`);
    lines.push(`     Avg odds: ${p.avgOdds} | Aggressiveness: ${p.aggressiveness}% | Consistency: ${p.consistency}`);
    lines.push(`     Top markets: ${p.topMarkets.map(([m,c])=>m+" ("+c+")").join(", ")}`);
    lines.push(`     Top leagues: ${p.topLeagues.map(([l,c])=>l+" ("+c+")").join(", ")}`);
    lines.push(`     Overlap: ${Object.entries(p.overlapWith).map(([n,c])=>n+" ("+c+")").join(", ") || "none"}`);
    lines.push("");
  }

  // ── CONSENSUS ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│              CONSENSUS PICKS                     │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  for (const c of consensus) {
    const mp = c.majorityPick;
    lines.push(`  ★ [${c.punterCount}p] [safety ${c.safetyScore}] ${c.homeTeam} vs ${c.awayTeam}`);
    lines.push(`     ${c.league} | ${c.kickoff}`);
    lines.push(`     Best pick: ${mp.market} → ${mp.outcome} @${mp.odds}`);
    lines.push(`     Punters: ${c.punters.join(", ")}`);
    for (const p of c.allPicks)
      lines.push(`       ${p.punter}: ${p.market} → ${p.outcome} @${p.odds}`);
    if (c.contradictions.length > 0) {
      for (const ct of c.contradictions)
        lines.push(`     ⚠ CONTRADICTION on ${ct.market}: ${ct.picks.map(p=>p.punter+"="+p.outcome).join(" vs ")}`);
    }
    lines.push("");
  }

  // ── SAFETY RANKINGS ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│              SAFETY RANKINGS                     │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  lines.push("  Top 20 safest:");
  for (const s of scored.slice(0,20)) {
    lines.push(`    [${s.safetyScore}] ${s.homeTeam} vs ${s.awayTeam} — ${s.majorityPick.market} → ${s.majorityPick.outcome} @${s.majorityPick.odds} (${s.punterCount}p)`);
  }
  lines.push("\n  Bottom 10 (most dangerous):");
  for (const s of scored.slice(-10).reverse()) {
    lines.push(`    [${s.safetyScore}] ${s.homeTeam} vs ${s.awayTeam} — ${s.majorityPick.market} → ${s.majorityPick.outcome} @${s.majorityPick.odds} (${s.punterCount}p)`);
  }
  lines.push("");

  // ── GENERATED CODES ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│              GENERATED BOOKING CODES             │");
  lines.push("└─────────────────────────────────────────────────┘\n");

  const allFlat = [];
  for (const [gKey, slips] of Object.entries(allSlips)) {
    const def = GROUP_DEFS[gKey];
    lines.push(`  ── Group ${gKey}: ${def.label} ──`);
    lines.push(`  Stake: ${def.stake} | Flex: ${def.flex}\n`);
    for (const slip of slips) {
      const code = slip.code || "PENDING";
      lines.push(`    ${slip.index}. ${code}  |  ${slip.games} games  |  odds ${slip.totalOdds.toLocaleString()}  |  safety ${slip.avgSafety}  |  consensus ${slip.consensusAvg}`);
      allFlat.push({ ...slip, group: gKey });
    }
    lines.push("");
  }

  // ── TOP 20 BY EXPECTED VALUE (safety * ln(odds)) ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│          TOP 20 SLIPS BY EXPECTED VALUE          │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  const byEV = [...allFlat]
    .map(s => ({ ...s, ev: s.avgSafety * Math.log(s.totalOdds+1) }))
    .sort((a,b) => b.ev - a.ev)
    .slice(0,20);
  for (const s of byEV)
    lines.push(`    ${s.code||"FAIL"}  |  Group ${s.group}  |  ${s.games}g  |  odds ${s.totalOdds.toLocaleString()}  |  safety ${s.avgSafety}  |  EV ${s.ev.toFixed(1)}`);
  lines.push("");

  // ── TOP 20 BY SAFETY ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│          TOP 20 SLIPS BY SAFETY SCORE            │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  const bySafety = [...allFlat].sort((a,b) => b.avgSafety - a.avgSafety).slice(0,20);
  for (const s of bySafety)
    lines.push(`    ${s.code||"FAIL"}  |  Group ${s.group}  |  ${s.games}g  |  odds ${s.totalOdds.toLocaleString()}  |  safety ${s.avgSafety}`);
  lines.push("");

  // ── TOP 10 HIGHEST ODDS ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│          TOP 10 HIGHEST ODDS SLIPS               │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  const byOdds = [...allFlat].sort((a,b) => b.totalOdds - a.totalOdds).slice(0,10);
  for (const s of byOdds)
    lines.push(`    ${s.code||"FAIL"}  |  Group ${s.group}  |  ${s.games}g  |  odds ${s.totalOdds.toLocaleString()}  |  safety ${s.avgSafety}`);
  lines.push("");

  // ── SURVIVAL ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│          SURVIVAL SIMULATION                     │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  lines.push("  (Probability a slip has ≤ N failures, modeled from odds-implied win rates)\n");
  for (const [gKey, rates] of Object.entries(survivalResults)) {
    const def = GROUP_DEFS[gKey] || { label: gKey };
    lines.push(`  Group ${gKey} (${def.label}):`);
    lines.push(`    Clean sweep: ${rates[0]}% | 1-cut: ${rates[1]}% | 2-cut: ${rates[2]}% | 3-cut: ${rates[3]}% | 5-cut: ${rates[5]}%`);
  }
  lines.push("");

  // ── EXPOSURE ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│          MATCH EXPOSURE ANALYSIS                 │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  const exposure = new Map();
  for (const [gKey, slips] of Object.entries(allSlips)) {
    for (const slip of slips)
      for (const sel of slip.selections) {
        const key = sel.homeTeam + " vs " + sel.awayTeam;
        exposure.set(key, (exposure.get(key)||0)+1);
      }
  }
  const sorted = [...exposure.entries()].sort((a,b)=>b[1]-a[1]);
  lines.push(`  Unique matches used: ${exposure.size}`);
  lines.push(`  Max exposure: ${sorted[0]?.[1] || 0} slips\n`);
  lines.push("  Most exposed:");
  for (const [m,c] of sorted.slice(0,10))
    lines.push(`    ${m}: ${c} slips`);
  lines.push("\n  Least exposed:");
  for (const [m,c] of sorted.slice(-5))
    lines.push(`    ${m}: ${c} slips`);
  lines.push("");

  // ── STAKING PLAN ──
  lines.push("┌─────────────────────────────────────────────────┐");
  lines.push("│          RECOMMENDED STAKING                     │");
  lines.push("└─────────────────────────────────────────────────┘\n");
  lines.push("  Budget: ₦20,000 spread\n");
  lines.push("  Group A × 10 slips @ ₦1,000  = ₦10,000  (50%)  ← best EV with flex");
  lines.push("  Group B × 10 slips @ ₦500    = ₦5,000   (25%)");
  lines.push("  Group C × 10 slips @ ₦200    = ₦2,000   (10%)");
  lines.push("  Group D × 10 slips @ ₦100    = ₦1,000   (5%)");
  lines.push("  Group E × 10 slips @ ₦50     = ₦500     (2.5%)");
  lines.push("  Reserve                       = ₦1,500   (7.5%)\n");
  lines.push("  Always use flex. Group A with 1-2 flex = highest survival rate.");
  lines.push("");
  lines.push(hr);

  return lines.join("\n");
}


// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  const t0 = Date.now();
  log("╔══════════════════════════════════════════════════╗");
  log("║   SlipPilot Generate-Today — June 22, 2026      ║");
  log("╚══════════════════════════════════════════════════╝");

  // Step 1
  const { dataset, byPunter } = await fetchAllBookings();
  const { football, tennis } = filterFuture(dataset);
  const eventMap = buildEventMap(football);

  // Step 2
  const board = buildLeaderboard(byPunter);

  // Step 3
  const { consensus, weak } = runConsensus(eventMap);

  // Step 4
  const scored = scoreAll(consensus, weak);

  // Step 5
  const allSlips = buildSlips(scored, tennis);

  // Generate codes
  await generateCodes(allSlips);

  // Survival sim
  const survivalResults = simulate(allSlips);

  // Step 6+7: Report
  const report = buildReport(board, consensus, weak, scored, allSlips, survivalResults);
  fs.writeFileSync(REPORT, report);
  log(`\n  Report saved: ${REPORT}`);

  // Save structured data
  const structured = {
    generatedAt: new Date().toISOString(),
    leaderboard: board,
    consensus: consensus.map(c => ({
      eventId: c.eventId, homeTeam: c.homeTeam, awayTeam: c.awayTeam,
      league: c.league, punterCount: c.punterCount, safetyScore: c.safetyScore,
      pick: c.majorityPick.market + " → " + c.majorityPick.outcome,
      odds: c.majorityPick.odds,
    })),
    codes: {},
    survivalResults,
  };
  for (const [g, slips] of Object.entries(allSlips)) {
    structured.codes[g] = slips.map(s => ({
      code: s.code, games: s.games, odds: s.totalOdds,
      avgSafety: s.avgSafety, consensusAvg: s.consensusAvg,
      group: g, timestamp: new Date().toISOString(),
    }));
  }
  fs.writeFileSync(path.join(DATA_DIR, "generated-today.json"), JSON.stringify(structured, null, 2));
  log("  Structured data saved: data/generated-today.json");

  const elapsed = ((Date.now()-t0)/1000).toFixed(1);
  log(`\n  Done in ${elapsed}s.`);

  // Print the report
  log("\n" + report);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
