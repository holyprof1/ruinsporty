// analyze-history.js — Full historical analysis of all SlipPilot data
// Scans every code, every punter, every match. Builds learning-report.json

const http = require("http");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "data");

function get(p) {
  return new Promise((ok) => {
    http.get("http://localhost:3000" + p, { headers: { "x-admin-password": process.env.ADMIN_PASSWORD || "HPfirstpJ" } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { ok(JSON.parse(d)); } catch { ok(null); } });
    }).on("error", () => ok(null));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  console.log("═══ FULL HISTORICAL ANALYSIS ═══\n");

  // ── Collect all codes to scan ──
  const allCodes = new Set();
  const codeSource = {}; // code → {punter, date, group}

  // From leaderboard
  const lb = await get("/api/leaderboard");
  for (const p of lb?.leaderboard || []) {
    for (const c of p.codes || []) {
      if (c.code) { allCodes.add(c.code); codeSource[c.code] = { punter: p.punter, date: c.date, group: c.group || "" }; }
    }
  }

  // From code-history
  try {
    const ch = JSON.parse(fs.readFileSync(path.join(DATA, "code-history.json"), "utf-8"));
    for (const c of ch) {
      if (c.code && c.code !== "FAILED") { allCodes.add(c.code); if (!codeSource[c.code]) codeSource[c.code] = { punter: c.punter, date: c.date, group: c.group || "" }; }
    }
  } catch {}

  // From punter-profiles
  try {
    const pp = JSON.parse(fs.readFileSync(path.join(DATA, "punter-profiles.json"), "utf-8"));
    for (const [name, prof] of Object.entries(pp)) {
      for (const c of prof.codes || []) {
        if (c.code) { allCodes.add(c.code); if (!codeSource[c.code]) codeSource[c.code] = { punter: name, date: c.date }; }
      }
    }
  } catch {}

  // From punters.json
  try {
    const punters = JSON.parse(fs.readFileSync(path.join(DATA, "punters.json"), "utf-8"));
    for (const p of punters) {
      for (const s of p.slips || []) {
        if (s.code) { allCodes.add(s.code); if (!codeSource[s.code]) codeSource[s.code] = { punter: p.name, date: s.date?.slice(0, 10) }; }
      }
    }
  } catch {}

  console.log("Total unique codes to scan: " + allCodes.size);

  // ── Scan every code ──
  const allSelections = []; // every individual selection with verdict
  const codeResults = [];   // per-code summary
  let scanned = 0, failed = 0;

  for (const code of allCodes) {
    try {
      const r = await get("/api/scan/" + code);
      if (!r || r.error || !r.results) { failed++; continue; }

      const src = codeSource[code] || {};
      codeResults.push({
        code, punter: src.punter || "Unknown", date: src.date || "", group: src.group || "",
        total: r.total, won: r.won, lost: r.lost, void: r.void, pending: r.pending, hitRate: r.hitRate,
      });

      for (const sel of r.results) {
        allSelections.push({
          code, punter: src.punter || "Unknown", date: src.date || "",
          eventId: sel.eventId, homeTeam: sel.homeTeam, awayTeam: sel.awayTeam,
          league: sel.league, category: sel.category,
          market: sel.market, outcome: sel.outcome, odds: sel.odds,
          kickoff: sel.kickoff, verdict: sel.verdict,
          sport: sel.sport,
        });
      }
      scanned++;
    } catch { failed++; }

    if (scanned % 20 === 0) process.stdout.write("  Scanned " + scanned + "/" + allCodes.size + "...\r");
    await sleep(120);
  }

  console.log("\nScanned: " + scanned + " codes, " + failed + " failed, " + allSelections.length + " total selections\n");

  // ── Filter to settled selections only ──
  const settled = allSelections.filter((s) => s.verdict === "WON" || s.verdict === "LOST");
  const won = settled.filter((s) => s.verdict === "WON");
  const lost = settled.filter((s) => s.verdict === "LOST");
  console.log("Settled selections: " + settled.length + " (W:" + won.length + " L:" + lost.length + " = " + Math.round(won.length / settled.length * 100) + "% hit rate)\n");

  // ══════════════════════════════════════════
  //  STEP 2: PUNTER INTELLIGENCE
  // ══════════════════════════════════════════
  console.log("═══ STEP 2: PUNTER INTELLIGENCE ═══\n");

  const punterStats = {};
  for (const s of settled) {
    const p = s.punter;
    if (!punterStats[p]) punterStats[p] = {
      punter: p, total: 0, won: 0, lost: 0, odds: [], markets: {}, leagues: {},
      homeW: 0, homeL: 0, awayW: 0, awayL: 0,
      overW: 0, overL: 0, underW: 0, underL: 0,
      dcW: 0, dcL: 0, bttsW: 0, bttsL: 0, dnbW: 0, dnbL: 0,
      earlyW: 0, earlyL: 0, afternoonW: 0, afternoonL: 0, eveningW: 0, eveningL: 0,
      recent7: [], recent30: [],
    };
    const ps = punterStats[p];
    ps.total++;
    if (s.verdict === "WON") ps.won++; else ps.lost++;
    ps.odds.push(s.odds);

    // Market tracking
    const m = s.market || "Unknown";
    if (!ps.markets[m]) ps.markets[m] = { w: 0, l: 0 };
    if (s.verdict === "WON") ps.markets[m].w++; else ps.markets[m].l++;

    // League tracking
    const l = s.league || "Unknown";
    if (!ps.leagues[l]) ps.leagues[l] = { w: 0, l: 0 };
    if (s.verdict === "WON") ps.leagues[l].w++; else ps.leagues[l].l++;

    // Home/Away
    const out = (s.outcome || "").toLowerCase();
    if (out.includes("home") || out === "1") { if (s.verdict === "WON") ps.homeW++; else ps.homeL++; }
    if (out.includes("away") || out === "2") { if (s.verdict === "WON") ps.awayW++; else ps.awayL++; }

    // Market type
    const ml = m.toLowerCase();
    if (ml.includes("over")) { if (s.verdict === "WON") ps.overW++; else ps.overL++; }
    if (ml.includes("under")) { if (s.verdict === "WON") ps.underW++; else ps.underL++; }
    if (ml.includes("double chance")) { if (s.verdict === "WON") ps.dcW++; else ps.dcL++; }
    if (ml.includes("gg/ng") || ml.includes("btts")) { if (s.verdict === "WON") ps.bttsW++; else ps.bttsL++; }
    if (ml.includes("draw no bet")) { if (s.verdict === "WON") ps.dnbW++; else ps.dnbL++; }

    // Kickoff time
    if (s.kickoff) {
      const hour = new Date(s.kickoff).getUTCHours();
      if (hour < 14) { if (s.verdict === "WON") ps.earlyW++; else ps.earlyL++; }
      else if (hour < 18) { if (s.verdict === "WON") ps.afternoonW++; else ps.afternoonL++; }
      else { if (s.verdict === "WON") ps.eveningW++; else ps.eveningL++; }
    }
  }

  // Print punter intelligence
  const punterList = Object.values(punterStats).filter((p) => p.total >= 10 && p.punter !== "Generated");
  punterList.sort((a, b) => (b.won / b.total) - (a.won / a.total));

  for (const ps of punterList) {
    const hr = Math.round(ps.won / ps.total * 100);
    const avgOdds = (ps.odds.reduce((a, b) => a + b, 0) / ps.odds.length).toFixed(2);
    console.log("▸ " + ps.punter + " (" + ps.total + " games, " + hr + "% HR, avg " + avgOdds + " odds)");
    const pct = (w, l) => (w + l > 0 ? Math.round(w / (w + l) * 100) + "%" : "-");
    console.log("  Home: " + pct(ps.homeW, ps.homeL) + " | Away: " + pct(ps.awayW, ps.awayL) + " | Over: " + pct(ps.overW, ps.overL) + " | Under: " + pct(ps.underW, ps.underL));
    console.log("  DC: " + pct(ps.dcW, ps.dcL) + " | BTTS: " + pct(ps.bttsW, ps.bttsL) + " | DNB: " + pct(ps.dnbW, ps.dnbL));
    console.log("  Early(<2pm): " + pct(ps.earlyW, ps.earlyL) + " | Afternoon(2-6pm): " + pct(ps.afternoonW, ps.afternoonL) + " | Evening(6pm+): " + pct(ps.eveningW, ps.eveningL));

    // Best/worst leagues
    const leagueArr = Object.entries(ps.leagues).map(([l, d]) => ({ league: l, ...d, total: d.w + d.l, hr: d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0 })).filter((l) => l.total >= 3);
    const bestLeagues = leagueArr.sort((a, b) => b.hr - a.hr).slice(0, 3);
    const worstLeagues = leagueArr.sort((a, b) => a.hr - b.hr).slice(0, 3);
    if (bestLeagues.length) console.log("  Best leagues: " + bestLeagues.map((l) => l.league + "(" + l.hr + "%)").join(", "));
    if (worstLeagues.length) console.log("  Worst leagues: " + worstLeagues.map((l) => l.league + "(" + l.hr + "%)").join(", "));

    // Best/worst markets
    const mktArr = Object.entries(ps.markets).map(([m, d]) => ({ market: m, ...d, total: d.w + d.l, hr: d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0 })).filter((m) => m.total >= 3);
    const bestMkts = mktArr.sort((a, b) => b.hr - a.hr).slice(0, 3);
    const worstMkts = mktArr.sort((a, b) => a.hr - b.hr).slice(0, 3);
    if (bestMkts.length) console.log("  Best markets: " + bestMkts.map((m) => m.market + "(" + m.hr + "%)").join(", "));
    if (worstMkts.length) console.log("  Worst markets: " + worstMkts.map((m) => m.market + "(" + m.hr + "%)").join(", "));
    console.log("");
  }

  // ══════════════════════════════════════════
  //  STEP 4: HOME VS AWAY
  // ══════════════════════════════════════════
  console.log("═══ STEP 4: HOME VS AWAY ═══\n");
  const homeTotal = settled.filter((s) => (s.outcome || "").toLowerCase().includes("home"));
  const awayTotal = settled.filter((s) => (s.outcome || "").toLowerCase().includes("away"));
  const homeWin = homeTotal.filter((s) => s.verdict === "WON").length;
  const awayWin = awayTotal.filter((s) => s.verdict === "WON").length;
  console.log("Home picks: " + homeTotal.length + " total, " + homeWin + " won (" + Math.round(homeWin / homeTotal.length * 100) + "%)");
  console.log("Away picks: " + awayTotal.length + " total, " + awayWin + " won (" + Math.round(awayWin / awayTotal.length * 100) + "%)");

  // ══════════════════════════════════════════
  //  STEP 5: MARKET LEARNING
  // ══════════════════════════════════════════
  console.log("\n═══ STEP 5: MARKET LEARNING ═══\n");
  const marketGlobal = {};
  for (const s of settled) {
    const m = s.market || "Unknown";
    if (!marketGlobal[m]) marketGlobal[m] = { w: 0, l: 0 };
    if (s.verdict === "WON") marketGlobal[m].w++; else marketGlobal[m].l++;
  }
  const mktSorted = Object.entries(marketGlobal)
    .map(([m, d]) => ({ market: m, ...d, total: d.w + d.l, hr: Math.round(d.w / (d.w + d.l) * 100) }))
    .filter((m) => m.total >= 5)
    .sort((a, b) => b.hr - a.hr);
  console.log("Market Win Rates (min 5 samples):");
  mktSorted.forEach((m) => console.log("  " + m.market + ": " + m.hr + "% (" + m.w + "W/" + m.l + "L)"));

  // ══════════════════════════════════════════
  //  STEP 5b: CONVERSION LEARNING
  // ══════════════════════════════════════════
  console.log("\n═══ STEP 5b: CONVERSION ANALYSIS ═══\n");
  // For each lost selection, check if a safer market on same match won
  const matchResults = {};
  for (const s of allSelections) {
    if (!matchResults[s.eventId]) matchResults[s.eventId] = [];
    matchResults[s.eventId].push(s);
  }
  const conversionTable = {};
  for (const s of lost) {
    const matchSels = matchResults[s.eventId] || [];
    const winners = matchSels.filter((x) => x.verdict === "WON" && x.code !== s.code);
    for (const w of winners) {
      const key = s.market + " → " + w.market;
      if (!conversionTable[key]) conversionTable[key] = { count: 0, examples: [] };
      conversionTable[key].count++;
      if (conversionTable[key].examples.length < 2) conversionTable[key].examples.push(s.homeTeam + " vs " + s.awayTeam);
    }
  }
  const convSorted = Object.entries(conversionTable).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  console.log("When X lost, Y on the same match won:");
  convSorted.forEach(([key, d]) => console.log("  " + key + ": " + d.count + " times"));

  // ══════════════════════════════════════════
  //  STEP 6: MATCH EXPOSURE
  // ══════════════════════════════════════════
  console.log("\n═══ STEP 6: MATCH EXPOSURE ═══\n");
  const matchExposure = {};
  for (const s of settled) {
    const key = s.homeTeam + " vs " + s.awayTeam;
    if (!matchExposure[key]) matchExposure[key] = { match: key, league: s.league, appearances: 0, wins: 0, losses: 0 };
    matchExposure[key].appearances++;
    if (s.verdict === "WON") matchExposure[key].wins++; else matchExposure[key].losses++;
  }
  const dangerous = Object.values(matchExposure).filter((m) => m.losses >= 3).sort((a, b) => b.losses - a.losses).slice(0, 10);
  const reliable = Object.values(matchExposure).filter((m) => m.wins >= 3 && m.losses === 0).sort((a, b) => b.wins - a.wins).slice(0, 10);
  console.log("Most Dangerous Matches (3+ losses):");
  dangerous.forEach((m) => console.log("  " + m.match + " [" + m.league + "]: " + m.losses + "L/" + m.wins + "W"));
  console.log("\nMost Reliable Matches (3+ wins, 0 losses):");
  reliable.forEach((m) => console.log("  " + m.match + " [" + m.league + "]: " + m.wins + "W/0L"));

  // ══════════════════════════════════════════
  //  STEP 7: TIME ANALYSIS
  // ══════════════════════════════════════════
  console.log("\n═══ STEP 7: TIME ANALYSIS ═══\n");
  const timeSlots = { "12-2pm": { w: 0, l: 0 }, "2-4pm": { w: 0, l: 0 }, "4-6pm": { w: 0, l: 0 }, "6-8pm": { w: 0, l: 0 }, "8pm+": { w: 0, l: 0 } };
  for (const s of settled) {
    if (!s.kickoff) continue;
    const h = new Date(s.kickoff).getUTCHours();
    const slot = h < 14 ? "12-2pm" : h < 16 ? "2-4pm" : h < 18 ? "4-6pm" : h < 20 ? "6-8pm" : "8pm+";
    if (s.verdict === "WON") timeSlots[slot].w++; else timeSlots[slot].l++;
  }
  for (const [slot, d] of Object.entries(timeSlots)) {
    const total = d.w + d.l;
    console.log("  " + slot + ": " + (total > 0 ? Math.round(d.w / total * 100) : 0) + "% (" + d.w + "W/" + d.l + "L)");
  }

  // ══════════════════════════════════════════
  //  STEP 8: CONSENSUS ANALYSIS
  // ══════════════════════════════════════════
  console.log("\n═══ STEP 8: CONSENSUS ANALYSIS ═══\n");
  // Group selections by eventId, count unique punters
  const eventPunters = {};
  for (const s of settled) {
    if (!eventPunters[s.eventId]) eventPunters[s.eventId] = { punters: new Set(), won: false, lost: false };
    eventPunters[s.eventId].punters.add(s.punter);
    if (s.verdict === "WON") eventPunters[s.eventId].won = true;
    if (s.verdict === "LOST") eventPunters[s.eventId].lost = true;
  }
  const consensusLevels = { 1: { w: 0, l: 0 }, 2: { w: 0, l: 0 }, 3: { w: 0, l: 0 }, 4: { w: 0, l: 0 }, "5+": { w: 0, l: 0 } };
  for (const ev of Object.values(eventPunters)) {
    const level = ev.punters.size >= 5 ? "5+" : String(ev.punters.size);
    if (ev.won && !ev.lost) consensusLevels[level].w++;
    else if (ev.lost) consensusLevels[level].l++;
  }
  for (const [level, d] of Object.entries(consensusLevels)) {
    const total = d.w + d.l;
    console.log("  " + level + " punter(s): " + (total > 0 ? Math.round(d.w / total * 100) : 0) + "% (" + d.w + "W/" + d.l + "L, " + total + " matches)");
  }

  // ══════════════════════════════════════════
  //  STEP 5c: ODDS RANGE ANALYSIS
  // ══════════════════════════════════════════
  console.log("\n═══ ODDS RANGE ANALYSIS ═══\n");
  const oddsRanges = { "1.01-1.15": { w: 0, l: 0 }, "1.15-1.25": { w: 0, l: 0 }, "1.25-1.35": { w: 0, l: 0 }, "1.35-1.50": { w: 0, l: 0 }, "1.50-1.75": { w: 0, l: 0 }, "1.75-2.00": { w: 0, l: 0 }, "2.00+": { w: 0, l: 0 } };
  for (const s of settled) {
    const o = s.odds || 0;
    const range = o < 1.15 ? "1.01-1.15" : o < 1.25 ? "1.15-1.25" : o < 1.35 ? "1.25-1.35" : o < 1.50 ? "1.35-1.50" : o < 1.75 ? "1.50-1.75" : o < 2.00 ? "1.75-2.00" : "2.00+";
    if (s.verdict === "WON") oddsRanges[range].w++; else oddsRanges[range].l++;
  }
  for (const [range, d] of Object.entries(oddsRanges)) {
    const total = d.w + d.l;
    console.log("  " + range + ": " + (total > 0 ? Math.round(d.w / total * 100) : 0) + "% (" + d.w + "W/" + d.l + "L)");
  }

  // ══════════════════════════════════════════
  //  STEP 6b: LEAGUE GLOBAL ANALYSIS
  // ══════════════════════════════════════════
  console.log("\n═══ LEAGUE WIN RATES ═══\n");
  const leagueGlobal = {};
  for (const s of settled) {
    const l = s.league || "Unknown";
    if (!leagueGlobal[l]) leagueGlobal[l] = { w: 0, l: 0 };
    if (s.verdict === "WON") leagueGlobal[l].w++; else leagueGlobal[l].l++;
  }
  const lgSorted = Object.entries(leagueGlobal)
    .map(([l, d]) => ({ league: l, ...d, total: d.w + d.l, hr: Math.round(d.w / (d.w + d.l) * 100) }))
    .filter((l) => l.total >= 5)
    .sort((a, b) => b.hr - a.hr);
  lgSorted.forEach((l) => console.log("  " + l.league + ": " + l.hr + "% (" + l.w + "W/" + l.l + "L)"));

  // ══════════════════════════════════════════
  //  STEP 9: BUILD LEARNING REPORT
  // ══════════════════════════════════════════
  console.log("\n═══ STEP 9: SAVING LEARNING REPORT ═══\n");

  const report = {
    generatedAt: new Date().toISOString(),
    totalCodesScanned: scanned,
    totalSelections: allSelections.length,
    settledSelections: settled.length,
    globalHitRate: Math.round(won.length / settled.length * 100),

    bestPunters: punterList.slice(0, 20).map((p) => ({
      punter: p.punter,
      total: p.total, won: p.won, lost: p.lost,
      hitRate: Math.round(p.won / p.total * 100),
      avgOdds: +(p.odds.reduce((a, b) => a + b, 0) / p.odds.length).toFixed(3),
      homeHR: p.homeW + p.homeL > 0 ? Math.round(p.homeW / (p.homeW + p.homeL) * 100) : null,
      awayHR: p.awayW + p.awayL > 0 ? Math.round(p.awayW / (p.awayW + p.awayL) * 100) : null,
      overHR: p.overW + p.overL > 0 ? Math.round(p.overW / (p.overW + p.overL) * 100) : null,
      dcHR: p.dcW + p.dcL > 0 ? Math.round(p.dcW / (p.dcW + p.dcL) * 100) : null,
      bestLeagues: Object.entries(p.leagues).map(([l, d]) => ({ league: l, hr: d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0, total: d.w + d.l })).filter((x) => x.total >= 3).sort((a, b) => b.hr - a.hr).slice(0, 5),
      bestMarkets: Object.entries(p.markets).map(([m, d]) => ({ market: m, hr: d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0, total: d.w + d.l })).filter((x) => x.total >= 3).sort((a, b) => b.hr - a.hr).slice(0, 5),
    })),

    bestMarkets: mktSorted.slice(0, 20),
    bestLeagues: lgSorted.slice(0, 20),
    oddsRanges: Object.fromEntries(Object.entries(oddsRanges).map(([r, d]) => [r, { ...d, hr: d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0 }])),
    timeSlots: Object.fromEntries(Object.entries(timeSlots).map(([s, d]) => [s, { ...d, hr: d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0 }])),
    consensusLevels: Object.fromEntries(Object.entries(consensusLevels).map(([l, d]) => [l, { ...d, hr: d.w + d.l > 0 ? Math.round(d.w / (d.w + d.l) * 100) : 0 }])),
    conversions: convSorted.map(([key, d]) => ({ conversion: key, count: d.count })),
    dangerousMatches: dangerous,
    reliableMatches: reliable,
    homeVsAway: {
      homePicksHR: homeTotal.length > 0 ? Math.round(homeWin / homeTotal.length * 100) : 0,
      awayPicksHR: awayTotal.length > 0 ? Math.round(awayWin / awayTotal.length * 100) : 0,
    },
  };

  fs.writeFileSync(path.join(DATA, "learning-report.json"), JSON.stringify(report, null, 2));
  console.log("Saved: data/learning-report.json");

  // ══════════════════════════════════════════
  //  STEP 10: RECOMMENDATIONS
  // ══════════════════════════════════════════
  console.log("\n═══ STEP 10: RECOMMENDATIONS FOR TOMORROW ═══\n");

  console.log("TOP PUNTER PATTERNS:");
  report.bestPunters.slice(0, 10).forEach((p, i) => {
    console.log("  " + (i + 1) + ". " + p.punter + " (" + p.hitRate + "% over " + p.total + " games, avg " + p.avgOdds + " odds)");
    if (p.bestLeagues.length) console.log("     Best leagues: " + p.bestLeagues.slice(0, 3).map((l) => l.league + "(" + l.hr + "%)").join(", "));
    if (p.bestMarkets.length) console.log("     Best markets: " + p.bestMarkets.slice(0, 3).map((m) => m.market + "(" + m.hr + "%)").join(", "));
  });

  console.log("\nTOP MARKET PATTERNS:");
  report.bestMarkets.slice(0, 10).forEach((m, i) => console.log("  " + (i + 1) + ". " + m.market + ": " + m.hr + "% (" + m.total + " samples)"));

  console.log("\nTOP LEAGUE PATTERNS:");
  report.bestLeagues.slice(0, 10).forEach((l, i) => console.log("  " + (i + 1) + ". " + l.league + ": " + l.hr + "% (" + l.total + " samples)"));

  console.log("\nODDS SWEET SPOT:");
  for (const [range, d] of Object.entries(report.oddsRanges)) {
    const total = d.w + d.l;
    if (total >= 5) console.log("  " + range + ": " + d.hr + "% (" + total + " samples)");
  }

  console.log("\nBEST TIME WINDOWS:");
  for (const [slot, d] of Object.entries(report.timeSlots)) {
    const total = d.w + d.l;
    if (total >= 5) console.log("  " + slot + ": " + d.hr + "% (" + total + " samples)");
  }

  console.log("\nCONSENSUS PROOF:");
  for (const [level, d] of Object.entries(report.consensusLevels)) {
    const total = d.w + d.l;
    if (total >= 2) console.log("  " + level + " punter(s): " + d.hr + "% (" + total + " matches)");
  }

  console.log("\nRECOMMENDED STRATEGY:");
  console.log("  Games per slip: 8-12");
  console.log("  Max odds per pick: 1.45");
  console.log("  Target total odds: 30-300x");
  console.log("  Flex: 1-2 per slip");
  console.log("  Total codes: 20");
  console.log("  Bankroll ₦1,000:");
  console.log("    10 × ₦50 (banker, 8-10 games)");
  console.log("    10 × ₦50 (solid, 10-12 games)");

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n═══ DONE in " + elapsed + "s ═══");
})();
