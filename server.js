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
const _keepAliveTimer = setInterval(() => {
  try {
    const http = require("http");
    const ping = http.get("http://localhost:" + (process.env.PORT || 3000) + "/api/health", { timeout: 5000 }, r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => {});
    }).on("error", () => {});
    ping.on("timeout", () => ping.destroy());
  } catch {}
}, 90 * 1000);

// Memory management + cache/rate-limiter housekeeping
const _housekeepingTimer = setInterval(() => {
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
// Hosting-panel environment variables are authoritative. In particular, a stale
// NODE_ENV in .env must not re-enable admin engines and startup subprocesses live.
require("dotenv").config({ override: false });
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const { monitorEventLoopDelay } = require("perf_hooks");
const BoundedFileSessionStore = require("./lib/bounded-file-session-store");
const { Semaphore, semaphoreMiddleware, startNonOverlappingJob } = require("./lib/runtime-guards");
const https = require("https");
const path = require("path");
const fs = require("fs");
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let xAssistant = null, intel = null, portfolioBuilder = null, strategyEngine = null, advancedGen = null, autobet = null;
if (!IS_PRODUCTION) {
  // autobet-engine drives a real browser against a real SportyBet account and
  // places real bets. It must never load in production — the guard is here as
  // well as inside the engine itself.
  try { autobet = require("./autobet-engine"); } catch (e) { console.error('[STARTUP] autobet-engine load failed:', e.message); }
  try { xAssistant = require("./x-assistant-engine"); } catch {}
  try { intel = require("./intelligence-engine"); } catch {}
  // portfolio-builder.js is no longer used by the (now-replaced) Advanced
  // Generator UI, but x-assistant-engine.js's CONTENT/BUILD flow still calls
  // POST /api/admin/portfolio-generate as its primary code-builder — keep it
  // wired so that feature isn't silently degraded to its legacy fallback.
  try { portfolioBuilder = require("./portfolio-builder"); } catch {}
  try { strategyEngine = require("./strategy-engine"); } catch {}
  try { advancedGen = require("./advanced-generator-engine"); } catch (e) { console.error('[STARTUP] advanced-generator-engine load failed:', e.message); }
}

// Table Tennis workspace is a public-facing feature (not admin/debug-only), so it loads
// in production too, unlike the engines above.
let ttEngine = null;
try { ttEngine = require("./tt-engine"); } catch (e) { console.error('[STARTUP] tt-engine load failed:', e.message); }

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_UPSTREAM_BYTES = parseInt(process.env.MAX_UPSTREAM_BYTES || "2097152", 10);
const shutdownTasks = [];
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

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
      pool: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  } catch { console.warn('[SUPPORT] nodemailer not installed — support tickets will save to file'); }
}
const BUILD_VERSION = Date.now().toString(36); // unique per restart — injected into HTML asset URLs

const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const DEBUG_DIR = path.join(__dirname, "debug", "markets");
const H2H_DEBUG_DIR = path.join(__dirname, "debug", "h2h");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
try { fs.mkdirSync(DATA_DIR,     { recursive: true }); } catch(e) { console.error('[STARTUP] Cannot create DATA_DIR:',     e.message); }
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch(e) { console.error('[STARTUP] Cannot create SESSIONS_DIR:', e.message); }
try { fs.mkdirSync(REPORTS_DIR,  { recursive: true }); } catch(e) { console.error('[STARTUP] Cannot create REPORTS_DIR:',  e.message); }
if (!IS_PRODUCTION) {
  try { fs.mkdirSync(DEBUG_DIR,     { recursive: true }); } catch(e) {}
  try { fs.mkdirSync(H2H_DEBUG_DIR, { recursive: true }); } catch(e) {}
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
  // In development this file is being actively edited on disk, and the
  // Cache-Control headers on the response only stop the BROWSER from
  // caching — they say nothing about the server's own copy. Caching here
  // too meant every edit needed a manual server restart to ever be served,
  // which cost real time and looked exactly like a browser-caching bug when
  // it wasn't one. Production keeps the cache (the file never changes under
  // a running deploy, so re-reading it on every request is pure waste).
  if (!IS_PRODUCTION) {
    let raw = fs.readFileSync(path.join(__dirname, "public", name), "utf8");
    raw = raw.replace(/\?v=[a-zA-Z0-9._-]+/g, `?v=${BUILD_VERSION}`);
    return raw;
  }
  if (!_htmlCache[name]) {
    let raw = fs.readFileSync(path.join(__dirname, "public", name), "utf8");
    raw = raw.replace(/\?v=[a-zA-Z0-9._-]+/g, `?v=${BUILD_VERSION}`);
    raw = raw.replace('<head>', '<head><script>window.IS_PRODUCTION=true;</script>');
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
app.use(express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 100 }));

// Cap simultaneous CPU/upstream-heavy work. Cheap static and health routes bypass this.
const expensiveSemaphore = new Semaphore(parseInt(process.env.EXPENSIVE_CONCURRENCY || "3", 10), 12);
const expensivePaths = ["/api/generate", "/api/scan", "/api/merge", "/api/h2h", "/api/tt/", "/api/admin/"];
const expensiveRateMap = new Map();
app.use((req, res, next) => expensivePaths.some(p => req.path.startsWith(p))
  ? semaphoreMiddleware(expensiveSemaphore)(req, res, next) : next());
app.use((req, res, next) => {
  if (!expensivePaths.some(p => req.path.startsWith(p)) || req.method === "GET") return next();
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const entry = expensiveRateMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now >= entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  expensiveRateMap.delete(ip); expensiveRateMap.set(ip, entry);
  while (expensiveRateMap.size > 1000) expensiveRateMap.delete(expensiveRateMap.keys().next().value);
  if (entry.count > 15) return res.status(429).set("Retry-After", "60").json({ error: "Too many expensive requests" });
  next();
});

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

function safeSecretEqual(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Intentionally separate from public health: operational details require a secret.
app.get("/api/diagnostics", (req, res) => {
  const expected = process.env.DIAGNOSTICS_TOKEN || process.env.ADMIN_PASSWORD;
  if (!safeSecretEqual(req.headers["x-diagnostics-token"], expected)) return res.status(404).json({ error: "Not found" });
  const mem = process.memoryUsage();
  res.set("Cache-Control", "no-store").json({
    rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal,
    activeHandles: process._getActiveHandles().length,
    activeRequests: process._getActiveRequests().length,
    uptime: process.uptime(),
    eventLoopDelayMs: {
      mean: Number.isFinite(eventLoopDelay.mean) ? +(eventLoopDelay.mean / 1e6).toFixed(2) : 0,
      p95: +(eventLoopDelay.percentile(95) / 1e6).toFixed(2),
      max: +(eventLoopDelay.max / 1e6).toFixed(2),
    },
    expensive: { active: expensiveSemaphore.active, queued: expensiveSemaphore.queue.length },
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
const sessionStore = new BoundedFileSessionStore({ dir: SESSIONS_DIR, maxSessions: 500, ttlMs: 3600000 });
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "sp-secret-change-me",
  name: "slippilot.sid", resave: false, saveUninitialized: false,
  cookie: { secure: IS_PRODUCTION, httpOnly: true, sameSite: "lax", maxAge: 3600000 },
}));
shutdownTasks.push(() => sessionStore.close());

// ── Helpers ──

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https
      // SportyBet's CloudFront WAF started rejecting the bare "Mozilla/5.0"
      // User-Agent with a 403 (confirmed live 2026-09-09 — this exact string
      // vs a fuller one, same endpoint, back to back: 403 vs 200). This was
      // silently breaking every one of this function's 28 callers across the
      // app (booking-code lookups, scans, regen-merged, etc.) since every
      // caller wraps the call in try/catch and treats the rejection as "no
      // data" rather than surfacing an error. Matches the fuller UA string
      // postJSON/fetchJSONWithStatus already use successfully.
      .get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }, timeout: 15000 }, (res) => {
        let data = "", bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_UPSTREAM_BYTES) return req.destroy(new Error("Upstream response too large"));
          data += chunk;
        });
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
        let data = "", bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          if (bytes > MAX_UPSTREAM_BYTES) return req.destroy(new Error("Upstream response too large"));
          data += c;
        });
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
  const usageKeys = Object.keys(data.usage || {});
  if (usageKeys.length > 5000) for (const key of usageKeys.slice(0, usageKeys.length - 5000)) delete data.usage[key];
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

// v41 — REAL BUG (confirmed on live data, real user ticket): this used to
// iterate `outcomes` (SportyBet's per-event summary/result array) and only
// use `ticketSelections` (json.data.ticket.selections — the ORIGINAL,
// AUTHORITATIVE list of every leg actually on the code) to enrich a match it
// had already found by eventId. But `outcomes` can genuinely be missing an
// entry for a leg — confirmed live on a real 33-leg ticket where an unusual
// "Over/Under - Early Goals" (minute-restricted) market leg was present in
// `ticket.selections` but simply absent from `outcomes` on SportyBet's own
// server (verified via a direct curl of the raw API — 33 vs 32 entries).
// That leg silently vanished from EVERY feature built on this function
// (booking, scan, merge, scoreboard, leaderboard rescans) — no error, no
// count mismatch shown, nothing — this is the root cause behind "rescan
// isn't giving full data" and a real "5 lost legs, only 4 shown" mismatch.
// Fixed by flipping the iteration: `ticketSelections` is now the source of
// truth for WHICH legs exist (it's the original booking-code data, always
// complete); `outcomes` only enriches with team names/market text/result
// when a match is found. A leg with no `outcomes` match is still INCLUDED
// (never silently dropped) — `unmatched: true`, best-effort ID-based labels
// since no human-readable names exist without the outcomes lookup, and
// evaluateVerdict below reports it as a distinct "UNVERIFIED" status rather
// than falsely implying PENDING (upcoming) or guessing WON/LOST — SportyBet
// genuinely doesn't expose this leg's settlement any other way.
function mapOutcomes(outcomes, ticketSelections) {
  const outcomeMap = new Map();
  (outcomes || []).forEach((o) => outcomeMap.set(o.eventId, o));

  return (ticketSelections || []).map((ts) => {
    const o = outcomeMap.get(ts.eventId);
    if (!o) {
      return {
        eventId: ts.eventId || "",
        homeTeam: "", awayTeam: "", sport: "", sportId: ts.sportId || "",
        league: "", category: "",
        market: `Mkt${ts.marketId}`, marketId: ts.marketId || "",
        specifier: ts.specifier || "",
        outcome: `Outcome${ts.outcomeId}`, outcomeId: ts.outcomeId || "",
        productId: ts.productId || 3,
        odds: 0, // genuinely unknown — not in ticket.selections, and no outcomes entry to source it from
        kickoff: "", matchStatus: "", score: null, halfScores: [],
        isWinning: undefined, refundFactor: undefined,
        unmatched: true,
      };
    }
    const mkt = o.markets && o.markets[0] ? o.markets[0] : {};
    const oc = mkt.outcomes && mkt.outcomes[0] ? mkt.outcomes[0] : {};
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
      unmatched: false,
    };
  });
}

