const express = require("express");
const https = require("https");
const path = require("path");
const app = express();
const PORT = 3000;
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
    if (!json || json.bizCode !== 10000 || !json.data) return res.status(404).json({ error: "Code not found" });
    const outcomes = json.data.outcomes || [];
    const selections = outcomes.map(o => {
      const mkt = o.markets?.[0] || {}; const oc = mkt.outcomes?.[0] || {};
      return { eventId: o.eventId, homeTeam: o.homeTeamName, awayTeam: o.awayTeamName,
        market: o.marketName || "", outcome: o.outcomeName || "", odds: parseFloat(o.odds) || 0,
        kickoff: o.estimateStartTime ? new Date(Number(o.estimateStartTime)).toISOString() : "" };
    });
    res.json({ shareCode: json.data.shareCode || code, selections, totalOdds: selections.reduce((a,s) => a*s.odds, 1) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.listen(PORT, () => console.log("Running on port " + PORT));
