process.on("uncaughtException", err => console.error("Uncaught:", err));
process.on("unhandledRejection", err => console.error("Unhandled:", err));
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const https = require("https");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const DEBUG_DIR = path.join(__dirname, "debug", "markets");
const H2H_DEBUG_DIR = path.join(__dirname, "debug", "h2h");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.mkdirSync(H2H_DEBUG_DIR, { recursive: true });

// Visitor tracking
const VISITORS_FILE = path.join(DATA_DIR, "visitors.json");
function trackVisitor(req) {
  if (req.path.startsWith("/api/") || req.path.includes(".")) return;
  try {
    let visitors = [];
    try { visitors = JSON.parse(fs.readFileSync(VISITORS_FILE, "utf-8")); } catch {}
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const today = new Date().toISOString().slice(0, 10);
    visitors.push({ date: today, time: new Date().toISOString(), ip: ip.slice(-8), path: req.path, ref: req.headers.referer || req.headers.referrer || "direct", ua: (req.headers["user-agent"] || "").slice(0, 80) });
    if (visitors.length > 500) visitors = visitors.slice(-500);
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
  } catch {}
}

app.use((req, res, next) => {
  trackVisitor(req);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.set("trust proxy", 1);
app.use(session({ secret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "sp-secret", resave: false, saveUninitialized: false, cookie: { secure: false, httpOnly: true, maxAge: 3600000 } }));

// ── Helpers ──

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error("Invalid JSON from " + url.slice(0, 60))); }
        });
      })
      .on("error", reject)
      .on("timeout", () => { req.destroy(); reject(new Error("Request timeout: " + url.slice(0, 60))); });
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
        timeout: 15000,
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
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error("Invalid JSON from POST")); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("POST timeout")); });
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
  raw[key] = (raw[key] || 0) + 1 + Math.floor(Math.random() * 3);
  saveStats(raw);
}

app.get("/api/stats", (req, res) => {
  res.json(loadStats());
});

// ── API Rate Limiting (H2H only) ──

const API_USAGE_FILE = path.join(DATA_DIR, "api-usage.json");

function loadApiUsage() {
  try { return JSON.parse(fs.readFileSync(API_USAGE_FILE, "utf-8")); }
  catch { return { date: "", usage: {}, adminCalls: 0 }; }
}

function saveApiUsage(data) { fs.writeFileSync(API_USAGE_FILE, JSON.stringify(data, null, 2)); }

function checkApiLimit(req, res, next) {
  const u = loadApiUsage();
  const today = new Date().toISOString().split("T")[0];
  if (u.date !== today) { u.date = today; u.usage = {}; u.adminCalls = 0; saveApiUsage(u); }
  if (req.headers["x-admin-key"] === process.env.ADMIN_PASSWORD || req.session?.admin) {
    u.adminCalls = (u.adminCalls || 0) + 1; saveApiUsage(u); return next();
  }
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const calls = u.usage[ip] || 0;
  if (calls >= 50) return res.json({ found: false, fallback: true, h2h: [], keyStats: {}, message: null });
  u.usage[ip] = calls + 1; saveApiUsage(u); next();
}

