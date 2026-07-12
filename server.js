// Crash recovery — log to file + exit so wrapper can restart
const CRASH_LOG = require("path").join(__dirname, "data", "crash.log");
function writeCrashLog(tag, err) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${tag}: ${err && err.stack ? err.stack : err}\n`;
  try { require("fs").appendFileSync(CRASH_LOG, line); } catch {}
  console.error(line.trimEnd());
}
const _startTime = Date.now();

process.on("uncaughtException", err => {
  writeCrashLog("UNCAUGHT", err);
  if (err.code === "EADDRINUSE") {
    console.log("[CRASH] Port busy — exiting for wrapper restart...");
    setTimeout(() => process.exit(1), 2000);
  }
  // Non-fatal: keep running unless it's a port conflict
});
process.on("unhandledRejection", (reason) => {
  writeCrashLog("UNHANDLED_REJECTION", reason instanceof Error ? reason : new Error(String(reason)));
});

// Keep-alive: ping /api/health every 90s (cPanel Passenger idle timeout can be as low as 2 min)
setInterval(() => {
  try {
    const http = require("http");
    http.get("http://localhost:" + (process.env.PORT || 3000) + "/api/health", r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => {});
    }).on("error", () => {});
  } catch {}
}, 90 * 1000);

// Memory management + cache/rate-limiter housekeeping
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB  = Math.round(mem.rss / 1024 / 1024);
  console.log(`[MEM] Heap: ${heapMB}MB  RSS: ${rssMB}MB`);

  // Purge expired bookingCache entries (TTL = 5 min) — prevents unbounded growth
  const now = Date.now();
  try {
    for (const [k, v] of bookingCache) {
      if (now - v.time > BOOKING_CACHE_TTL) bookingCache.delete(k);
    }
    // Hard cap: keep only 200 most-recent entries
    if (bookingCache.size > 200) {
      const entries = [...bookingCache.entries()].sort((a,b)=>a[1].time-b[1].time);
      for (let i = 0; i < entries.length - 200; i++) bookingCache.delete(entries[i][0]);
    }
  } catch {}

  // Purge expired rate-limiter entries (these NEVER got cleaned — the memory leak)
  try {
    for (const [k, v] of bookingRateMap) { if (now > v.reset) bookingRateMap.delete(k); }
    for (const [k, v] of generateRateMap) { if (now > v.reset) generateRateMap.delete(k); }
  } catch {}

  // Purge oddsStore beyond 2000 entries (trim oldest half when over cap)
  try {
    if (typeof oddsStore !== "undefined" && oddsStore.size > 2000) {
      const ks = [...oddsStore.keys()];
      for (let i = 0; i < ks.length - 1000; i++) oddsStore.delete(ks[i]);
    }
  } catch {}

  // Emergency clears at high memory
  if (heapMB > 220) {
    try { bookingCache.clear(); } catch {}
    try { if (typeof oddsStore !== "undefined") oddsStore.clear(); } catch {}
    try { bookingRateMap.clear(); generateRateMap.clear(); } catch {}
    console.log(`[MEM] Emergency clear at ${heapMB}MB`);
  }
  if (heapMB > 380) { console.error(`[OOM] ${heapMB}MB — restarting`); process.exit(1); }
}, 60000);
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const https = require("https");
const path = require("path");
const fs = require("fs");
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let xAssistant = null, intel = null;
if (!IS_PRODUCTION) {
  try { xAssistant = require("./x-assistant-engine"); } catch {}
  try { intel = require("./intelligence-engine"); } catch {}
}

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Production email transport — optional, falls back to file-save if nodemailer not installed
let _mailer = null;
if (IS_PRODUCTION) {
  try {
    const nodemailer = require('nodemailer');
    _mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '25'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      tls: { rejectUnauthorized: false },
    });
  } catch { console.warn('[SUPPORT] nodemailer not installed — support tickets will save to file'); }
}
const BUILD_VERSION = Date.now().toString(36); // unique per restart — injected into HTML asset URLs

const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const DEBUG_DIR = path.join(__dirname, "debug", "markets");
const H2H_DEBUG_DIR = path.join(__dirname, "debug", "h2h");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });
if (!IS_PRODUCTION) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.mkdirSync(H2H_DEBUG_DIR, { recursive: true });
}

function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

// Visitor tracking — debounced in-memory buffer; writes every 5s to avoid blocking event loop
const VISITORS_FILE = path.join(DATA_DIR, "visitors.json");
let _visitorBuffer = null;
let _visitorTimer = null;
function trackVisitor(req) {
  if (req.path.startsWith("/api/") || req.path.includes(".")) return;
  try {
    if (!_visitorBuffer) {
      try { _visitorBuffer = JSON.parse(fs.readFileSync(VISITORS_FILE, "utf-8")); } catch { _visitorBuffer = []; }
    }
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const today = new Date().toISOString().slice(0, 10);
    _visitorBuffer.push({ date: today, time: new Date().toISOString(), ip: ip.slice(-8), path: req.path, ref: req.headers.referer || req.headers.referrer || "direct", ua: (req.headers["user-agent"] || "").slice(0, 80) });
    if (_visitorBuffer.length > 500) _visitorBuffer = _visitorBuffer.slice(-500);
    clearTimeout(_visitorTimer);
    _visitorTimer = setTimeout(() => {
      const data = JSON.stringify(_visitorBuffer, null, 2);
      fs.writeFile(VISITORS_FILE, data, () => {});
    }, 5000);
  } catch {}
}

// ── HTML auto-versioning ──
// Read HTML once at startup, inject BUILD_VERSION into all ?v= query params.
// This means every server restart automatically busts the browser cache — no manual edits.
const _htmlCache = {};
function getVersionedHTML(name) {
  if (!_htmlCache[name]) {
    let raw = fs.readFileSync(path.join(__dirname, "public", name), "utf8");
    raw = raw.replace(/\?v=[a-zA-Z0-9._-]+/g, `?v=${BUILD_VERSION}`);
    if (IS_PRODUCTION) raw = raw.replace('<head>', '<head><script>window.IS_PRODUCTION=true;</script>');
    _htmlCache[name] = raw;
  }
  return _htmlCache[name];
}

function sendHTML(name) {
  return (req, res) => {
    try {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("ETag", `"${BUILD_VERSION}"`);
      res.setHeader("Last-Modified", new Date(parseInt(BUILD_VERSION, 36)).toUTCString());
      res.send(getVersionedHTML(name));
    } catch (e) {
      console.error(`[HTML] Error serving ${name}:`, e.message);
      res.status(500).send("Page temporarily unavailable. Please refresh.");
    }
  };
}

// Serve the main page before express.static so versioning is always injected
app.get("/", sendHTML("index.html"));

app.use((req, res, next) => {
  trackVisitor(req);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  // Request timeout — kill hanging requests after 30 seconds
  req.setTimeout(30000, () => { if (!res.headersSent) res.status(504).json({ error: "Request timeout" }); });
  next();
});

// Production firewall — must run BEFORE express.static so admin.html cannot be fetched directly
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    const p = req.path;
    const blocked = (
      p.startsWith('/admin') ||
      p.startsWith('/api/admin') ||
      p.startsWith('/api/punters') ||
      p.startsWith('/api/leaderboard') ||
      p.startsWith('/api/h2h') ||
      p.startsWith('/api/proxy-h2h') ||
      p.startsWith('/api/session') ||
      p.startsWith('/api/intelligence') ||
      p.startsWith('/api/studio') ||
      p === '/api/score-selections' ||
      p === '/api/smart-slips' ||
      p === '/api/generated-codes' ||
      p.startsWith('/api/code-history') ||
      p === '/api/weak-matches' ||
      p === '/api/submit-code' ||
      p === '/api/usage' ||
      p.startsWith('/api/debug') ||
      p.startsWith('/debug') ||
      p.startsWith('/punter/') ||
      (p === '/api/support' && req.method !== 'POST') ||
      p.startsWith('/api/support/') ||
      p === '/api/header-inject'
    );
    if (blocked) return res.status(404).json({ error: 'Not found' });
    next();
  });
}

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    } else if (/\.(css|js)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    } else {
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
  },
}));
app.use(express.json({ limit: "1mb" }));

// Health check for the wrapper, cPanel, and simple uptime probes
app.get("/api/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    build: BUILD_VERSION,
    memMB: Math.round(mem.heapUsed / 1024 / 1024),
    time: new Date().toISOString(),
  });
});

// Deployment verification: confirms which build is running + cache busting is active
app.get("/api/version", (req, res) => {
  res.json({
    version: BUILD_VERSION,
    built: new Date(parseInt(BUILD_VERSION, 36)).toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

// Block direct access to sensitive files
app.use((req, res, next) => {
  const blocked = ["/data/", "/.env", "/server.js", "/session-engine.js", "/package.json"];
  if (blocked.some(b => req.path.startsWith(b) || req.path === b)) return res.status(403).json({ error: "Forbidden" });
  next();
});

app.set("trust proxy", 1);
if (!IS_PRODUCTION) {
  app.use(session({ secret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "sp-secret", resave: false, saveUninitialized: false, cookie: { secure: false, httpOnly: true, maxAge: 3600000 } }));
}

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

// Debounced stats — no sync I/O on every request
let _statsRaw = null;
let _statsDirty = false;
let _statsWriteTimer = null;

function _loadStatsRaw() {
  if (!_statsRaw) {
    try { _statsRaw = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")); } catch { _statsRaw = {}; }
  }
  return _statsRaw;
}

function loadStats() {
  const raw = _loadStatsRaw();
  const merged = { ...STATS_BASELINE };
  for (const k of Object.keys(merged)) merged[k] += (raw[k] || 0);
  if (raw.puntersSaved && !raw.puntersTracked) merged.puntersTracked += raw.puntersSaved;
  return merged;
}

function incrementStat(key) {
  const raw = _loadStatsRaw();
  raw[key] = (raw[key] || 0) + 1;
  _statsDirty = true;
  clearTimeout(_statsWriteTimer);
  _statsWriteTimer = setTimeout(() => {
    if (_statsDirty && _statsRaw) {
      fs.writeFile(STATS_FILE, JSON.stringify(_statsRaw, null, 2), () => {});
      _statsDirty = false;
    }
  }, 3000);
}

app.get("/api/stats", (req, res) => {
  res.json(loadStats());
});

// ── API Rate Limiting (H2H only) ──

const API_USAGE_FILE = path.join(DATA_DIR, "api-usage.json");

// Debounced API usage — cached in memory, async write every 2s
let _apiUsageCache = null;
let _apiUsageDirty = false;
let _apiUsageTimer = null;

function loadApiUsage() {
  if (!_apiUsageCache) {
    try { _apiUsageCache = JSON.parse(fs.readFileSync(API_USAGE_FILE, "utf-8")); }
    catch { _apiUsageCache = { date: "", usage: {}, adminCalls: 0 }; }
  }
  return _apiUsageCache;
}

function saveApiUsage(data) {
  _apiUsageCache = data;
  _apiUsageDirty = true;
  clearTimeout(_apiUsageTimer);
  _apiUsageTimer = setTimeout(() => {
    if (_apiUsageDirty && _apiUsageCache) {
      fs.writeFile(API_USAGE_FILE, JSON.stringify(_apiUsageCache, null, 2), () => {});
      _apiUsageDirty = false;
    }
  }, 2000);
}

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
      odds: parseFloat(ts.odds) || parseFloat(oc.odds) || 0,
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

// ── Odds cache: saves original odds when code is first loaded ──
const oddsStore = new Map(); // key: "CODE|eventId" -> odds at first load

function saveOddsForCode(code, selections) {
  for (const s of selections) {
    const key = code + "|" + s.eventId;
    if (!oddsStore.has(key)) oddsStore.set(key, s.odds);
  }
}

function getOriginalOdds(code, eventId, fallback) {
  return oddsStore.get(code + "|" + eventId) || fallback;
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

    // Persist original pre-match odds on first sight; look up for all subsequent scans
    const bank = loadOddsBank();
    storeOriginalOdds(bank, selections, new Date().toISOString());
    saveOddsForCode(code, selections); // in-memory fallback for same-session rescans

    const enriched = selections.map(s => ({
      ...s,
      originalOdds: getBankOdds(bank, s), // null when not in bank → frontend hides badge
    }));

    const totalOdds = enriched.reduce((acc, s) => acc * (s.originalOdds || s.odds || 1), 1);

    incrementStat("slipsLoaded");

    const result = {
      shareCode: json.data.shareCode || code,
      selections: enriched,
      totalOdds: Math.round(totalOdds * 100) / 100,
    };

    bookingCache.set(code, { data: result, time: Date.now() });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch booking" });
  }
});

// ── Generate ──

// Rate limiter for generate: 20 req/min per IP
const generateRateMap = new Map();
function checkGenerateRate(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = generateRateMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  generateRateMap.set(ip, entry);
  if (entry.count > 20) return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  next();
}

app.post("/api/generate", checkGenerateRate, async (req, res) => {
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
    const json = await postJSON(
      "https://www.sportybet.com/api/ng/orders/share",
      { selections: payload }
    );

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
    if (!IS_PRODUCTION) {
      const debugPath = path.join(DEBUG_DIR, `${safeId}.json`);
      fs.writeFileSync(debugPath, JSON.stringify(d, null, 2));
    }

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
      ...(IS_PRODUCTION ? {} : { debugFile: `debug/markets/${safeId}.json` }),
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
  const code = req.params.code.trim().toUpperCase();
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
    const scanTs = new Date().toISOString();

    // Persistent odds bank: store original odds on first scan, look up on re-scans
    const bank = loadOddsBank();
    storeOriginalOdds(bank, selections, scanTs);
    saveOddsForCode(code, selections); // in-memory fallback for same-session

    const results = selections.map((s) => {
      const bankOdds = getBankOdds(bank, s);
      const memOdds = getOriginalOdds(code, s.eventId, 0);
      const originalOdds = bankOdds || (memOdds > 0 ? memOdds : null);
      const currentOdds = s.odds;

      let oddsChange = null, oddsMovePct = null;
      if (originalOdds && currentOdds && originalOdds > 1 && currentOdds > 1) {
        oddsChange = parseFloat((currentOdds - originalOdds).toFixed(3));
        oddsMovePct = parseFloat(((currentOdds - originalOdds) / originalOdds * 100).toFixed(1));
      }

      return { ...s, originalOdds, currentOdds, oddsChange, oddsMovePct, verdict: evaluateVerdict(s) };
    });

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
// STATUS: SUSPENDED — replace key in .env when reactivated
// Key location: .env → API_FOOTBALL_KEY=your_key_here
// Dashboard: https://dashboard.api-football.com
const h2hCache = new Map();
const H2H_CACHE_TTL = 24 * 60 * 60 * 1000;

function apiFootballFetch(endpoint) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return Promise.resolve(null);
  // Skip if key is known-suspended to avoid wasting time
  if (key === "f1739cfdacf78915c1b8a7eb2ad726ba" || key === "967dcdc512484c631bf76f7493f5c9b5") {
    console.log("[H2H] API-Football key suspended — skipping. Replace in .env");
    return Promise.resolve(null);
  }
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

app.get("/punter/:name", sendHTML("index.html"));

// SEO routes
app.get("/optimizer", (req, res) => res.redirect("/#optimizer"));
app.get("/scanner", (req, res) => res.redirect("/#scanner"));
app.get("/convert", (req, res) => res.redirect("/#convert"));
app.get("/merger", (req, res) => res.redirect("/#merger"));
app.get("/optimize-sportybet-slip", (req, res) => res.sendFile(path.join(__dirname, "public", "optimize-sportybet-slip.html")));
app.get("/sportybet-booking-code-converter", (req, res) => res.sendFile(path.join(__dirname, "public", "sportybet-booking-code-converter.html")));
app.get("/check-sportybet-slip-result", (req, res) => res.sendFile(path.join(__dirname, "public", "check-sportybet-slip-result.html")));

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
  // API routes must always return JSON — never redirect
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Unauthorized" });
  if (req.accepts("html")) return res.redirect("/admin");
  return res.status(403).json({ error: "Unauthorized" });
}

app.get("/admin", sendHTML("admin.html"));
app.get("/admin/leaderboard", requireAdmin, sendHTML("index.html"));
app.get("/admin/support", requireAdmin, sendHTML("index.html"));

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

app.post("/api/support", async (req, res) => {
  const { name, email, type, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: "Email and message required" });

  // Always persist ticket to file (backup in production, primary in dev)
  const ticket = { id: Date.now(), date: new Date().toISOString(), name: name || "Anonymous", email, type: type || "Other", message, status: "New" };
  try { const tickets = loadSupport(); tickets.push(ticket); saveSupport(tickets); }
  catch (saveErr) { console.error('[SUPPORT] File save failed:', saveErr.message); }

  // Email immediately if mailer configured
  if (_mailer) {
    const to = process.env.SUPPORT_EMAIL || 'support@slippilot.com.ng';
    const from = process.env.FROM_EMAIL || 'SlipPilot <noreply@slippilot.com.ng>';
    try {
      await _mailer.sendMail({
        from, to, replyTo: email,
        subject: `[SlipPilot] ${type || 'Support'} from ${name || email}`,
        text: `Name: ${name || 'Anonymous'}\nEmail: ${email}\nType: ${type || 'Other'}\n\nMessage:\n${message}`,
        html: `<p><b>Name:</b> ${name || 'Anonymous'}</p><p><b>Email:</b> ${email}</p><p><b>Type:</b> ${type || 'Other'}</p><hr><p>${(message || '').replace(/\n/g, '<br>')}</p>`,
      });
    } catch (mailErr) {
      console.error('[SUPPORT] Email delivery failed:', mailErr.message);
    }
  }

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
  try {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

    // Also update leaderboard.json
    try {
      const lb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "leaderboard.json"), "utf-8"));
      let entry = lb.find(l => l.punter === name);
      if (!entry) { entry = { punter: name, daysActive: 0, totalGames: 0, won: 0, lost: 0, hitRate: 0, trustScore: 0, codes: [], consensusRate: 0, conversionRate: 0, riskProfile: "medium", lastActive: "" }; lb.push(entry); }
      if (!entry.codes) entry.codes = [];
      if (!entry.codes.some(c => c.code === slip.code)) {
        entry.codes.unshift({ code: slip.code, date: date || new Date().toISOString().slice(0, 10), games: results.length, won, lost, void: voided, pending, hitRate });
      }
      const settled_codes = entry.codes.filter(c => (c.won + c.lost) > 0);
      entry.won = settled_codes.reduce((a, c) => a + c.won, 0);
      entry.lost = settled_codes.reduce((a, c) => a + c.lost, 0);
      entry.totalGames = settled_codes.reduce((a, c) => a + c.games, 0);
      const ts = entry.won + entry.lost;
      entry.hitRate = ts > 0 ? Math.round(entry.won / ts * 100) : 0;
      const rates = settled_codes.map(c => c.hitRate);
      const avg = rates.length ? rates.reduce((a, r) => a + r, 0) / rates.length : 0;
      const variance = rates.length > 1 ? Math.sqrt(rates.reduce((a, r) => a + Math.pow(r - avg, 2), 0) / rates.length) : 0;
      entry.consistency = Math.round(100 - variance);
      let trust = entry.hitRate;
      if (rates.length >= 3 && variance < 15) trust += 10;
      if (rates.some(r => r >= 80)) trust += 10;
      if (rates.some(r => r < 40)) trust -= 10;
      entry.trustScore = Math.max(0, Math.min(100, trust));
      entry.lastActive = date || new Date().toISOString().slice(0, 10);
      entry.daysActive = new Set(entry.codes.map(c => c.date)).size;
      fs.writeFileSync(path.join(DATA_DIR, "leaderboard.json"), JSON.stringify(lb, null, 2));
    } catch {}

    // Also write to punter-codes.json if the date is today (so it shows in Today's Punter Codes)
    try {
      const today = localToday();
      const codeDate = date || today;
      if (codeDate === today) {
        const pc = JSON.parse(fs.readFileSync(PUNTER_CODES_FILE, "utf-8").replace(/^﻿/, ""));
        pc[name] = code.trim().toUpperCase();
        pc._date = today;
        fs.writeFileSync(PUNTER_CODES_FILE, JSON.stringify(pc, null, 2));
      }
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

// Regenerate all codes (runs analyze2.js) — guard against concurrent spawns
let _regenRunning = false;
app.post("/api/admin/regen-all", requireAdmin, (req, res) => {
  if (_regenRunning) return res.json({ success: false, message: "Analysis already running — wait for it to finish." });
  _regenRunning = true;
  const { execFile } = require("child_process");
  execFile("node", [path.join(__dirname, "analyze2.js")], { timeout: 300000 }, (err, stdout, stderr) => {
    _regenRunning = false;
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

// ── Daily Post (morning X post generator) ────────────────────────────────────
const DAILY_MERGED_FILE = path.join(DATA_DIR, "daily-merged.json");

app.get("/api/admin/daily-post-data", requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const codes = loadPunterCodes();
  let merged = "";
  try {
    const dm = JSON.parse(fs.readFileSync(DAILY_MERGED_FILE, "utf-8"));
    if (dm.date === today) merged = dm.code || "";
  } catch {}
  res.json({ date: today, codes, merged });
});

app.post("/api/admin/daily-merged", requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { code } = req.body;
  fs.writeFileSync(DAILY_MERGED_FILE, JSON.stringify({ date: today, code: (code || "").trim().toUpperCase() }, null, 2));
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
  try {
    const raw = JSON.parse(fs.readFileSync(PUNTER_CODES_FILE, "utf-8").replace(/^﻿/, ""));
    const today = localToday();
    if (!raw._date || raw._date !== today) {
      // Date has changed — return empty codes without writing (caller must explicitly save)
      const clean = {};
      for (const k of Object.keys(raw)) { if (k !== "_date") clean[k] = ""; }
      return clean;
    }
    const clean = { ...raw };
    delete clean._date;
    return clean;
  }
  catch { return { "39 Billion": "", "9Z": "", "Big Strategic": "", "Ayo Jordan": "", "Bayo Bets": "", "OY": "", "Princewill": "", "Sirtee": "" }; }
}

app.get("/api/admin/punter-codes", requireAdmin, (req, res) => {
  const codes = loadPunterCodes();
  const clean = { ...codes };
  delete clean._date;
  res.json(clean);
});

// Aliases that must never appear as standalone keys — always merged into canonical
const PUNTER_ALIASES = {
  "Bayobet": "Bayo Bets", "Bayobets": "Bayo Bets",
  "Top Boy Comrade": "Top Boy",
  "SuperMario": "Super Mario",
};

app.post("/api/admin/punter-codes", requireAdmin, (req, res) => {
  const current = loadPunterCodes();
  const today = localToday();
  const merged = { ...current, ...req.body, _date: today };
  // Collapse aliases into canonical names, delete alias keys
  for (const [alias, canonical] of Object.entries(PUNTER_ALIASES)) {
    if (alias in merged) {
      if (merged[alias] && !merged[canonical]) merged[canonical] = merged[alias];
      delete merged[alias];
    }
  }
  fs.writeFileSync(PUNTER_CODES_FILE, JSON.stringify(merged, null, 2));
  const clean = { ...merged }; delete clean._date;
  res.json({ success: true, codes: clean });
});

// ── Community Codes ──

const COMMUNITY_CODES_FILE = path.join(DATA_DIR, "community-codes.json");

function loadCommunityCodes() {
  try { return JSON.parse(fs.readFileSync(COMMUNITY_CODES_FILE, "utf-8")); }
  catch { return []; }
}
function saveCommunityCodes(list) {
  fs.writeFileSync(COMMUNITY_CODES_FILE, JSON.stringify(list, null, 2));
}

app.get("/api/admin/community-codes", requireAdmin, (req, res) => {
  res.json(loadCommunityCodes());
});

app.post("/api/admin/community-codes", requireAdmin, (req, res) => {
  const { code, source, platform, notes } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  const list = loadCommunityCodes();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    code: code.trim().toUpperCase(),
    source: (source || "").trim(),
    platform: platform || "SportyBet",
    addedBy: "admin",
    dateAdded: localToday(),
    notes: (notes || "").trim(),
    status: "pending",
    scanResult: null,
    promoted: false,
    promotedAs: null,
  };
  list.unshift(entry);
  saveCommunityCodes(list);
  res.json({ success: true, entry });
});

app.delete("/api/admin/community-codes/:id", requireAdmin, (req, res) => {
  const list = loadCommunityCodes().filter(c => c.id !== req.params.id);
  saveCommunityCodes(list);
  res.json({ success: true });
});

app.post("/api/admin/community-codes/:id/scan", requireAdmin, async (req, res) => {
  const list = loadCommunityCodes();
  const entry = list.find(c => c.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found" });
  try {
    const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(entry.code)}`;
    const json = await fetchJSON(url);
    if (!json || json.bizCode !== 10000 || !json.data) throw new Error("SportyBet returned no data");
    const outcomes = json.data.outcomes || [];
    const ticketSels = json.data.ticket?.selections || [];
    const selections = mapOutcomes(outcomes, ticketSels);
    const results = selections.map(s => ({ ...s, verdict: evaluateVerdict(s) }));
    const won = results.filter(r => r.verdict === "WON").length;
    const lost = results.filter(r => r.verdict === "LOST").length;
    const pending = results.filter(r => r.verdict === "PENDING").length;
    const voided = results.filter(r => r.verdict === "VOID").length;
    const settled = won + lost;
    entry.scanResult = { total: results.length, won, lost, void: voided, pending, hitRate: settled > 0 ? Math.round(won / settled * 100) : 0, scannedAt: new Date().toISOString() };
    entry.status = "scanned";
    saveCommunityCodes(list);
    res.json({ success: true, entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/community-codes/:id/promote", requireAdmin, (req, res) => {
  const { punterName } = req.body;
  if (!punterName) return res.status(400).json({ error: "punterName required" });
  const list = loadCommunityCodes();
  const entry = list.find(c => c.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found" });

  // Add to punter-codes.json so it gets tracked
  try {
    const pc = JSON.parse(fs.readFileSync(PUNTER_CODES_FILE, "utf-8").replace(/^﻿/, ""));
    pc[punterName] = entry.code;
    pc._date = localToday();
    fs.writeFileSync(PUNTER_CODES_FILE, JSON.stringify(pc, null, 2));
  } catch {}

  entry.status = "promoted";
  entry.promoted = true;
  entry.promotedAs = punterName;
  saveCommunityCodes(list);
  res.json({ success: true, entry });
});

// ── Social Links (editable from admin) ──

const SOCIAL_FILE = path.join(DATA_DIR, "social-links.json");

app.get("/api/social-links", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SOCIAL_FILE, "utf-8"))); }
  catch { res.json({ twitter: "slippilot", email: "support@slippilot.com.ng" }); }
});

