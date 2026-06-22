// generate-now.js — Quick 50-code generator
// RULES: every pick < 2.0 odds, every slip total >= 500x
const http = require("http");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "data");

const PUNTERS = {
  "Comrade": ["GBVV9A"],
  "King Eric": ["TMJZQX"],
  "Mr Lantern": ["MSP1E8", "PEZ1ZM", "VSCDSV"],
  "39 Billion": ["URGYHF"],
  "9Z": ["LT0RMU"],
  "Ayo Jordan": ["QWJHGG"],
  "Big Strategic": ["QU303D"],
  "Bayo Bets": ["RE9N9N"],
  "OY": ["M9J9KV"],
  "Princewill": ["V3XV6K"],
  "Sirtee": ["HXQH8Q"],
};

function get(p) {
  return new Promise((ok, fail) => {
    http.get("http://localhost:3000" + p, r => {
      let d = ""; r.on("data", c => d += c);
      r.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json")); } });
    }).on("error", fail);
  });
}
function post(p, body) {
  return new Promise((ok, fail) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: "localhost", port: 3000, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json")); } }); });
    req.on("error", fail); req.write(payload); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Market optimizer: find safest sub-2.0 option from full market list
function findBestSafe(rawPick, allMarkets) {
  if (!allMarkets || !allMarkets.length) {
    return rawPick.odds < 2.0 ? { pick: rawPick, changed: false } : null;
  }

  const rm = (rawPick.market || "").toLowerCase();
  const ro = (rawPick.outcome || "").toLowerCase();
  let candidates = [];

  // Try converting risky markets to safer ones
  if (rm.includes("1x2") && !rm.includes("&")) {
    if (ro.includes("home")) candidates = allMarkets.filter(m => m.marketName === "Double Chance" && m.outcomeName === "Home or Draw" && m.odds < 2.0);
    else if (ro.includes("away")) candidates = allMarkets.filter(m => m.marketName === "Double Chance" && m.outcomeName === "Draw or Away" && m.odds < 2.0);
  }
  if ((rm.includes("gg/ng") || rm.includes("btts")) && ro.includes("yes")) {
    candidates = allMarkets.filter(m => m.marketName === "Over/Under" && (m.outcomeName === "Over 1.5" || m.outcomeName === "Over 2.5") && m.odds < 2.0);
  }
  if (rm.includes("over/under") && (ro.includes("over 3.5") || /over 3($|\s)/.test(ro))) {
    candidates = allMarkets.filter(m => m.marketName === "Over/Under" && m.outcomeName === "Over 2.5" && m.specifier.includes("total=2.5") && m.odds < 2.0);
  }
  if (rm.includes("both halves over") && ro.includes("yes")) {
    candidates = allMarkets.filter(m => m.marketName === "Over/Under" && m.outcomeName === "Over 2.5" && m.odds < 2.0);
  }
  if (rm.includes("handicap") && ro.includes("home")) {
    candidates = allMarkets.filter(m => m.marketName === "Double Chance" && m.outcomeName === "Home or Draw" && m.odds < 2.0);
  }
  if (rm.includes("handicap") && ro.includes("away")) {
    candidates = allMarkets.filter(m => m.marketName === "Double Chance" && m.outcomeName === "Draw or Away" && m.odds < 2.0);
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.odds - a.odds); // pick highest odds among safe options
    const best = candidates[0];
    return { pick: { marketName: best.marketName, marketId: best.marketId, outcomeName: best.outcomeName, outcomeId: best.outcomeId, specifier: best.specifier || "", odds: best.odds }, changed: true, reason: `${rawPick.market}→${best.marketName}: ${best.outcomeName} @${best.odds}` };
  }

  // Original pick is fine if under 2.0
  if (rawPick.odds < 2.0) return { pick: rawPick, changed: false };

  // Last resort: find ANY sub-2.0 market for this event
  const anySafe = allMarkets.filter(m => m.odds > 1.05 && m.odds < 2.0).sort((a, b) => b.odds - a.odds);
  if (anySafe.length) {
    const best = anySafe[0];
    return { pick: { marketName: best.marketName, marketId: best.marketId, outcomeName: best.outcomeName, outcomeId: best.outcomeId, specifier: best.specifier || "", odds: best.odds }, changed: true, reason: `forced safe: ${best.marketName}: ${best.outcomeName} @${best.odds}` };
  }

  return null; // can't make this match safe
}

function shuffle(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

(async () => {
  const t0 = Date.now();
  console.log("═══ GENERATE NOW ═══\n");

  // 1. Fetch all bookings
  console.log("Fetching bookings...");
  const allSels = [];
  for (const [name, codes] of Object.entries(PUNTERS)) {
    for (const code of codes) {
      try {
        const res = await get("/api/booking/" + code);
        if (res.selections) {
          let count = 0;
          for (const s of res.selections) {
            s.punter = name; s.sourceCode = code;
            allSels.push(s);
            count++;
          }
          console.log(`  ✓ ${name} [${code}]: ${count}`);
        }
      } catch (e) { console.log(`  ✗ ${name} [${code}]: ${e.message}`); }
      await sleep(100);
    }
  }

  // 2. Filter future football, build event map
  const now = Date.now();
  const events = new Map();
  for (const s of allSels) {
    if (!s.kickoff || new Date(s.kickoff).getTime() <= now) continue;
    if ((s.sport || "").toLowerCase() !== "football") continue;
    if (!events.has(s.eventId)) {
      events.set(s.eventId, { eventId: s.eventId, homeTeam: s.homeTeam, awayTeam: s.awayTeam, league: s.league, category: s.category, kickoff: s.kickoff, sportId: s.sportId, picks: [] });
    }
    events.get(s.eventId).picks.push(s);
  }
  console.log(`\nFuture football: ${events.size} matches`);

  // 3. Optimize each match — fetch markets, find best sub-2.0 pick
  console.log("Optimizing markets (sub-2.0 only)...");
  const pool = [];
  const conversions = [];
  let dropped = 0;

  for (const [eid, ev] of events) {
    const punters = [...new Set(ev.picks.map(p => p.punter))];
    const consensus = punters.length;

    // Find majority raw pick
    const groups = {};
    for (const p of ev.picks) {
      const k = `${p.market}|${p.outcome}`;
      if (!groups[k]) groups[k] = { ...p, cnt: 0, backers: [] };
      groups[k].cnt++; groups[k].backers.push(p.punter);
    }
    const majority = Object.values(groups).sort((a, b) => b.cnt - a.cnt)[0];

    // Fetch all available markets
    let mkts = [];
    try { const r = await get("/api/markets/" + eid); mkts = r.markets || []; } catch {}

    const result = findBestSafe(majority, mkts);
    if (!result) { dropped++; continue; }

    const p = result.pick;
    if (result.changed) conversions.push({ match: ev.homeTeam + " vs " + ev.awayTeam, reason: result.reason });

    pool.push({
      eventId: eid, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
      league: ev.league, category: ev.category, kickoff: ev.kickoff,
      market: p.marketName || p.market, marketId: p.marketId,
      outcome: p.outcomeName || p.outcome, outcomeId: p.outcomeId,
      specifier: p.specifier || "", odds: p.odds,
      productId: p.productId || 3, sportId: p.sportId || ev.sportId || "sr:sport:1",
      consensus, punters,
    });

    if (pool.length % 10 === 0) process.stdout.write(`  ${pool.length} matches optimized...\r`);
    await sleep(60);
  }

  pool.sort((a, b) => b.odds - a.odds);
  console.log(`\nPool: ${pool.length} matches (dropped ${dropped} — no sub-2.0 option)`);
  console.log(`Conversions: ${conversions.length}`);
  conversions.slice(0, 8).forEach(c => console.log(`  ${c.match}: ${c.reason}`));

  // Verify all under 2.0
  const over2 = pool.filter(p => p.odds >= 2.0);
  if (over2.length) { console.log(`ERROR: ${over2.length} picks still >= 2.0`); process.exit(1); }
  console.log("✓ All picks confirmed < 2.0 odds");

  // How many games needed for 500x minimum?
  const sorted = [...pool].sort((a, b) => b.odds - a.odds);
  let cumOdds = 1, gamesFor500 = 0;
  for (const s of sorted) { cumOdds *= s.odds; gamesFor500++; if (cumOdds >= 500) break; }
  console.log(`Min games for 500x: ${gamesFor500} (using highest-odds picks)`);

  // 4. Generate 50 slips — all >= 500 total odds
  console.log("\nGenerating 50 slips...");

  // All 50 slips must be >= 500x. With avg odds ~1.30, need ~20 games.
  // Differentiate by SIZE: smaller = tighter/riskier, bigger = more cushion.
  const base = gamesFor500;
  const GROUPS = [
    { id: "A", label: "Banker",     count: 10, target: [base, base + 4] },
    { id: "B", label: "Solid",      count: 10, target: [base + 2, base + 8] },
    { id: "C", label: "Balanced",   count: 10, target: [base + 5, base + 12] },
    { id: "D", label: "Aggressive", count: 10, target: [base + 10, Math.min(base + 20, pool.length)] },
    { id: "E", label: "Moonshot",   count: 10, target: [Math.min(base + 18, pool.length - 2), Math.min(pool.length, 50)] },
  ];

  const allSlips = {};
  const globalUsage = new Map();

  for (const g of GROUPS) {
    const slips = [];
    const groupUsage = new Map();

    for (let i = 0; i < g.count; i++) {
      const [lo, hi] = g.target;
      let target = lo + Math.floor(Math.random() * (hi - lo + 1));
      target = Math.min(target, pool.length);

      let slip = [];
      let attempts = 0;

      // Keep trying until total odds >= 500
      while (attempts < 20) {
        attempts++;
        slip = [];
        const used = new Set();

        // Weight by consensus, inverse-usage, and jitter — no hard cap, just penalty
        const weighted = pool
          .map(s => ({ ...s, _w: (s.consensus * 5 + s.odds * 20) * (1 / (1 + (globalUsage.get(s.eventId) || 0) * 0.8)) * (0.5 + Math.random()) }));

        // Rotate consensus anchors
        const anchors = weighted.filter(s => s.consensus >= 3).sort((a, b) => b._w - a._w);
        const start = (i * 3 + attempts) % Math.max(1, anchors.length);
        const rotated = [...anchors.slice(start), ...anchors.slice(0, start)];
        const maxAnch = Math.ceil(target * 0.4);
        for (const s of rotated) {
          if (slip.length >= maxAnch) break;
          if (used.has(s.eventId)) continue;
          slip.push(s); used.add(s.eventId);
        }

        // Fill rest with shuffle
        const rest = shuffle(weighted.filter(s => !used.has(s.eventId)));
        for (const s of rest) {
          if (slip.length >= target) break;
          slip.push(s); used.add(s.eventId);
        }

        const total = slip.reduce((a, s) => a * s.odds, 1);
        if (total >= 500) break;

        // Not enough odds — try adding more games
        if (slip.length < pool.length) target = Math.min(target + 2, pool.length);
      }

      for (const s of slip) {
        globalUsage.set(s.eventId, (globalUsage.get(s.eventId) || 0) + 1);
        groupUsage.set(s.eventId, (groupUsage.get(s.eventId) || 0) + 1);
      }

      const totalOdds = slip.reduce((a, s) => a * s.odds, 1);
      slips.push({ idx: i + 1, games: slip.length, odds: +totalOdds.toFixed(2), picks: slip });
    }
    allSlips[g.id] = { label: g.label, slips };
    console.log(`  Group ${g.id} (${g.label}): ${slips.length} slips [${slips.map(s => s.games + "g/" + Math.round(s.odds) + "x").join(", ")}]`);
  }

  // Verify all slips >= 500
  let allOk = true;
  for (const [g, { slips }] of Object.entries(allSlips)) {
    for (const s of slips) {
      if (s.odds < 500) { console.log(`WARNING: ${g}#${s.idx} only ${Math.round(s.odds)}x`); allOk = false; }
    }
  }
  if (allOk) console.log("✓ All 50 slips confirmed >= 500x total odds");

  // 5. Generate booking codes
  console.log("\nGenerating SportyBet codes...");
  let ok = 0, fail = 0;
  for (const [g, { slips }] of Object.entries(allSlips)) {
    for (const slip of slips) {
      const payload = slip.picks.map(s => {
        const e = { eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, productId: s.productId || 3, sportId: s.sportId || "sr:sport:1", parentBetBuilderMarketId: "" };
        if (s.specifier) e.specifier = s.specifier;
        return e;
      });
      try {
        const res = await post("/api/generate", { selections: payload });
        if (res.success && res.shareCode) { slip.code = res.shareCode; ok++; }
        else { slip.code = "FAIL"; slip.error = res.error; fail++; console.log(`  ✗ ${g}#${slip.idx}: ${res.error}`); }
      } catch (e) { slip.code = "ERR"; fail++; }
      await sleep(200);
    }
  }
  console.log(`  Codes: ${ok} ok, ${fail} failed`);

  // 6. Save outputs
  const lines = [];
  lines.push("SLIPPILOT — " + new Date().toISOString().slice(0, 10));
  lines.push("Rules: all picks < 2.0 odds | all slips >= 500x total");
  lines.push("Pool: " + pool.length + " matches | Conversions: " + conversions.length);
  lines.push("═".repeat(50));

  for (const [g, { label, slips }] of Object.entries(allSlips)) {
    lines.push(`\n── GROUP ${g}: ${label} ──\n`);
    for (const s of slips) {
      lines.push(`${s.code || "FAIL"}  |  ${s.games}g  |  ${s.odds.toLocaleString()}x`);
    }
  }

  lines.push("\n" + "═".repeat(50));
  lines.push("Total: " + ok + " codes | Stake: ₦10 each = ₦500");

  const txt = lines.join("\n");
  fs.writeFileSync(path.join(DATA, "codes-today.txt"), txt);

  // Save structured data
  const structured = { date: new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString(), pool: pool.length, conversions: conversions.length, groups: {} };
  for (const [g, { label, slips }] of Object.entries(allSlips)) {
    structured.groups[g] = slips.map(s => ({ code: s.code, games: s.games, odds: s.odds, group: g, timestamp: new Date().toISOString() }));
  }
  fs.writeFileSync(path.join(DATA, "generated-today.json"), JSON.stringify(structured, null, 2));
  fs.writeFileSync(path.join(DATA, "session-today.json"), JSON.stringify(structured, null, 2));

  // Update leaderboard
  try {
    const lb = JSON.parse(fs.readFileSync(path.join(DATA, "leaderboard.json"), "utf-8"));
    for (const [name] of Object.entries(PUNTERS)) {
      let e = lb.find(l => l.punter === name);
      if (!e) { e = { punter: name, daysActive: 0, totalGames: 0, lastActive: "" }; lb.push(e); }
      e.lastActive = new Date().toISOString().slice(0, 10);
    }
    fs.writeFileSync(path.join(DATA, "leaderboard.json"), JSON.stringify(lb, null, 2));
  } catch {}

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("\n" + txt);
})();