app.get("/api/usage", (req, res) => {
  const u = loadApiUsage();
  const totalPublic = Object.values(u.usage || {}).reduce((a, v) => a + v, 0);
  res.json({ date: u.date, publicCalls: totalPublic, adminCalls: u.adminCalls || 0, limit: 50 });
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
  const st = (sel.matchStatus || "").toLowerCase();
  if (["postponed", "cancelled", "abandoned"].includes(st)) return "VOID";
  if (sel.refundFactor === 1) return "VOID";
  if (st !== "ended") return "PENDING";
  if (sel.isWinning === 1) return "WON";
  if (sel.isWinning === 0) return "LOST";
  return "PENDING";
}

// ── Booking (with cache + rate limiting) ──

const bookingCache = new Map();
const BOOKING_CACHE_TTL = 300000; // 5 minutes

// Rate limiter: max 30 req/min per IP on booking fetch
const bookingRateMap = new Map();
function checkBookingRate(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = bookingRateMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  bookingRateMap.set(ip, entry);
  if (entry.count > 30) return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  next();
}

app.get("/api/booking/:code", checkBookingRate, async (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Booking code required" });

  // Check cache
  const cached = bookingCache.get(code);
  if (cached && Date.now() - cached.time < BOOKING_CACHE_TTL) {
    return res.json(cached.data);
  }

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

    const result = {
      shareCode: json.data.shareCode || code,
      selections,
      totalOdds: Math.round(totalOdds * 100) / 100,
    };

    bookingCache.set(code, { data: result, time: Date.now() });
    res.json(result);
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

// API-Football integration
const h2hCache = new Map();
const H2H_CACHE_TTL = 24 * 60 * 60 * 1000;

function apiFootballFetch(endpoint) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return Promise.resolve(null);
  return new Promise((resolve) => {
    https.get(`https://v3.football.api-sports.io${endpoint}`, {
      headers: { "x-apisports-key": key, Accept: "application/json" },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

async function apiFootballH2H(home, away, pick) {
  const cacheKey = `${home}|${away}`.toLowerCase();
  const cached = h2hCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < H2H_CACHE_TTL) return cached.data;

  if (!process.env.API_FOOTBALL_KEY) return null;

  const homeSearch = await apiFootballFetch(`/teams?search=${encodeURIComponent(home)}`);
  const awaySearch = await apiFootballFetch(`/teams?search=${encodeURIComponent(away)}`);
  const homeTeam = homeSearch?.response?.[0]?.team;
  const awayTeam = awaySearch?.response?.[0]?.team;
  if (!homeTeam?.id || !awayTeam?.id) return null;

  const [h2hRes, homeFormRes, awayFormRes] = await Promise.all([
    apiFootballFetch(`/fixtures/headtohead?h2h=${homeTeam.id}-${awayTeam.id}`),
    apiFootballFetch(`/fixtures?team=${homeTeam.id}&season=2025`),
    apiFootballFetch(`/fixtures?team=${awayTeam.id}&season=2025`),
  ]);

  const parseFixture = (f) => {
    const h = f.teams?.home?.name || "";
    const a = f.teams?.away?.name || "";
    const hs = f.goals?.home ?? 0;
    const as = f.goals?.away ?? 0;
    const date = f.fixture?.date?.slice(0, 10) || "";
    return { date, home: h, away: a, homeScore: hs, awayScore: as };
  };

  const finishedOnly = (arr) => (arr || []).filter(f => f.fixture?.status?.short === "FT");
  const sortDesc = (arr) => arr.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const h2h = sortDesc(finishedOnly(h2hRes?.response).map(parseFixture)).slice(0, 5);
  const homeFixtures = sortDesc(finishedOnly(homeFormRes?.response).map(parseFixture)).slice(0, 5);
  const awayFixtures = sortDesc(finishedOnly(awayFormRes?.response).map(parseFixture)).slice(0, 5);

  const formOf = (fixtures, teamName) => fixtures.slice(0, 5).map(f => {
    const isHome = f.home.toLowerCase().includes(teamName.toLowerCase().slice(0, 5));
    const gf = isHome ? f.homeScore : f.awayScore;
    const ga = isHome ? f.awayScore : f.homeScore;
    return gf > ga ? "W" : gf < ga ? "L" : "D";
  });

  const stats = keyStats(h2h.length ? h2h : []);
  const homeWinRate = h2h.length ? Math.round(h2h.filter(m => m.homeScore > m.awayScore).length / h2h.length * 100) : null;

  // Safety score
  let score = 50;
  const p = (pick || "").toLowerCase();
  if (stats.avgGoals !== null) {
    if (stats.avgGoals < 1.5) { if (p.includes("over 1.5")) score += 20; if (p.includes("over 2.5")) score -= 25; if (p.includes("yes") && p.includes("btts")) score -= 15; }
    else if (stats.avgGoals <= 2.5) { if (p.includes("over 1.5")) score += 15; if (p.includes("over 2.5")) score -= 5; }
    else { if (p.includes("over 2.5")) score += 20; if (p.includes("over 3.5")) score += 5; if (p.includes("yes") && stats.bttsPct > 50) score += 10; }
  }
  if (stats.bttsPct !== null) { if (stats.bttsPct > 60 && p.includes("yes")) score += 20; if (stats.bttsPct < 40 && p.includes("yes")) score -= 20; if (stats.bttsPct < 40 && p.includes("no")) score += 20; }
  if (homeWinRate !== null) { if (homeWinRate >= 80 && p.includes("home")) score += 25; if (homeWinRate <= 20 && p.includes("home")) score -= 25; if (homeWinRate <= 20 && p.includes("away")) score += 20; }
  const hf = formOf(homeFixtures, home); if (hf.filter(r => r === "W").length >= 4 && p.includes("home")) score += 10;
  const af = formOf(awayFixtures, away); if (af.filter(r => r === "W").length >= 4 && p.includes("away")) score += 10;
  score = Math.max(0, Math.min(100, score));

  const safetyLabel = score >= 70 ? "Strong" : score >= 40 ? "Neutral" : "Risky";
  let recommendation = "";
  if (stats.avgGoals !== null && stats.avgGoals < 1.5 && p.includes("over 2.5")) recommendation = `Avg ${stats.avgGoals} goals in H2H — Over 2.5 is risky. Consider Over 1.5.`;
  else if (stats.avgGoals !== null && stats.avgGoals > 3 && p.includes("over 2.5")) recommendation = `Avg ${stats.avgGoals} goals in H2H — Over 2.5 looks strong.`;
  else if (stats.bttsPct !== null && stats.bttsPct < 30 && p.includes("yes")) recommendation = `BTTS rate only ${stats.bttsPct}% — this pick is risky.`;
  else if (score >= 70) recommendation = "Stats support this pick.";
  else if (score < 40) recommendation = "Stats go against this pick. Consider changing.";

  const result = {
    source: "API-Football",
    found: true,
    homeTeam: { name: homeTeam.name, form: formOf(homeFixtures, home) },
    awayTeam: { name: awayTeam.name, form: formOf(awayFixtures, away) },
    h2h: h2h.map(m => ({ ...m, result: m.homeScore > m.awayScore ? "H" : m.homeScore < m.awayScore ? "A" : "D" })),
    keyStats: { ...stats, homeWinRate },
    safetyScore: score,
    safetyLabel,
    recommendation,
    confidence: safetyLabel,
  };

  h2hCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

app.get("/api/h2h", checkApiLimit, async (req, res) => {
  const { eventId, home, away, pick } = req.query;
  if (!home) return res.status(400).json({ error: "home team required" });

  try {
    // Try API-Football first
    const apif = await apiFootballH2H(home, away, pick);
    if (apif?.found) return res.json(apif);

    // Fallback to SportyBet endpoints
    const sporty = await sportyStats(eventId, home, away);
    if (sporty?.found) return res.json(sporty);

    // Fallback to TheSportsDB
    const fallback = await fallbackStats(home, away);
    res.json({ ...fallback, sportyDebugFile: sporty?.debugFile || null, noApiKey: !process.env.API_FOOTBALL_KEY });
  } catch (err) {
    res.json({ h2h: [], homeForm: [], awayForm: [], keyStats: {}, found: false, error: err.message, noApiKey: !process.env.API_FOOTBALL_KEY });
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
    req.session.admin = true;
    res.json({ success: true });
  } else {
    res.status(403).json({ success: false, error: "Wrong password" });
  }
});

app.get("/api/admin/check", (req, res) => {
  const isAdmin = req.session?.admin || req.headers["x-admin-password"] === process.env.ADMIN_PASSWORD;
  res.json({ admin: !!isAdmin });
});

app.get("/punter/:name", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// SEO routes
app.get("/optimizer", (req, res) => res.redirect("/#optimizer"));
app.get("/scanner", (req, res) => res.redirect("/#scanner"));
app.get("/convert", (req, res) => res.redirect("/#convert"));
app.get("/merger", (req, res) => res.redirect("/#merger"));
app.get("/optimize-sportybet-slip", (req, res) => res.sendFile(path.join(__dirname, "public", "optimize-sportybet-slip.html")));

// ── Admin Panel ──

app.post("/admin/login", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    res.json({ success: true });
  } else {
    res.status(403).json({ success: false });
  }
});

app.get("/admin/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  if (req.headers["x-admin-password"] === process.env.ADMIN_PASSWORD) return next();
  if (req.accepts("html")) return res.redirect("/admin");
  return res.status(403).json({ error: "Unauthorized" });
}

app.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "-1");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/admin/leaderboard", requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin/support", requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  const stats = loadStats();
  const usage = loadApiUsage();
  const tickets = loadSupport();
  const totalPublic = Object.values(usage.usage || {}).reduce((a, v) => a + v, 0);
  res.json({
    stats,
    api: { date: usage.date, publicCalls: totalPublic, adminCalls: usage.adminCalls || 0, limit: 50 },
    tickets: tickets.length,
    ticketsNew: tickets.filter(t => t.status === "New").length,
  });
});

// ── Support ──

const SUPPORT_FILE = path.join(DATA_DIR, "support.json");

function loadSupport() { try { return JSON.parse(fs.readFileSync(SUPPORT_FILE, "utf-8")); } catch { return []; } }
function saveSupport(data) { fs.writeFileSync(SUPPORT_FILE, JSON.stringify(data, null, 2)); }

app.post("/api/support", (req, res) => {
  const { name, email, type, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: "Email and message required" });
  const tickets = loadSupport();
  tickets.push({ id: Date.now(), date: new Date().toISOString(), name: name || "Anonymous", email, type: type || "Other", message, status: "New" });
  saveSupport(tickets);
  res.json({ success: true });
});

app.get("/api/support", (req, res) => {
  const adminPw = req.headers["x-admin-password"];
  if (adminPw !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: "Unauthorized" });
  res.json({ tickets: loadSupport() });
});

app.patch("/api/support/:id", (req, res) => {
  const adminPw = req.headers["x-admin-password"];
  if (adminPw !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: "Unauthorized" });
  const tickets = loadSupport();
  const t = tickets.find(t => t.id === parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: "Not found" });
  if (req.body.status) t.status = req.body.status;
  saveSupport(tickets);
  res.json({ success: true });
});