function evaluateVerdict(sel) {
  // v41 — a leg mapOutcomes couldn't match to SportyBet's outcomes array is
  // genuinely unverifiable, not "pending" (which implies upcoming/not yet
  // played — false for e.g. yesterday's already-finished games) and not
  // safe to guess WON/LOST for. Distinct status so it's never silently
  // miscounted either way.
  if (sel.unmatched) return "UNVERIFIED";
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
  while (oddsStore.size > 2000) oddsStore.delete(oddsStore.keys().next().value);
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
    while (bookingCache.size > 200) bookingCache.delete(bookingCache.keys().next().value);
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

// Factored out of the route below (same pattern as getH2HStats) so the
// Themed Repost background job can look up a match's live market board
// directly, without an internal HTTP self-call.
async function getEventMarkets(eventId) {
  const url = `https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(eventId)}`;
  const json = await fetchJSON(url);
  if (!json || json.bizCode !== 10000 || !json.data) {
    return { error: json?.message || "Event not found" };
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
  return {
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
  };
}

app.get("/api/markets/:eventId", async (req, res) => {
  const eventId = req.params.eventId;
  if (!eventId) return res.status(400).json({ error: "eventId required" });
  try {
    const result = await getEventMarkets(eventId);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json(result);
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
    // v41 — legs SportyBet's outcomes array doesn't cover (see mapOutcomes)
    // land here, not silently miscounted into won/lost/pending/void — surfaced
    // explicitly so `total` always equals the sum of every bucket.
    const unverified = results.filter((r) => r.verdict === "UNVERIFIED").length;
    const settled = won + lost;
    const hitRate = settled > 0 ? Math.round((won / settled) * 100) : 0;

    incrementStat("slipsScanned");

    res.json({
      shareCode: json.data.shareCode || code,
      total: results.length,
      won, lost, void: voided, pending, unverified, hitRate,
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
  while (h2hCache.size > 250) h2hCache.delete(h2hCache.keys().next().value);
  return result;
}

// Shared H2H waterfall (API-Football → SportyBet's own stats endpoints →
// TheSportsDB) — factored out of the /api/h2h route so intelligence-engine.js's
// CORE scoring pipeline (masterScore, used by every ticket type) can pull the
// same real head-to-head signal, not just the Convert tool's Deep Scan and the
// admin Themed Repost feature. Note: API_FOOTBALL_KEY is currently a known-
// suspended key (see apiFootballFetch above) — this waterfall already
// degrades gracefully to the keyless SportyBet/TheSportsDB sources today, and
// will automatically start using real API-Football data with zero further
// code changes the moment a working key is set in .env.
async function getH2HStats(eventId, home, away, pick) {
  try {
    const apif = await apiFootballH2H(home, away, pick);
    if (apif?.found) return apif;
  } catch {}
  try {
    const sporty = await sportyStats(eventId, home, away);
    if (sporty?.found) return sporty;
  } catch {}
  try {
    const fallback = await fallbackStats(home, away);
    return { ...fallback, noApiKey: !process.env.API_FOOTBALL_KEY };
  } catch (err) {
    return { h2h: [], homeForm: [], awayForm: [], keyStats: {}, found: false, error: err.message, noApiKey: !process.env.API_FOOTBALL_KEY };
  }
}

app.get("/api/h2h", checkApiLimit, async (req, res) => {
  const { eventId, home, away, pick } = req.query;
  if (!home) return res.status(400).json({ error: "home team required" });
  res.json(await getH2HStats(eventId, home, away, pick));
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

// ── Admin Panel — blocked entirely in production ──
if (IS_PRODUCTION) {
  app.all(/^\/(admin|api\/admin)(\/.*)?$/, (req, res) => res.status(404).json({ error: "Not found" }));
}

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
  if (!IS_PRODUCTION) return next(); // no password required in local dev
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

// v43 — REAL BUG: postJSON'ing the WHOLE merged selection list in one shot
// meant a single stale/invalid selection (SportyBet: "invalid event data, no
// market there" — e.g. a market that got suspended or changed between scan
// and post) poisoned the ENTIRE batch — confirmed live: a real 230-selection
// merge failed outright with `code: null`, even though 229 of those 230
// selections were perfectly valid. There was no fallback; the whole "Daily
// Post MERGED" feature broke for everyone over one bad leg. Fixed with a
// divide-and-conquer retry: if the full batch fails, bisect it, retry each
// half, and recursively drop whichever half(s) still fail down to the
// individual leg(s) actually causing it — same "find and exclude the poison
// pill" pattern, not a blind cap or a full feature outage.
async function postMergedSelections(sels, logger) {
  if (!sels.length) return null;
  const payload = sels.map(s => ({ eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifier: s.specifier || "", productId: s.productId || 3, sportId: s.sportId || "" }));
  try {
    const r = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
    if (r.bizCode === 10000 && r.data?.shareCode) return r.data.shareCode;
  } catch {}
  return null;
}

async function findValidMergedSelections(sels, logger, depth = 0) {
  if (!sels.length) return [];
  const whole = await postMergedSelections(sels);
  if (whole !== null) return sels; // the whole (sub)batch is valid as-is
  if (sels.length === 1) {
    logger && logger(`  Dropped 1 invalid selection: ${sels[0].eventId} (SportyBet rejected it — likely a market that changed/suspended since scanning)`);
    return [];
  }
  if (depth > 12) return []; // safety cap — should never realistically be hit for normal leg counts
  const mid = Math.floor(sels.length / 2);
  const left = await findValidMergedSelections(sels.slice(0, mid), logger, depth + 1);
  const right = await findValidMergedSelections(sels.slice(mid), logger, depth + 1);
  return [...left, ...right];
}

app.post("/api/admin/regen-merged", requireAdmin, async (req, res) => {
  // v45 — REAL BUG: this route fetches every punter's code from SportyBet
  // SEQUENTIALLY (line ~1799) plus the merge POST itself plus any bisection
  // retries, same shape as the other multi-punter/multi-code routes that
  // already got bumped past the global 30s timeout (see line ~216) — this
  // one never was. With single-digit punters it usually finished under 30s
  // by luck; past that (more punters, slower SportyBet response) the global
  // timeout fired mid-request, the socket got dropped with no real response,
  // and the client saw a bare "Failed to fetch" — indistinguishable from a
  // server crash. Same fix already applied everywhere else in this file.
  req.setTimeout(120000);
  try {
    const allSels = [];
    const seen = new Set();
    const now = Date.now();

    for (const [name, rawCode] of Object.entries(getTodayCodes())) {
      if (!rawCode) continue;
      // v43 — REAL BUG: a multi-code punter's raw "CODE1, CODE2" string was
      // passed straight to the share-code lookup as ONE combined string,
      // which SportyBet correctly rejects as invalid — that punter's games
      // were silently skipped entirely, every single day. Split first, same
      // pattern already used correctly elsewhere (regen-merged's own
      // sibling routes, rescan-all's Step 1).
      const codeList = String(rawCode).split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
      for (const code of codeList) {
        try {
          const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
          const json = await fetchJSON(url);
          if (json?.bizCode === 10000 && json.data?.outcomes) {
            const ticketSels = json.data.ticket?.selections || [];
            const selections = mapOutcomes(json.data.outcomes, ticketSels);
            for (const s of selections) {
              // v39 — same fix as the Themed Repost job: kickoff alone can be
              // missing/falsy, which let some live/played legs through with no
              // real-time check at all. matchStatus is authoritative.
              const ms = (s.matchStatus || "").toLowerCase();
              if (["ended", "h1", "h2", "ht", "p1", "p2", "inprogress"].includes(ms)) continue;
              if (s.kickoff && new Date(s.kickoff).getTime() <= now) continue;
              if (!seen.has(s.eventId)) { seen.add(s.eventId); allSels.push(s); }
            }
          }
        } catch {}
      }
    }

    // One real SportyBet code covering EVERY game, however many. Confirmed live
    // (2026-08-03) that SportyBet's share API stores and echoes back any number
    // of selections without truncating (145 posted, 145 confirmed on readback) —
    // the "50 selections" wall is enforced only by their own site's betslip JS
    // when someone tries to load/place it there. SlipPilot's own tools (Optimizer,
    // Merger) read a code via this same raw share API, not through SportyBet's
    // front-end, so they display every game on it with no cap of their own.
    let code = null;
    let droppedCount = 0;
    let finalCount = allSels.length;
    if (allSels.length) {
      code = await postMergedSelections(allSels);
      if (code === null) {
        // Full batch failed — bisect to find and exclude whichever selection(s)
        // are actually invalid, then generate from the clean remainder.
        const valid = await findValidMergedSelections(allSels, (msg) => { droppedCount++; console.log("[regen-merged]", msg); });
        if (valid.length) code = await postMergedSelections(valid);
        if (code) finalCount = valid.length; // report the real, final count actually on the code
      }
    }

    res.json({ success: true, code, totalGames: finalCount, droppedInvalid: droppedCount, message: code ? `1 code from ${finalCount} future games${droppedCount ? ` (${droppedCount} invalid dropped)` : ""}` : "Code generation failed" });
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

// ── Themed Repost — background job ───────────────────────────────────────────
// v38 — REAL FEEDBACK: this used to run entirely in the browser (a single
// button click kicking off a long chain of fetches — scan, safe-convert,
// master-pool score, H2H-refine, generate). Closing the tab mid-build (a
// 75s-300s process) killed the whole thing with nothing to show for it. Now
// runs server-side as a real background job, persisted to disk — closing the
// tab, refreshing, or coming back an hour later all land on the same
// in-progress-or-finished job. Also keeps a history of past builds.
const THEMED_REPOST_FILE = path.join(DATA_DIR, "themed-repost.json");
function loadThemedRepostState() {
  try { return JSON.parse(fs.readFileSync(THEMED_REPOST_FILE, "utf-8")); }
  catch { return { current: null, history: [] }; }
}
function saveThemedRepostState(state) {
  fs.writeFileSync(THEMED_REPOST_FILE, JSON.stringify(state, null, 2));
}
function updateThemedRepostCurrent(patch) {
  const state = loadThemedRepostState();
  state.current = { ...(state.current || {}), ...patch };
  saveThemedRepostState(state);
  return state.current;
}

function legCategoryServer(l) {
  const m = l.market || "";
  if (/over\/under/i.test(m)) return "overunder";
  if (/handicap/i.test(m)) return "handicap";
  if (/double chance|draw no bet/i.test(m)) return "dcdnb";
  return "mixed";
}

// v40 — "just over.. full game over.. infact it should be part of that
// option": a dedicated, stricter category — the generic "overunder" bucket
// above matches ANY market with "Over/Under" in the name, including 2nd
// Half/Early Goals/team-scoped variants (e.g. "2nd Half - Over/Under",
// "Rezeknes Fa/Bjss Over/Under"). The real full-match market's name is
// exactly "Over/Under" with nothing else appended — team-scoped markets
// always carry the team name as a literal prefix instead (same fact
// advanced-generator-engine.js's isTeamScopedMarket relies on) — so an exact
// match after trimming cleanly excludes every derivative variant. Also
// requires the OUTCOME be "Over ..." specifically, not "Under ...".
function isFullGameOverLeg(l) {
  const m = (l.market || "").trim().toLowerCase();
  const out = (l.outcome || "").trim().toLowerCase();
  return m === "over/under" && out.startsWith("over");
}

// Same shift direction as the public Convert tool's tryConvertOver/
// tryConvertUnder — Over X → Over (X-1), Under X → Under (X+1) — now via
// getEventMarkets() directly instead of an internal HTTP self-call.
async function applySafeOUServer(leg) {
  const out = (leg.outcome || "").trim();
  const overM = out.match(/^Over (\d+\.?\d*)$/i);
  const underM = out.match(/^Under (\d+\.?\d*)$/i);
  if (!overM && !underM) return leg;
  const newVal = overM ? parseFloat(overM[1]) - 1 : parseFloat(underM[1]) + 1;
  if (overM && newVal < 0.5) return leg;
  try {
    const j = await getEventMarkets(leg.eventId);
    const wantName = overM ? `Over ${newVal}` : `Under ${newVal}`;
    const t = (j.markets || []).find(m => m.outcomeName === wantName && m.marketName.toLowerCase().includes("over/under"));
    if (t) return { ...leg, market: t.marketName, outcome: t.outcomeName, odds: t.odds, marketId: t.marketId, outcomeId: t.outcomeId, specifier: t.specifier || "" };
  } catch {}
  return leg;
}

async function ensureMasterPoolThemedRepost(logger) {
  const cached = intel && intel.getMasterPool();
  if (cached?.masterPool?.length) return cached.masterPool;
  if (!intel) return [];
  logger("Analyzing punters for quality ranking…");
  const codesRaw = loadPunterCodes();
  const punterMap = {};
  for (const [k, v] of Object.entries(codesRaw)) {
    if (k.startsWith("_") || !v || typeof v !== "string" || v === "__SKIP__") continue;
    punterMap[k] = v;
  }
  if (!Object.keys(punterMap).length) return [];
  const result = await intel.runAnalysis(punterMap, logger, getH2HStats);
  return result.success ? result.masterPool : [];
}

function scoreThemedCandidates(candidates, masterPool) {
  const byEvent = new Map();
  for (const m of masterPool) {
    const existing = byEvent.get(m.eventId);
    if (!existing || m.confidence > existing.confidence) byEvent.set(m.eventId, m);
  }
  return candidates.map(l => {
    const m = byEvent.get(l.eventId);
    let score = m ? m.confidence : 45;
    if (m?.converted) score += 8;
    return { ...l, _qScore: score };
  });
}

async function refineThemedWithH2H(shortlist, onProgress) {
  const out = [];
  for (let i = 0; i < shortlist.length; i++) {
    const l = shortlist[i];
    if (onProgress) onProgress(i + 1, shortlist.length);
    try {
      const h2h = await getH2HStats(l.eventId, l.homeTeam || "", l.awayTeam || "", l.outcome || "");
      if (h2h?.found && typeof h2h.safetyScore === "number") out.push({ ...l, _qScore: l._qScore * 0.6 + h2h.safetyScore * 0.4 });
      else out.push(l);
    } catch { out.push(l); }
  }
  return out;
}

// v45 — REAL BUG (user report, with real numbers to prove it): a straight
// top-50-by-quality-score slice let the SAFEST legs (often odds ~1.03-1.10 —
// near-certainties that barely move a compounding product) crowd out
// everything else whenever the candidate pool skewed that way. Confirmed
// live: the Full Game Over theme's "best 50" compounded to only 149.93x
// total — 50 real legs for barely more than a coin flip's worth of payout,
// while a same-day Over/Under theme's best 50 hit 1,104,194x. "Sure" and
// "worth playing" are different bars — a 50-leg accumulator that can't clear
// triple digits isn't a stronger pick than a shorter one, it's just diluted.
// Fixed: within each 50-leg chunk, legs with odds below MEANINGFUL_ODDS_MIN
// are deprioritized (not banned — still used to fill remaining slots if the
// quality-ranked pool genuinely doesn't have 50 legs above that bar) rather
// than allowed to dominate purely because they scored safest. Quality order
// is preserved within both groups — this changes WHICH legs get skipped,
// never how they're ranked against each other.
const MEANINGFUL_ODDS_MIN = 1.10;

// v40 — "give me 2 codes": splits the quality-ranked pool into up to
// `variantCount` non-overlapping ≤50-leg chunks (best legs first, same
// pattern as Max Builder's multi-variant split — see [[maxbuilder-multi-variant]])
// instead of always producing exactly one code. Each chunk independently
// trims from its worst-ranked end if maxOdds is set.
function capThemedToVariants(rankedByQuality, maxOdds, variantCount) {
  const variants = [];
  let pool = [...rankedByQuality];
  for (let i = 0; i < variantCount && pool.length; i++) {
    const meaningful = pool.filter(l => (l.odds || 1) >= MEANINGFUL_ODDS_MIN);
    const tooSafe = pool.filter(l => (l.odds || 1) < MEANINGFUL_ODDS_MIN);
    let chunk = meaningful.slice(0, 50);
    if (chunk.length < 50) chunk = chunk.concat(tooSafe.slice(0, 50 - chunk.length));
    const used = new Set(chunk.map(l => `${l.eventId}|${l.marketId}|${l.outcomeId}`));
    pool = pool.filter(l => !used.has(`${l.eventId}|${l.marketId}|${l.outcomeId}`));
    if (maxOdds) {
      while (chunk.length > 1) {
        const total = chunk.reduce((a, l) => a * (l.odds || 1), 1);
        if (total <= maxOdds) break;
        chunk.pop();
      }
    }
    if (chunk.length) variants.push(chunk);
  }
  return variants;
}

// v44 — "master where we can be like today over, today handicap... all the
// mode then run h2h and delivered": runs every real theme category in ONE
// job instead of one at a time. Punter codes are scanned ONCE (the expensive
// part — ~30 real SportyBet lookups) and fanned out into per-category pools,
// not re-scanned per category. "all" is deliberately excluded — it's the
// generic umbrella, not one of the distinct themes "master" means to cover.
const THEMED_MASTER_CATEGORIES = ["overunder", "fullgameover", "handicap", "dcdnb"];

// Safe-convert → quality-rank via master pool → H2H-refine → split into
// variants → generate real code(s), for ONE category's already-pooled
// candidates. Factored out of runThemedRepostJob so "master" mode can run it
// once per category against a single shared scan, instead of duplicating
// this whole pipeline inline per category.
async function buildThemedCategoryResult(category, candidatesIn, params, masterPool, log) {
  let candidates = candidatesIn;
  if (!candidates.length) return { category, error: `No games matched (${category === "all" ? "any market" : category}) across today's punters.` };

  if (params.safeMode) {
    const converted = [];
    for (let i = 0; i < candidates.length; i++) {
      log(`[${category}] Converting to safe… (${i + 1}/${candidates.length})`);
      converted.push(await applySafeOUServer(candidates[i]));
    }
    candidates = converted;
    // A safe-converted leg can land on a DIFFERENT over/under market than the
    // exact full-game one (applySafeOUServer only checks the market name
    // contains "over/under", not that it's exactly the full-match market) —
    // re-validate rather than silently include a mismatch.
    if (category === "fullgameover") candidates = candidates.filter(isFullGameOverLeg);
    if (!candidates.length) return { category, error: "No picks survived the safe conversion — try a lower min odds or turn Safe off." };
  }

  const variantCount = Math.max(1, Math.min(5, params.variants || 1));
  let scored = scoreThemedCandidates(candidates, masterPool);
  scored.sort((a, b) => b._qScore - a._qScore);
  const H2H_SHORTLIST = Math.min(scored.length, 60 * variantCount);
  const refined = await refineThemedWithH2H(scored.slice(0, H2H_SHORTLIST), (i, n) => log(`[${category}] Checking H2H… (${i}/${n})`));
  refined.sort((a, b) => b._qScore - a._qScore);
  const ranked = [...refined, ...scored.slice(H2H_SHORTLIST)];

  let variantChunks = capThemedToVariants(ranked, params.maxOdds, variantCount);
  if (params.minOdds) {
    const before = variantChunks.length;
    variantChunks = variantChunks.filter(chunk => chunk.reduce((a, l) => a * (l.odds || 1), 1) >= params.minOdds);
    if (!variantChunks.length) return { category, error: `None of the ${before} variant(s) reached your ${params.minOdds}x floor.` };
  }
  if (!variantChunks.length) return { category, error: "Not enough games to build even one code." };

  const variantResults = [];
  for (let i = 0; i < variantChunks.length; i++) {
    log(`[${category}] Generating code ${i + 1}/${variantChunks.length}…`);
    const payload = variantChunks[i].map(l => ({ eventId: l.eventId, marketId: l.marketId, outcomeId: l.outcomeId, specifier: l.specifier || "", productId: l.productId || 3, sportId: l.sportId || "" }));
    const genRes = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
    if (genRes.bizCode === 10000 && genRes.data?.shareCode) variantResults.push({ code: genRes.data.shareCode, legs: variantChunks[i].length });
    await new Promise(r => setTimeout(r, 300));
  }
  if (!variantResults.length) return { category, error: "Code generation failed for every variant." };

  const masterEventIds = new Set(masterPool.map(mp => mp.eventId));
  const keptUnion = variantChunks.flat();
  const matchedCount = keptUnion.filter(l => masterEventIds.has(l.eventId)).length;
  return { category, variants: variantResults, legs: keptUnion.length, candidatePool: candidates.length, matchedPool: matchedCount };
}

async function runThemedRepostJob(jobId, params) {
  const log = msg => updateThemedRepostCurrent({ stage: msg });
  try {
    const codesRaw = loadPunterCodes();
    const entries = Object.entries(codesRaw).filter(([k, v]) => !k.startsWith("_") && v && typeof v === "string");
    if (!entries.length) throw new Error("No punter codes saved for today yet.");

    const categories = params.master ? THEMED_MASTER_CATEGORIES : [params.category];
    const poolsByCategory = {};
    for (const c of categories) poolsByCategory[c] = new Map();

    for (let i = 0; i < entries.length; i++) {
      const [, code] = entries[i];
      log(`Scanning… (${i + 1}/${entries.length})`);
      try {
        const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
        const json = await fetchJSON(url);
        if (!json || json.bizCode !== 10000 || !json.data) continue;
        const outcomes = json.data.outcomes || [];
        const ticketSels = json.data.ticket?.selections || [];
        const results = mapOutcomes(outcomes, ticketSels);
        const now = Date.now();
        for (const l of results) {
          // v39 — "live games and played games should be removed": kickoff
          // alone isn't reliable enough — it's falsy/missing for some legs,
          // which used to let them through with no live/played check at all.
          // matchStatus is the authoritative real-time indicator (same set
          // intelligence-engine.js's runAnalysis already excludes on).
          const ms = (l.matchStatus || "").toLowerCase();
          if (["ended", "h1", "h2", "ht", "p1", "p2", "inprogress"].includes(ms)) continue;
          if (l.kickoff && new Date(l.kickoff).getTime() <= now) continue;
          for (const cat of categories) {
            const matches = cat === "fullgameover" ? isFullGameOverLeg(l) : (cat === "all" || legCategoryServer(l) === cat);
            if (!matches) continue;
            const pool = poolsByCategory[cat];
            const existing = pool.get(l.eventId);
            if (!existing || (l.odds || 0) > (existing.odds || 0)) pool.set(l.eventId, l);
          }
        }
      } catch {}
    }

    const masterPool = await ensureMasterPoolThemedRepost(log);
    const categoryResults = [];
    for (const cat of categories) {
      const candidates = [...poolsByCategory[cat].values()];
      categoryResults.push(await buildThemedCategoryResult(cat, candidates, params, masterPool, log));
    }

    const state = loadThemedRepostState();
    if (state.current && state.current.jobId === jobId) {
      if (params.master) {
        const anySuccess = categoryResults.some(r => !r.error);
        if (!anySuccess) throw new Error("No theme produced any picks today: " + categoryResults.map(r => `${r.category} (${r.error})`).join("; "));
        state.current.status = "done";
        state.current.finishedAt = new Date().toISOString();
        state.current.result = { master: true, categories: categoryResults };
      } else {
        const r = categoryResults[0];
        if (r.error) throw new Error(r.error);
        state.current.status = "done";
        state.current.finishedAt = new Date().toISOString();
        state.current.result = { variants: r.variants, legs: r.legs, candidatePool: r.candidatePool, matchedPool: r.matchedPool };
      }
      state.history = [state.current, ...(state.history || [])].slice(0, 30);
    }
    saveThemedRepostState(state);
  } catch (e) {
    const state = loadThemedRepostState();
    if (state.current && state.current.jobId === jobId) {
      state.current.status = "error";
      state.current.finishedAt = new Date().toISOString();
      state.current.error = e.message;
      state.history = [state.current, ...(state.history || [])].slice(0, 30);
    }
    saveThemedRepostState(state);
  }
}

app.post("/api/admin/themed-repost/start", requireAdmin, (req, res) => {
  const existing = loadThemedRepostState();
  if (existing.current?.status === "running") {
    return res.json({ success: true, jobId: existing.current.jobId, alreadyRunning: true });
  }
  const jobId = "tr-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const params = {
    master: !!req.body?.master, // v44 — runs every real theme (Over/Under, Full Game Over, Handicap, DC/DNB) in one job
    category: ["all", "overunder", "fullgameover", "handicap", "dcdnb"].includes(req.body?.category) ? req.body.category : "all",
    minOdds: Number(req.body?.minOdds) || 0,
    maxOdds: Number(req.body?.maxOdds) || 0,
    safeMode: !!req.body?.safeMode,
    variants: Math.max(1, Math.min(5, Number(req.body?.variants) || 1)), // v40 — "give me 2 codes"
  };
  const state = loadThemedRepostState();
  state.current = { jobId, status: "running", params, stage: "Starting…", startedAt: new Date().toISOString() };
  saveThemedRepostState(state);
  runThemedRepostJob(jobId, params); // fire-and-forget — survives the request/tab closing
  res.json({ success: true, jobId });
});

app.get("/api/admin/themed-repost/state", requireAdmin, (req, res) => {
  res.json({ success: true, ...loadThemedRepostState() });
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
// v24 — "put the odds there, once shown it must not change forever, till
// everything clear again" — a code's odds, once scanned, are frozen for the
// rest of the day regardless of live market movement. Keyed by the CODE
// STRING itself (not punter name), so re-saving the SAME code never
// re-scans it, but typing in a genuinely NEW code always gets a fresh scan.
// Same _date-keyed reset semantics as PUNTER_CODES_FILE — a new calendar
// day clears every frozen odds entry, ready to be captured fresh.
const PUNTER_CODE_ODDS_FILE = path.join(DATA_DIR, "punter-code-odds.json");

function loadPunterCodeOdds() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUNTER_CODE_ODDS_FILE, "utf-8").replace(/^﻿/, ""));
    if (!raw._date || raw._date !== localToday()) return {};
    const clean = { ...raw };
    delete clean._date;
    return clean;
  } catch { return {}; }
}

function savePunterCodeOdds(map) {
  fs.writeFileSync(PUNTER_CODE_ODDS_FILE, JSON.stringify({ ...map, _date: localToday() }, null, 2));
}

// Scans one code and returns its combined odds/leg count, or null if the
// code is invalid/unreadable — never throws, so one bad code can't abort
// freezing odds for the rest of a punter's codes.
async function scanCodeForFrozenOdds(code) {
  try {
    const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
    const json = await fetchJSON(url);
    if (!json || json.bizCode !== 10000 || !json.data) return null;
    const outcomes = json.data.outcomes || [];
    const ticketSels = json.data.ticket?.selections || [];
    const selections = mapOutcomes(outcomes, ticketSels);
    if (!selections.length) return null;
    const odds = Math.round(selections.reduce((acc, s) => acc * (s.odds || 1), 1) * 100) / 100;
    return { odds, legs: selections.length, scannedAt: new Date().toISOString() };
  } catch { return null; }
}

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
  res.json({ ...clean, _oddsFrozen: loadPunterCodeOdds() });
});

// Aliases that must never appear as standalone keys — always merged into canonical
const PUNTER_ALIASES = {
  "Bayobet": "Bayo Bets", "Bayobets": "Bayo Bets",
  "Top Boy Comrade": "Top Boy",
  "SuperMario": "Super Mario",
};

app.post("/api/admin/punter-codes", requireAdmin, async (req, res) => {
  const current = loadPunterCodes();
  const today = localToday();
  const body = { ...req.body };
  delete body._oddsFrozen; // the client may echo this back; never let it get written as a punter name
  const merged = { ...current, ...body, _date: today };
  // Collapse aliases into canonical names, delete alias keys
  for (const [alias, canonical] of Object.entries(PUNTER_ALIASES)) {
    if (alias in merged) {
      if (merged[alias] && !merged[canonical]) merged[canonical] = merged[alias];
      delete merged[alias];
    }
  }
  fs.writeFileSync(PUNTER_CODES_FILE, JSON.stringify(merged, null, 2));

  // v42 — capture today's codes into the PERMANENT leaderboard history right
  // now, at save time — see captureTodaysCodesIntoLeaderboard's own comment
  // for the full "7 days only showing 2 dates" bug this closes.
  captureTodaysCodesIntoLeaderboard(merged, today);

  // v24 — "once an odd is shown, it must not change forever, till everything
  // clears again": freeze combined odds per CODE STRING (not per punter),
  // the first time each code is seen today. A code already frozen (saved
  // unchanged, or re-typed identically) is never re-scanned — only a
  // genuinely new code string gets a fresh scan. This is real network work
  // (one request per new code), so it happens here, once, on save — not on
  // every page load/render.
  const oddsMap = loadPunterCodeOdds();
  const allCodes = new Set();
  for (const [name, val] of Object.entries(merged)) {
    if (name === "_date" || !val) continue;
    for (const c of String(val).split(",").map(s => s.trim().toUpperCase()).filter(Boolean)) allCodes.add(c);
  }
  for (const code of allCodes) {
    if (oddsMap[code]) continue; // already frozen today
    const scanned = await scanCodeForFrozenOdds(code);
    if (scanned) oddsMap[code] = scanned;
    await new Promise(r => setTimeout(r, 150));
  }
  savePunterCodeOdds(oddsMap);

  const clean = { ...merged }; delete clean._date;
  res.json({ success: true, codes: clean, oddsFrozen: oddsMap });
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
// v42 — REAL BUG (user report: "7 days only showing 2 dates... posted for
// at least 6 days.. where are others??"): leaderboard.json's PERMANENT code
// history only ever grew when an admin manually clicked "Rescan All"
// (POST /api/admin/rescan-all, Step 1, below) — loadLeaderboard() itself
// computes today's code in memory on every call but NEVER WRITES IT BACK to
// disk (confirmed: no fs.writeFileSync anywhere in that function). Any day
// nobody happened to trigger a full rescan, that day's code was captured
// nowhere — and since punter-codes.json is a single mutable file (overwritten
// daily, not date-versioned), the moment the NEXT day's codes were saved,
// that day's code was gone forever, with no error or warning anywhere.
// Confirmed on real data: 39 Billion's leaderboard.json history had gaps of
// 4-5 consecutive missing days despite them posting every day. Fixed at the
// SOURCE: every successful punter-codes save now immediately captures each
// punter's current code into leaderboard.json's permanent history itself —
// no dependency on anyone remembering to click Rescan All, and no
// scheduling/timing race against the daily punter-codes.json rollover.
function captureTodaysCodesIntoLeaderboard(codesByPunter, today) {
  try {
    // v42.1 — REAL BUG in the FIRST version of this fix (caught immediately
    // via live testing): used loadLeaderboard() as the starting point, but
    // that function does its OWN ephemeral, in-memory-only merge of today's
    // code (see its "Attach today's active code" block) — so by the time the
    // dedup check below ran, the code already LOOKED present (from that
    // transient merge) and `changed` never flipped true, so the write was
    // skipped — the exact same silent-no-op failure mode this whole fix was
    // meant to close. Also, writing loadLeaderboard()'s merged view back to
    // disk would have permanently baked in every OTHER ephemeral/computed
    // field it adds (profile-merged trustScore/won/lost, code-history merges)
    // on every single save, polluting the file with derived data that should
    // stay computed-on-read. Reads the RAW on-disk file directly instead —
    // the same first step loadLeaderboard() itself uses — and writes back
    // only that raw structure, untouched by any transient merge.
    let lb = [];
    try { lb = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf-8").replace(/^﻿/, "")); } catch {}
    const lbMap = new Map(lb.map(p => [p.punter, p]));
    let changed = false;
    for (const [name, code] of Object.entries(codesByPunter)) {
      if (!code || name === "_date" || name.startsWith("_")) continue;
      let entry = lbMap.get(name);
      if (!entry) { entry = { punter: name, codes: [], daysActive: 0, totalGames: 0, won: 0, lost: 0, hitRate: 0, trustScore: 0 }; lb.push(entry); lbMap.set(name, entry); }
      if (!entry.codes) entry.codes = [];
      const codeList = String(code).split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
      for (const codeStr of codeList) {
        if (codeStr && !entry.codes.some(c => c.code === codeStr)) {
          entry.codes.unshift({ code: codeStr, date: today, games: 0, won: 0, lost: 0, void: 0, pending: 0, hitRate: 0, status: "active" });
          changed = true;
        }
      }
    }
    if (changed) fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2));
  } catch (e) {
    console.error("[captureTodaysCodesIntoLeaderboard]", e.message);
  }
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
      const today = localToday();
      let found = false;

      for (const entry of lb) {
        if (!entry.codes) continue;
        // Exact match first; also check if code is stored as part of a comma-combined entry
        let ce = entry.codes.find(c => c.code === codeUpper);
        if (!ce) {
          const combo = entry.codes.find(c => c.code && c.code.split(',').map(x => x.trim()).includes(codeUpper));
          if (combo) {
            ce = { code: codeUpper, date: combo.date, games: 0, won: 0, lost: 0, void: 0, pending: 0, hitRate: 0 };
            entry.codes.unshift(ce);
          }
        }
        if (ce) {
          found = true;
          ce.games = results.length; ce.won = won; ce.lost = lost; ce.void = voided;
          ce.pending = pending; ce.hitRate = hitRate;
          ce.lastScanned = new Date().toISOString(); ce.scanAttempts = 0;
          const sc = entry.codes.filter(c => (c.won + c.lost) > 0);
          entry.won = sc.reduce((a, c) => a + c.won, 0);
          entry.lost = sc.reduce((a, c) => a + c.lost, 0);
          entry.totalGames = sc.reduce((a, c) => a + c.games, 0);
          const ts = entry.won + entry.lost;
          entry.hitRate = ts > 0 ? Math.round(entry.won / ts * 100) : 0;
        }
      }

      // Code not in any leaderboard entry — look up punter from punter-codes.json and add it
      if (!found) {
        const todayCodes = loadPunterCodes();
        const lbMap = new Map(lb.map(p => [p.punter, p]));
        for (const [name, pCode] of Object.entries(todayCodes)) {
          if (!pCode || name.startsWith('_')) continue;
          const codeList = pCode.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
          if (codeList.includes(codeUpper)) {
            let entry = lbMap.get(name);
            if (!entry) {
              entry = { punter: name, codes: [], daysActive: 0, totalGames: 0, won: 0, lost: 0, hitRate: 0, trustScore: 0 };
              lb.push(entry); lbMap.set(name, entry);
            }
            if (!entry.codes) entry.codes = [];
            entry.codes.unshift({ code: codeUpper, date: today, games: results.length, won, lost, void: voided, pending, hitRate, lastScanned: new Date().toISOString(), scanAttempts: 0 });
            const sc = entry.codes.filter(c => (c.won + c.lost) > 0);
            entry.won = sc.reduce((a, c) => a + c.won, 0);
            entry.lost = sc.reduce((a, c) => a + c.lost, 0);
            entry.totalGames = sc.reduce((a, c) => a + c.games, 0);
            const ts = entry.won + entry.lost;
            entry.hitRate = ts > 0 ? Math.round(entry.won / ts * 100) : 0;
            break;
          }
        }
      }

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

  // Build date-range from the filter the UI sent
  const dateFilter = req.body?.dateFilter || 'all';
  const today = localToday();
  let minDate = null;
  if (dateFilter === 'today') {
    minDate = today;
  } else if (dateFilter === '24h') {
    const d = new Date(); d.setTime(d.getTime() - 86400000);
    minDate = d.toISOString().slice(0, 10);
  } else if (dateFilter === 'week') {
    const d = new Date(); d.setTime(d.getTime() - 7 * 86400000);
    minDate = d.toISOString().slice(0, 10);
  }
  const inRange = (c) => !minDate || !c.date || c.date >= minDate;

  try {
    const lb = loadLeaderboard(); // Uses merged data (profiles + code-history + punter-codes)
    const todayCodes = loadPunterCodes();
    const lbMap = new Map(lb.map(p => [p.punter, p]));

    // Step 1: Add today's active codes to leaderboard if not present
    for (const [name, code] of Object.entries(todayCodes)) {
      if (!code || name === "_date" || name.startsWith("_")) continue;
      let entry = lbMap.get(name);
      if (!entry) { entry = { punter: name, codes: [], daysActive: 0, totalGames: 0, won: 0, lost: 0, hitRate: 0, trustScore: 0 }; lb.push(entry); lbMap.set(name, entry); }
      if (!entry.codes) entry.codes = [];
      const codeList = typeof code === "string"
        ? code.split(',').map(c => c.trim().toUpperCase()).filter(Boolean)
        : (Array.isArray(code) ? code.map(String) : []);
      for (const codeStr of codeList) {
        if (codeStr && !entry.codes.some(c => c.code === codeStr)) {
          entry.codes.unshift({ code: codeStr, date: today, games: 0, won: 0, lost: 0, void: 0, pending: 0, hitRate: 0 });
        }
      }
    }

    // Count how many codes need scanning.
    // Codes with pending games but scanned within the last 20 min are skipped — they're fresh.
    const nowMs = Date.now();
    const staleMs = 20 * 60 * 1000;
    const needsScanFn = (c) => {
      if (!c.code) return false;
      if (!inRange(c)) return false;  // respect date filter
      const neverScanned = c.games === 0 && (c.scanAttempts || 0) < 3;
      const stale = !c.lastScanned || (nowMs - new Date(c.lastScanned).getTime()) > staleMs;
      // Skip codes where all settled games are zero (pure future) and the code is older than 14 days
      const allFuture = c.games > 0 && c.won === 0 && c.lost === 0;
      const codeAge = c.date ? nowMs - new Date(c.date).getTime() : 0;
      if (allFuture && codeAge > 14 * 24 * 60 * 60 * 1000) return false;
      return neverScanned || (c.pending > 0 && stale);
    };
    // Prioritise today's codes — sort entries and their code lists newest-first
    lb.sort((a, b) => {
      const aHasToday = (a.codes || []).some(c => c.date === today);
      const bHasToday = (b.codes || []).some(c => c.date === today);
      if (aHasToday && !bHasToday) return -1;
      if (!aHasToday && bHasToday) return 1;
      return 0;
    });
    for (const entry of lb) {
      if (entry.codes) entry.codes.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
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
        await new Promise(r => setTimeout(r, 100));
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
      for (const f of fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json'))) {
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
      if (code && code !== '__SKIP__') punterMap[name] = code;
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
  if (!xAssistant) return res.status(503).json({ error: "X Assistant not available in production" });
  try {
    const { tweetUrl, tweetText, sessionId } = req.body || {};
    if (!tweetUrl && !tweetText) {
      return res.status(400).json({ error: "Provide a tweetUrl or tweetText" });
    }
    const result = await xAssistant.analyze({ tweetUrl, tweetText, sessionId: sessionId || req.sessionID });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "X Assistant analysis failed" });
  }
});

// Conversational chat endpoint — send any natural language message
app.post("/api/admin/x-assistant/chat", requireAdmin, async (req, res) => {
  if (!xAssistant) return res.status(503).json({ error: "X Assistant not available in production" });
  try {
    const { text, tweetUrl } = req.body || {};
    if (!text && !tweetUrl) return res.status(400).json({ error: "Provide text or tweetUrl" });
    const result = await xAssistant.analyzeText({
      text: text || '',
      tweetUrl: tweetUrl || null,
      sessionId: req.sessionID,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Chat failed" });
  }
});

app.post("/api/admin/x-assistant/parse-opts", requireAdmin, (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "Provide text" });
    const { parseGeneratorOptions } = require("./intent-engine");
    const opts = parseGeneratorOptions(text);
    res.json({ opts });
  } catch (err) {
    res.status(500).json({ error: err.message || "Parse failed" });
  }
});

app.get("/api/admin/x-assistant/history", requireAdmin, (req, res) => {
  if (!xAssistant) return res.json([]);
  const list = xAssistant.loadHistory();
  res.json(list.slice().reverse());
});

app.get("/api/admin/x-assistant/history/:id", requireAdmin, (req, res) => {
  if (!xAssistant) return res.status(404).json({ error: "Not found" });
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
  const analysis = await intel.runAnalysis(punterMap, logger, getH2HStats);

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
  if (!intel) return res.status(503).json({ success: false, error: "Intelligence engine not available in production" });
  req.setTimeout(600000); // 10 min — analysis fetches all punters from SportyBet
  try {
    const codesRaw = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "punter-codes.json"), "utf8").replace(/^﻿/, '')); }
      catch { return {}; }
    })();
    const punterMap = {};
    for (const [k, v] of Object.entries(codesRaw)) {
      if (k.startsWith('_') || !v || typeof v !== 'string' || v === '__SKIP__') continue;
      punterMap[k] = v;
    }
    if (!Object.keys(punterMap).length) return res.status(400).json({ success: false, error: "No punter codes configured" });

    const logs = [];
    const logger = msg => { logs.push(msg); console.log('[intel-engine]', msg); };

    const result = await intel.runAnalysis(punterMap, logger, getH2HStats);
    res.json({ ...result, logs });
  } catch (e) {
    console.error('[run-analysis]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Return today's cached master pool (null if stale / not yet run)
app.get("/api/admin/master-pool", requireAdmin, (req, res) => {
  if (!intel) return res.json({ success: false, stale: true, message: "Intelligence engine not available in production" });
  try {
    const pool = intel.getMasterPool();
    if (!pool) return res.json({ success: false, stale: true, message: "No analysis for today. Run /api/admin/run-analysis first." });
    res.json({ success: true, ...pool });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Generate themed booking codes from today's master pool
app.post("/api/admin/booking-codes", requireAdmin, async (req, res) => {
  if (!intel) return res.status(503).json({ success: false, error: "Intelligence engine not available in production" });
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
  if (!intel) return res.json({ success: false, message: "Intelligence engine not available" });
  try {
    const ctx = intel.getXContext();
    res.json({ success: true, ...ctx });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Portfolio Generator (backend only) ───────────────────────────────────────
// The admin "Generator" tab UI no longer calls this (see Advanced Generator
// below) — kept live purely as x-assistant-engine.js's code-building
// dependency (buildViaPortfolio in the CONTENT/BUILD conversation flow).

app.get("/api/admin/portfolio-generate/progress", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("data: connected\n\n");
  req.on("close", () => res.end());
});

app.post("/api/admin/portfolio-generate", requireAdmin, async (req, res) => {
  if (!portfolioBuilder) return res.status(503).json({ success: false, error: "Portfolio builder not available in production" });
  req.setTimeout(300000); // 5 min

  const opts = {
    count:           Math.min(20, Math.max(1, parseInt(req.body.count)     || 1)),
    minGames:        Math.min(50, Math.max(1, parseInt(req.body.minGames)  || 12)),
    maxGames:        Math.min(50, Math.max(1, parseInt(req.body.maxGames)  || 20)),
    todayOnly:       !!req.body.todayOnly,
    kickoffStart:    req.body.kickoffStart  || null,
    kickoffEnd:      req.body.kickoffEnd    || null,
    sortBy:          ['confidence','kickoff','odds'].includes(req.body.sortBy) ? req.body.sortBy : 'confidence',
    maxOddsPerPick:  parseFloat(req.body.maxOddsPerPick) || 2.0,
    minConfidence:   req.body.minConfidence != null ? parseInt(req.body.minConfidence) : 55,
    convertRisky:    !!req.body.convertRisky,
    footballOnly:    req.body.footballOnly !== false,
    removeFriendlies:req.body.removeFriendlies !== false,
    removeBanned:    req.body.removeBanned !== false,
    preferConsensus: !!req.body.preferConsensus,
    topPuntersOnly:  !!req.body.topPuntersOnly,
    maxRepeat:       req.body.maxRepeat != null ? Math.min(10, Math.max(1, parseInt(req.body.maxRepeat))) : 1,
    strategy:        ['balanced','safe','high_odds','consensus'].includes(req.body.strategy) ? req.body.strategy : 'balanced',
  };
  if (opts.minGames > opts.maxGames) opts.minGames = opts.maxGames;

  const logs = [];
  const log = msg => { logs.push(msg); console.log('[portfolio]', msg); };

  try {
    let masterPool = null;
    if (intel) {
      const cached = intel.getMasterPool();
      if (cached?.masterPool?.length) { masterPool = cached.masterPool; log('Using cached master pool: ' + masterPool.length + ' picks'); }
    }
    if (!masterPool || !masterPool.length) {
      try {
        const mpFile = require("path").join(DATA_DIR, "master-pool.json");
        const raw = JSON.parse(require("fs").readFileSync(mpFile, "utf-8"));
        if (raw.masterPool?.length) { masterPool = raw.masterPool; log('Loaded master pool from disk: ' + masterPool.length + ' picks'); }
      } catch {}
    }
    if (!masterPool || !masterPool.length) {
      return res.status(400).json({ success: false, error: "No master pool available. Run 'Run Master Analysis' first." });
    }

    const generateCodeFn = async (selections) => {
      const payload = selections.map(s => ({
        eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
        productId: s.productId || 3, sportId: s.sportId || "sr:sport:1",
        specifier: s.specifier || "", parentBetBuilderMarketId: "",
      }));
      const r = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
      if (r.bizCode === 10000 && r.data?.shareCode) return { code: r.data.shareCode, url: r.data.shareURL || "" };
      throw new Error("SportyBet rejected: " + (r.msg || r.bizCode || "unknown"));
    };

    const result = await portfolioBuilder.buildPortfolio(masterPool, opts, generateCodeFn, log);
    res.json({ ...result, logs });
  } catch (e) {
    console.error('[portfolio-generate]', e);
    res.status(500).json({ success: false, error: e.message, logs });
  }
});

// ── Advanced Generator — 9-phase punter/community intelligence pipeline ─────
// Replaces the old simple Portfolio Generator UI entirely. See
// advanced-generator-engine.js for the full phase-by-phase implementation.

// Start a run — returns immediately with a runId; the run itself proceeds
// asynchronously and streams progress via the SSE endpoint below. This is
// what makes the run restartable/resumable: the run lives server-side keyed
// by runId, independent of any one browser connection.
app.post("/api/admin/advanced-generator/start", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  try {
    const runId = advancedGen.startRun({
      internalBaseUrl: `http://127.0.0.1:${PORT}`,
      config: req.body?.config || {},
      mode: ['full', 'punters', 'mixtures'].includes(req.body?.mode) ? req.body.mode : 'full',
    });
    res.json({ success: true, runId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// SSE stream — replays the full event log on connect (so a page refresh or
// reconnect catches up instantly) then streams new events live.
app.get("/api/admin/advanced-generator/stream/:runId", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).end();
  const { runId } = req.params;
  const run = advancedGen.getRun(runId);
  if (!run) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const fromSeq = parseInt(req.query.fromSeq, 10) || 0;
  for (const ev of run.events) {
    if (ev.seq < fromSeq) continue;
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ ...ev.data, seq: ev.seq })}\n\n`);
  }
  if (run.state.status === 'done' || run.state.status === 'error' || run.state.status === 'stopped') {
    // Named 'run-error', never bare 'error' — the browser's native EventSource
    // fires its OWN unrelated 'error' event on every connection drop (including
    // a plain server restart), and a client listening on 'error' for both would
    // misreport an in-progress run as failed. See generator.js genAttachStream.
    const evName = run.state.status === 'error' ? 'run-error' : run.state.status === 'stopped' ? 'stopped' : 'done';
    res.write(`event: ${evName}\ndata: ${JSON.stringify(run.state)}\n\n`);
    return res.end();
  }
  advancedGen.subscribe(runId, res);
  req.on("close", () => {});
});

// Polling fallback / resume-on-refresh — full current state, no SSE required.
app.get("/api/admin/advanced-generator/state/:runId", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  const run = advancedGen.getRun(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: "Run not found" });
  res.json({ success: true, state: run.state, events: run.events });
});

app.get("/api/admin/advanced-generator/latest", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  const runId = advancedGen.getLatestRunId();
  if (!runId) return res.json({ success: true, runId: null });
  const run = advancedGen.getRun(runId);
  res.json({ success: true, runId, state: run?.state || null });
});

app.get("/api/admin/advanced-generator/pool/:runId", requireAdmin, (req, res) => {
  try {
    const file = path.join(DATA_DIR, "advanced-generator", `pool-${req.params.runId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    res.json({ success: true, ...raw });
  } catch (e) {
    res.status(404).json({ success: false, error: "Pool not found for this run" });
  }
});

// ── Auto-Bet (LOCAL DEV ONLY) ────────────────────────────────────────────────
// Places real money on a real account. Every route 503s in production because
// `autobet` is only required when !IS_PRODUCTION. The stake is fixed at
// autobet.MAX_STAKE inside the engine and is deliberately NOT accepted from
// the request body — there is no wire format for raising it.

const autobetUnavailable = (res) =>
  res.status(503).json({ success: false, error: "Auto-bet is local-dev only" });

app.get("/api/admin/autobet/status", requireAdmin, async (req, res) => {
  if (!autobet) return autobetUnavailable(res);
  try {
    const s = await autobet.checkSession();
    res.json({ success: true, ...s, stake: autobet.MAX_STAKE, minLegs: autobet.MIN_LEGS,
      flexTrigger: autobet.FLEX_TRIGGER_ODDS, flexMinOdds: autobet.FLEX_MIN_ODDS });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Opens a headed browser for a human to log in. Long-running by design.
app.post("/api/admin/autobet/signin", requireAdmin, async (req, res) => {
  if (!autobet) return autobetUnavailable(res);
  req.setTimeout(330000);
  try {
    const r = await autobet.signIn();
    res.json({ success: !!r.success, error: r.error || null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Dry-run check only — validates codes without opening a browser at all.
app.post("/api/admin/autobet/check", requireAdmin, async (req, res) => {
  if (!autobet) return autobetUnavailable(res);
  try {
    const codes = autobet.parseCodes(req.body.codes);
    if (!codes.length) return res.status(400).json({ success: false, error: "No valid booking codes in that input" });
    // rebuild:true so Check Only shows the code as it would ACTUALLY be played
    // — kicked-off legs dropped and reposted — not the raw original. This is
    // the safe, non-money-moving path: it never opens a browser or clicks
    // anything, it only builds the ready booking code via SportyBet's normal
    // share API (the same call Book Bet uses).
    const checks = await Promise.all(codes.map(async (code) => {
      try { return { code, ...(await autobet.validateCode(code, { rebuild: true })) }; }
      catch (e) { return { code, ok: false, reason: e.message }; }
    }));
    res.json({ success: true, stake: autobet.MAX_STAKE, checks });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/admin/autobet/start", requireAdmin, async (req, res) => {
  if (!autobet) return autobetUnavailable(res);
  try {
    const state = await autobet.startRun(req.body.codes, { dryRun: !!req.body.dryRun });
    res.json({ success: true, ...state });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get("/api/admin/autobet/stream/:runId", requireAdmin, (req, res) => {
  if (!autobet) return res.status(503).end();
  const run = autobet.getRun(req.params.runId);
  if (!run) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const fromSeq = parseInt(req.query.fromSeq, 10) || 0;
  for (const ev of run.events) {
    if (ev.seq < fromSeq) continue;
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ ...ev.data, seq: ev.seq })}\n\n`);
  }
  // 'run-error', never bare 'error' — EventSource fires its own 'error' on any
  // dropped connection, and a client listening for both would misreport a live
  // run as failed (same reasoning as the advanced-generator stream above).
  if (run.state.status === 'done' || run.state.status === 'error') {
    res.write(`event: ${run.state.status === 'error' ? 'run-error' : 'done'}\ndata: ${JSON.stringify(run.state)}\n\n`);
    return res.end();
  }
  autobet.subscribe(req.params.runId, res);
});

app.get("/api/admin/autobet/state/:runId", requireAdmin, (req, res) => {
  if (!autobet) return autobetUnavailable(res);
  const run = autobet.getRun(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: "Run not found" });
  res.json({ success: true, state: run.state });
});

app.post("/api/admin/autobet/stop/:runId", requireAdmin, (req, res) => {
  if (!autobet) return autobetUnavailable(res);
  res.json({ success: autobet.stopRun(req.params.runId) });
});

app.get("/api/admin/advanced-generator/results", requireAdmin, (req, res) => {
  try {
    const file = path.join(DATA_DIR, "advanced-generator-results.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    res.json({ success: true, history: raw.slice(-20) });
  } catch (e) {
    res.json({ success: true, history: [] });
  }
});

app.delete("/api/admin/advanced-generator/results", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  advancedGen.deleteResults();
  res.json({ success: true });
});

app.get("/api/admin/advanced-generator/blacklist", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  res.json({ success: true, blacklist: advancedGen.loadBlacklist() });
});

app.post("/api/admin/advanced-generator/blacklist", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  const hard = Array.isArray(req.body?.hard) ? req.body.hard.filter(Boolean) : null;
  const soft = Array.isArray(req.body?.soft) ? req.body.soft.filter(Boolean) : null;
  if (!hard || !soft) return res.status(400).json({ success: false, error: "hard[] and soft[] arrays required" });
  const current = advancedGen.loadBlacklist();
  advancedGen.saveBlacklist({ hard, soft, note: req.body.note || current.note || '', updatedAt: new Date().toISOString() });
  res.json({ success: true });
});

// v3.1 §4 — one-time-per-day-of-history backfill: replays every settled leg
// found in data/reports/*.json into the shared league/team-intelligence
// files. Additive + idempotent (tracks already-ingested files) — safe to
// click repeatedly, only new settled days get picked up each time.
app.post("/api/admin/advanced-generator/backfill-intelligence", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  try {
    const result = advancedGen.backfillIntelligenceFromHistory(msg => console.log('[backfill]', msg));
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v8 §4 — so opening the tab shows "Yesterday's lessons applied" even
// before starting a run today, not only right after a live run finishes.
app.get("/api/admin/advanced-generator/last-lessons", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  res.json({ success: true, lessons: advancedGen.getLastLessons() });
});

// v18 — Report page: read-only lessons lookup for an arbitrary date (no
// side effects, unlike POST daily-review which mutates downweights).
app.get("/api/admin/advanced-generator/lessons/:date", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  res.json({ success: true, lessons: advancedGen.getLessonsForDate(req.params.date) });
});

// v10 §2 — real fail-rate + sample + day-variance, shown with the rate, not just a raw count.
app.get("/api/admin/advanced-generator/blacklist-candidates", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  res.json({ success: true, candidates: advancedGen.getBlacklistCandidates() });
});

app.get("/api/admin/advanced-generator/floor-state", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  res.json({ success: true, floorState: advancedGen.loadFloorState() });
});

// v6 — graceful Stop Run: sets a flag the running process checks between
// loop iterations; in-flight API calls finish, no new work starts, then the
// run persists whatever it collected/scored with status 'stopped'.
app.post("/api/admin/advanced-generator/stop/:runId", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  const ok = advancedGen.requestStop(req.params.runId);
  if (!ok) return res.status(404).json({ success: false, error: "Run not found or not currently running" });
  res.json({ success: true });
});

// v6 — Generator Settings modal: live-editable config, persisted, applied to
// the next run. GET returns effective values (DEFAULT_CONFIG + saved
// overrides) so the UI never shows a blank/fake field.
app.get("/api/admin/advanced-generator/config", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  const effective = { ...advancedGen.DEFAULT_CONFIG, ...advancedGen.loadSettings() };
  res.json({ success: true, config: effective, defaults: advancedGen.DEFAULT_CONFIG });
});

app.post("/api/admin/advanced-generator/config", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  const allowedNumericKeys = [
    'confidenceFloor', 'toxicMinKillCount', 'toxicFailRateThreshold', 'lateLegDropDefaultN', 'conversionConcurrency',
    'softLeaguePenalty', 'softLeagueTicketCapPct', 'teamExposureCap', 'leagueExposureCapBig', 'leagueExposureCapSmall',
    'riskBandLeave', 'conversionMinImprovement', 'legOddsPreferredMin', 'legOddsPreferredMax', 'legOddsHardFloor', 'tierOverlapCapPct',
    'variantOverlapCapPct', 'moonshotVariantOverlapCapMax', 'maxVariantsTier1', 'maxVariantsTier2', 'maxVariantsTier3', 'maxVariantsTier4',
    'maxVariantsMoonshot', 'maxVariantsConsensus', 'maxVariantsSureTier', 'maxVariantsMix', 'autoRunHour', 'autoRunMinute',
    'minPunterSlipOdds', // v11 §4 — was code-only; now a real, UI-editable setting like everything else
    'legBracketRollingDays', 'legBracketMinSample', 'legBracketCapThreshold', // v14 — Portfolio Survival tunables
    'sectionASurvivalLabelMinLegs', // v21 — Section A leg-count survival label threshold
    'maxBuilderMinPoolSize', 'maxBuilderPerSourceCap', 'maxVariantsMaxBuilder', // v21/v23/v35 — Max Builder tunables; the leg cap is now the universal 50-leg guard in generateTicketCode
  ];
  const boolKeys = ['forcedUnderShift', 'autoRunEnabled', 'allowBeyondProvenLegCount'];
  // Merge onto existing saved settings (not the code defaults) so a modal
  // save never wipes out a previously-saved field the current request
  // doesn't include — settings.json is the persisted source of truth.
  const settings = { ...advancedGen.loadSettings() };
  for (const k of allowedNumericKeys) if (req.body[k] != null && !isNaN(req.body[k])) settings[k] = Number(req.body[k]);
  for (const k of boolKeys) if (req.body[k] != null) settings[k] = (req.body[k] === true || req.body[k] === 'true' || req.body[k] === 1 || req.body[k] === '1');
  advancedGen.saveSettings(settings);
  res.json({ success: true, config: { ...advancedGen.DEFAULT_CONFIG, ...settings } });
});

// v14 — Portfolio Survival: rolling observed-vs-theoretical ticket win rate
// by leg-count bracket, and whether/what it currently caps. Read-only —
// the cap itself is only ever set by cfg.allowBeyondProvenLegCount via the
// /config route above, computed fresh here from real settled history.
app.get("/api/admin/advanced-generator/leg-bracket-survival", requireAdmin, (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  const cfg = { ...advancedGen.DEFAULT_CONFIG, ...advancedGen.loadSettings() };
  const survival = advancedGen.computeLegBracketSurvival(cfg);
  res.json({ success: true, ...survival });
});

// Manual "Run Daily Review" trigger (§5) — also runs automatically via the
// scheduled job registered near the daily-cleanup cron below.
app.post("/api/admin/advanced-generator/daily-review", requireAdmin, async (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  // v9 §6 — same root cause the scoreboard route had: runDailyReview scans
  // every ticket of the day sequentially against live SportyBet via
  // buildScoreboard, which easily exceeds the global 30s request timeout on
  // a real day's worth of tickets. That's why the button "did nothing" —
  // the request was silently killed before the client ever got a response.
  req.setTimeout(300000);
  const dateStr = req.body?.date || new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  try {
    const result = await advancedGen.runDailyReview(dateStr, `http://127.0.0.1:${PORT}`, msg => console.log('[daily-review]', msg));
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// v7 §6 — Performance tab: yesterday's (or any given date's) real scoreboard.
// Scans each ticket's code once via /api/scan, caches settled results —
// re-opening the tab or re-running daily-review never re-scans a fully
// settled ticket.

// v8 §4 — manual trigger to verify the morning path (review -> run,
// sequential) without waiting for the actual clock. Same sequence
// checkAutoRunSchedule uses; returns as soon as it's kicked off (run itself
// streams via SSE as normal — this endpoint doesn't block on it).
app.post("/api/admin/advanced-generator/simulate-auto-run", requireAdmin, async (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  req.setTimeout(300000);
  try {
    const dateStr = req.body?.reviewDate || new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    const reviewResult = await advancedGen.runDailyReview(dateStr, `http://127.0.0.1:${PORT}`, msg => console.log('[simulate-auto-run/daily-review]', msg));
    const runId = advancedGen.startRun({ mode: 'full', internalBaseUrl: `http://127.0.0.1:${PORT}`, config: {} });
    res.json({ success: true, reviewResult, runId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/admin/advanced-generator/scoreboard/:date", requireAdmin, async (req, res) => {
  if (!advancedGen) return res.status(503).json({ success: false, error: "Advanced generator not available in production" });
  req.setTimeout(300000); // 5 min — the global 30s timeout killed this on a real run: scanning 16+ tickets sequentially against live SportyBet easily exceeds it
  try {
    const result = await advancedGen.buildScoreboard(req.params.date, `http://127.0.0.1:${PORT}`, msg => console.log('[scoreboard]', msg), req.query.rescan === '1');
    if (!result.tickets) return res.status(404).json(result);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Strategy Engine — Phase 4 ────────────────────────────────────────────────
// 15 independent named strategies built from the same master pool, each with
// its own construction rules, full audit metadata, and a safest→riskiest rank.

app.get("/api/admin/strategy-list", requireAdmin, (req, res) => {
  if (!strategyEngine) return res.status(503).json({ success: false, error: "Strategy engine not available in production" });
  res.json({ success: true, strategies: strategyEngine.listStrategies() });
});

app.post("/api/admin/h2h-refine", requireAdmin, async (req, res) => {
  if (!strategyEngine) return res.status(503).json({ success: false, error: "Strategy engine not available in production" });
  req.setTimeout(300000); // several codes x up to ~50 legs, sequential live market checks + stagger

  // Accept one or several comma/whitespace-separated booking codes so a
  // punter's own hand-built codes can be merged into a single refined ticket.
  const codes = [...new Set(
    (req.body?.code || "").split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean)
  )];
  if (!codes.length) return res.status(400).json({ success: false, error: "At least one booking code required" });

  try {
    // Fetch each code SERIALLY — SportyBet's share endpoint silently returns
    // empty selections under concurrent load (see settled-odds-contamination
    // notes), so codes are pulled one at a time, not in parallel.
    const perCodeSelections = [];
    for (const code of codes) {
      const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
      const json = await fetchJSON(url);
      if (!json || json.bizCode !== 10000 || !json.data) {
        return res.status(404).json({ success: false, error: `${code}: ${json?.message || json?.innerMsg || "booking code not found"}` });
      }
      const outcomes = json.data.outcomes || [];
      const ticketSels = json.data.ticket?.selections || [];
      perCodeSelections.push(...mapOutcomes(outcomes, ticketSels).map((s) => ({ ...s, sourceCode: code })));
    }

    // Same-match guard across ALL pasted codes combined — first code pasted
    // wins the fixture if it appears more than once.
    const byEvent = new Map();
    for (const s of perCodeSelections) if (!byEvent.has(s.eventId)) byEvent.set(s.eventId, s);
    const selections = [...byEvent.values()];

    const fetchEventMarkets = async (eventId) => {
      const eurl = `https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(eventId)}`;
      const ejson = await fetchJSON(eurl);
      if (!ejson || ejson.bizCode !== 10000 || !ejson.data) throw new Error(ejson?.message || "Event not found");
      const d = ejson.data;
      return (d.markets || []).flatMap((m) =>
        (m.outcomes || []).filter((o) => o.isActive === 1).map((o) => ({
          marketId: m.id, marketName: m.desc || "", specifier: m.specifier || "",
          outcomeId: o.id, outcomeName: o.desc || "", odds: parseFloat(o.odds) || 0,
        }))
      );
    };

    const { legs, summary } = await strategyEngine.refineTicketForH2HFavorites(selections, fetchEventMarkets);

    // Build the final leg list — KEEP as-is, EDIT swapped to its suggestion,
    // DROP excluded — then generate a real SportyBet code from the result.
    const UNIVERSAL_MAX_LEGS = 50;
    let finalPicks = legs
      .filter((l) => l.verdict === "KEEP" || (l.verdict === "EDIT" && l.suggestion))
      .map((l) => l.verdict === "KEEP"
        ? { eventId: l.eventId, marketId: l.marketId, outcomeId: l.outcomeId, specifier: l.specifier || "", productId: l.productId || 3, sportId: l.sportId || "sr:sport:1" }
        : { eventId: l.eventId, marketId: l.suggestion.marketId, outcomeId: l.suggestion.outcomeId, specifier: l.suggestion.specifier || "", productId: l.productId || 3, sportId: l.sportId || "sr:sport:1" });
    if (finalPicks.length > UNIVERSAL_MAX_LEGS) finalPicks = finalPicks.slice(0, UNIVERSAL_MAX_LEGS);

    let generated = { skipped: true, reason: `Only ${finalPicks.length} usable leg(s) after refine — need at least 3.` };
    if (finalPicks.length >= 3) {
      const payload = finalPicks.map((s) => ({
        eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
        productId: s.productId, sportId: s.sportId, parentBetBuilderMarketId: "",
        ...(s.specifier ? { specifier: s.specifier } : {}),
      }));
      const genJson = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
      if (genJson.bizCode === 10000 && genJson.data?.shareCode) {
        incrementStat("codesGenerated");
        generated = { skipped: false, shareCode: genJson.data.shareCode, shareURL: genJson.data.shareURL || "", legCount: finalPicks.length };
      } else {
        generated = { skipped: true, reason: genJson.message || genJson.innerMsg || "SportyBet rejected the refined selections" };
      }
    }

    res.json({ success: true, codesUsed: codes, legCount: selections.length, summary, legs, generated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "Failed to refine code" });
  }
});

app.post("/api/admin/strategy-generate", requireAdmin, async (req, res) => {
  if (!strategyEngine) return res.status(503).json({ success: false, error: "Strategy engine not available in production" });
  req.setTimeout(600000); // up to 10 min — "all" mode posts up to 16 real codes to SportyBet

  const strategyKey = (req.body?.strategy || 'all').trim();
  const logs = [];
  const log = msg => { logs.push(msg); console.log('[strategy-engine]', msg); };

  try {
    // Get master pool — prefer fresh analysis, fall back to cached/disk copy
    let masterPool = null;
    if (intel) {
      const cached = intel.getMasterPool();
      if (cached?.masterPool?.length) { masterPool = cached.masterPool; log('Using cached master pool: ' + masterPool.length + ' picks'); }
    }
    if (!masterPool || !masterPool.length) {
      try {
        const mpFile = path.join(DATA_DIR, "master-pool.json");
        const raw = JSON.parse(fs.readFileSync(mpFile, "utf-8").replace(/^﻿/, ''));
        if (raw.masterPool?.length) { masterPool = raw.masterPool; log('Loaded master pool from disk: ' + masterPool.length + ' picks'); }
      } catch {}
    }
    if (!masterPool || !masterPool.length) {
      return res.status(400).json({ success: false, error: "No master pool available. Run 'Run Master Analysis' first." });
    }

    const generateCodeFn = async (selections) => {
      const payload = selections.map(s => ({
        eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
        productId: s.productId || 3, sportId: s.sportId || "sr:sport:1",
        specifier: s.specifier || "", parentBetBuilderMarketId: "",
      }));
      const r = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
      if (r.bizCode === 10000 && r.data?.shareCode) return { code: r.data.shareCode, url: r.data.shareURL || "" };
      throw new Error("SportyBet rejected: " + (r.msg || r.bizCode || "unknown"));
    };

    if (strategyKey === 'all') {
      const result = await strategyEngine.runAllStrategies(masterPool, generateCodeFn, log);
      return res.json({ success: true, ...result, logs });
    }

    const ticket = await strategyEngine.runStrategy(strategyKey, masterPool, generateCodeFn, log);
    res.json({ success: true, strategies: [ticket], top3: [], logs });
  } catch (e) {
    console.error('[strategy-generate]', e);
    res.status(500).json({ success: false, error: e.message, logs });
  }
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

// ── Table Tennis Workspace ──
// Public-facing TT analysis workspace: paste booking codes -> decode -> ingest any
// newly-resolved legs -> rebuild real empirical rates -> cross-market score every unplayed
// match (G1 Under19.5, G1 Over17.5, FM Under, Handicap) -> return honest 5-leg vs
// target-fit (10k-1M, floor 1000x) selections. Model logic lives in tt-engine.js.
//
// Scanning a real match pool (tonight's sessions routinely covered 80-150 matches) takes
// several minutes end-to-end - far past the 30s request timeout set near the top of this
// file - so this runs as a background job the frontend polls, not a single request/response.

const ttScanJobs = new Map(); // scanId -> { status, progress, result, error, startedAt }
const TT_SCAN_JOB_TTL = 30 * 60 * 1000; // drop finished in-memory jobs after 30 minutes
function cleanupTTScanJobs() {
  const now = Date.now();
  for (const [id, job] of ttScanJobs) {
    if (job.status !== "running" && now - job.startedAt > TT_SCAN_JOB_TTL) ttScanJobs.delete(id);
  }
}
// A finished scan only lived in the in-memory Map above - a page refresh (new client, same
// server) had no way to see it, and it vanished entirely after TT_SCAN_JOB_TTL or a server
// restart. Persisting the most recent completed scan to disk means "the result scanned
// doesn't save on refresh" is actually fixed: the UI can always ask for it back.
const TT_LAST_SCAN_FILE = path.join(ttEngine ? ttEngine.DATA_DIR : path.join(__dirname, "data"), "tt-last-scan.json");
function saveTTLastScan(scanId, codes, result) {
  if (!ttEngine) return;
  try { ttEngine.saveJSON(TT_LAST_SCAN_FILE, { scanId, codes, result, savedAt: new Date().toISOString() }); } catch {}
}
function loadTTLastScan() { return ttEngine ? ttEngine.loadJSON(TT_LAST_SCAN_FILE, null) : null; }
// Look up a scan job by id: check the in-memory Map first (fast path, has live progress),
// fall back to the disk-persisted last scan if the id matches (covers server restarts and
// jobs that aged out of the in-memory TTL above).
function findTTScanJob(scanId) {
  const live = ttScanJobs.get(scanId);
  if (live) return live;
  const persisted = loadTTLastScan();
  if (persisted && persisted.scanId === scanId) return { status: "done", result: persisted.result, progress: null, error: null };
  return null;
}

async function runTTScan(scanId, cleanCodes) {
  const job = ttScanJobs.get(scanId);
  try {
    const history = ttEngine.loadJSON(ttEngine.HISTORY_FILE, []);
    const seen = new Set(history.map(h => ttEngine.recordKey(h)));
    const unplayedByEvent = new Map();
    let ingestedCount = 0;
    const codeResults = [];

    for (const code of cleanCodes) {
      const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
      let json;
      try { json = await fetchJSON(url); } catch { codeResults.push({ code, error: "Fetch failed" }); job.progress.decoded++; continue; }
      if (!json || json.bizCode !== 10000 || !json.data) { codeResults.push({ code, error: "Code not found or invalid" }); job.progress.decoded++; continue; }
      const selections = mapOutcomes(json.data.outcomes || [], json.data.ticket?.selections || []);
      const notStart = selections.filter(s => s.matchStatus === "Not start");
      const ended = selections.filter(s => s.matchStatus === "Ended");

      for (const s of ended) {
        const key = ttEngine.recordKey(s);
        if (seen.has(key)) continue;
        seen.add(key);
        history.push({
          eventId: s.eventId, home: s.homeTeam, away: s.awayTeam, league: s.league, category: s.category,
          kickoff: s.kickoff, marketId: s.marketId, specifier: s.specifier, market: s.market, outcome: s.outcome,
          odds: s.odds, isWinning: s.isWinning, score: s.score, halfScores: s.halfScores,
          sourceCode: code, ingestedAt: new Date().toISOString(),
        });
        ingestedCount++;
      }
      for (const s of notStart) if (!unplayedByEvent.has(s.eventId)) unplayedByEvent.set(s.eventId, s);
      codeResults.push({ code, totalSelections: selections.length, unplayed: notStart.length, resolved: ended.length });
      job.progress.decoded++;
    }

    // Persist newly-resolved legs and rebuild real empirical rates before scoring anything -
    // this is the "rebuilt automatically as new codes get ingested" requirement.
    if (ingestedCount > 0) ttEngine.saveJSON(ttEngine.HISTORY_FILE, history);
    const { handicapRates } = ttEngine.rebuild();

    const ctx = ttEngine.buildScoringContext();
    const unplayed = [...unplayedByEvent.values()];
    job.progress.totalUnplayed = unplayed.length;
    const analyzed = [];
    for (const s of unplayed) {
      const url = `https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(s.eventId)}`;
      let marketJson;
      try { marketJson = await fetchJSON(url); } catch { job.progress.scored++; continue; }
      if (!marketJson || marketJson.bizCode !== 10000 || !marketJson.data) { job.progress.scored++; continue; }
      const markets = (marketJson.data.markets || []).flatMap(m =>
        (m.outcomes || []).filter(o => o.isActive === 1).map(o => ({
          marketId: m.id, specifier: m.specifier || "", outcomeId: o.id, outcomeName: o.desc || "", odds: parseFloat(o.odds) || 0,
        }))
      );
      const scored = ttEngine.scoreMatchAllMarkets(s.homeTeam, s.awayTeam, markets, ctx, s.league);
      job.progress.scored++;
      if (!scored.best) continue;
      scored.eventId = s.eventId; scored.sportId = s.sportId; scored.league = s.league;
      analyzed.push(scored);
      // Log this prediction so the calibration loop (computeCalibration, run inside
      // rebuild()) can compare it against the real result once this match settles.
      ttEngine.logPrediction(s.eventId, scored.best.marketId, scored.best.specifier, scored.best.market, scored.best.confidence, s.homeTeam, s.awayTeam, scored.best.outcome);
      // Small courtesy delay between upstream event fetches - not a hard rate limit, but
      // avoids hammering SportyBet with dozens of rapid-fire requests from one IP.
      await new Promise(r => setTimeout(r, 350));
    }

    const selectionResult = ttEngine.buildSelections(analyzed, { maxLegs: 50, tiers: [1000, 10000, 100000, 1000000] });
    analyzed.sort((a, b) => (b.best?.confidence || 0) - (a.best?.confidence || 0));

    const historyKickoffs = history.map(h => h.kickoff && h.kickoff.slice(0, 10)).filter(Boolean).sort();

    // Explainability: top 5 strongest picks (already the head of the sorted list), and top 5
    // REJECTED candidates - markets that had the best odds among rejects (the ones most
    // tempting to a human eyeballing odds) but lost the market-score competition - with why.
    const top5Strongest = analyzed.slice(0, 5).map(m => ({
      match: m.home + " vs " + m.away, market: m.best.type, odds: m.best.odds, confidencePct: +(m.best.confidence * 100).toFixed(1),
      reason: [m.knownPlayers ? "known players" : null, m.h2hMeetings ? m.h2hMeetings + " H2H meetings" : null, m.best.gapAdjustNote ? "opponent-adjusted" : null].filter(Boolean).join(", ") || "model + shrinkage confidence",
    }));
    const rejected = [];
    for (const m of analyzed) {
      for (const c of (m.candidates || [])) {
        if (c === m.best) continue;
        rejected.push({ match: m.home + " vs " + m.away, market: c.type, odds: c.odds, confidencePct: +(c.confidence * 100).toFixed(1), beatenBy: m.best.type + " (" + (m.best.confidence * 100).toFixed(1) + "%)" });
      }
    }
    rejected.sort((a, b) => b.odds - a.odds);
    const top5Rejected = rejected.slice(0, 5).map(r => ({ ...r, reason: `Odds looked tempting (${r.odds}×) but real confidence was only ${r.confidencePct}% - ${r.beatenBy} scored higher for this match.` }));

    job.status = "done";
    job.result = {
      codes: codeResults,
      ingestedNewLegs: ingestedCount,
      totalUnplayedMatches: unplayed.length,
      scoredMatches: analyzed.length,
      handicapRates,
      selections: selectionResult,
      matches: analyzed.map(m => ({ home: m.home, away: m.away, eventId: m.eventId, sportId: m.sportId, league: m.league, knownPlayers: m.knownPlayers, strengthGap: m.strengthGap, h2hMeetings: m.h2hMeetings, best: m.best, allCandidates: m.candidates })),
      dataWindow: { earliestRecord: historyKickoffs[0] || null, latestRecord: historyKickoffs[historyKickoffs.length - 1] || null, totalHistoryRecords: history.length },
      top5Strongest, top5Rejected,
    };
    saveTTLastScan(scanId, cleanCodes, job.result);
  } catch (err) {
    job.status = "error";
    job.error = err.message;
  }
}

app.post("/api/tt/scan", requireAdmin, (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const { codes } = req.body;
  if (!codes || !Array.isArray(codes) || !codes.length) return res.status(400).json({ error: "codes array required" });
  const cleanCodes = [...new Set(codes.map(c => String(c).trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  if (!cleanCodes.length) return res.status(400).json({ error: "No valid codes provided" });

  if ([...ttScanJobs.values()].filter(job => job.status === "running").length >= 2)
    return res.status(503).set("Retry-After", "30").json({ error: "Two scans are already running" });

  cleanupTTScanJobs();
  const scanId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  ttScanJobs.set(scanId, {
    status: "running",
    progress: { decoded: 0, totalCodes: cleanCodes.length, scored: 0, totalUnplayed: 0 },
    result: null, error: null, startedAt: Date.now(),
  });
  while (ttScanJobs.size > 20) {
    const oldest = ttScanJobs.keys().next().value;
    if (ttScanJobs.get(oldest)?.status === "running") break;
    ttScanJobs.delete(oldest);
  }
  runTTScan(scanId, cleanCodes);
  res.json({ scanId, status: "running" });
});

// "Result scanned doesn't save on refresh" - the client calls this on tab open/page load to
// restore the most recently completed scan without needing to re-run it (rescanning ~90-100
// live matches takes several minutes). Not tied to any one browser/session - it's whatever
// this server last scanned. MUST be registered before the /:scanId route below, otherwise
// Express matches "last" as a :scanId value and this route is never reached.
app.get("/api/tt/scan/last", requireAdmin, (req, res) => {
  const persisted = loadTTLastScan();
  if (!persisted) return res.status(404).json({ error: "No scan has completed yet on this server." });
  res.json(persisted);
});

app.get("/api/tt/scan/:scanId", requireAdmin, (req, res) => {
  const job = findTTScanJob(req.params.scanId);
  if (!job) return res.status(404).json({ error: "Unknown or expired scanId" });
  res.json(job);
});

app.get("/api/tt/leaderboards", requireAdmin, (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const leaderboards = ttEngine.loadJSON(ttEngine.LEADERBOARDS_FILE, {});
  const handicapRates = ttEngine.loadJSON(path.join(ttEngine.DATA_DIR, "tt-handicap-rates.json"), null) || ttEngine.computeHandicapRates();
  res.json({ leaderboards, handicapRates });
});

// Full player/history browse — separate from leaderboards (market-level) so the UI can
// show "all information we ever had" without requiring a fresh scan first.
app.get("/api/tt/players", requireAdmin, (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const players = ttEngine.loadJSON(ttEngine.PLAYERS_FILE, {});
  const history = ttEngine.loadJSON(ttEngine.HISTORY_FILE, []);
  const list = Object.entries(players).map(([name, p]) => ({ name, ...p }));
  list.sort((a, b) => b.n - a.n);
  res.json({ players: list, totalPlayers: list.length, totalHistoryRecords: history.length });
});

// Bulk-ingest historical (already-decided) codes straight into permanent history, without
// running the (expensive, per-match live-market) scoring pass runTTScan does for upcoming
// fixtures. Meant for "we have a lot of old codes, let's build the player database from them."
const ttIngestJobs = new Map();
async function runTTBulkIngest(jobId, cleanCodes) {
  const job = ttIngestJobs.get(jobId);
  try {
    const history = ttEngine.loadJSON(ttEngine.HISTORY_FILE, []);
    const seen = new Set(history.map(h => ttEngine.recordKey(h)));
    let ingestedCount = 0;
    const codeResults = [];
    for (const code of cleanCodes) {
      const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;
      let json;
      try { json = await fetchJSON(url); } catch { codeResults.push({ code, error: "Fetch failed" }); job.progress.done++; continue; }
      if (!json || json.bizCode !== 10000 || !json.data) { codeResults.push({ code, error: "Code not found or invalid" }); job.progress.done++; continue; }
      const selections = mapOutcomes(json.data.outcomes || [], json.data.ticket?.selections || []);
      const ended = selections.filter(s => s.matchStatus === "Ended");
      let added = 0;
      for (const s of ended) {
        const key = ttEngine.recordKey(s);
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
      ingestedCount += added;
      codeResults.push({ code, totalSelections: selections.length, resolved: ended.length, newlyIngested: added });
      job.progress.done++;
      await new Promise(r => setTimeout(r, 150));
    }
    if (ingestedCount > 0) ttEngine.saveJSON(ttEngine.HISTORY_FILE, history);
    const rebuilt = ttEngine.rebuild();
    job.status = "done";
    job.result = {
      codes: codeResults, ingestedNewLegs: ingestedCount,
      totalHistoryRecords: history.length,
      totalPlayers: Object.keys(rebuilt.players).length,
      leaderboards: rebuilt.leaderboards,
    };
  } catch (err) {
    job.status = "error";
    job.error = err.message;
  }
}
app.post("/api/tt/ingest-bulk", requireAdmin, (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const { codes } = req.body;
  if (!codes || !Array.isArray(codes) || !codes.length) return res.status(400).json({ error: "codes array required" });
  const cleanCodes = [...new Set(codes.map(c => String(c).trim().toUpperCase()).filter(Boolean))].slice(0, 200);
  if (!cleanCodes.length) return res.status(400).json({ error: "No valid codes provided" });
  if ([...ttIngestJobs.values()].some(job => job.status === "running"))
    return res.status(503).set("Retry-After", "30").json({ error: "A bulk ingest is already running" });
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  ttIngestJobs.set(jobId, { status: "running", progress: { done: 0, total: cleanCodes.length }, result: null, error: null });
  while (ttIngestJobs.size > 10) ttIngestJobs.delete(ttIngestJobs.keys().next().value);
  runTTBulkIngest(jobId, cleanCodes);
  res.json({ jobId, status: "running" });
});
app.get("/api/tt/ingest-bulk/:jobId", requireAdmin, (req, res) => {
  const job = ttIngestJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown or expired jobId" });
  res.json(job);
});

// Market-specific generate: "gen X, under 78.5" / "gen X, highest handicap" - re-selects from
// an already-completed scan's per-match candidate lists (every market was already scored, not
// just the winner) by a SPECIFIC market instead of whichever scored best per match, then
// generates + logs the code immediately in one call, same as the tier/batch generators.
app.post("/api/tt/market-select/:scanId", requireAdmin, checkGenerateRate, async (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const job = findTTScanJob(req.params.scanId);
  if (!job || job.status !== "done" || !job.result) return res.status(404).json({ error: "Unknown, expired, or not-yet-finished scanId" });
  const { market, maxLegs } = req.body || {};
  if (!market || !ttEngine.MARKET_SELECT_KEYS.includes(market)) return res.status(400).json({ error: "Unknown market. Valid: " + ttEngine.MARKET_SELECT_KEYS.join(", ") });
  const view = ttEngine.buildMarketSelection(job.result.matches || [], market, { maxLegs: Number(maxLegs) || 50 });
  if (!view.legs) return res.json({ success: false, error: view.note });

  const payload = view.selections.map(s => ({
    eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
    productId: s.productId || 3, sportId: s.sportId, parentBetBuilderMarketId: "",
    ...(s.specifier ? { specifier: s.specifier } : {}),
  }));
  try {
    const json = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
    if (json.bizCode === 10000 && json.data?.shareCode) {
      incrementStat("codesGenerated");
      const log = loadTTLog();
      log.unshift({
        shareCode: json.data.shareCode, tier: "market:" + market, sourceCodes: job.result.codes?.map(c => c.code) || [],
        legs: payload.length, combinedOdds: view.combinedOdds, straightWinPct: view.straightWinPct,
        marketMix: { [market]: payload.length }, generatedAt: new Date().toISOString(),
      });
      saveTTLog(log.slice(0, 500));
      return res.json({ success: true, shareCode: json.data.shareCode, shareURL: json.data.shareURL || "", ...view });
    }
    return res.status(400).json({ success: false, error: json.message || json.innerMsg || "Unknown error" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Batch: build 5-10 genuinely DIFFERENT, correlation-aware codes from an already-completed
// scan's scored matches, instead of one code per odds tier. Reuses the finished scan job
// (no re-fetching live markets) so this is fast - just re-slices the same real confidence data.
app.post("/api/tt/batch/:scanId", requireAdmin, (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const job = findTTScanJob(req.params.scanId);
  if (!job || job.status !== "done" || !job.result) return res.status(404).json({ error: "Unknown, expired, or not-yet-finished scanId" });
  const { count, minLegs, maxLegs, floor } = req.body || {};
  const analyzed = job.result.matches || [];
  const batch = ttEngine.buildBatch(analyzed, {
    count: Number(count) || 8,
    minLegs: Number(minLegs) || 5,
    maxLegs: Number(maxLegs) || 50,
    floor: Number(floor) || 1000,
  });
  res.json(batch);
});

// Generate a booking code from a Table Tennis selection AND log it, so past
// recommendations are retrievable later ("show logs when I ask") instead of vanishing
// the moment the page is closed. This wraps the same SportyBet share-code call the shared
// /api/generate route makes, but is TT-specific so only TT-originated codes land in this log.
const TT_GENERATED_LOG_FILE = path.join(ttEngine ? ttEngine.DATA_DIR : path.join(__dirname, "data"), "tt-generated-log.json");
function loadTTLog() { return ttEngine ? ttEngine.loadJSON(TT_GENERATED_LOG_FILE, []) : []; }
function saveTTLog(log) { if (ttEngine) ttEngine.saveJSON(TT_GENERATED_LOG_FILE, log); }

app.post("/api/tt/generate", requireAdmin, checkGenerateRate, async (req, res) => {
  const { selections, tier, sourceCodes, combinedOdds, straightWinPct, marketMix } = req.body;
  if (!selections || !Array.isArray(selections) || !selections.length) return res.status(400).json({ error: "No selections provided" });

  const payload = selections.map(s => ({
    eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
    productId: s.productId || 3, sportId: s.sportId, parentBetBuilderMarketId: "",
    ...(s.specifier ? { specifier: s.specifier } : {}),
  }));

  try {
    const json = await postJSON("https://www.sportybet.com/api/ng/orders/share", { selections: payload });
    if (json.bizCode === 10000 && json.data?.shareCode) {
      incrementStat("codesGenerated");
      const log = loadTTLog();
      log.unshift({
        shareCode: json.data.shareCode, tier: tier || "unknown", sourceCodes: sourceCodes || [],
        legs: payload.length, combinedOdds: combinedOdds ?? null, straightWinPct: straightWinPct ?? null,
        marketMix: marketMix || null, generatedAt: new Date().toISOString(),
      });
      saveTTLog(log.slice(0, 500)); // keep the most recent 500 entries
      return res.json({ success: true, shareCode: json.data.shareCode, shareURL: json.data.shareURL || "" });
    }
    return res.status(400).json({ success: false, error: json.message || json.innerMsg || "Unknown error" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/tt/log", requireAdmin, (req, res) => {
  res.json({ log: loadTTLog() });
});

// Track external codes (e.g. from another AI/tipster) alongside our own generated ones, so
// "all games, save it, run analysis later" works for any code, not just ones this engine built.
app.post("/api/tt/track", requireAdmin, (req, res) => {
  const { codes, source, label } = req.body;
  if (!codes || !Array.isArray(codes) || !codes.length) return res.status(400).json({ error: "codes array required" });
  const clean = [...new Set(codes.map(c => String(c).trim().toUpperCase()).filter(Boolean))];
  if (!clean.length) return res.status(400).json({ error: "No valid codes provided" });
  const log = loadTTLog();
  const existing = new Set(log.map(e => e.shareCode));
  let added = 0;
  for (const shareCode of clean) {
    if (existing.has(shareCode)) continue;
    log.unshift({
      shareCode, tier: "external", sourceCodes: [], legs: null, combinedOdds: null, straightWinPct: null,
      marketMix: null, generatedAt: new Date().toISOString(), source: source || "external", label: label || null,
    });
    added++;
  }
  saveTTLog(log.slice(0, 500));
  res.json({ success: true, added, skippedDuplicates: clean.length - added });
});

// Live status for every saved/tracked code - decodes each via SportyBet and reports real
// won/lost/pending counts. This is the "run analysis" half of the saved-codes tab.
// "After each loss, document all the players in those games and rebuild/update the data" -
// this endpoint checks real results already; the gap was that checking never fed those real
// results back into tt-history.json, so the model never actually learned from a Saved Code's
// outcome unless you separately re-pasted it into Scan & Analyze. Fixed: every ENDED leg found
// while checking results here now gets ingested (same dedupe key as everywhere else) and, if
// anything new came in, rebuild() runs once at the end - real player stats, handicap rates, and
// calibration all update from every code you check, not just freshly-scanned ones.
app.get("/api/tt/track/status", requireAdmin, async (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const log = loadTTLog();
  if (!log.length) return res.json({ codes: [] });
  const history = ttEngine.loadJSON(ttEngine.HISTORY_FILE, []);
  const seen = new Set(history.map(h => h.eventId + "|" + h.marketId + "|" + h.specifier));
  let ingestedCount = 0;
  const results = [];
  for (const entry of log.slice(0, 60)) { // cap per request so this can't run forever
    try {
      const cached = bookingCache.get(entry.shareCode);
      let selections;
      if (cached && Date.now() - cached.time < BOOKING_CACHE_TTL) {
        selections = cached.data.selections;
      } else {
        const url = `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(entry.shareCode)}`;
        const json = await fetchJSON(url);
        if (!json || json.bizCode !== 10000 || !json.data) { results.push({ ...entry, status: "not_found" }); continue; }
        selections = mapOutcomes(json.data.outcomes || [], json.data.ticket?.selections || []);
        bookingCache.set(entry.shareCode, { data: { selections }, time: Date.now() });
        await new Promise(r => setTimeout(r, 200));
      }
      for (const s of selections) {
        if (s.matchStatus !== "Ended") continue;
        const key = ttEngine.recordKey(s);
        if (seen.has(key)) continue;
        seen.add(key);
        history.push({
          eventId: s.eventId, home: s.homeTeam, away: s.awayTeam, league: s.league, category: s.category,
          kickoff: s.kickoff, marketId: s.marketId, specifier: s.specifier, market: s.market, outcome: s.outcome,
          odds: s.odds, isWinning: s.isWinning, score: s.score, halfScores: s.halfScores,
          sourceCode: entry.shareCode, ingestedAt: new Date().toISOString(),
        });
        ingestedCount++;
      }
      const won = selections.filter(s => s.isWinning === 1).length;
      const lost = selections.filter(s => s.isWinning === 0).length;
      const pending = selections.filter(s => s.matchStatus === "Not start").length;
      const settled = won + lost;
      results.push({
        ...entry, totalLegs: selections.length, won, lost, pending,
        hitRatePct: settled ? +((won / settled) * 100).toFixed(1) : null,
        status: pending > 0 ? "in_progress" : lost === 0 ? "won" : "lost",
      });
    } catch (err) {
      results.push({ ...entry, status: "error", error: err.message });
    }
  }
  let rebuilt = null;
  if (ingestedCount > 0) {
    ttEngine.saveJSON(ttEngine.HISTORY_FILE, history);
    rebuilt = ttEngine.rebuild();
  }
  res.json({ codes: results, truncated: log.length > 60, ingestedNewLegs: ingestedCount, totalHistoryRecords: history.length, totalPlayers: rebuilt ? Object.keys(rebuilt.players).length : undefined });
});

// Post-match review: real loss-by-loss diagnosis (sweep-bust vs close-miss for handicap,
// close-miss vs wide-miss for totals), plus the calibration state (predicted vs actual,
// per market, with the bounded self-correction currently in effect). Optional ?codes=A,B,C
// to scope to specific source codes; omit for all-time.
app.get("/api/tt/loss-analysis", requireAdmin, (req, res) => {
  if (!ttEngine) return res.status(503).json({ error: "Table Tennis engine unavailable" });
  const sourceCodes = req.query.codes ? String(req.query.codes).split(",").map(c => c.trim().toUpperCase()).filter(Boolean) : null;
  const analysis = ttEngine.analyzeLosses(sourceCodes);
  const calibration = ttEngine.loadJSON(ttEngine.CALIBRATION_FILE, { byMarket: {}, totalPredictionsLogged: 0 });
  res.json({ analysis, calibration });
});

// ── Global error handler (must be last middleware) ──

app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  const status = err.type === "entity.too.large" ? 413 : (err.status || 500);
  res.status(status).json({ error: status === 413 ? "Request body too large" : (err.message || "Server error") });
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
  if (gracefulShutdown.started) return;
  gracefulShutdown.started = true;
  clearInterval(_keepAliveTimer);
  clearInterval(_housekeepingTimer);
  for (const stop of shutdownTasks.splice(0)) { try { stop(); } catch {} }
  try { eventLoopDelay.disable(); } catch {}
  try { _mailer?.close(); } catch {}
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

// v8 §4 — Morning Readiness: optional auto-run. Off by default. When
// enabled, at the configured local time the server runs Daily Review on
// YESTERDAY's codes first (scoreboard + learning loop), waits for it to
// fully finish, THEN starts a fresh generator run — sequential, never
// concurrent, so there's no lock/stale-state race between the two. Checked
// every minute; a per-day marker stops it firing more than once even though
// the check runs every 60s and the target minute is a 60s-wide window.
let _lastAutoRunDate = null;
async function checkAutoRunSchedule() {
  if (!advancedGen) return;
  try {
    const settings = advancedGen.loadSettings();
    if (!settings.autoRunEnabled) return;
    const cfg = { ...advancedGen.DEFAULT_CONFIG, ...settings };
    const now = new Date();
    const [h, m] = now.toLocaleString('en-US', { timeZone: 'Africa/Lagos', hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    if (h !== cfg.autoRunHour || m !== cfg.autoRunMinute || _lastAutoRunDate === todayStr) return;
    _lastAutoRunDate = todayStr;
    console.log('[auto-run] Morning readiness triggered for', todayStr);
    const yesterday = new Date(now.getTime() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    try {
      await advancedGen.runDailyReview(yesterday, `http://127.0.0.1:${PORT}`, msg => console.log('[auto-run/daily-review]', msg));
      console.log('[auto-run] Daily review complete — starting generator run…');
    } catch (e) {
      console.error('[auto-run] daily review failed, starting run anyway:', e.message);
    }
    advancedGen.startRun({ mode: 'full', internalBaseUrl: `http://127.0.0.1:${PORT}`, config: {} });
  } catch (e) {
    console.error('[auto-run] check failed:', e.message);
  }
}

// v19 §1 — test-moonshot-floor.js existed since v11 but was only ever run
// manually, once, by hand — nothing stopped it from silently going stale
// again (it did, twice). This runs it for real on every server start, in a
// child process so a crash/hang in the test can't take the server down with
// it. On failure: never a silent log line — a impossible-to-miss banner,
// repeated every 5 minutes for as long as the process runs, so it can't get
// scrolled away and forgotten before anyone notices.
let _selfCheckFailed = false;
// v36 — test-conversion-safety.js added alongside test-moonshot-floor.js:
// same "run for real on every server start" rationale, guarding the
// REMOVE-risk-market conversion bypass found in the same forensic audit
// that produced this patch. Both run the same way — child process, so a
// crash/hang in either can't take the server down — and either failing
// trips the same persistent banner.
const SELF_CHECK_TESTS = [
  { file: 'test-moonshot-floor.js', label: 'odds-floor guards verified for every category (Moonshot/Lite/Mini, Tier 1, Tier 4, universal floor)' },
  { file: 'test-conversion-safety.js', label: 'REMOVE-risk market conversion/drop guards verified (no risky leg bypasses classification or slips into Max Builder unconverted)' },
  // v38 — output-architecture redesign: PUNTER_POOL/GLOBAL_POOL separation,
  // no-padding, and duplicate-ticket-discard guards verified on every start.
  { file: 'test-global-pool-architecture.js', label: 'PUNTER_POOL/GLOBAL_POOL separation verified (no multi-code ticket duplication, no dropped/unconverted leg in GLOBAL output, no near-duplicate global tickets)' },
];
function runStartupSelfChecks() {
  const { execFileSync } = require('child_process');
  let anyFailed = false;
  for (const { file, label } of SELF_CHECK_TESTS) {
    const testPath = path.join(__dirname, file);
    if (!fs.existsSync(testPath)) {
      console.error(`[self-check] ${file} not found — skipping (this should never happen in a real deploy).`);
      continue;
    }
    try {
      execFileSync(process.execPath, [testPath], { encoding: 'utf8', timeout: 30000 });
      console.log(`[self-check] ${file}: PASSED — ${label}.`);
    } catch (e) {
      anyFailed = true;
      const banner = '\n' + '!'.repeat(78) + '\n' +
        `!! SELF-CHECK FAILURE — ${file} FAILED on startup.\n` +
        '!! A generator safety guard has regressed. DO NOT TRUST GENERATOR OUTPUT\n' +
        `!! until this is fixed. Run \`node ${file}\` for full details.\n` +
        '!'.repeat(78) + '\n';
      console.error(banner);
      console.error((e.stdout || '').toString());
      console.error((e.stderr || e.message || '').toString());
      console.error(banner);
    }
  }
  _selfCheckFailed = anyFailed;
}

// ── Start ──

const server = app.listen(PORT, () => {
  console.log(`SlipPilot v8 running at http://localhost:${PORT}  build=${BUILD_VERSION}`);
  // A Themed Repost job runs in-memory (fire-and-forget, no worker process of
  // its own) — if the server restarts mid-job, the persisted "running" state
  // is now a lie: nothing is actually working on it anymore, and it would
  // otherwise sit there forever looking like it's still going. Mark it as an
  // honest error on every startup instead of leaving a stale "running" ghost.
  try {
    const trState = loadThemedRepostState();
    if (trState.current?.status === "running") {
      trState.current.status = "error";
      trState.current.error = "Interrupted by a server restart — please rebuild.";
      trState.current.finishedAt = new Date().toISOString();
      trState.history = [trState.current, ...(trState.history || [])].slice(0, 30);
      saveThemedRepostState(trState);
    }
  } catch {}
  if (!IS_PRODUCTION) runStartupSelfChecks();
  // Persistent, not one-shot: if it failed, keep the banner surfacing every
  // 5 minutes so it can never quietly scroll off and be forgotten — this is
  // exactly the failure mode ("fixed and verified live... broke silently")
  // this patch exists to close off.
  if (!IS_PRODUCTION) {
    const selfCheckJob = startNonOverlappingJob(async () => { if (_selfCheckFailed) runStartupSelfChecks(); }, 5 * 60 * 1000);
    shutdownTasks.push(() => selfCheckJob.stop());
  }
  const cleanupJob = startNonOverlappingJob(runDailyCleanup, 24 * 60 * 60 * 1000);
  const cleanupStart = setTimeout(() => cleanupJob.run(), 60000); cleanupStart.unref?.();
  const autoRunJob = startNonOverlappingJob(checkAutoRunSchedule, 60000);
  const metricsJob = startNonOverlappingJob(() => {
    const mem = process.memoryUsage();
    console.log(`[METRIC] rssMB=${(mem.rss / 1048576).toFixed(1)} heapMB=${(mem.heapUsed / 1048576).toFixed(1)} handles=${process._getActiveHandles().length} loopP95Ms=${(eventLoopDelay.percentile(95) / 1e6).toFixed(1)}`);
    eventLoopDelay.reset();
  }, 5 * 60 * 1000);
  shutdownTasks.push(() => { clearTimeout(cleanupStart); cleanupJob.stop(); autoRunJob.stop(); metricsJob.stop(); });
});

// Prevent slow clients from holding connections open indefinitely
server.keepAliveTimeout = 65000;   // must be > LiteSpeed/proxy's timeout
server.headersTimeout   = 70000;
server.requestTimeout   = 30000;
server.maxRequestsPerSocket = 1000;

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