app.get("/api/admin/social-links", requireAdmin, (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SOCIAL_FILE, "utf-8"))); }
  catch { res.json({ twitter: "slippilot", email: "support@slippilot.com.ng" }); }
});

app.post("/api/admin/social-links", requireAdmin, (req, res) => {
  const { twitter, email } = req.body;
  const data = { twitter: (twitter || "").trim(), email: (email || "").trim() };
  fs.writeFileSync(SOCIAL_FILE, JSON.stringify(data, null, 2));
  res.json({ success: true, ...data });
});

// ── User Submissions ──

const SUBMISSIONS_FILE = path.join(DATA_DIR, "user-submissions.json");

app.post("/api/submit-code", (req, res) => {
  const { code, punter } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  try {
    let subs = [];
    try { subs = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, "utf-8")); } catch {}
    subs.push({ code: code.trim().toUpperCase(), punter: punter || "Unknown", timestamp: new Date().toISOString(), source: "user-submission" });
    if (subs.length > 1000) subs = subs.slice(-1000);
    fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(subs, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/submissions", requireAdmin, (req, res) => {
  try {
    const subs = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, "utf-8"));
    const punterCounts = {};
    for (const s of subs) { punterCounts[s.punter || "Unknown"] = (punterCounts[s.punter || "Unknown"] || 0) + 1; }
    const topPunters = Object.entries(punterCounts).sort((a, b) => b[1] - a[1]);
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = subs.filter(s => s.timestamp?.startsWith(today)).length;
    res.json({ total: subs.length, today: todayCount, topPunters, recent: subs.slice(-20).reverse() });
  } catch { res.json({ total: 0, today: 0, topPunters: [], recent: [] }); }
});