// ── SportyBet H2H proxy (browser can't call SportyBet directly due to CORS) ──

app.get("/api/proxy-h2h/:eventId", async (req, res) => {
  const eid = req.params.eventId;
  const numId = eid.replace("sr:match:", "");

  const urls = [
    `https://www.sportybet.com/api/ng/factsCenter/matchStatistic?matchId=${eid}`,
    `https://www.sportybet.com/api/ng/factsCenter/h2h?matchId=${eid}`,
    `https://www.sportybet.com/api/ng/factsCenter/preMatchData?matchId=${eid}`,
    `https://www.sportybet.com/api/ng/factsCenter/matchStatistic?matchId=${numId}`,
    `https://www.sportybet.com/api/ng/factsCenter/h2h?matchId=${numId}`,
    `https://www.sportybet.com/api/ng/factsCenter/preMatchData?matchId=${numId}`,
  ];

  for (const url of urls) {
    try {
      const r = await fetchJSONWithStatus(url);
      if (r.status === 200 && r.json?.bizCode === 10000 && r.json?.data) {
        console.log("[H2H Proxy] HIT:", url);
        const safeId = eid.replace(/[^a-zA-Z0-9_-]/g, "_");
        fs.writeFileSync(path.join(H2H_DEBUG_DIR, `proxy_${safeId}.json`), JSON.stringify({ url, data: r.json.data }, null, 2));
        return res.json({ found: true, source: "SportyBet", url, data: r.json.data });
      }
    } catch {}
  }

  res.json({ found: false, source: "SportyBet", triedUrls: urls.length });
});

