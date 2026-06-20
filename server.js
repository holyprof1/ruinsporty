require("dotenv").config();
const express = require("express");
const https = require("https");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

const DEBUG_DIR = path.join(__dirname, "debug", "markets");
const H2H_DEBUG_DIR = path.join(__dirname, "debug", "h2h");
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(H2H_DEBUG_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Helpers ──

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid JSON response"));
          }
        });
      })
      .on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid JSON from POST"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Stats ──

const STATS_FILE = path.join(DATA_DIR, "stats.json");

const STATS_BASELINE = {
  slipsLoaded: 48291,
  codesGenerated: 31847,
  slipsScanned: 12903,
  puntersTracked: 4721,
  slipsMerged: 8834,
  slipsSplit: 3201,
};

function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
    const merged = { ...STATS_BASELINE };
    for (const k of Object.keys(merged)) merged[k] += (raw[k] || 0);
    if (raw.puntersSaved && !raw.puntersTracked) merged.puntersTracked += raw.puntersSaved;
    return merged;
  } catch {
    return { ...STATS_BASELINE };
  }
}

function saveStats(data) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
}

function incrementStat(key) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")); } catch { raw = {}; }
  raw[key] = (raw[key] || 0) + 1;
  saveStats(raw);
}

app.get("/api/stats", (req, res) => {
  res.json(loadStats());
});

// ── Punters ──

const PUNTERS_FILE = path.join(DATA_DIR, "punters.json");

