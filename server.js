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
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); } });
    }).on("error", reject);
  });
}
app.get("/api/booking/:code", async (req, res) => {
  const code = req.params.code.trim();
  if (!code) return res.status(400).json({ error: "Booking code required" });
  try {
    const json = await fetchJSON("https://www.sportybet.com/api/ng/orders/share/" + encodeURIComponent(code));
    if (!json || json.bizCode !== 10000 || !json.data) return res.status(404).json({ error: json?.message || "Not found" });
    const outcomes = json.data.outcomes || [];
    const selections = outcomes.map(o => {
      const mkt = o.markets && o.markets[0] ? o.markets[0] : {};
      const oc = mkt.outcomes && mkt.outcomes[0] ? mkt.outcomes[0] : {};
      return { eventId: o.eventId || "", homeTeam: o.homeTeamName || "", awayTeam: o.awayTeamName || "",
        sport: o.sport?.name || "", league: o.sport?.category?.tournament?.name || "",
        category: o.sport?.category?.name || "", market: mkt.desc || "", specifier: mkt.specifier || "",
        outcome: oc.desc || "", odds: parseFloat(oc.odds) || 0,
        kickoff: o.estimateStartTime ? new Date(Number(o.estimateStartTime)).toISOString() : "",
        matchStatus: o.matchStatus || "" };
    });
    res.json({ shareCode: json.data.shareCode || code, selections, totalOdds: Math.round(selections.reduce((a,s) => a*s.odds, 1) * 100) / 100 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/markets/:eventId", async (req, res) => {
  const eventId = req.params.eventId;
  try {
    const json = await fetchJSON("https://www.sportybet.com/api/ng/factsCenter/event?eventId=" + encodeURIComponent(eventId));
    if (!json || json.bizCode !== 10000 || !json.data) return res.status(404).json({ error: "Event not found" });
    const d = json.data;
    const safeId = eventId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    fs.writeFileSync(path.join(DEBUG_DIR, safeId + ".json"), JSON.stringify(d, null, 2));
    const allMarkets = (d.markets || []).flatMap(m => (m.outcomes || []).filter(o => o.isActive === 1).map(o => ({
      marketId: m.id, marketName: m.desc || "", specifier: m.specifier || "", group: m.group || "",
      outcomeId: o.id, outcomeName: o.desc || "", odds: parseFloat(o.odds) || 0 })));
    res.json({ eventId: d.eventId, homeTeam: d.homeTeamName || "", awayTeam: d.awayTeamName || "",
      sport: d.sport?.name || "", league: d.sport?.category?.tournament?.name || "",
      marketCount: (d.markets || []).length, outcomeCount: allMarkets.length, markets: allMarkets,
      debugFile: "debug/markets/" + safeId + ".json" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/debug/markets/:file", (req, res) => {
  const fp = path.join(DEBUG_DIR, req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "application/json"); fs.createReadStream(fp).pipe(res);
});
app.listen(PORT, () => console.log("Running at http://localhost:" + PORT));