// ── Debug: SportyBet H2H probe ──

app.get("/debug/sportybet-h2h/:eventId", async (req, res) => {
  const eid = req.params.eventId;
  const numId = eid.replace("sr:match:", "");
  const endpoints = [
    `/api/ng/factsCenter/h2h?matchId=${eid}`,
    `/api/ng/factsCenter/h2h?eventId=${eid}`,
    `/api/ng/sport/h2h?matchId=${eid}`,
    `/api/ng/factsCenter/matchStatistic?matchId=${eid}`,
    `/api/ng/factsCenter/matchSummary?eventId=${eid}`,
    `/api/ng/factsCenter/preMatch?matchId=${eid}`,
    `/api/ng/orders/matchDetail?matchId=${eid}`,
    `/api/ng/factsCenter/h2h?matchId=${numId}`,
    `/api/ng/factsCenter/h2h?eventId=${numId}`,
    `/api/ng/factsCenter/matchStatistic?matchId=${numId}`,
    `/api/ng/factsCenter/preMatch?matchId=${numId}`,
  ];

  const results = [];
  for (const ep of endpoints) {
    const url = `https://www.sportybet.com${ep}`;
    const r = await fetchJSONWithStatus(url);
    results.push({ endpoint: ep, status: r.status, bizCode: r.json?.bizCode, hasData: !!(r.json?.data && Object.keys(r.json.data).length > 0), preview: JSON.stringify(r.json || r.raw).slice(0, 500) });
  }

  const safeId = eid.replace(/[^a-zA-Z0-9_-]/g, "_");
  fs.writeFileSync(path.join(H2H_DEBUG_DIR, `probe_${safeId}.json`), JSON.stringify(results, null, 2));
  res.json({ eventId: eid, results });
});

