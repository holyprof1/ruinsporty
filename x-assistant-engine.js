// x-assistant-engine.js — X-specific adapter over intent-engine.js
// No LLM anywhere in this file or its dependencies. Deterministic only.
// Reuses existing SlipPilot endpoints (booking, scan, generate, markets, score-selections)
// via loopback calls, same pattern as session-engine.js. No business logic duplicated.

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const intentEngine = require("./intent-engine");

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "x-assistant-history.json");
const PORT = 3000;
const ADMIN_KEY = process.env.ADMIN_PASSWORD || "";

// ── Loopback HTTP to the running SlipPilot server (reuses Scanner/Optimizer/Converter — never duplicated) ──
function get(p) {
  return new Promise((ok, fail) => {
    http.get("http://localhost:" + PORT + p, { headers: { "x-admin-password": ADMIN_KEY } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json: " + p)); } });
    }).on("error", fail);
  });
}
function post(p, body) {
  return new Promise((ok, fail) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: "localhost", port: PORT, path: p, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "x-admin-password": ADMIN_KEY } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { ok(JSON.parse(d)); } catch { fail(new Error("bad json POST " + p)); } }); }
    );
    req.on("error", fail); req.write(payload); req.end();
  });
}

// Dependencies injected into the channel-agnostic intent engine
const engineDeps = {
  scoreSelections: (selections) => post("/api/score-selections", { selections }),
  getEventMarkets: (eventId) => get("/api/markets/" + encodeURIComponent(eventId)),
};

// ── History store ──
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")); } catch { return []; }
}
function saveHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(-300), null, 2));
}
function appendHistory(entry) {
  const list = loadHistory();
  list.push(entry);
  saveHistory(list);
  return entry;
}

// ── Tweet text fetch via public oEmbed (no auth needed, never crashes) ──
function fetchTweetText(tweetUrl) {
  return new Promise((resolve) => {
    const oembedUrl = "https://publish.twitter.com/oembed?omit_script=true&url=" + encodeURIComponent(tweetUrl);
    https.get(oembedUrl, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.html) return resolve({ success: false });
          const firstP = json.html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          let text = firstP ? firstP[1] : json.html;
          text = text
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .trim();
          resolve({ success: true, text, author: json.author_name || "" });
        } catch { resolve({ success: false }); }
      });
    }).on("error", () => resolve({ success: false }))
      .on("timeout", function () { this.destroy(); resolve({ success: false }); });
  });
}

// ── Booking code detection: regex candidates validated against the real Scanner (deterministic) ──
const STOPWORDS = new Set(["ABOUT","THANKS","PLEASE","TODAY","GAMES","GOALS","THINK","MAKE","THESE","THOSE",
  "BEFORE","AFTER","LEAGUE","THINGS","REMOVE","THANK","GREAT","REALLY","SAFER","RISKY","THREE","SEVEN",
  "EIGHT","BRAZIL","ARSENAL","TOMORROW","TONIGHT","MATCHES","MARKET","MARKETS","CONFIDENCE","OPTIMIZE",
  "SWEDEN","REBUILD","IMPROVE","REPLACE","BOOKING","SCANNER","VERIFY","STATUS"]);

async function detectBookingCode(text) {
  if (!text) return null;
  const candidates = [...new Set((text.match(/\b[A-Za-z0-9]{5,9}\b/g) || []).map((c) => c.toUpperCase()))]
    .filter((c) => !STOPWORDS.has(c));
  for (const code of candidates) {
    try {
      const result = await get("/api/booking/" + encodeURIComponent(code));
      if (result && !result.error && result.selections) return { code, booking: result };
    } catch {}
  }
  return null;
}

// ── Main orchestrator ──
async function analyze({ tweetUrl, tweetText }) {
  const warnings = [];
  let text = tweetText || "";
  let author = "";

  if (tweetUrl && !tweetText) {
    const fetched = await fetchTweetText(tweetUrl);
    if (fetched.success) { text = fetched.text; author = fetched.author; }
    else return { needsManualText: true, tweetUrl, warnings: ["Couldn't auto-fetch that tweet — paste the tweet text instead."] };
  }

  if (!text.trim()) return { needsManualText: true, tweetUrl, warnings: ["No text to work with — paste the tweet text."] };

  const detected = await detectBookingCode(text);
  const intent = intentEngine.parseIntent(text);

  const result = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    tweetUrl: tweetUrl || null,
    tweetText: text,
    author,
    detectedCode: detected?.code || null,
    intentSummary: intent.summary || "",
    actionsRequested: intent.actions || [],
    actionsPerformed: [],
    oldOdds: null,
    newOdds: null,
    newBookingCode: null,
    confidence: null,
    warnings,
    scan: null,
    reply: null,
    firstReply: null,
  };

  if (!detected) {
    result.warnings.push("No valid SportyBet booking code detected in the text.");
  } else if (intent.isScanRequest || ((intent.actions || []).length === 0 && !intent.isExplainRequest)) {
    result.intentSummary = "Scan/verify this ticket";
    try {
      const scan = await get("/api/scan/" + encodeURIComponent(detected.code));
      result.scan = scan;
      result.oldOdds = detected.booking.totalOdds;
    } catch (e) { result.warnings.push("Scan failed: " + e.message); }
  } else if (intent.isExplainRequest) {
    result.oldOdds = detected.booking.totalOdds;
    result.scan = { total: detected.booking.selections.length };
  } else {
    result.oldOdds = detected.booking.totalOdds;
    const originalCount = detected.booking.selections.length;
    try {
      const newSels = await intentEngine.applyActions(detected.booking.selections, intent.actions, warnings, engineDeps);
      result.actionsPerformed = intent.actions;
      if (newSels.length > 0) {
        const gen = await post("/api/generate", { selections: newSels });
        if (gen.success) {
          result.newBookingCode = gen.shareCode;
          result.newOdds = Math.round(newSels.reduce((acc, s) => acc * (s.originalOdds || s.odds || 1), 1) * 100) / 100;
          result.removedCount = Math.max(0, originalCount - newSels.length);
        } else {
          result.warnings.push("Could not generate new booking code: " + (gen.error || "unknown error"));
        }
        try {
          const scored = await post("/api/score-selections", { selections: newSels });
          if (scored?.success) result.confidence = Math.round(scored.selections.reduce((a, s) => a + s.score, 0) / scored.selections.length);
        } catch {}
      } else {
        result.warnings.push("All selections were removed by the requested changes — nothing to rebuild.");
      }
    } catch (e) {
      result.warnings.push("Optimization failed: " + e.message);
    }
  }

  const { reply, firstReply } = intentEngine.buildReply({
    detectedCode: result.detectedCode,
    actionsPerformed: result.actionsPerformed,
    scan: result.scan,
    oldOdds: result.oldOdds,
    newOdds: result.newOdds,
    newBookingCode: result.newBookingCode,
    removedCount: result.removedCount || 0,
    warnings: result.warnings,
  });
  result.reply = reply;
  result.firstReply = firstReply;

  appendHistory(result);
  return result;
}

module.exports = { analyze, loadHistory };
