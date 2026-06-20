const express = require("express");
const https = require("https");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

const DEBUG_DIR = path.join(__dirname, "debug", "markets");
fs.mkdirSync(DEBUG_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

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
            reject(new Error("Invalid JSON from SportyBet"));
          }
        });
      })
      .on("error", reject);
  });
}

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
    const ticketSelections = json.data.ticket?.selections || [];

    // Build a lookup from the ticket selections for rebooking fields
    const ticketMap = new Map();
    ticketSelections.forEach((ts) => ticketMap.set(ts.eventId, ts));

    const selections = outcomes.map((o) => {
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
      };
    });

    const totalOdds = selections.reduce((acc, s) => acc * s.odds, 1);

    res.json({
      shareCode: json.data.shareCode || code,
      selections,
      totalOdds: Math.round(totalOdds * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch booking" });
  }
});

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
            reject(new Error("Invalid JSON from SportyBet POST"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

app.post("/api/generate", async (req, res) => {
  const { selections } = req.body;
  if (!selections || !Array.isArray(selections) || selections.length === 0) {
    return res.status(400).json({ error: "No selections provided" });
  }

  // Build the payload matching SportyBet's expected format
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

  const attempts = [
    { label: "Shape A: { selections }", body: { selections: payload } },
  ];

  for (const attempt of attempts) {
    try {
      console.log(`[Generate] Trying ${attempt.label}`);
      console.log("[Generate] POST body:", JSON.stringify(attempt.body).slice(0, 500));

      const json = await postJSON(
        "https://www.sportybet.com/api/ng/orders/share",
        attempt.body
      );

      console.log("[Generate] Response:", JSON.stringify(json).slice(0, 500));

      if (json.bizCode === 10000 && json.data?.shareCode) {
        return res.json({
          success: true,
          shareCode: json.data.shareCode,
          shareURL: json.data.shareURL || "",
          selectionsCount: payload.length,
        });
      }

      // If this shape failed, log and return the error
      return res.status(400).json({
        success: false,
        error: json.message || json.innerMsg || "Unknown error",
        bizCode: json.bizCode,
        rawResponse: json,
        attemptedPayload: attempt.body,
      });
    } catch (err) {
      console.error(`[Generate] ${attempt.label} error:`, err.message);
      return res.status(500).json({
        success: false,
        error: err.message,
        attemptedPayload: attempt.body,
      });
    }
  }
});

app.get("/api/markets/:eventId", async (req, res) => {
  const eventId = req.params.eventId;
  if (!eventId) return res.status(400).json({ error: "eventId required" });

  try {
    const url = `https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(eventId)}`;
    const json = await fetchJSON(url);

    if (!json || json.bizCode !== 10000 || !json.data) {
      const msg = json?.message || "Event not found";
      return res.status(404).json({ error: msg });
    }

    const d = json.data;

    // Save raw response to debug/markets/
    const safeId = eventId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const debugPath = path.join(DEBUG_DIR, `${safeId}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(json.data, null, 2));

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
      league: d.sport?.category?.tournament?.name || "",
      marketCount: (d.markets || []).length,
      outcomeCount: allMarkets.length,
      markets: allMarkets,
      debugFile: `debug/markets/${safeId}.json`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch markets" });
  }
});

app.get("/debug/markets/:file", (req, res) => {
  const filePath = path.join(DEBUG_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "application/json");
  fs.createReadStream(filePath).pipe(res);
});

// ── Result Scanner ──

const PUNTERS_FILE = path.join(__dirname, "data", "punters.json");
fs.mkdirSync(path.dirname(PUNTERS_FILE), { recursive: true });

function loadPunters() {
  try { return JSON.parse(fs.readFileSync(PUNTERS_FILE, "utf-8")); }
  catch { return []; }
}

function savePunters(data) {
  fs.writeFileSync(PUNTERS_FILE, JSON.stringify(data, null, 2));
}

function evaluatePick(outcome, market, score, matchStatus) {
  if (matchStatus !== "Ended") return "PENDING";

  const oc = outcome || {};
  if (oc.isWinning === 1) return "WON";
  if (oc.refundFactor === 1) return "VOID";
  if (oc.isWinning === 0) return "LOST";

  return "PENDING";
}

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
    const results = outcomes.map((o) => {
      const mkt = o.markets && o.markets[0] ? o.markets[0] : {};
      const oc = mkt.outcomes && mkt.outcomes[0] ? mkt.outcomes[0] : {};
      const score = o.setScore || null;
      const verdict = evaluatePick(oc, mkt, score, o.matchStatus);

      return {
        eventId: o.eventId || "",
        homeTeam: o.homeTeamName || "",
        awayTeam: o.awayTeamName || "",
        sport: o.sport?.name || "",
        league: o.sport?.category?.tournament?.name || "",
        category: o.sport?.category?.name || "",
        market: mkt.desc || "",
        outcome: oc.desc || "",
        odds: parseFloat(oc.odds) || 0,
        kickoff: o.estimateStartTime
          ? new Date(Number(o.estimateStartTime)).toISOString()
          : "",
        matchStatus: o.matchStatus || "",
        score,
        halfScores: o.gameScore || [],
        verdict,
      };
    });

    const won = results.filter((r) => r.verdict === "WON").length;
    const lost = results.filter((r) => r.verdict === "LOST").length;
    const voided = results.filter((r) => r.verdict === "VOID").length;
    const pending = results.filter((r) => r.verdict === "PENDING").length;
    const settled = won + lost;
    const hitRate = settled > 0 ? Math.round((won / settled) * 100) : 0;

    res.json({
      shareCode: json.data.shareCode || code,
      total: results.length,
      won,
      lost,
      void: voided,
      pending,
      hitRate,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to scan" });
  }
});

app.post("/api/scan/:code/manual", (req, res) => {
  const { eventId, verdict } = req.body;
  if (!eventId || !["WON", "LOST", "VOID"].includes(verdict)) {
    return res.status(400).json({ error: "eventId and verdict (WON/LOST/VOID) required" });
  }
  // Manual overrides are handled client-side; this endpoint is a placeholder
  res.json({ success: true, eventId, verdict });
});

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

  // Check if this code already saved for this punter
  const existing = punters.find((p) => p.name === name);
  const slip = {
    code,
    date: new Date().toISOString(),
    total: results.length,
    won,
    lost,
    void: voided,
    hitRate: settled > 0 ? Math.round((won / settled) * 100) : 0,
  };

  if (existing) {
    if (!existing.slips.some((s) => s.code === code)) {
      existing.slips.push(slip);
    }
  } else {
    punters.push({ name, slips: [slip] });
  }

  savePunters(punters);
  res.json({ success: true });
});

app.get("/api/punters", (req, res) => {
  const punters = loadPunters();

  const leaderboard = punters.map((p) => {
    const totalWon = p.slips.reduce((a, s) => a + s.won, 0);
    const totalLost = p.slips.reduce((a, s) => a + s.lost, 0);
    const totalVoid = p.slips.reduce((a, s) => a + s.void, 0);
    const totalGames = p.slips.reduce((a, s) => a + s.total, 0);
    const settled = totalWon + totalLost;

    return {
      name: p.name,
      slips: p.slips.length,
      totalGames,
      won: totalWon,
      lost: totalLost,
      void: totalVoid,
      hitRate: settled > 0 ? Math.round((totalWon / settled) * 100) : 0,
    };
  }).sort((a, b) => b.hitRate - a.hitRate || b.won - a.won);

  res.json({ leaderboard });
});

app.listen(PORT, () => {
  console.log(`Sporty Slip Optimizer running at http://localhost:${PORT}`);
});