// ── Punter Profiles & Generated Codes (admin only) ──

const PROFILES_FILE = path.join(DATA_DIR, "punter-profiles.json");
const CODES_FILE = path.join(DATA_DIR, "generated-codes.json");

app.get("/api/punter-profiles", requireAdmin, (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"))); }
  catch { res.json({}); }
});

app.get("/api/generated-codes", requireAdmin, (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CODES_FILE, "utf-8"))); }
  catch { res.json({}); }
});

app.post("/api/admin/save-codes", requireAdmin, (req, res) => {
  try { fs.writeFileSync(CODES_FILE, JSON.stringify(req.body, null, 2)); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Scan a punter's today code and update their profile
app.post("/api/punters/scan-today", requireAdmin, async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: "name and code required" });

  try {
    const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
    const json = await fetchJSON(url);
    if (!json || json.bizCode !== 10000 || !json.data) return res.status(404).json({ error: "Code not found" });

    const outcomes = json.data.outcomes || [];
    const ticketSels = json.data.ticket?.selections || [];
    const selections = mapOutcomes(outcomes, ticketSels);
    const results = selections.map(s => ({ ...s, verdict: evaluateVerdict(s) }));

    const won = results.filter(r => r.verdict === "WON").length;
    const lost = results.filter(r => r.verdict === "LOST").length;
    const voided = results.filter(r => r.verdict === "VOID").length;
    const pending = results.filter(r => r.verdict === "PENDING").length;
    const settled = won + lost;
    const hitRate = settled > 0 ? Math.round(won / settled * 100) : 0;

    // Update punters.json leaderboard
    const punters = loadPunters();
    const existing = punters.find(p => p.name === name);
    const slip = { code, date: new Date().toISOString(), total: results.length, won, lost, void: voided, hitRate };
    if (existing) { if (!existing.slips.some(s => s.code === code)) existing.slips.push(slip); }
    else punters.push({ name, slips: [slip] });
    savePunters(punters);

    res.json({ success: true, won, lost, void: voided, pending, hitRate, total: results.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add code to a punter's history
app.post("/api/punters/:name/add-code", requireAdmin, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { code, date } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });

  try {
    const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code.trim().toUpperCase())}`;
    const json = await fetchJSON(url);
    if (!json || json.bizCode !== 10000 || !json.data) return res.status(404).json({ error: "Code not found on SportyBet" });

    const outcomes = json.data.outcomes || [];
    const ticketSels = json.data.ticket?.selections || [];
    const selections = mapOutcomes(outcomes, ticketSels);
    const results = selections.map(s => ({ ...s, verdict: evaluateVerdict(s) }));

    const won = results.filter(r => r.verdict === "WON").length;
    const lost = results.filter(r => r.verdict === "LOST").length;
    const voided = results.filter(r => r.verdict === "VOID").length;
    const pending = results.filter(r => r.verdict === "PENDING").length;
    const settled = won + lost;
    const hitRate = settled > 0 ? Math.round(won / settled * 100) : 0;

    // Update punters.json
    const punters = loadPunters();
    const existing = punters.find(p => p.name === name);
    const slip = { code: code.trim().toUpperCase(), date: (date || new Date().toISOString().slice(0, 10)) + "T00:00:00Z", total: results.length, won, lost, void: voided, hitRate };
    if (existing) { if (!existing.slips.some(s => s.code === slip.code)) existing.slips.push(slip); }
    else punters.push({ name, slips: [slip] });
    savePunters(punters);

    // Update punter-profiles.json
    try {
      const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
      if (profiles[name]) {
        if (!profiles[name].codes) profiles[name].codes = [];
        if (!profiles[name].codes.some(c => c.code === slip.code)) {
          profiles[name].codes.unshift({ code: slip.code, date: date || new Date().toISOString().slice(0, 10), games: results.length, won, lost, void: voided, pending, hitRate });
        }
        // Recalculate totals
        const allCodes = profiles[name].codes.filter(c => (c.won + c.lost) > 0);
        profiles[name].totalGames = allCodes.reduce((a, c) => a + c.games, 0);
        profiles[name].won = allCodes.reduce((a, c) => a + c.won, 0);
        profiles[name].lost = allCodes.reduce((a, c) => a + c.lost, 0);
        profiles[name].void = allCodes.reduce((a, c) => a + (c.void || 0), 0);
        const totalSettled = profiles[name].won + profiles[name].lost;
        profiles[name].hitRate = totalSettled > 0 ? Math.round(profiles[name].won / totalSettled * 100) : 0;
        // Recalculate trust
        const rates = allCodes.map(c => c.hitRate);
        const avg = rates.length ? rates.reduce((a, r) => a + r, 0) / rates.length : 0;
        const variance = rates.length > 1 ? Math.round(Math.sqrt(rates.reduce((a, r) => a + Math.pow(r - avg, 2), 0) / rates.length)) : 0;
        profiles[name].consistency = 100 - variance;
        let trust = profiles[name].hitRate;
        if (rates.length >= 3 && variance < 15) trust += 10;
        if (rates.some(r => r >= 80)) trust += 10;
        if (rates.some(r => r < 40)) trust -= 10;
        profiles[name].trustScore = Math.max(0, Math.min(100, trust));
      }
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
    } catch {}

    res.json({ success: true, won, lost, void: voided, pending, hitRate, total: results.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// H2H debug/test endpoint
app.get("/api/debug/h2h-test", requireAdmin, async (req, res) => {
  try {
    const result = await apiFootballH2H("Riga FC", "FK Liepaja", "Over 2.5");
    const usage = loadApiUsage();
    const totalCalls = Object.values(usage.usage || {}).reduce((a, v) => a + v, 0);
    res.json({ tested: "Riga FC vs FK Liepaja", result: result || { found: false }, apiKeyUsed: process.env.API_FOOTBALL_KEY ? "yes" : "no", callsToday: totalCalls });
  } catch (err) { res.json({ tested: "Riga FC vs FK Liepaja", result: { found: false, error: err.message }, apiKeyUsed: process.env.API_FOOTBALL_KEY ? "yes" : "no" }); }
});

// Regenerate merged codes (all punters, live games removed)
function getTodayCodes() { return loadPunterCodes(); }

app.post("/api/admin/regen-merged", requireAdmin, async (req, res) => {
  try {
    const allSels = [];
    const seen = new Set();
    const now = Date.now();

    for (const [name, code] of Object.entries(getTodayCodes())) {
      if (!code) continue;
      try {
        const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
        const json = await fetchJSON(url);
        if (json?.bizCode === 10000 && json.data?.outcomes) {
          const ticketSels = json.data.ticket?.selections || [];
          const selections = mapOutcomes(json.data.outcomes, ticketSels);
          for (const s of selections) {
            if (s.kickoff && new Date(s.kickoff).getTime() <= now) continue;
            if (!seen.has(s.eventId)) { seen.add(s.eventId); allSels.push(s); }
          }
        }
      } catch {}
    }

    const codes = [];
    for (let i = 0; i < allSels.length; i += 50) {
      const batch = allSels.slice(i, i + 50);
      const payload = batch.map(s => ({ eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifier: s.specifier || "", productId: s.productId || 3, sportId: s.sportId || "" }));
      try {
        const r = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
        if (r.bizCode === 10000 && r.data?.shareCode) codes.push({ code: r.data.shareCode, games: batch.length });
      } catch {}
    }

    res.json({ success: true, codes, totalGames: allSels.length, message: `${codes.length} codes from ${allSels.length} future games` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Regenerate all codes (runs analyze2.js)
app.post("/api/admin/regen-all", requireAdmin, (req, res) => {
  const { execFile } = require("child_process");
  execFile("node", [path.join(__dirname, "analyze2.js")], { timeout: 600000 }, (err, stdout, stderr) => {
    if (err) return res.json({ success: false, message: "Analysis failed: " + (err.message || stderr).slice(0, 200) });
    res.json({ success: true, message: "Analysis complete. Codes regenerated.", output: stdout.slice(-500) });
  });
});

// ── Admin: visitors + header code ──

app.get("/api/admin/visitors", requireAdmin, (req, res) => {
  try {
    const visitors = JSON.parse(fs.readFileSync(VISITORS_FILE, "utf-8"));
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = visitors.filter(v => v.date === today).length;
    const uniqueIPs = new Set(visitors.filter(v => v.date === today).map(v => v.ip)).size;
    const refs = {};
    visitors.filter(v => v.date === today).forEach(v => { refs[v.ref] = (refs[v.ref] || 0) + 1; });
    res.json({ today: todayCount, uniqueToday: uniqueIPs, total: visitors.length, topRefs: Object.entries(refs).sort((a, b) => b[1] - a[1]).slice(0, 10), recent: visitors.slice(-20).reverse() });
  } catch { res.json({ today: 0, uniqueToday: 0, total: 0, topRefs: [], recent: [] }); }
});

// Page lock system
const PAGE_LOCKS_FILE = path.join(DATA_DIR, "page-locks.json");
function loadPageLocks() { try { return JSON.parse(fs.readFileSync(PAGE_LOCKS_FILE, "utf-8")); } catch { return {}; } }

app.get("/api/page-locks", (req, res) => { res.json(loadPageLocks()); });

app.post("/api/admin/page-locks", requireAdmin, (req, res) => {
  fs.writeFileSync(PAGE_LOCKS_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

const HEADER_CODE_FILE = path.join(DATA_DIR, "header-code.txt");

app.get("/api/admin/header-code", requireAdmin, (req, res) => {
  try { res.json({ code: fs.readFileSync(HEADER_CODE_FILE, "utf-8") }); }
  catch { res.json({ code: "" }); }
});

app.post("/api/admin/header-code", requireAdmin, (req, res) => {
  const { code } = req.body;
  fs.writeFileSync(HEADER_CODE_FILE, code || "");
  res.json({ success: true });
});

// Serve header code injection for index.html
app.get("/api/header-inject", (req, res) => {
  try { res.type("text/plain").send(fs.readFileSync(HEADER_CODE_FILE, "utf-8")); }
  catch { res.type("text/plain").send(""); }
});

// ── Debug: test outbound HTTPS ──
app.get("/api/debug/outbound", async (req, res) => {
  const start = Date.now();
  try {
    const r = await fetchJSON("https://www.sportybet.com/api/ng/orders/share/S2WZVC");
    res.json({ ok: true, time: Date.now() - start + "ms", hasData: !!r?.data, bizCode: r?.bizCode });
  } catch (e) {
    res.json({ ok: false, time: Date.now() - start + "ms", error: e.message });
  }
});

// ── Admin Punter Codes (editable daily) ──

const PUNTER_CODES_FILE = path.join(DATA_DIR, "punter-codes.json");

function loadPunterCodes() {
  try { return JSON.parse(fs.readFileSync(PUNTER_CODES_FILE, "utf-8")); }
  catch { return { "39 Billion": "", "9Z": "", "Big Strategic": "", "Ayo Jordan": "", "Bayo Bets": "", "OY": "", "Princewill": "", "Sirtee": "" }; }
}

app.get("/api/admin/punter-codes", requireAdmin, (req, res) => {
  res.json(loadPunterCodes());
});

app.post("/api/admin/punter-codes", requireAdmin, (req, res) => {
  const current = loadPunterCodes();
  const updated = { ...current, ...req.body };
  fs.writeFileSync(PUNTER_CODES_FILE, JSON.stringify(updated, null, 2));
  res.json({ success: true, codes: updated });
});

// ── Global error handler (must be last middleware) ──

app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: err.message || "Server error" });
});

// ── Start ──

app.listen(PORT, () => {
  console.log("SlipPilot v3 running at http://localhost:" + PORT);
});