function loadPunters() {
  try {
    return JSON.parse(fs.readFileSync(PUNTERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function savePunters(data) {
  fs.writeFileSync(PUNTERS_FILE, JSON.stringify(data, null, 2));
}

// ── Selection mapper (shared by booking, scan, merge) ──

function mapOutcomes(outcomes, ticketSelections) {
  const ticketMap = new Map();
  (ticketSelections || []).forEach((ts) => ticketMap.set(ts.eventId, ts));

  return outcomes.map((o) => {
    const mkt = o.markets && o.markets[0] ? o.markets[0] : {};
    const oc = mkt.outcomes && mkt.outcomes[0] ? mkt.outcomes[0] : {};
    const ts = ticketMap.get(o.eventId) || {};

    return {
      eventId: o.eventId || "",
      homeTeam: o.homeTeamName || "",
      awayTeam: o.awayTeamName || "",
      sport: o.sport?.name || "",
      sportId: o.sport?.id || ts.sportId || "",
      league: o.sport?.category?.tournament?.name || "",
      category: o.sport?.category?.name || "",
      market: mkt.desc || "",
      marketId: ts.marketId || mkt.id || "",
      specifier: ts.specifier || mkt.specifier || "",
      outcome: oc.desc || "",
      outcomeId: ts.outcomeId || oc.id || "",
      productId: ts.productId || mkt.product || 3,
      odds: parseFloat(oc.odds) || 0,
      kickoff: o.estimateStartTime
        ? new Date(Number(o.estimateStartTime)).toISOString()
        : "",
      matchStatus: o.matchStatus || "",
      score: o.setScore || null,
      halfScores: o.gameScore || [],
      isWinning: oc.isWinning,
      refundFactor: oc.refundFactor,
    };
  });
}

function evaluateVerdict(sel) {
  if (sel.matchStatus !== "Ended") return "PENDING";
  if (sel.isWinning === 1) return "WON";
  if (sel.refundFactor === 1) return "VOID";
  if (sel.isWinning === 0) return "LOST";
  return "PENDING";
}

// ── Booking ──

app.get("/api/booking/:code", async (req, res) => {
  const code = req.params.code.trim();
  if (!code) return res.status(400).json({ error: "Booking code required" });

  try {
    const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
    const json = await fetchJSON(url);

    if (!json || json.bizCode !== 10000 || !json.data) {
      const msg = json?.message || json?.innerMsg || "Booking code not found";
      return res.status(404).json({ error: msg });
    }

    const outcomes = json.data.outcomes || [];
    const ticketSels = json.data.ticket?.selections || [];
    const selections = mapOutcomes(outcomes, ticketSels);
    const totalOdds = selections.reduce((acc, s) => acc * s.odds, 1);

    incrementStat("slipsLoaded");

    res.json({
      shareCode: json.data.shareCode || code,
      selections,
      totalOdds: Math.round(totalOdds * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch booking" });
  }
});

// ── Generate ──

app.post("/api/generate", async (req, res) => {
  const { selections } = req.body;
  if (!selections || !Array.isArray(selections) || selections.length === 0) {
    return res.status(400).json({ error: "No selections provided" });
  }

  const payload = selections.map((s) => {
    const entry = {
      eventId: s.eventId,
      marketId: s.marketId,
      outcomeId: s.outcomeId,
      productId: s.productId || 3,
      sportId: s.sportId,
      parentBetBuilderMarketId: "",
    };
    if (s.specifier) entry.specifier = s.specifier;
    return entry;
  });

  try {
    console.log("[Generate] POST", payload.length, "selections");
    const json = await postJSON(
      "https://www.sportybet.com/api/ng/orders/share",
      { selections: payload }
    );
    console.log("[Generate] Response:", JSON.stringify(json).slice(0, 300));

    if (json.bizCode === 10000 && json.data?.shareCode) {
      incrementStat("codesGenerated");
      return res.json({
        success: true,
        shareCode: json.data.shareCode,
        shareURL: json.data.shareURL || "",
        selectionsCount: payload.length,
      });
    }

    return res.status(400).json({
      success: false,
      error: json.message || json.innerMsg || "Unknown error",
      bizCode: json.bizCode,
      rawResponse: json,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Market Explorer ──

app.get("/api/markets/:eventId", async (req, res) => {
  const eventId = req.params.eventId;
  if (!eventId) return res.status(400).json({ error: "eventId required" });

  try {
    const url = `https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(eventId)}`;
    const json = await fetchJSON(url);

    if (!json || json.bizCode !== 10000 || !json.data) {
      return res.status(404).json({ error: json?.message || "Event not found" });
    }

    const d = json.data;
    const safeId = eventId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const debugPath = path.join(DEBUG_DIR, `${safeId}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(d, null, 2));

    const allMarkets = (d.markets || []).flatMap((m) =>
      (m.outcomes || [])
        .filter((o) => o.isActive === 1)
        .map((o) => ({
          marketId: m.id,
          marketName: m.desc || "",
          specifier: m.specifier || "",
          group: m.group || "",
          outcomeId: o.id,
          outcomeName: o.desc || "",
          odds: parseFloat(o.odds) || 0,
        }))
    );

    res.json({
      eventId: d.eventId,
      homeTeam: d.homeTeamName || "",
      awayTeam: d.awayTeamName || "",
      sport: d.sport?.name || "",
      sportId: d.sport?.id || "",
      league: d.sport?.category?.tournament?.name || "",
      marketCount: (d.markets || []).length,
      outcomeCount: allMarkets.length,
      markets: allMarkets,
      debugFile: `debug/markets/${safeId}.json`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/debug/markets/:file", (req, res) => {
  const filePath = path.join(DEBUG_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "application/json");
  fs.createReadStream(filePath).pipe(res);
});

// ── Result Scanner ──

app.get("/api/scan/:code", async (req, res) => {
  const code = req.params.code.trim();
  if (!code) return res.status(400).json({ error: "Booking code required" });

  try {
    const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
    const json = await fetchJSON(url);

    if (!json || json.bizCode !== 10000 || !json.data) {
      const msg = json?.message || json?.innerMsg || "Booking code not found";
      return res.status(404).json({ error: msg });
    }

    const outcomes = json.data.outcomes || [];
    const ticketSels = json.data.ticket?.selections || [];
    const selections = mapOutcomes(outcomes, ticketSels);
    const results = selections.map((s) => ({ ...s, verdict: evaluateVerdict(s) }));

    const won = results.filter((r) => r.verdict === "WON").length;
    const lost = results.filter((r) => r.verdict === "LOST").length;
    const voided = results.filter((r) => r.verdict === "VOID").length;
    const pending = results.filter((r) => r.verdict === "PENDING").length;
    const settled = won + lost;
    const hitRate = settled > 0 ? Math.round((won / settled) * 100) : 0;

    incrementStat("slipsScanned");

    res.json({
      shareCode: json.data.shareCode || code,
      total: results.length,
      won, lost, void: voided, pending, hitRate,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Merger ──

app.post("/api/merge", async (req, res) => {
  const { codes } = req.body;
  if (!codes || !Array.isArray(codes) || codes.length < 2) {
    return res.status(400).json({ error: "At least 2 booking codes required" });
  }

  try {
    const allSelections = [];
    const seenEvents = new Map();
    const conflicts = [];
    const sourceMap = {};
    let totalOriginal = 0;

    for (const code of codes) {
      const trimmed = code.trim();
      if (!trimmed) continue;
      const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(trimmed)}`;
      const json = await fetchJSON(url);

      if (!json || json.bizCode !== 10000 || !json.data) continue;

      const outcomes = json.data.outcomes || [];
      const ticketSels = json.data.ticket?.selections || [];
      const mapped = mapOutcomes(outcomes, ticketSels);
      totalOriginal += mapped.length;

      mapped.forEach((s) => {
        const existing = seenEvents.get(s.eventId);
        s.sourceCode = trimmed;
        if (existing) {
          conflicts.push({
            eventId: s.eventId,
            homeTeam: s.homeTeam,
            awayTeam: s.awayTeam,
            options: [existing, s],
          });
          return;
        }
        seenEvents.set(s.eventId, s);
        s.sourceCode = trimmed;
        allSelections.push(s);
      });

      sourceMap[trimmed] = mapped.length;
    }

    incrementStat("slipsMerged");

    res.json({
      mergedCount: allSelections.length,
      totalOriginal,
      dupesRemoved: totalOriginal - allSelections.length,
      sourceMap,
      conflicts,
      selections: allSelections,
      totalOdds: Math.round(allSelections.reduce((a, s) => a * s.odds, 1) * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Splitter ──

app.post("/api/split", (req, res) => {
  const { selections, count, method } = req.body;
  if (!selections || !Array.isArray(selections) || !count || count < 2) {
    return res.status(400).json({ error: "selections array and count (>=2) required" });
  }

  const slips = Array.from({ length: count }, () => []);

  if (method === "random") {
    const shuffled = [...selections].sort(() => Math.random() - 0.5);
    shuffled.forEach((s, i) => slips[i % count].push(s));
  } else if (method === "byOdds") {
    const sorted = [...selections].sort((a, b) => b.odds - a.odds);
    sorted.forEach((s) => {
      let minIdx = 0;
      let minOdds = Infinity;
      slips.forEach((slip, idx) => {
        const odds = slip.length === 0 ? 1 : slip.reduce((a, x) => a * x.odds, 1);
        if (odds < minOdds) { minOdds = odds; minIdx = idx; }
      });
      slips[minIdx].push(s);
    });
  } else if (method === "sequential") {
    const chunkSize = Math.ceil(selections.length / count);
    selections.forEach((s, i) => {
      const idx = Math.min(Math.floor(i / chunkSize), count - 1);
      slips[idx].push(s);
    });
  } else {
    selections.forEach((s, i) => slips[i % count].push(s));
  }

  incrementStat("slipsSplit");

  res.json({
    originalCount: selections.length,
    slipCount: slips.length,
    slips: slips.map((s, i) => ({
      index: i,
      count: s.length,
      totalOdds: s.length > 0 ? Math.round(s.reduce((a, x) => a * x.odds, 1) * 100) / 100 : 0,
      selections: s,
    })),
  });
});

// H2H / Match stats

function fetchJSONWithStatus(url) {
  return new Promise((resolve) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json",
            Referer: "https://www.sportybet.com/ng/",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode, json: JSON.parse(body), raw: body });
            } catch {
              resolve({ status: res.statusCode, json: null, raw: body });
            }
          });
        }
      )
      .on("error", (err) => resolve({ status: 0, json: null, raw: err.message }));
  });
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeMatch(item) {
  const home = item.homeTeamName || item.homeTeam || item.homeName || item.competitor1Name || item.strHomeTeam;
  const away = item.awayTeamName || item.awayTeam || item.awayName || item.competitor2Name || item.strAwayTeam;
  const homeScore = toInt(item.homeScore ?? item.homeTeamScore ?? item.score1 ?? item.intHomeScore);
  const awayScore = toInt(item.awayScore ?? item.awayTeamScore ?? item.score2 ?? item.intAwayScore);
  const rawDate = item.date || item.matchDate || item.startTime || item.estimateStartTime || item.dateEvent;
  const date = rawDate && /^\d+$/.test(String(rawDate)) ? new Date(Number(rawDate)).toISOString().slice(0, 10) : rawDate;
  if (!home || !away || homeScore === null || awayScore === null) return null;
  return { date: date || "", home, away, homeScore, awayScore };
}

function collectMatches(node, out = []) {
  if (!node || out.length >= 30) return out;
  if (Array.isArray(node)) {
    for (const item of node) {
      const match = item && typeof item === "object" ? normalizeMatch(item) : null;
      if (match) out.push(match);
      else collectMatches(item, out);
    }
    return out;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) collectMatches(value, out);
  }
  return out;
}

function resultFor(match, team) {
  const isHome = String(match.home).toLowerCase() === String(team).toLowerCase();
  const goalsFor = isHome ? match.homeScore : match.awayScore;
  const goalsAgainst = isHome ? match.awayScore : match.homeScore;
  if (goalsFor > goalsAgainst) return "W";
  if (goalsFor < goalsAgainst) return "L";
  return "D";
}

function buildForm(matches, team) {
  if (!team) return [];
  return matches
    .filter((m) => [m.home, m.away].some((name) => String(name).toLowerCase() === String(team).toLowerCase()))
    .slice(0, 5)
    .map((m) => ({ ...m, result: resultFor(m, team) }));
}

function keyStats(matches) {
  const usable = matches.filter((m) => Number.isFinite(m.homeScore) && Number.isFinite(m.awayScore));
  if (!usable.length) return { avgGoals: null, bttsPct: null, over25Pct: null };
  const avgGoals = usable.reduce((sum, m) => sum + m.homeScore + m.awayScore, 0) / usable.length;
  const btts = usable.filter((m) => m.homeScore > 0 && m.awayScore > 0).length;
  const over25 = usable.filter((m) => m.homeScore + m.awayScore > 2.5).length;
  return {
    avgGoals: Math.round(avgGoals * 10) / 10,
    bttsPct: Math.round((btts / usable.length) * 100),
    over25Pct: Math.round((over25 / usable.length) * 100),
  };
}

function confidenceFromStats(stats) {
  if (stats.avgGoals !== null && stats.avgGoals > 3) return "Strong";
  if (stats.bttsPct !== null && stats.bttsPct < 40) return "Risky";
  return "Neutral";
}

async function sportyStats(eventId, home, away) {
  if (!eventId) return null;
  const encoded = encodeURIComponent(eventId);
  const endpoints = [
    `https://www.sportybet.com/api/ng/factsCenter/eventH2h?eventId=${encoded}`,
    `https://www.sportybet.com/api/ng/factsCenter/h2h?eventId=${encoded}`,
    `https://www.sportybet.com/api/ng/factsCenter/matchSummary?eventId=${encoded}`,
    `https://www.sportybet.com/api/ng/factsCenter/stats?eventId=${encoded}`,
    `https://www.sportybet.com/api/ng/factsCenter/preMatchStats?eventId=${encoded}`,
    `https://www.sportybet.com/api/ng/factsCenter/timeline?eventId=${encoded}`,
  ];
  const responses = [];
  for (const url of endpoints) {
    const response = await fetchJSONWithStatus(url);
    responses.push({
      url,
      status: response.status,
      body: response.json || response.raw,
    });
  }

  const safeId = eventId.replace(/[^a-zA-Z0-9_-]/g, "_");
  fs.writeFileSync(path.join(H2H_DEBUG_DIR, `${safeId}.json`), JSON.stringify(responses, null, 2));

  const matches = responses.flatMap((r) => collectMatches(r.body)).slice(0, 15);
  const h2h = matches
    .filter((m) => {
      const names = [m.home.toLowerCase(), m.away.toLowerCase()];
      return names.includes(String(home).toLowerCase()) && names.includes(String(away).toLowerCase());
    })
    .slice(0, 5);
  const stats = keyStats(h2h.length ? h2h : matches);

  return {
    source: matches.length ? "SportyBet" : "SportyBet raw",
    found: matches.length > 0,
    h2h,
    homeForm: buildForm(matches, home),
    awayForm: buildForm(matches, away),
    keyStats: stats,
    confidence: confidenceFromStats(stats),
    debugFile: `debug/h2h/${safeId}.json`,
  };
}

async function fallbackStats(home, away) {
  const query = away ? `${home}_vs_${away}` : home;
  const searchUrl = `https://www.thesportsdb.com/api/v1/json/3/searchevents.php?e=${encodeURIComponent(query)}`;
  const searchJson = await fetchJSON(searchUrl);
  const events = (searchJson?.event || []).map(normalizeMatch).filter(Boolean).slice(0, 5);

  const fetchForm = async (teamName) => {
    if (!teamName) return [];
    const teamUrl = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(teamName)}`;
    const teamJson = await fetchJSON(teamUrl);
    const team = teamJson?.teams?.[0] || null;
    if (!team?.idTeam) return [];
    const lastUrl = `https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=${team.idTeam}`;
    const lastJson = await fetchJSON(lastUrl);
    return (lastJson?.results || []).map(normalizeMatch).filter(Boolean).slice(0, 5);
  };

  const [homeLast, awayLast] = await Promise.all([fetchForm(home), fetchForm(away)]);
  const stats = keyStats(events);
  return {
    source: "fallback",
    found: events.length > 0 || homeLast.length > 0 || awayLast.length > 0,
    h2h: events,
    homeForm: buildForm(homeLast, home),
    awayForm: buildForm(awayLast, away),
    keyStats: stats,
    confidence: confidenceFromStats(stats),
  };
}

app.get("/api/h2h", async (req, res) => {
  const { eventId, home, away } = req.query;
  if (!home) return res.status(400).json({ error: "home team required" });

  try {
    const sporty = await sportyStats(eventId, home, away);
    if (sporty?.found) return res.json(sporty);
    const fallback = await fallbackStats(home, away);
    res.json({
      ...fallback,
      sportyDebugFile: sporty?.debugFile || null,
    });
  } catch (err) {
    res.json({ h2h: [], homeForm: [], awayForm: [], keyStats: {}, found: false, error: err.message });
  }
});

// Legacy H2H fallback

app.get("/api/h2h-fallback", async (req, res) => {
  const { home, away } = req.query;
  if (!home) return res.status(400).json({ error: "home team required" });

  try {
    const query = away ? `${home}_vs_${away}` : home;
    const searchUrl = `https://www.thesportsdb.com/api/v1/json/3/searchevents.php?e=${encodeURIComponent(query)}`;
    const searchJson = await fetchJSON(searchUrl);
    const events = searchJson?.event || [];

    const teamUrl = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(home)}`;
    const teamJson = await fetchJSON(teamUrl);
    const team = teamJson?.teams?.[0] || null;

    let lastEvents = [];
    if (team?.idTeam) {
      const lastUrl = `https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=${team.idTeam}`;
      const lastJson = await fetchJSON(lastUrl);
      lastEvents = (lastJson?.results || []).map((e) => ({
        date: e.dateEvent,
        home: e.strHomeTeam,
        away: e.strAwayTeam,
        homeScore: e.intHomeScore,
        awayScore: e.intAwayScore,
      }));
    }

    res.json({
      h2h: events.slice(0, 5).map((e) => ({
        date: e.dateEvent,
        home: e.strHomeTeam,
        away: e.strAwayTeam,
        homeScore: e.intHomeScore,
        awayScore: e.intAwayScore,
      })),
      teamForm: lastEvents,
      teamBadge: team?.strBadge || null,
      teamName: team?.strTeam || home,
      found: events.length > 0 || lastEvents.length > 0,
    });
  } catch (err) {
    res.json({ h2h: [], teamForm: [], found: false, error: err.message });
  }
});

// ── Punters CRUD ──

app.post("/api/punters", (req, res) => {
  const { name, code, results } = req.body;
  if (!name || !code || !results) {
    return res.status(400).json({ error: "name, code, and results required" });
  }

  const punters = loadPunters();
  const won = results.filter((r) => r.verdict === "WON").length;
  const lost = results.filter((r) => r.verdict === "LOST").length;
  const voided = results.filter((r) => r.verdict === "VOID").length;
  const settled = won + lost;

  const slip = {
    code,
    date: new Date().toISOString(),
    total: results.length,
    won, lost, void: voided,
    hitRate: settled > 0 ? Math.round((won / settled) * 100) : 0,
  };

  const existing = punters.find((p) => p.name === name);
  if (existing) {
    if (!existing.slips.some((s) => s.code === code)) {
      existing.slips.push(slip);
    }
  } else {
    punters.push({ name, slips: [slip] });
  }

  savePunters(punters);
  incrementStat("puntersTracked");
  res.json({ success: true });
});

app.get("/api/punters", (req, res) => {
  const punters = loadPunters();

  const leaderboard = punters.map((p) => {
    const totalWon = p.slips.reduce((a, s) => a + s.won, 0);
    const totalLost = p.slips.reduce((a, s) => a + s.lost, 0);
    const totalVoid = p.slips.reduce((a, s) => a + (s.void || 0), 0);
    const totalGames = p.slips.reduce((a, s) => a + s.total, 0);
    const settled = totalWon + totalLost;

    return {
      name: p.name,
      sharePath: `/punter/${encodeURIComponent(p.name)}`,
      slips: p.slips,
      slipCount: p.slips.length,
      totalGames,
      won: totalWon,
      lost: totalLost,
      void: totalVoid,
      hitRate: settled > 0 ? Math.round((totalWon / settled) * 100) : 0,
    };
  }).sort((a, b) => b.hitRate - a.hitRate || b.won - a.won);

  leaderboard.forEach((p, i) => {
    p.rank = i + 1;
  });

  res.json({ leaderboard });
});

app.delete("/api/punters/:name", (req, res) => {
  const adminPw = req.headers["x-admin-password"];
  if (adminPw !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const punters = loadPunters();
  const idx = punters.findIndex((p) => p.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: "Punter not found" });
  punters.splice(idx, 1);
  savePunters(punters);
  res.json({ success: true });
});

// ── Admin ──

app.post("/api/admin/verify", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(403).json({ success: false, error: "Wrong password" });
  }
});

app.get("/punter/:name", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ──

app.listen(PORT, () => {
  console.log(`SlipPilot running at http://localhost:${PORT}`);
});