// ── Enhanced Leaderboard API ──

const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const CODE_HISTORY_FILE = path.join(DATA_DIR, "code-history.json");
const WEAK_MATCHES_FILE = path.join(DATA_DIR, "weak-matches.json");

function loadLeaderboard() {
  let lb = [];
  try { lb = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf-8").replace(/^﻿/, "")); } catch {}
  // Auto-merge from punter-profiles.json if leaderboard is missing trust/win data
  try {
    const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
    const lbMap = new Map(lb.map(p => [p.punter, p]));
    for (const [name, prof] of Object.entries(profiles)) {
      let entry = lbMap.get(name);
      if (!entry) { entry = { punter: name }; lb.push(entry); lbMap.set(name, entry); }
      if (!entry.trustScore && prof.trustScore) entry.trustScore = prof.trustScore;
      if (!entry.won && prof.won) entry.won = prof.won;
      if (!entry.lost && prof.lost) entry.lost = prof.lost;
      if (!entry.hitRate && prof.hitRate) entry.hitRate = prof.hitRate;
      if (!entry.handle && prof.handle) entry.handle = prof.handle;
      if (!entry.consistency && prof.consistency) entry.consistency = prof.consistency;
      if ((!entry.codes || !entry.codes.length) && prof.codes && prof.codes.length) entry.codes = prof.codes;
      if (!entry.tier && prof.tier) entry.tier = prof.tier;
    }
  } catch {}
  // Attach today's active code from punter-codes.json
  try {
    const todayCodes = loadPunterCodes();
    const today = localToday();
    const lbMap2 = new Map(lb.map(p => [p.punter, p]));
    for (const [name, code] of Object.entries(todayCodes)) {
      if (!code || name === "_date" || name.startsWith("_")) continue;
      let entry = lbMap2.get(name);
      if (!entry) { entry = { punter: name, codes: [], daysActive: 0, totalGames: 0 }; lb.push(entry); lbMap2.set(name, entry); }
      entry.lastActive = today;
      if (!entry.codes) entry.codes = [];
      const codeStr = typeof code === "string" ? code : (Array.isArray(code) ? code[0] : "");
      if (codeStr && !entry.codes.some(c => c.code === codeStr)) {
        entry.codes.unshift({ code: codeStr, date: today, games: 0, won: 0, lost: 0, void: 0, pending: 0, hitRate: 0, status: "active" });
      }
      // Badge = today's code ONLY if it has pending games or hasn't been scanned yet
      const codeEntry = entry.codes.find(c => c.code === codeStr);
      if (codeEntry && (codeEntry.pending > 0 || codeEntry.games === 0) && codeEntry.date === today) {
        entry.todayCode = code;
      } else {
        entry.todayCode = "";
      }
      entry.daysActive = new Set([...(entry.codes||[]).map(c => c.date), today].filter(Boolean)).size;
    }
  } catch {}
  // Attach codes from code-history (skip AI/SlipPilot/Generated)
  try {
    const ch = loadCodeHistory();
    const lbMap3 = new Map(lb.map(p => [p.punter, p]));
    for (const c of ch) {
      if (!c.punter || !c.code) continue;
      const n = c.punter;
      if (n.includes("SlipPilot") || n.includes("Generated") || n.startsWith("AI") || n.includes("Independent") || n.includes("Jun2")) continue;
      let entry = lbMap3.get(n);
      if (!entry) continue;
      if (!entry.codes) entry.codes = [];
      if (!entry.codes.some(x => x.code === c.code)) {
        entry.codes.push({ code: c.code, date: c.date, games: c.games || 0, won: 0, lost: 0, void: 0, pending: c.games || 0, hitRate: 0, group: c.group });
      }
    }
  } catch {}
  // Final filter: remove any non-human entries
  const final = lb.filter(p => {
    const n = p.punter || "";
    if (n.startsWith("_") || n === "_date") return false;
    if (n.includes("SlipPilot") || n.includes("Generated") || n.startsWith("AI (") || n.includes("Independent")) return false;
    return true;
  });
  return final;
}
function loadCodeHistory() { try { return JSON.parse(fs.readFileSync(CODE_HISTORY_FILE, "utf-8")); } catch { return []; } }
function loadWeakMatches() { try { return JSON.parse(fs.readFileSync(WEAK_MATCHES_FILE, "utf-8")); } catch { return {}; } }

app.get("/api/leaderboard", (req, res) => {
  const lb = loadLeaderboard();
  const { sort, order, search } = req.query;
  let list = [...lb];

  if (search) {
    const q = search.toLowerCase();
    list = list.filter(p => (p.punter || "").toLowerCase().includes(q) || (p.handle || "").toLowerCase().includes(q));
  }

  const dir = order === "asc" ? 1 : -1;
  const sortFns = {
    wins: (a, b) => ((a.won || 0) - (b.won || 0)) * dir,
    winPct: (a, b) => ((a.consensusRate || 0) - (b.consensusRate || 0)) * dir,
    totalBets: (a, b) => ((a.totalGames || 0) - (b.totalGames || 0)) * dir,
    roi: (a, b) => ((a.roi || 0) - (b.roi || 0)) * dir,
    consensus: (a, b) => ((a.consensusRate || 0) - (b.consensusRate || 0)) * dir,
    conversion: (a, b) => ((a.conversionRate || 0) - (b.conversionRate || 0)) * dir,
    risk: (a, b) => (({ low: 1, medium: 2, high: 3 }[a.riskProfile] || 0) - ({ low: 1, medium: 2, high: 3 }[b.riskProfile] || 0)) * dir,
    active: (a, b) => ((a.daysActive || 0) - (b.daysActive || 0)) * dir,
    lastActive: (a, b) => ((a.lastActive || "").localeCompare(b.lastActive || "")) * dir,
    consistency: (a, b) => ((a.consistency || 0) - (b.consistency || 0)) * dir,
    avgOdds: (a, b) => ((a.avgOdds || 0) - (b.avgOdds || 0)) * dir,
    trust: (a, b) => ((a.trustScore || 0) - (b.trustScore || 0)) * dir,
    hitRate: (a, b) => ((a.hitRate || 0) - (b.hitRate || 0)) * dir,
  };
  // Split humans and AI, sort humans, AI always at bottom
  const isAIPunter = (p) => p.isAI || p.punter === "Generated" || p.punter.startsWith("AI (") || p.punter === "SlipPilot";
  let humans = list.filter(p => !isAIPunter(p));
  let ais = list.filter(p => isAIPunter(p));
  if (sortFns[sort]) { humans.sort(sortFns[sort]); ais.sort(sortFns[sort]); }
  list = [...humans, ...ais];

  // Compute badges
  const badges = {};
  if (lb.length) {
    const byWins = [...lb].sort((a, b) => (b.won || b.wins || 0) - (a.won || a.wins || 0));
    const byCons = [...lb].sort((a, b) => (b.consistency || 0) - (a.consistency || 0));
    const byActive = [...lb].sort((a, b) => (b.daysActive || 0) - (a.daysActive || 0));
    const byOdds = [...lb].sort((a, b) => (b.avgOdds || 0) - (a.avgOdds || 0));
    const byROI = [...lb].sort((a, b) => (b.roi || 0) - (a.roi || 0));
    if (byWins[0]) badges[byWins[0].punter] = [...(badges[byWins[0].punter] || []), "Top Winner"];
    if (byOdds[0]) badges[byOdds[0].punter] = [...(badges[byOdds[0].punter] || []), "Highest Odds"];
    if (byCons[0]) badges[byCons[0].punter] = [...(badges[byCons[0].punter] || []), "Most Consistent"];
    if (byActive[0]) badges[byActive[0].punter] = [...(badges[byActive[0].punter] || []), "Most Active"];
    if (byROI[0] && (byROI[0].roi || 0) > 0) badges[byROI[0].punter] = [...(badges[byROI[0].punter] || []), "Best ROI"];
  }

  list.forEach(p => { p.badges = badges[p.punter] || []; });

  // Auto-remove AI/Generated codes with 10+ losses
  for (const p of list) {
    if (p.isAI || p.punter === "Generated" || p.punter.startsWith("AI (") || p.punter === "SlipPilot") {
      if (p.codes) p.codes = p.codes.filter(c => (c.lost || 0) < 10);
    }
  }
  // Remove non-human entries
  const final = list.filter(p => {
    const n = p.punter || "";
    if (n.startsWith("_") || n === "_date") return false;
    if (n.includes("SlipPilot") || n.includes("Generated") || n.startsWith("AI (") || n.includes("Independent")) return false;
    if (p.isAI) return false;
    return true;
  });

  res.json({ leaderboard: final, total: final.length });
});

app.get("/api/code-history", requireAdmin, (req, res) => {
  const history = loadCodeHistory();
  const { punter, group, status } = req.query;
  let list = [...history];
  if (punter) list = list.filter(c => c.punter === punter);
  if (group) list = list.filter(c => c.group === group);
  if (status) list = list.filter(c => c.status === status);
  res.json({ codes: list.slice(-200), total: list.length });
});

app.post("/api/code-history/update-status", requireAdmin, (req, res) => {
  const { code, status } = req.body;
  if (!code || !status) return res.status(400).json({ error: "code and status required" });
  const history = loadCodeHistory();
  const entry = history.find(c => c.code === code);
  if (!entry) return res.status(404).json({ error: "code not found" });
  entry.status = status;
  entry.updatedAt = new Date().toISOString();
  fs.writeFileSync(CODE_HISTORY_FILE, JSON.stringify(history, null, 2));

  // Update weak matches if status is "lost"
  if (status === "lost" && entry.picks) {
    const weak = loadWeakMatches();
    for (const pick of entry.picks) {
      const eid = pick.eventId || pick.event;
      if (!eid) continue;
      if (!weak[eid]) weak[eid] = { eventId: eid, match: pick.home || pick.match || "", appearances: 0, losses: 0, failureRate: 0 };
      weak[eid].losses++;
      weak[eid].failureRate = weak[eid].appearances > 0 ? Math.round(weak[eid].losses / weak[eid].appearances * 100) : 0;
    }
    fs.writeFileSync(WEAK_MATCHES_FILE, JSON.stringify(weak, null, 2));
  }

  res.json({ success: true });
});

app.get("/api/weak-matches", requireAdmin, (req, res) => {
  res.json(loadWeakMatches());
});

// ── Scan Single Code + Update Leaderboard ──

app.post("/api/admin/scan-code", requireAdmin, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  try {
    const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code.trim().toUpperCase())}`;
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

    // Update leaderboard — use loadLeaderboard() so today's punter-codes.json codes are found
    try {
      const lb = loadLeaderboard();
      const codeUpper = code.trim().toUpperCase();
      for (const entry of lb) {
        if (!entry.codes) continue;
        const ce = entry.codes.find(c => c.code === codeUpper);
        if (ce) {
          ce.games = results.length; ce.won = won; ce.lost = lost; ce.void = voided; ce.pending = pending; ce.hitRate = hitRate;
          const sc = entry.codes.filter(c => (c.won + c.lost) > 0);
          entry.won = sc.reduce((a, c) => a + c.won, 0);
          entry.lost = sc.reduce((a, c) => a + c.lost, 0);
          entry.totalGames = sc.reduce((a, c) => a + c.games, 0);
          const ts = entry.won + entry.lost;
          entry.hitRate = ts > 0 ? Math.round(entry.won / ts * 100) : 0;
        }
      }
      // Write merged data back so scan results persist across restarts
      fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2));
    } catch {}

    res.json({ success: true, won, lost, void: voided, pending, hitRate, total: results.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auto-Rescan All Punter Codes ──

// ── Intelligence Engine ────────────────────────────────────────────────────────

const ODDS_HISTORY_FILE = path.join(DATA_DIR, "odds-history.json");
const ODDS_BANK_FILE    = path.join(DATA_DIR, "odds-bank.json"); // legacy — migrated on first write
const LEAGUE_INTEL_FILE = path.join(DATA_DIR, "league-intelligence.json");
const MARKET_INTEL_FILE = path.join(DATA_DIR, "market-intelligence.json");
const TEAM_INTEL_FILE   = path.join(DATA_DIR, "team-intelligence.json");
const SEL_HISTORY_FILE  = path.join(DATA_DIR, "selection-history.json");

// ── In-memory intel cache (invalidated after every rescan) ────────────────────
let _intel = { league: null, market: null, team: null, selHistory: null };
function clearIntelCache() { _intel = { league: null, market: null, team: null, selHistory: null }; }

const BANNED_LEAGUE_KEYWORDS = [
  "kolmonen","4. deild","3. deild","besta deild","club friendlies",
  "youth","women","virtual","usl league two","serie b ecuador","carioca",
  "mineiro","azadegan","russian 2. liga","division 2","division 3",
  "division 4","division 5","brasileiro serie b","esiliiga b",
];
function isBannedLeague(l) {
  const s = (l || "").toLowerCase();
  return BANNED_LEAGUE_KEYWORDS.some(b => s.includes(b));
}

function oddsKey(s) {
  return `${s.league}|${s.homeTeam}|${s.awayTeam}|${s.market}|${s.outcome}`;
}

function loadOddsBank() {
  // Try new file first; fall back to legacy odds-bank.json for migration
  try { return JSON.parse(fs.readFileSync(ODDS_HISTORY_FILE, "utf8")); } catch {}
  try { return JSON.parse(fs.readFileSync(ODDS_BANK_FILE, "utf8")); } catch {}
  return {};
}

// Debounced async write — never blocks the event loop
let _oddsBankWriteTimer = null;
let _oddsBankDirty = false;
let _oddsBankCache = null;

function storeOriginalOdds(bank, selections, timestamp) {
  let changed = false;
  for (const s of selections) {
    if (!s.odds || s.odds <= 1) continue;
    const key = oddsKey(s);
    if (!bank[key]) {
      bank[key] = {
        eventId: s.eventId,
        league: s.league, homeTeam: s.homeTeam, awayTeam: s.awayTeam,
        market: s.market, outcome: s.outcome, originalOdds: s.odds,
        kickoff: s.kickoff, firstSeen: timestamp,
      };
      changed = true;
    }
  }
  if (changed) {
    _oddsBankDirty = true;
    _oddsBankCache = bank;
    clearTimeout(_oddsBankWriteTimer);
    _oddsBankWriteTimer = setTimeout(() => {
      if (_oddsBankDirty && _oddsBankCache) {
        fs.writeFile(ODDS_HISTORY_FILE, JSON.stringify(_oddsBankCache, null, 2), (err) => {
          if (err) console.error("[OddsHistory] write failed:", err.message);
        });
        _oddsBankDirty = false;
      }
    }, 3000);
  }
}

function getBankOdds(bank, s) {
  return bank[oddsKey(s)]?.originalOdds || null;
}

function getBankEntry(bank, s) {
  return bank[oddsKey(s)] || null;
}

function formatTotalOdds(n) {
  if (!n || n <= 1 || !isFinite(n)) return null;
  if (n >= 1e15) return ">999T";
  const sig3 = v => { const s = parseFloat(v.toPrecision(3)); return isFinite(s) ? String(s) : v.toFixed(0); };
  if (n < 1000)  return parseFloat(n.toPrecision(3)).toString();
  if (n < 1e6)   return sig3(n / 1e3)  + "K";
  if (n < 1e9)   return sig3(n / 1e6)  + "M";
  if (n < 1e12)  return sig3(n / 1e9)  + "B";
  return sig3(n / 1e12) + "T";
}

function loadLeagueIntelligence() {
  if (_intel.league) return _intel.league;
  try { _intel.league = JSON.parse(fs.readFileSync(LEAGUE_INTEL_FILE, "utf8")); } catch { _intel.league = {}; }
  return _intel.league;
}

function updateLeagueIntelligence(resultsByDate) {
  const intel = loadLeagueIntelligence();
  for (const results of Object.values(resultsByDate)) {
    for (const r of results) {
      if (r.verdict === "PENDING" || r.verdict === "VOID" || !r.league) continue;
      if (!intel[r.league]) intel[r.league] = {
        league: r.league, totalSelections: 0, won: 0, lost: 0,
        markets: {}, banned: isBannedLeague(r.league), lastUpdated: "",
      };
      const li = intel[r.league];
      li.totalSelections++;
      if (r.verdict === "WON") li.won++; else li.lost++;
      li.hitRate = li.won + li.lost > 0 ? Math.round(li.won / (li.won + li.lost) * 100) : 0;
      const mk = r.market || "Unknown";
      if (!li.markets[mk]) li.markets[mk] = { won: 0, lost: 0, hitRate: 0 };
      if (r.verdict === "WON") li.markets[mk].won++; else li.markets[mk].lost++;
      const mt = li.markets[mk].won + li.markets[mk].lost;
      li.markets[mk].hitRate = mt > 0 ? Math.round(li.markets[mk].won / mt * 100) : 0;
      li.lastUpdated = new Date().toISOString().slice(0, 10);
    }
  }
  try { fs.writeFileSync(LEAGUE_INTEL_FILE, JSON.stringify(intel, null, 2)); } catch {}
  return intel;
}

function loadMarketIntelligence() {
  if (_intel.market) return _intel.market;
  try { _intel.market = JSON.parse(fs.readFileSync(MARKET_INTEL_FILE, "utf8")); } catch { _intel.market = {}; }
  return _intel.market;
}

function loadTeamIntelligence() {
  if (_intel.team) return _intel.team;
  try { _intel.team = JSON.parse(fs.readFileSync(TEAM_INTEL_FILE, "utf8")); } catch { _intel.team = {}; }
  return _intel.team;
}

function loadSelectionHistory() {
  if (_intel.selHistory) return _intel.selHistory;
  try { _intel.selHistory = JSON.parse(fs.readFileSync(SEL_HISTORY_FILE, "utf8")); } catch { _intel.selHistory = {}; }
  return _intel.selHistory;
}

function updateTeamIntelligence(resultsByDate) {
  const intel = loadTeamIntelligence();
  for (const results of Object.values(resultsByDate)) {
    for (const r of results) {
      if (r.verdict === "PENDING" || r.verdict === "VOID") continue;
      const won = r.verdict === "WON";
      const out = (r.outcome || "").toLowerCase();
      const mkt = (r.market  || "").toLowerCase();
      const isHomePick = out === "home" || out === "1" || out === "home win" || mkt === "1x2" && out === "home";
      const isAwayPick = out === "away" || out === "2" || out === "away win" || mkt === "1x2" && out === "away";
      for (const [team, side] of [[r.homeTeam, isHomePick ? "home" : null], [r.awayTeam, isAwayPick ? "away" : null]]) {
        if (!team || !side) continue;
        if (!intel[team]) intel[team] = { home: { won: 0, lost: 0 }, away: { won: 0, lost: 0 } };
        if (won) intel[team][side].won++; else intel[team][side].lost++;
      }
    }
  }
  for (const t of Object.values(intel)) {
    for (const side of ["home", "away"]) {
      const total = t[side].won + t[side].lost;
      t[side].hitRate = total > 0 ? Math.round(t[side].won / total * 100) : null;
    }
  }
  try { fs.writeFileSync(TEAM_INTEL_FILE, JSON.stringify(intel, null, 2)); } catch {}
  _intel.team = intel;
  return intel;
}

function updateSelectionHistory(resultsByDate) {
  const history = loadSelectionHistory();
  for (const results of Object.values(resultsByDate)) {
    for (const r of results) {
      if (r.verdict === "PENDING" || r.verdict === "VOID") continue;
      const key = oddsKey(r);
      if (!history[key]) history[key] = { appearances: 0, won: 0, lost: 0, hitRate: 0, totalWinOdds: 0, totalLoseOdds: 0, avgWinOdds: 0, avgLoseOdds: 0, lastSeen: "" };
      const h = history[key];
      h.appearances++;
      const odds = r.originalOdds || r.odds || 0;
      if (r.verdict === "WON") { h.won++; h.totalWinOdds += odds; }
      else                      { h.lost++; h.totalLoseOdds += odds; }
      const total = h.won + h.lost;
      h.hitRate      = total > 0 ? Math.round(h.won / total * 100) : 0;
      h.avgWinOdds   = h.won  > 0 ? Math.round(h.totalWinOdds  / h.won  * 100) / 100 : 0;
      h.avgLoseOdds  = h.lost > 0 ? Math.round(h.totalLoseOdds / h.lost * 100) / 100 : 0;
      h.lastSeen     = new Date().toISOString().slice(0, 10);
    }
  }
  try { fs.writeFileSync(SEL_HISTORY_FILE, JSON.stringify(history, null, 2)); } catch {}
  _intel.selHistory = history;
  return history;
}

// Compute punter recent form from their last N days of codes
function getRecentForm(lbEntry, days = 7) {
  if (!lbEntry?.codes?.length) return null;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const recent = (lbEntry.codes || []).filter(c => c.date && new Date(c.date) >= cutoff && (c.won || 0) + (c.lost || 0) > 0);
  if (!recent.length) return null;
  const w = recent.reduce((a, c) => a + (c.won || 0), 0);
  const l = recent.reduce((a, c) => a + (c.lost || 0), 0);
  return w + l > 0 ? Math.round(w / (w + l) * 100) : null;
}

function updateMarketIntelligence(resultsByDate) {
  const intel = loadMarketIntelligence();
  for (const results of Object.values(resultsByDate)) {
    for (const r of results) {
      if (r.verdict === "PENDING" || r.verdict === "VOID") continue;
      const mk = r.market || "Unknown";
      if (!intel[mk]) intel[mk] = {
        market: mk, totalSelections: 0, won: 0, lost: 0,
        totalWinOdds: 0, totalLoseOdds: 0, lastUpdated: "",
      };
      const mi = intel[mk];
      mi.totalSelections++;
      const odds = r.originalOdds || r.odds || 0;
      if (r.verdict === "WON") { mi.won++; mi.totalWinOdds += odds; }
      else { mi.lost++; mi.totalLoseOdds += odds; }
      const total = mi.won + mi.lost;
      mi.hitRate    = total > 0 ? Math.round(mi.won / total * 100) : 0;
      mi.avgWinOdds  = mi.won  > 0 ? Math.round(mi.totalWinOdds  / mi.won  * 100) / 100 : 0;
      mi.avgLoseOdds = mi.lost > 0 ? Math.round(mi.totalLoseOdds / mi.lost * 100) / 100 : 0;
      mi.lastUpdated = new Date().toISOString().slice(0, 10);
    }
  }
  try { fs.writeFileSync(MARKET_INTEL_FILE, JSON.stringify(intel, null, 2)); } catch {}
  return intel;
}

function generateDailyAnalysis(results, date, leagueIntel, marketIntel) {
  const settled = results.filter(r => r.verdict === "WON" || r.verdict === "LOST");
  const won     = settled.filter(r => r.verdict === "WON");
  const lost    = settled.filter(r => r.verdict === "LOST");

  // Group by match
  const matchMap = {};
  for (const r of results) {
    const key = `${r.homeTeam}|${r.awayTeam}|${r.kickoff}`;
    if (!matchMap[key]) matchMap[key] = {
      homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league, kickoff: r.kickoff, selections: [],
    };
    matchMap[key].selections.push(r);
  }

  // Ticket killers & consensus wins
  const ticketKillers = [], consensusWins = [];
  for (const match of Object.values(matchMap)) {
    const ms = match.selections.filter(s => s.verdict === "WON" || s.verdict === "LOST");
    if (ms.length < 2) continue;
    const mLost = ms.filter(s => s.verdict === "LOST");
    const mWon  = ms.filter(s => s.verdict === "WON");

    for (const [group, target] of [[mLost, ticketKillers], [mWon, consensusWins]]) {
      if (group.length < 2) continue;
      const punters = [...new Set(group.map(s => s.punter))];
      const codes   = [...new Set(group.map(s => s.code))];
      const avgOdds = group.reduce((a, s) => a + (s.originalOdds || s.odds || 0), 0) / group.length;
      const leagueHR = (leagueIntel || {})[match.league]?.hitRate;
      const mktHRs   = group.map(s => (marketIntel || {})[s.market]?.hitRate).filter(Boolean);
      const avgMktHR = mktHRs.length ? Math.round(mktHRs.reduce((a, b) => a + b, 0) / mktHRs.length) : null;

      let confidence = 50;
      if (leagueHR != null) confidence = (confidence + leagueHR) / 2;
      if (avgMktHR  != null) confidence = (confidence + avgMktHR) / 2;
      if (avgOdds > 5)  confidence -= 20;
      if (avgOdds > 10) confidence -= 15;
      if (punters.length === 1) confidence -= 10;
      if (punters.length >= 3)  confidence += 10;
      if (target === consensusWins && avgOdds < 2) confidence += 5;
      confidence = Math.max(5, Math.min(99, Math.round(confidence)));

      const reasons = target === ticketKillers ? [
        ...(avgOdds > 5 ? [`Very high odds market (${avgOdds.toFixed(2)})`] : []),
        ...(punters.length === 1 ? ["Only 1 punter suggested it — low consensus"] : []),
        ...(leagueHR != null && leagueHR < 60 ? [`${match.league} has low historical hit rate (${leagueHR}%)`] : []),
        ...(avgMktHR != null && avgMktHR < 55 ? ["Market historically underperforms"] : []),
      ] : [];

      target.push({
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        homeTeam: match.homeTeam, awayTeam: match.awayTeam,
        league: match.league, kickoff: match.kickoff,
        punters, codes,
        selections: group.map(s => ({
          market: s.market, outcome: s.outcome,
          originalOdds: s.originalOdds || s.odds, punter: s.punter,
        })),
        codeCount: codes.length, punterCount: punters.length,
        avgOdds: Math.round(avgOdds * 100) / 100,
        confidence, reasons,
        recommendation: target === ticketKillers
          ? (avgOdds > 5 || punters.length === 1
              ? "Blacklist this market family or require 3+ punter consensus."
              : leagueHR != null && leagueHR < 60
                ? "Avoid this league in future slips."
                : "Review market selection strategy.")
          : undefined,
        leagueHitRate: leagueHR || null,
        marketHitRate: avgMktHR || null,
      });
    }
  }
  ticketKillers.sort((a, b) => b.punterCount - a.punterCount || b.codeCount - a.codeCount);
  consensusWins.sort((a, b) => b.punterCount - a.punterCount || b.codeCount - a.codeCount);

  // Per-day league stats
  const dayLeague = {};
  for (const r of settled) {
    if (!r.league) continue;
    if (!dayLeague[r.league]) dayLeague[r.league] = {
      league: r.league, won: 0, lost: 0, selections: 0, banned: isBannedLeague(r.league), markets: {},
    };
    const ls = dayLeague[r.league];
    ls.selections++;
    if (r.verdict === "WON") ls.won++; else ls.lost++;
    const mk = r.market || "Unknown";
    if (!ls.markets[mk]) ls.markets[mk] = { won: 0, lost: 0 };
    if (r.verdict === "WON") ls.markets[mk].won++; else ls.markets[mk].lost++;
  }
  for (const ls of Object.values(dayLeague)) {
    ls.hitRate = ls.won + ls.lost > 0 ? Math.round(ls.won / (ls.won + ls.lost) * 100) : 0;
    for (const mk of Object.values(ls.markets)) {
      const mt = mk.won + mk.lost;
      mk.hitRate = mt > 0 ? Math.round(mk.won / mt * 100) : 0;
    }
  }

  // Per-day market stats
  const dayMarket = {};
  for (const r of settled) {
    const mk = r.market || "Unknown";
    if (!dayMarket[mk]) dayMarket[mk] = { market: mk, won: 0, lost: 0, selections: 0 };
    dayMarket[mk].selections++;
    if (r.verdict === "WON") dayMarket[mk].won++; else dayMarket[mk].lost++;
  }
  for (const ms of Object.values(dayMarket)) {
    ms.hitRate = ms.won + ms.lost > 0 ? Math.round(ms.won / (ms.won + ms.lost) * 100) : 0;
  }

  // Punter day stats
  const punterStats = {};
  for (const r of results) {
    if (!punterStats[r.punter]) punterStats[r.punter] = {
      punter: r.punter, won: 0, lost: 0, void: 0, pending: 0, codes: new Set(),
    };
    const ps = punterStats[r.punter];
    if (r.code) ps.codes.add(r.code);
    if      (r.verdict === "WON")     ps.won++;
    else if (r.verdict === "LOST")    ps.lost++;
    else if (r.verdict === "VOID")    ps.void++;
    else                              ps.pending++;
  }
  for (const ps of Object.values(punterStats)) {
    const t = ps.won + ps.lost;
    ps.hitRate = t > 0 ? Math.round(ps.won / t * 100) : 0;
    ps.codes   = [...ps.codes];
  }

  // Bullets
  const bullets = [];
  for (const tk of ticketKillers.slice(0, 3)) {
    const selStr = [...new Set(tk.selections.map(s => s.outcome ? `${s.market}: ${s.outcome}` : s.market))].join("; ");
    bullets.push(`${tk.match} trapped ${tk.punterCount} punter${tk.punterCount > 1 ? "s" : ""} (${tk.punters.join(", ")}) — ${selStr} lost across ${tk.codeCount} slip${tk.codeCount !== 1 ? "s" : ""}.`);
  }
  for (const cw of consensusWins.slice(0, 2)) {
    const selStr = [...new Set(cw.selections.map(s => s.outcome || s.market))].join(", ");
    bullets.push(`${cw.match} rewarded ${cw.punterCount} punter${cw.punterCount > 1 ? "s" : ""} (${cw.punters.join(", ")}) — ${selStr}.`);
  }
  const worstMkt = Object.values(dayMarket).filter(ms => ms.selections >= 3 && ms.hitRate < 50).sort((a, b) => a.hitRate - b.hitRate)[0];
  if (worstMkt) bullets.push(`${worstMkt.market} was the weakest market today: ${worstMkt.hitRate}% (${worstMkt.won}W/${worstMkt.lost}L).`);
  const bestMkt = Object.values(dayMarket).filter(ms => ms.selections >= 3 && ms.hitRate >= 70).sort((a, b) => b.hitRate - a.hitRate)[0];
  if (bestMkt) bullets.push(`${bestMkt.market} was the strongest market: ${bestMkt.hitRate}% (${bestMkt.won}W/${bestMkt.lost}L).`);
  const bannedActive = Object.values(dayLeague).filter(ls => ls.banned && ls.selections > 0);
  if (bannedActive.length) {
    const bannedLoss = bannedActive.reduce((a, ls) => a + ls.lost, 0);
    const bannedTotal = bannedActive.reduce((a, ls) => a + ls.selections, 0);
    bullets.push(`Flagged league${bannedActive.length > 1 ? "s" : ""} ${bannedActive.map(ls => ls.league).join(", ")} caused ${Math.round(bannedLoss / Math.max(1, bannedTotal) * 100)}% loss rate.`);
  }

  // Insights
  const insights = [];
  const bannedCount = results.filter(r => isBannedLeague(r.league)).length;
  if (bannedCount) insights.push(`${bannedCount} selection${bannedCount !== 1 ? "s" : ""} from flagged leagues were identified — filter before building slips.`);
  const worstLg = Object.values(dayLeague).filter(ls => !ls.banned && ls.selections >= 3 && ls.hitRate < 50).sort((a, b) => a.hitRate - b.hitRate)[0];
  if (worstLg) insights.push(`${worstLg.league} caused ${worstLg.lost} loss${worstLg.lost !== 1 ? "es" : ""} today at ${worstLg.hitRate}% — consider down-weighting.`);
  if (worstMkt) {
    const alt = worstMkt.market.includes("2.5") ? "Over 1.5" : worstMkt.market === "GG" ? "Double Chance" : null;
    insights.push(`${worstMkt.market} underperformed at ${worstMkt.hitRate}%.${alt ? ` Historical data suggests ${alt} may be safer.` : ""}`);
  }
  const topPunters = Object.values(punterStats).filter(p => p.won + p.lost >= 3).sort((a, b) => b.hitRate - a.hitRate);
  if (topPunters.length >= 2) {
    const best = topPunters[0], worst = topPunters[topPunters.length - 1];
    insights.push(`${best.punter} led all analysts at ${best.hitRate}%. ${worst.punter} had the toughest session at ${worst.hitRate}%.`);
  }
  const consensusAnchors = Object.values(matchMap).filter(m => [...new Set(m.selections.map(s => s.punter))].length >= 3);
  if (consensusAnchors.length) insights.push(`${consensusAnchors.length} match${consensusAnchors.length !== 1 ? "es" : ""} had 3+ punter consensus — treat as anchor selections.`);

  // Headline
  let headline;
  if (ticketKillers.length && ticketKillers[0].punterCount >= 3)
    headline = `${ticketKillers[0].match} was the biggest killer, costing ${ticketKillers[0].punterCount} punters.`;
  else if (consensusWins.length && consensusWins[0].punterCount >= 3)
    headline = `${consensusWins[0].match} delivered the biggest consensus win for ${consensusWins[0].punterCount} punters.`;
  else if (ticketKillers.length)
    headline = `${ticketKillers[0].match} trapped ${ticketKillers[0].punterCount} punter${ticketKillers[0].punterCount > 1 ? "s" : ""}.`;
  else {
    const pct = settled.length > 0 ? Math.round(won.length / settled.length * 100) : 0;
    headline = `${pct}% of settled selections won on ${date} (${won.length}/${settled.length}).`;
  }

  return {
    date, generatedAt: new Date().toISOString(),
    analysis: {
      partial: settled.length < 10,
      headline, bullets, insights,
      leagueWatch: dayLeague,
      marketWatch: dayMarket,
      ticketKillers: ticketKillers.slice(0, 10),
      consensusWins: consensusWins.slice(0, 10),
      punterStats,
      totals: {
        selections: results.length, settled: settled.length,
        won: won.length, lost: lost.length,
        void: results.filter(r => r.verdict === "VOID").length,
        pending: results.filter(r => r.verdict === "PENDING").length,
        hitRate: settled.length > 0 ? Math.round(won.length / settled.length * 100) : 0,
      },
      allSelections: results.map(r => ({
        punter: r.punter, code: r.code, codeDate: r.codeDate,
        homeTeam: r.homeTeam, awayTeam: r.awayTeam, league: r.league,
        market: r.market, outcome: r.outcome,
        originalOdds: r.originalOdds, odds: r.odds,
        kickoff: r.kickoff, verdict: r.verdict,
        eventId: r.eventId, marketId: r.marketId,
        outcomeId: r.outcomeId, productId: r.productId, specifier: r.specifier,
      })),
    },
  };
}

let rescanRunning = false;
let rescanProgress = { scanned: 0, updated: 0, errors: 0, total: 0, stillPending: 0, phase: '' };

app.post("/api/admin/rescan-all", requireAdmin, async (req, res) => {
  if (rescanRunning) return res.status(409).json({ error: "Rescan already running" });
  rescanRunning = true;
  rescanProgress = { scanned: 0, updated: 0, errors: 0, total: 0, phase: 'Preparing…' };
  res.json({ success: true, message: "Rescan started" });

  try {
    const lb = loadLeaderboard(); // Uses merged data (profiles + code-history + punter-codes)
    const todayCodes = loadPunterCodes();
    const today = localToday();
    const lbMap = new Map(lb.map(p => [p.punter, p]));

    // Step 1: Add today's active codes to leaderboard if not present
    for (const [name, code] of Object.entries(todayCodes)) {
      if (!code || name === "_date" || name.startsWith("_")) continue;
      let entry = lbMap.get(name);
      if (!entry) { entry = { punter: name, codes: [], daysActive: 0, totalGames: 0, won: 0, lost: 0, hitRate: 0, trustScore: 0 }; lb.push(entry); lbMap.set(name, entry); }
      if (!entry.codes) entry.codes = [];
      const codeStr = typeof code === "string" ? code : (Array.isArray(code) ? code[0] : "");
      if (codeStr && !entry.codes.some(c => c.code === codeStr)) {
        entry.codes.unshift({ code: codeStr, date: today, games: 0, won: 0, lost: 0, void: 0, pending: 0, hitRate: 0 });
      }
    }

    // Count how many codes need scanning.
    // Codes with pending games but scanned within the last 20 min are skipped — they're fresh.
    const nowMs = Date.now();
    const staleMs = 20 * 60 * 1000;
    const needsScanFn = (c) => {
      const neverScanned = c.games === 0 && c.code && (c.scanAttempts || 0) < 3;
      const stale = !c.lastScanned || (nowMs - new Date(c.lastScanned).getTime()) > staleMs;
      return neverScanned || (c.pending > 0 && stale);
    };
    const totalToScan = lb.reduce((sum, e) => {
      if (!e.codes || e.punter === "Generated") return sum;
      return sum + e.codes.filter(needsScanFn).length;
    }, 0);
    rescanProgress.total = totalToScan;
    rescanProgress.phase = 'Scanning codes…';

    // Step 2: Rescan codes that need updating — skip bulk "Generated" entries
    let scanned = 0, updated = 0, errors = 0, stillPending = 0;
    const resultsByDate = {};
    const oddsBank = loadOddsBank();
    const scanTs = new Date().toISOString();

    for (const entry of lb) {
      if (!entry.codes) continue;
      if (entry.punter === "Generated") continue;
      for (const codeEntry of entry.codes) {
        if (!needsScanFn(codeEntry)) continue;
        try {
          const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(codeEntry.code)}`;
          const json = await fetchJSON(url);
          if (!json || json.bizCode !== 10000 || !json.data) {
            errors++;
            codeEntry.scanAttempts = (codeEntry.scanAttempts || 0) + 1;
            continue;
          }
          const outcomes = json.data.outcomes || [];
          const ticketSels = json.data.ticket?.selections || [];
          const selections = mapOutcomes(outcomes, ticketSels);
          const results = selections.map(s => ({ ...s, verdict: evaluateVerdict(s) }));

          storeOriginalOdds(oddsBank, selections, scanTs);

          const codeDate = codeEntry.date || today;
          if (!resultsByDate[codeDate]) resultsByDate[codeDate] = [];
          for (const r of results) {
            resultsByDate[codeDate].push({
              ...r, punter: entry.punter, code: codeEntry.code,
              codeDate, originalOdds: getBankOdds(oddsBank, r),
            });
          }

          const won = results.filter(r => r.verdict === "WON").length;
          const lost = results.filter(r => r.verdict === "LOST").length;
          const voided = results.filter(r => r.verdict === "VOID").length;
          const pending = results.filter(r => r.verdict === "PENDING").length;
          const hitRate = (won + lost) > 0 ? Math.round(won / (won + lost) * 100) : 0;
          const totalOdds = Math.round(selections.reduce((acc, s) => acc * (s.odds || 1), 1) * 100) / 100;

          const changed = codeEntry.won !== won || codeEntry.lost !== lost || codeEntry.pending !== pending;
          codeEntry.games = results.length;
          codeEntry.won = won; codeEntry.lost = lost; codeEntry.void = voided;
          codeEntry.pending = pending; codeEntry.hitRate = hitRate;
          codeEntry.scanAttempts = 0;
          codeEntry.lastScanned = new Date().toISOString();
          if (totalOdds > 1) codeEntry.totalOdds = totalOdds;

          if (changed) updated++;
          if (pending > 0) stillPending++;
          scanned++;
        } catch { errors++; codeEntry.scanAttempts = (codeEntry.scanAttempts || 0) + 1; }
        rescanProgress.scanned = scanned; rescanProgress.updated = updated;
        rescanProgress.errors = errors; rescanProgress.stillPending = stillPending;
        await new Promise(r => setTimeout(r, 150));
      }

      // Recalculate punter totals
      const settled = entry.codes.filter(c => (c.won + c.lost) > 0);
      entry.won = settled.reduce((a, c) => a + c.won, 0);
      entry.lost = settled.reduce((a, c) => a + c.lost, 0);
      entry.totalGames = settled.reduce((a, c) => a + c.games, 0);
      const ts = entry.won + entry.lost;
      entry.hitRate = ts > 0 ? Math.round(entry.won / ts * 100) : 0;
      const rates = settled.map(c => c.hitRate);
      if (rates.length) {
        const avg = rates.reduce((a, r) => a + r, 0) / rates.length;
        const variance = rates.length > 1 ? Math.sqrt(rates.reduce((a, r) => a + Math.pow(r - avg, 2), 0) / rates.length) : 0;
        entry.consistency = Math.round(100 - variance);
        let trust = entry.hitRate;
        if (rates.length >= 3 && variance < 15) trust += 10;
        if (rates.some(r => r >= 80)) trust += 10;
        if (rates.some(r => r < 40)) trust -= 10;
        entry.trustScore = Math.max(0, Math.min(100, trust));
      }
      entry.daysActive = new Set(entry.codes.map(c => c.date)).size;
      entry.lastActive = entry.codes[0]?.date || today;
    }

    // Also update punter-profiles.json to stay in sync
    try {
      const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
      for (const entry of lb) {
        if (profiles[entry.punter]) {
          profiles[entry.punter].won = entry.won;
          profiles[entry.punter].lost = entry.lost;
          profiles[entry.punter].hitRate = entry.hitRate;
          profiles[entry.punter].trustScore = entry.trustScore;
          profiles[entry.punter].consistency = entry.consistency;
          profiles[entry.punter].totalGames = entry.totalGames;
          if (entry.codes?.length) profiles[entry.punter].codes = entry.codes;
        }
      }
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
    } catch {}

    rescanProgress.phase = 'Saving & analysing…';
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2));
    console.log(`[Rescan] Done: ${scanned} scanned, ${updated} updated, ${errors} errors`);

    // Generate analysis reports and update all intelligence files
    clearIntelCache();
    if (Object.keys(resultsByDate).length) {
      try {
        const leagueIntel  = updateLeagueIntelligence(resultsByDate);
        const marketIntel  = updateMarketIntelligence(resultsByDate);
        updateTeamIntelligence(resultsByDate);
        updateSelectionHistory(resultsByDate);
        for (const [date, dateResults] of Object.entries(resultsByDate)) {
          const report = generateDailyAnalysis(dateResults, date, leagueIntel, marketIntel);
          fs.writeFileSync(path.join(REPORTS_DIR, `${date}.json`), JSON.stringify(report, null, 2));
        }
        console.log(`[Rescan] Analysis saved for: ${Object.keys(resultsByDate).join(", ")}`);
      } catch (e) { console.error("[Rescan] Analysis generation error:", e.message); }
    }

    // Backfill partial reports: re-scan settled codes for dates where the report stub is empty
    // This fixes the case where games settled AFTER the partial stub was written
    try {
      const cutoff3Days = Date.now() - 3 * 86400000;
      const partialDates = [];
      for (const f of (fs.readdirSync(REPORTS_DIR).catch ? [] : fs.readdirSync(REPORTS_DIR)).filter(f => f.endsWith('.json'))) {
        const dateStr = f.slice(0, 10);
        if (new Date(dateStr).getTime() < cutoff3Days) continue;
        if (dateStr === today) continue; // today is expected to be partial
        try {
          const rpt = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
          if (rpt.analysis?.partial && !(rpt.analysis?.allSelections?.length)) partialDates.push(dateStr);
        } catch {}
      }
      for (const dateStr of partialDates) {
        rescanProgress.phase = `Backfilling report for ${dateStr}…`;
        const backfillResults = [];
        for (const entry of lb) {
          if (entry.punter === "Generated") continue;
          for (const ce of (entry.codes || [])) {
            if (ce.date !== dateStr || !ce.code || ce.games === 0) continue;
            try {
              const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(ce.code)}`;
              const json = await fetchJSON(url);
              if (!json || json.bizCode !== 10000 || !json.data) continue;
              const outcomes = json.data.outcomes || [];
              const ticketSels = json.data.ticket?.selections || [];
              const selections = mapOutcomes(outcomes, ticketSels);
              const results = selections.map(s => ({ ...s, verdict: evaluateVerdict(s) }));
              storeOriginalOdds(oddsBank, selections, scanTs);
              for (const r of results) {
                backfillResults.push({ ...r, punter: entry.punter, code: ce.code, codeDate: dateStr, originalOdds: getBankOdds(oddsBank, r) });
              }
              await new Promise(r => setTimeout(r, 200));
            } catch {}
          }
        }
        if (backfillResults.length) {
          const leagueIntelBf = loadLeagueIntelligence();
          const marketIntelBf = loadMarketIntelligence();
          const rpt = generateDailyAnalysis(backfillResults, dateStr, leagueIntelBf, marketIntelBf);
          fs.writeFileSync(path.join(REPORTS_DIR, `${dateStr}.json`), JSON.stringify(rpt, null, 2));
          console.log(`[Rescan] Backfilled ${dateStr}: ${backfillResults.length} selections → ${rpt.analysis?.ticketKillers?.length || 0} killers, ${rpt.analysis?.consensusWins?.length || 0} wins`);
        }
      }
    } catch(bfErr) { console.error('[Rescan] Backfill error:', bfErr.message); }

    // Always ensure a minimal report exists for today so X Assistant has something to work with
    try {
      const todayFile = path.join(REPORTS_DIR, `${today}.json`);
      if (!fs.existsSync(todayFile)) {
        const lbSnap = lb.filter(e => e.codes && e.codes.some(c => c.date === today));
        const minReport = {
          date: today, generatedAt: new Date().toISOString(),
          analysis: {
            partial: true, headline: `${lbSnap.length} punters tracked for ${today} — results pending.`,
            bullets: lbSnap.map(e => {
              const tc = e.codes.find(c => c.date === today);
              return tc ? `${e.punter}: ${tc.games || 0} games scanned (${tc.won || 0}W/${tc.lost || 0}L/${tc.pending || 0} pending)` : `${e.punter}: code entered`;
            }),
            insights: ['Run Rescan All after matches finish to get full analysis.'],
            ticketKillers: [], consensusWins: [], leagueWatch: {}, marketWatch: {}, punterStats: {},
            totals: { selections: 0, settled: 0, won: 0, lost: 0, void: 0, pending: 0, hitRate: 0 },
            allSelections: [],
          },
        };
        fs.writeFileSync(todayFile, JSON.stringify(minReport, null, 2));
        console.log(`[Rescan] Minimal analysis stub saved for ${today}`);
      }
    } catch {}
  } catch (e) { console.error("[Rescan] Fatal:", e); }
  finally { rescanRunning = false; }
});

app.get("/api/admin/rescan-status", requireAdmin, (req, res) => {
  res.json({ running: rescanRunning, ...rescanProgress });
});

// ── Daily Session Intelligence (dev-only) ──

if (!IS_PRODUCTION) {
  let sessionEngine; try { sessionEngine = require("./session-engine"); } catch {}
  const SESSION_TODAY_FILE = path.join(DATA_DIR, "session-today.json");

  app.get("/api/session/history", requireAdmin, (req, res) => {
    const HISTORY_FILE = path.join(DATA_DIR, "session-history.json");
    try {
      const history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
      const summary = history.map(s => ({
        date: s.date, archivedAt: s.archivedAt,
        punters: Object.keys(s.punters || {}).length,
        pool: s.masterPool?.total || 0,
        consensus: s.masterPool?.consensus || 0,
        conversions: s.conversions || 0,
        groups: Object.fromEntries(Object.entries(s.groups || {}).map(([g, slips]) => [g, slips.length])),
        codes: Object.values(s.groups || {}).flat().filter(c => c.code && c.code !== "FAILED").length,
      }));
      res.json({ history: summary.reverse(), total: summary.length });
    } catch { res.json({ history: [], total: 0 }); }
  });

  app.get("/api/session/today", requireAdmin, (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(SESSION_TODAY_FILE, "utf-8"))); }
    catch { res.json({ date: new Date().toISOString().slice(0, 10), status: "empty", punters: {}, groups: {}, pool: [] }); }
  });

  app.post("/api/session/reset", requireAdmin, (req, res) => {
    try {
      const result = sessionEngine.resetSession();
      res.json({ success: true, archived: result.archived, message: result.archived ? "Session archived and reset" : "Fresh session created" });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  let sessionRunning = false;
  let sessionLogs = [];

  app.post("/api/session/run", requireAdmin, async (req, res) => {
    if (sessionRunning) return res.status(409).json({ error: "Session already running" });
    sessionRunning = true;
    sessionLogs = [];

    // Build punter map: merge admin punter-codes with any request overrides
    const stored = loadPunterCodes();
    const overrides = req.body?.punters || {};
    const punterMap = {};
    for (const [name, code] of Object.entries({ ...stored, ...overrides })) {
      if (code) punterMap[name] = code;
    }
    // Support comma-separated multi-codes
    for (const [name, val] of Object.entries(punterMap)) {
      if (typeof val === "string" && val.includes(",")) {
        punterMap[name] = val.split(",").map(c => c.trim()).filter(Boolean);
      }
    }

    res.json({ success: true, message: "Generation started", punters: Object.keys(punterMap).length });

    try {
      await sessionEngine.run(punterMap, (msg) => {
        sessionLogs.push(msg);
        console.log("[SESSION]", msg);
      });
    } catch (e) {
      sessionLogs.push("FATAL: " + e.message);
      console.error("[SESSION FATAL]", e);
    } finally {
      sessionRunning = false;
    }
  });

  app.get("/api/session/status", requireAdmin, (req, res) => {
    res.json({ running: sessionRunning, logCount: sessionLogs.length, logs: sessionLogs.slice(-80) });
  });

  app.get("/api/session/logs", requireAdmin, (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: sessionRunning, logs: sessionLogs.slice(since), total: sessionLogs.length });
  });
}

// ── Content Studio Reports ──────────────────────────────────────────────────
const STUDIO_FILE = path.join(DATA_DIR, 'studio-reports.json');

function loadStudioReports() {
  try { return JSON.parse(fs.readFileSync(STUDIO_FILE, 'utf8')); } catch { return []; }
}

function saveStudioReports(reports) {
  fs.writeFileSync(STUDIO_FILE, JSON.stringify(reports, null, 2));
}

app.get('/api/studio/reports', requireAdmin, (req, res) => {
  const reports = loadStudioReports();
  // Return summaries only (no rankings/insights array to keep response light)
  res.json(reports.map(r => ({
    date: r.date,
    timestamp: r.timestamp,
    punterCount: r.punterCount,
    avgHR: r.avgHR,
    best: r.best,
    bestHR: r.bestHR
  })));
});

app.get('/api/studio/report/:date', requireAdmin, (req, res) => {
  const reports = loadStudioReports();
  const report = reports.find(r => r.date === req.params.date);
  if (!report) return res.status(404).json({ error: 'Report not found for ' + req.params.date });
  res.json(report);
});

app.post('/api/studio/report', requireAdmin, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  let reports = loadStudioReports();
  const idx = reports.findIndex(r => r.date === date);
  const entry = { ...req.body, timestamp: new Date().toISOString() };
  if (idx >= 0) reports[idx] = entry;
  else reports.unshift(entry);
  reports = reports.slice(0, 90);
  saveStudioReports(reports);
  res.json({ success: true, date });
});

// ── Analysis Reports ──────────────────────────────────────────────────────────

app.get("/api/analysis/:date", requireAdmin, (req, res) => {
  const file = path.join(REPORTS_DIR, `${req.params.date}.json`);
  try { res.json(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { res.status(404).json({ error: "No analysis for " + req.params.date }); }
});

app.get("/api/intelligence/leagues", requireAdmin, (req, res) => {
  res.json(loadLeagueIntelligence());
});

app.get("/api/intelligence/markets", requireAdmin, (req, res) => {
  res.json(loadMarketIntelligence());
});

app.get("/api/intelligence/teams", requireAdmin, (req, res) => {
  res.json(loadTeamIntelligence());
});

app.get("/api/intelligence/selections", requireAdmin, (req, res) => {
  res.json(loadSelectionHistory());
});

// Rebuild all intelligence from historical report files + leaderboard
app.post("/api/admin/rebuild-intelligence", requireAdmin, (req, res) => {
  try {
    clearIntelCache();
    const resultsByDate = {};
    // Collect from report files
    try {
      for (const f of fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith(".json"))) {
        const date = f.replace(".json", "");
        const report = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), "utf8"));
        if (report.analysis?.allSelections?.length) resultsByDate[date] = report.analysis.allSelections;
      }
    } catch {}
    if (Object.keys(resultsByDate).length) {
      updateLeagueIntelligence(resultsByDate);
      updateMarketIntelligence(resultsByDate);
      updateTeamIntelligence(resultsByDate);
      updateSelectionHistory(resultsByDate);
    }
    res.json({ success: true, daysProcessed: Object.keys(resultsByDate).length, message: `Rebuilt from ${Object.keys(resultsByDate).length} report files.` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Score a list of selections using unified intelligence engine (Manual Ticket Builder)
app.post("/api/score-selections", requireAdmin, (req, res) => {
  try {
    const { selections } = req.body;
    if (!Array.isArray(selections)) return res.status(400).json({ error: "selections array required" });
    const scored = intel.scoreSelections(selections).map(s => ({
      ...s,
      score: s.confidence,
      reasons: s.fromMasterPool ? ['Scored from today\'s master analysis pool'] : [],
      warnings: s.warning ? [s.warning] : (s.suggestions||[]).map(sg => sg.reason),
    }));
    res.json({ success: true, selections: scored });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── X Assistant (SlipPilot AI on X — no paid X API required) ─────────────────

app.post("/api/admin/x-assistant/analyze", requireAdmin, async (req, res) => {
  try {
    const { tweetUrl, tweetText } = req.body || {};
    if (!tweetUrl && !tweetText) {
      return res.status(400).json({ error: "Provide a tweetUrl or tweetText" });
    }
    const result = await xAssistant.analyze({ tweetUrl, tweetText });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "X Assistant analysis failed" });
  }
});

app.get("/api/admin/x-assistant/history", requireAdmin, (req, res) => {
  const list = xAssistant.loadHistory();
  res.json(list.slice().reverse());
});

app.get("/api/admin/x-assistant/history/:id", requireAdmin, (req, res) => {
  const list = xAssistant.loadHistory();
  const entry = list.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found" });
  res.json(entry);
});

// ── Smart Slip Builder ────────────────────────────────────────────────────────

// Generates a real SportyBet booking code from a selection list
async function buildSportybetCode(selections) {
  const payload = selections.map(s => {
    const e = { eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, productId: s.productId || 3, sportId: s.sportId || "sr:sport:1", parentBetBuilderMarketId: "" };
    if (s.specifier) e.specifier = s.specifier;
    return e;
  });
  const res = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
  if (res.bizCode === 10000 && res.data?.shareCode) return { code: res.data.shareCode, url: res.data.shareURL || "" };
  throw new Error(res.msg || "SportyBet returned no shareCode");
}

app.post("/api/smart-slips", requireAdmin, async (req, res) => {
  try {
  // v7: delegate entirely to the unified intelligence engine
  const codesRaw = loadPunterCodes();
  const punterMap = {};
  for (const [k, v] of Object.entries(codesRaw)) {
    if (k.startsWith('_') || !v || typeof v !== 'string') continue;
    punterMap[k] = v.trim().toUpperCase();
  }
  if (!Object.keys(punterMap).length) {
    return res.json({ success: false, error: 'No punter codes configured. Add codes in the Session tab.', slips: [] });
  }

  const logs = [];
  const logger = msg => { logs.push(msg); console.log('[smart-slips]', msg); };

  logger(`Starting unified intelligence analysis for ${Object.keys(punterMap).length} punters…`);
  const analysis = await intel.runAnalysis(punterMap, logger);

  if (!analysis.success || !analysis.masterPool || analysis.masterPool.length < 3) {
    return res.json({
      success: false,
      error: analysis.error || `Only ${(analysis.masterPool||[]).length} picks survived all filters. Add punter codes or run later.`,
      fetchLog: analysis.fetchLog || {},
      logs,
      slips: [],
    });
  }

  logger(`Master pool: ${analysis.masterPool.length} picks. Building themed codes…`);
  const codes = await intel.buildThemedCodes(analysis.masterPool, logger);

  if (!codes.length) {
    return res.json({ success: false, error: 'No codes generated from master pool.', logs, slips: [] });
  }

  // Format response to match what admin.html expects
  const slips = codes.map(c => ({
    label: c.theme,
    code: c.code,
    url: '',
    gameCount: c.games,
    totalOdds: c.odds,
    totalOddsFormatted: c.odds >= 1e6 ? (c.odds/1e6).toFixed(2)+'M' : c.odds >= 1e3 ? (c.odds/1e3).toFixed(2)+'K×' : Math.round(c.odds)+'×',
    avgScore: c.avgConfidence,
    // detailed data for frontend
    selections: (c.picks || []).map(s => ({
      homeTeam: s.homeTeam, awayTeam: s.awayTeam, league: s.league,
      market: s.marketName, outcome: s.outcomeName,
      odds: s.odds, punters: s.punters, score: s.confidence,
      kickoff: s.kickoff,
      eventId: s.eventId, marketId: s.marketId,
      outcomeId: s.outcomeId, productId: s.productId || 3,
      specifier: s.specifier, sportId: s.sportId,
      converted: s.converted, conversionNote: s.conversionNote,
      punterTier: s.punterTier, leagueTier: s.leagueTier,
    })),
    diversity: c.diversity || 0,
    topLeagues: c.topLeagues || '',
    topPunters: c.topPunters || '',
    markets: c.markets || '',
    borrowed: c.borrowed || 0,
  }));

  // Save to disk for persistence
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'smart-slips-last.json'), JSON.stringify({
      date: localToday(), generatedAt: new Date().toISOString(), engine: 'v7',
      poolSize: analysis.masterPool.length,
      slips: slips.map(s => ({ code: s.code, label: s.label, gameCount: s.gameCount, totalOdds: s.totalOdds, avgScore: s.avgScore })),
    }, null, 2));
  } catch {}

  res.json({
    success: true,
    date: localToday(),
    engine: 'v7',
    poolSize: analysis.masterPool.length,
    uniqueSelections: analysis.masterPool.length,
    excludedCount: analysis.excludedCount || 0,
    removedCount: analysis.excludedCount || 0,
    punterSummary: analysis.punterSummary || {},
    fetchLog: analysis.fetchLog || {},
    logs,
    slips,
  });
  } catch (e) {
    console.error('[smart-slips]', e);
    res.status(500).json({ success: false, error: e.message || 'Internal error' });
  }
});

// ── Smart Slips now fully delegates to intelligence-engine v7 (see above) ──

async function _deadCodeNeverCall() { // kept for syntax closure only — unreachable
  const codes       = loadPunterCodes();
  const lb          = loadLeaderboard();
  const bank        = loadOddsBank();
  const leagueIntel = loadLeagueIntelligence();
  const marketIntel = loadMarketIntelligence();
  const teamIntel   = loadTeamIntelligence();
  const selHistory  = loadSelectionHistory();
  const lbMap       = new Map(lb.map(p => [p.punter, p]));
  const weakMatches = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "weak-matches.json"), "utf8")); } catch { return {}; } })();

  const allSels = [], fetchErrors = [], puntScanned = [];
  const now = Date.now();

  for (const [name, code] of Object.entries(codes)) {
    if (!code || name.startsWith("_")) continue;
    const codeStr = typeof code === "string" ? code : (Array.isArray(code) ? code[0] : "");
    if (!codeStr) continue;
    try {
      const url  = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(codeStr)}`;
      const json = await fetchJSON(url);
      if (!json || json.bizCode !== 10000 || !json.data) continue;
      const sels = mapOutcomes(json.data.outcomes || [], json.data.ticket?.selections || []);
      storeOriginalOdds(bank, sels, new Date().toISOString());

      // 50% filter: only skip a code if SOME games have decided but less than half —
      // indicates a stale/mixed slip. Fresh codes (0 settled) are always included.
      const allVerdicts = sels.map(s => evaluateVerdict(s));
      const decidedCount = allVerdicts.filter(v => v === 'WON' || v === 'LOST' || v === 'VOID').length;
      if (sels.length > 0 && decidedCount > 0 && decidedCount < sels.length * 0.5) {
        fetchErrors.push(`${name}: only ${decidedCount}/${sels.length} games settled — skipped`);
        puntScanned.push(name);
        await new Promise(r => setTimeout(r, 150));
        continue;
      }

      for (const s of sels) {
        // Only include matches that haven't started yet (next-24h window)
        if (s.kickoff && new Date(s.kickoff).getTime() <= now) continue;
        allSels.push({ ...s, punter: name, code: codeStr, originalOdds: getBankOdds(bank, s) });
      }
      puntScanned.push(name);
      await new Promise(r => setTimeout(r, 150));
    } catch (e) { fetchErrors.push(`${name}: ${e.message}`); }
  }

  if (allSels.length < 3) {
    const why = puntScanned.length === 0
      ? "No codes could be read from SportyBet. Make sure punter codes are saved in the Session tab."
      : `Only ${allSels.length} upcoming games found from ${puntScanned.length} punter${puntScanned.length !== 1 ? 's' : ''}. Most matches may have already started — add codes earlier in the day or after punters post tomorrow's picks.`;
    return res.json({ success: false, error: why, fetchErrors, slips: [] });
  }

  // Deduplicate by event+market+outcome
  const selMap = {};
  for (const s of allSels) {
    const key = `${s.eventId}|${s.marketId}|${s.outcomeId}`;
    if (!selMap[key]) selMap[key] = { ...s, punters: [], codes: [], score: 50, reasons: [], warnings: [], removed: false };
    const e = selMap[key];
    if (!e.punters.includes(s.punter)) e.punters.push(s.punter);
    if (!e.codes.includes(s.code))     e.codes.push(s.code);
  }

  // Kickoff bunching map: count selections per kickoff slot (within 5 min)
  const kickoffSlots = {};
  for (const s of Object.values(selMap)) {
    if (!s.kickoff) continue;
    const slot = Math.floor(new Date(s.kickoff).getTime() / 300000); // 5-min buckets
    kickoffSlots[slot] = (kickoffSlots[slot] || 0) + 1;
  }

  // ── Score each unique selection ───────────────────────────────────────────
  for (const s of Object.values(selMap)) {
    if (isBannedLeague(s.league)) { s.removed = true; s.removeReason = `Banned league: ${s.league}`; continue; }

    let sc = 50;

    // Factor 1: Punter lifetime hit rate (weight: 0.3x, capped ±15)
    const pEntries = s.punters.map(n => lbMap.get(n)).filter(Boolean);
    const pHRs = pEntries.map(p => p.hitRate || 50);
    const avgPHR = pHRs.length ? pHRs.reduce((a, b) => a + b, 0) / pHRs.length : 50;
    const lifetimeAdj = Math.max(-15, Math.min(15, (avgPHR - 50) * 0.3));
    sc += lifetimeAdj;

    // Factor 2: Punter recent form — last 7 days (weight: 0.5x, capped ±15)
    const recentForms = pEntries.map(p => getRecentForm(p, 7)).filter(x => x !== null);
    if (recentForms.length) {
      const avgRecent = recentForms.reduce((a, b) => a + b, 0) / recentForms.length;
      const recentAdj = Math.max(-15, Math.min(15, (avgRecent - 50) * 0.5));
      sc += recentAdj;
      if (avgRecent >= 75) s.reasons.push(`Hot form: ${Math.round(avgRecent)}% (7d)`);
      if (avgRecent < 45)  s.warnings.push(`Cold form: only ${Math.round(avgRecent)}% (7d)`);
    } else {
      if (avgPHR >= 70) s.reasons.push(`Punters avg ${Math.round(avgPHR)}% lifetime HR`);
      if (avgPHR < 50)  s.warnings.push(`Punters avg ${Math.round(avgPHR)}% lifetime HR`);
    }

    // Factor 3: Consensus (capped ±20)
    const punterCount = s.punters.length;
    if (punterCount >= 4)      { sc += 20; s.reasons.push(`${punterCount} punters agree — strong consensus`); }
    else if (punterCount === 3) { sc += 15; s.reasons.push(`3 punters agree`); }
    else if (punterCount === 2) { sc += 8;  s.reasons.push("2 punters agree"); }
    else                        { sc -= 5;  }

    // Factor 4: League intelligence (capped ±15)
    const li = leagueIntel[s.league];
    if (li && li.totalSelections >= 5) {
      if (li.hitRate >= 70)     { sc += 12; s.reasons.push(`${s.league}: ${li.hitRate}% historical HR`); }
      else if (li.hitRate >= 55){ sc += 5;  }
      else if (li.hitRate < 50) { sc -= 15; s.warnings.push(`${s.league}: only ${li.hitRate}% historically (${li.totalSelections} games)`); }
      // Best market within league
      const lm = li.markets?.[s.market];
      if (lm && (lm.won + lm.lost) >= 3) {
        if (lm.hitRate >= 75)    { sc += 8; s.reasons.push(`${s.market} in ${s.league}: ${lm.hitRate}% HR`); }
        else if (lm.hitRate < 45){ sc -= 8; s.warnings.push(`${s.market} underperforms in ${s.league}: ${lm.hitRate}%`); }
      }
    } else if (li && li.banned) {
      s.removed = true; s.removeReason = `Flagged league: ${s.league}`; continue;
    }

    // Factor 5: Market intelligence (capped ±12)
    const mi = marketIntel[s.market];
    if (mi && mi.totalSelections >= 5) {
      if (mi.hitRate >= 70)     { sc += 10; s.reasons.push(`${s.market}: ${mi.hitRate}% global market HR`); }
      else if (mi.hitRate >= 55){ sc += 4;  }
      else if (mi.hitRate < 50) {
        sc -= 12;
        const alt = s.market.includes("2.5") ? "Over 1.5" : s.market === "GG" || s.market.toLowerCase().includes("goal") ? "Double Chance" : null;
        s.warnings.push(alt ? `${s.market} ${mi.hitRate}% — try ${alt}` : `${s.market}: ${mi.hitRate}% market HR`);
      }
      // Pricing sanity: if original odds >> average winning odds for this market, be skeptical
      if (mi.avgWinOdds > 0 && s.originalOdds > 0) {
        const pricingRatio = s.originalOdds / mi.avgWinOdds;
        if (pricingRatio > 2.5) { sc -= 8; s.warnings.push(`Priced ${pricingRatio.toFixed(1)}x above typical winning odds`); }
        else if (pricingRatio < 0.5) { sc += 5; s.reasons.push("Below typical odds for this market — value"); }
      }
    }

    // Factor 6: Selection history — this exact match+market+outcome (capped ±15)
    const sh = selHistory[oddsKey(s)];
    if (sh && sh.appearances >= 2) {
      if (sh.hitRate >= 70)     { sc += 12; s.reasons.push(`This pick: ${sh.hitRate}% in ${sh.appearances} appearances`); }
      else if (sh.hitRate < 40) { sc -= 15; s.warnings.push(`This pick: only ${sh.hitRate}% in ${sh.appearances} appearances — recurring loser`); }
      else if (sh.hitRate < 55) { sc -= 5; }
    }

    // Factor 7: Weak matches (penalty only)
    const wm = weakMatches[s.eventId];
    if (wm && wm.losses > 0) {
      const failRate = wm.appearances > 0 ? Math.round(wm.losses / wm.appearances * 100) : 0;
      if (failRate >= 60)      { sc -= 15; s.warnings.push(`High-risk game: ${failRate}% failure (${wm.losses}/${wm.appearances})`); }
      else if (failRate >= 40) { sc -= 8;  s.warnings.push(`Risky game: ${failRate}% failure rate`); }
    }

    // Factor 8: Odds sanity (bookmaker pricing signal, capped ±20)
    const odds = s.originalOdds || s.odds || 0;
    if (odds > 10)          { sc -= 20; s.warnings.push(`Very high odds (${odds.toFixed(2)}) — low probability`); }
    else if (odds > 5)      { sc -= 12; s.warnings.push(`High odds (${odds.toFixed(2)})`); }
    else if (odds > 3.5)    { sc -= 5; }
    else if (odds > 0 && odds <= 1.35) { sc += 8;  s.reasons.push("Very low-risk odds"); }
    else if (odds <= 1.7)   { sc += 4; }

    // Factor 9: Kickoff bunching — correlated exposure penalty
    if (s.kickoff) {
      const slot = Math.floor(new Date(s.kickoff).getTime() / 300000);
      const bunchCount = kickoffSlots[slot] || 0;
      if (bunchCount >= 5)     { sc -= 8;  s.warnings.push(`${bunchCount} games kick off simultaneously — correlated risk`); }
      else if (bunchCount >= 3){ sc -= 3; }
    }

    // Factor 10: Team intelligence
    const ti = s.homeTeam ? teamIntel[s.homeTeam] : null;
    const out = (s.outcome || "").toLowerCase();
    if (ti) {
      if ((out === "home" || out === "1") && ti.home.hitRate != null && ti.home.won + ti.home.lost >= 3) {
        if (ti.home.hitRate >= 70)     { sc += 6; s.reasons.push(`${s.homeTeam} strong at home (${ti.home.hitRate}%)`); }
        else if (ti.home.hitRate < 40) { sc -= 8; s.warnings.push(`${s.homeTeam} weak at home (${ti.home.hitRate}%)`); }
      }
    }
    const tai = s.awayTeam ? teamIntel[s.awayTeam] : null;
    if (tai) {
      if ((out === "away" || out === "2") && tai.away.hitRate != null && tai.away.won + tai.away.lost >= 3) {
        if (tai.away.hitRate >= 70)     { sc += 6; s.reasons.push(`${s.awayTeam} strong away (${tai.away.hitRate}%)`); }
        else if (tai.away.hitRate < 40) { sc -= 8; s.warnings.push(`${s.awayTeam} weak away (${tai.away.hitRate}%)`); }
      }
    }

    s.score = Math.round(Math.max(0, Math.min(100, sc)));
  }

  const valid = Object.values(selMap)
    .filter(s => !s.removed)
    .sort((a, b) => b.score - a.score || b.punters.length - a.punters.length);

  const tierACount = valid.filter(s => s.score >= 60).length;
  const tierBCount = valid.filter(s => s.score >= 45).length;

  if (valid.length < 3) {
    const removed = Object.values(selMap).filter(s => s.removed);
    const why = `Only ${valid.length} selections survived filters (${removed.length} removed — ${removed.slice(0,3).map(s=>s.removeReason).join("; ")}).`;
    return res.json({ success: false, error: why, removed: removed.map(s => ({ match: `${s.homeTeam} vs ${s.awayTeam}`, reason: s.removeReason })), slips: [] });
  }

  if (valid.length < 3) {
    const removed = Object.values(selMap).filter(s => s.removed);
    return res.json({ success: false, error: `Only ${valid.length} selections survived filters (${removed.length} removed). Add more punter codes or run Rescan All.`, removed: removed.map(s => ({ match: `${s.homeTeam} vs ${s.awayTeam}`, reason: s.removeReason })), slips: [] });
  }

  // ── Build 3 tiers with different risk/reward profiles ──
  // Tier A — Conservative: top-scored picks, moderate odds target 1K-50K
  // Tier B — Balanced: wider pool, medium odds 50K-500K
  // Tier C — Boomshot: all valid, targeting high odds 500K+

  function pickSlip(pool, count, label) {
    // Sort by score; take `count` picks
    const picks = pool.slice(0, Math.min(count, pool.length, 50));
    if (picks.length < 3) return null;
    const totalOdds = picks.reduce((acc, s) => acc * (s.originalOdds || s.odds || 1), 1);
    return {
      label,
      selections: picks.map(s => ({
        homeTeam: s.homeTeam, awayTeam: s.awayTeam, league: s.league,
        market: s.market, outcome: s.outcome,
        odds: s.originalOdds || (s.odds > 1 ? s.odds : null),
        punters: s.punters, score: s.score,
        reasons: s.reasons, warnings: s.warnings,
        kickoff: s.kickoff,
        eventId: s.eventId, marketId: s.marketId,
        outcomeId: s.outcomeId, productId: s.productId || 3,
        specifier: s.specifier, sportId: s.sportId,
      })),
      totalOdds: Math.round(totalOdds * 100) / 100,
      totalOddsFormatted: formatTotalOdds(totalOdds),
      avgScore: Math.round(picks.reduce((a, s) => a + s.score, 0) / picks.length),
      gameCount: picks.length,
    };
  }

  // Build slip candidates
  const hiScore = valid.filter(s => s.score >= 60);
  const midScore = valid.filter(s => s.score >= 45);
  const allValid = valid;

  const candidates = [
    // Tier A: Conservative (6-8 games, top picks by score)
    pickSlip(hiScore.length >= 6 ? hiScore : allValid, 7, "Conservative"),
    pickSlip(hiScore.length >= 6 ? hiScore : allValid, 6, "Conservative"),
    // Tier B: Balanced (10-12 games)
    pickSlip(midScore.length >= 10 ? midScore : allValid, 12, "Balanced"),
    pickSlip(midScore.length >= 10 ? midScore : allValid, 10, "Balanced"),
    // Tier C: Boomshot (14-20 games, all valid, favour high-odds picks)
    pickSlip(allValid, 18, "Boomshot"),
    pickSlip(allValid, 14, "Boomshot"),
    // Extra: Consensus only (picks agreed by 2+ punters)
    pickSlip(valid.filter(s => s.punters.length >= 2), 10, "Consensus"),
  ].filter(Boolean); // end of legacy candidates array (dead code — never executed)
} // end _legacySmartSlipsInner_DO_NOT_USE

// Rebuild a specific date's analysis report by re-scanning all punter codes for that date
app.post("/api/admin/rebuild-report/:date", requireAdmin, async (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: "Invalid date format" });
  try {
    const lb = loadLeaderboard();
    const oddsBank = loadOddsBank();
    const scanTs = new Date().toISOString();
    const backfillResults = [];
    const log = [];
    let fetched = 0, errors = 0;

    for (const entry of lb) {
      if (entry.punter === "Generated") continue;
      for (const ce of (entry.codes || [])) {
        if (ce.date !== dateStr || !ce.code) continue;
        try {
          const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(ce.code)}`;
          const json = await fetchJSON(url);
          if (!json || json.bizCode !== 10000 || !json.data) { errors++; continue; }
          const outcomes = json.data.outcomes || [];
          const ticketSels = json.data.ticket?.selections || [];
          const selections = mapOutcomes(outcomes, ticketSels);
          const results = selections.map(s => ({ ...s, verdict: evaluateVerdict(s) }));
          storeOriginalOdds(oddsBank, selections, scanTs);
          for (const r of results) {
            backfillResults.push({ ...r, punter: entry.punter, code: ce.code, codeDate: dateStr, originalOdds: getBankOdds(oddsBank, r) });
          }
          const won  = results.filter(r => r.verdict === "WON").length;
          const lost = results.filter(r => r.verdict === "LOST").length;
          log.push(`${entry.punter} (${ce.code}): ${results.length} games, ${won}W/${lost}L`);
          fetched++;
          await new Promise(r => setTimeout(r, 250));
        } catch(e) { errors++; log.push(`${entry.punter}: ${e.message}`); }
      }
    }

    if (!backfillResults.length) {
      return res.json({ success: false, message: `No data found for ${dateStr}. No punter codes recorded for that date.`, fetched, errors, log });
    }

    const leagueIntel = loadLeagueIntelligence();
    const marketIntel = loadMarketIntelligence();
    const report = generateDailyAnalysis(backfillResults, dateStr, leagueIntel, marketIntel);
    fs.writeFileSync(path.join(REPORTS_DIR, `${dateStr}.json`), JSON.stringify(report, null, 2));
    const a = report.analysis || {};
    res.json({
      success: true, date: dateStr, fetched, errors,
      selections: backfillResults.length,
      settled: (a.totals?.settled || 0),
      ticketKillers: (a.ticketKillers || []).length,
      consensusWins: (a.consensusWins || []).length,
      log,
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Intelligence Engine v6 — Unified Analysis API ────────────────────────────

// Run full master analysis from all punter codes. Caches to data/master-pool.json.
app.post("/api/admin/run-analysis", requireAdmin, async (req, res) => {
  req.setTimeout(600000); // 10 min — analysis fetches all punters from SportyBet
  try {
    const codesRaw = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "punter-codes.json"), "utf8").replace(/^﻿/, '')); }
      catch { return {}; }
    })();
    const punterMap = {};
    for (const [k, v] of Object.entries(codesRaw)) {
      if (k.startsWith('_') || !v || typeof v !== 'string') continue;
      punterMap[k] = v;
    }
    if (!Object.keys(punterMap).length) return res.status(400).json({ success: false, error: "No punter codes configured" });

    const logs = [];
    const logger = msg => { logs.push(msg); console.log('[intel-engine]', msg); };

    const result = await intel.runAnalysis(punterMap, logger);
    res.json({ ...result, logs });
  } catch (e) {
    console.error('[run-analysis]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Return today's cached master pool (null if stale / not yet run)
app.get("/api/admin/master-pool", requireAdmin, (req, res) => {
  try {
    const pool = intel.getMasterPool();
    if (!pool) return res.json({ success: false, stale: true, message: "No analysis for today. Run /api/admin/run-analysis first." });
    res.json({ success: true, ...pool });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Generate themed booking codes from today's master pool
app.post("/api/admin/booking-codes", requireAdmin, async (req, res) => {
  req.setTimeout(600000); // 10 min — posts 11 themed codes to SportyBet
  try {
    const cached = intel.getMasterPool();
    if (!cached) return res.status(400).json({ success: false, error: "Run /api/admin/run-analysis first to build today's master pool." });

    const logs = [];
    const logger = msg => { logs.push(msg); console.log('[booking-codes]', msg); };

    const codes = await intel.buildThemedCodes(cached.masterPool, logger);
    res.json({ success: true, date: localToday(), count: codes.length, codes, logs });
  } catch (e) {
    console.error('[booking-codes]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// X Assistant intelligence context — used by X Assistant tab to auto-fill with real data
app.get("/api/admin/x-intel", requireAdmin, (req, res) => {
  try {
    const ctx = intel.getXContext();
    res.json({ success: true, ...ctx });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Odds history inspection — shows all stored pre-match odds for debugging
app.get("/api/admin/odds-history", requireAdmin, (req, res) => {
  try {
    const bank = loadOddsBank();
    const now = Date.now();
    const entries = Object.entries(bank)
      .map(([key, v]) => ({
        key, eventId: v.eventId, homeTeam: v.homeTeam, awayTeam: v.awayTeam,
        league: v.league, market: v.market, outcome: v.outcome,
        originalOdds: v.originalOdds, kickoff: v.kickoff,
        firstSeen: v.firstSeen,
        ageHours: v.firstSeen ? Math.round((now - new Date(v.firstSeen).getTime()) / 3600000) : null,
      }))
      .sort((a, b) => (b.firstSeen || "").localeCompare(a.firstSeen || ""));
    res.json({ count: entries.length, entries: entries.slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Global error handler (must be last middleware) ──

app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: err.message || "Server error" });
});

// ── Daily Cleanup ──

function runDailyCleanup() {
  const now = Date.now();
  const day7  = 7  * 24 * 60 * 60 * 1000;
  const day30 = 30 * 24 * 60 * 60 * 1000;
  const day90 = 90 * 24 * 60 * 60 * 1000;

  // 1. Odds bank — drop entries whose kickoff was > 7 days ago
  try {
    const ob = loadOddsBank();
    let n = 0;
    for (const key of Object.keys(ob)) {
      const k = ob[key].kickoff || ob[key].firstSeen;
      if (k && now - new Date(k).getTime() > day7) { delete ob[key]; n++; }
    }
    if (n) { fs.writeFile(ODDS_HISTORY_FILE, JSON.stringify(ob, null, 2), () => {}); console.log(`[Cleanup] Odds history: removed ${n} stale entries`); }
  } catch(e) { console.error('[Cleanup] Odds bank:', e.message); }

  // 2. Daily analysis reports — delete files older than 30 days
  try {
    let n = 0;
    for (const f of fs.readdirSync(REPORTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
      if (now - new Date(f.replace('.json','')).getTime() > day30) { fs.unlinkSync(path.join(REPORTS_DIR, f)); n++; }
    }
    if (n) console.log(`[Cleanup] Reports: deleted ${n} files older than 30 days`);
  } catch(e) { console.error('[Cleanup] Reports:', e.message); }

  // 3. Express session files — delete files not touched in > 7 days
  try {
    let n = 0;
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      const fp = path.join(SESSIONS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > day7) { fs.unlinkSync(fp); n++; }
    }
    if (n) console.log(`[Cleanup] Sessions: deleted ${n} old session files`);
  } catch(e) { console.error('[Cleanup] Sessions:', e.message); }

  // 4. Visitors — trim entries older than 90 days
  try {
    const raw = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8'));
    const trimmed = raw.filter(v => v.time && now - new Date(v.time).getTime() < day90);
    if (trimmed.length < raw.length) {
      fs.writeFileSync(VISITORS_FILE, JSON.stringify(trimmed, null, 2));
      console.log(`[Cleanup] Visitors: trimmed ${raw.length - trimmed.length} old entries`);
    }
  } catch(e) { console.error('[Cleanup] Visitors:', e.message); }

  console.log('[Cleanup] Done —', new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }));
}

// ── Graceful shutdown ──

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — flushing and closing`);

  // Flush all debounced in-memory writes synchronously before exit
  try {
    if (_oddsBankDirty && _oddsBankCache)
      fs.writeFileSync(ODDS_HISTORY_FILE, JSON.stringify(_oddsBankCache, null, 2));
  } catch {}
  try {
    if (_statsDirty && _statsRaw)
      fs.writeFileSync(STATS_FILE, JSON.stringify(_statsRaw, null, 2));
  } catch {}
  try {
    if (_apiUsageDirty && _apiUsageCache)
      fs.writeFileSync(API_USAGE_FILE, JSON.stringify(_apiUsageCache, null, 2));
  } catch {}
  try {
    if (_visitorBuffer)
      fs.writeFileSync(VISITORS_FILE, JSON.stringify(_visitorBuffer, null, 2));
  } catch {}

  if (typeof server !== "undefined" && server) {
    server.close(() => { console.log("[SHUTDOWN] HTTP server closed cleanly"); process.exit(0); });
  } else {
    process.exit(0);
  }
  setTimeout(() => { console.error("[SHUTDOWN] Force-exit after 8s"); process.exit(1); }, 8000);
}

// ── Start ──

const server = app.listen(PORT, () => {
  console.log(`SlipPilot v8 running at http://localhost:${PORT}  build=${BUILD_VERSION}`);
  setTimeout(runDailyCleanup, 60000);
  setInterval(runDailyCleanup, 24 * 60 * 60 * 1000);
});

// Prevent slow clients from holding connections open indefinitely
server.keepAliveTimeout = 65000;   // must be > LiteSpeed/proxy's timeout
server.headersTimeout   = 70000;

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
