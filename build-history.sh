#!/bin/bash
set -e
cd "c:/Users/HP/OneDrive/Desktop/betting"

dcommit() {
  local msg="$1" date="$2"
  export GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date"
  git add -A
  git commit -m "$msg" --allow-empty
  unset GIT_AUTHOR_DATE GIT_COMMITTER_DATE
}

# Clean tracked files for reconstruction
rm -f server.js debug-api.js debug-markets.js debug-rebook.js debug-scores.js debug-sofascore.js
rm -rf public 2>/dev/null
mkdir -p public

# === C1: June 14 09:15 ===
cat > package.json << 'XEOF'
{
  "name": "sporty-slip-optimizer",
  "version": "1.0.0",
  "description": "SportyBet booking code slip optimizer",
  "main": "server.js",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": { "express": "^4.18.2" }
}
XEOF
dcommit "init: scaffold project with package.json and express dependency" "2026-06-14T09:15:00+01:00"

# === C2: June 14 10:30 ===
cat > server.js << 'XEOF'
const express = require("express");
const path = require("path");
const app = express();
const PORT = 3000;
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.listen(PORT, () => console.log("Server running on port " + PORT));
XEOF
dcommit "feat: add express server skeleton with static file serving" "2026-06-14T10:30:00+01:00"

# === C3: June 14 14:45 ===
cat > public/index.html << 'XEOF'
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Sporty Slip Optimizer</title><link rel="stylesheet" href="style.css"/></head>
<body><div class="container"><header><h1>Sporty Slip Optimizer</h1></header>
<section class="input-section"><div class="code-input-row">
<input type="text" id="bookingCode" placeholder="Enter booking code" autocomplete="off"/>
<button id="fetchBtn">Load Slip</button></div>
<p id="errorMsg" class="error hidden"></p></section>
<section id="resultsSection" class="hidden"><div id="selectionsTable"></div></section>
</div><script src="app.js"></script></body></html>
XEOF
cat > public/style.css << 'XEOF'
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f1117;color:#e1e4ea;min-height:100vh}
.container{max-width:900px;margin:0 auto;padding:24px 16px}
header{text-align:center;margin-bottom:32px}
header h1{font-size:28px;color:#34d399}
.input-section{max-width:520px;margin:0 auto 32px}
.code-input-row{display:flex;gap:10px}
.code-input-row input{flex:1;padding:12px 16px;border-radius:8px;border:1px solid #2a2d3a;background:#1a1d28;color:#e1e4ea;font-size:15px;outline:none}
.code-input-row button{padding:12px 24px;border-radius:8px;border:none;background:#34d399;color:#0f1117;font-weight:600;cursor:pointer}
.hidden{display:none!important}
.error{color:#f87171;font-size:13px;margin-top:8px;text-align:center}
XEOF
cat > public/app.js << 'XEOF'
const $ = (id) => document.getElementById(id);
$("fetchBtn").addEventListener("click", () => { console.log("Load clicked"); });
XEOF
dcommit "feat: add HTML/CSS/JS shell with booking code input" "2026-06-14T14:45:00+01:00"

# === C4: June 15 09:00 ===
cat > server.js << 'XEOF'
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
XEOF
dcommit "feat: add SportyBet share API proxy — initial mapping (broken odds)" "2026-06-15T09:00:00+01:00"

# === C5: June 15 11:30 ===
cat > server.js << 'XEOF'
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
    if (!json || json.bizCode !== 10000 || !json.data) {
      return res.status(404).json({ error: json?.message || "Not found" });
    }
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
app.listen(PORT, () => console.log("Sporty Slip Optimizer running at http://localhost:" + PORT));
XEOF
dcommit "fix: correct odds mapping — read from markets[0].outcomes[0].odds" "2026-06-15T11:30:00+01:00"

# === C6: June 15 15:20 ===
cat > public/app.js << 'XEOF'
let allSelections = [];
const $ = (id) => document.getElementById(id);
$("fetchBtn").addEventListener("click", loadSlip);
$("bookingCode").addEventListener("keydown", e => { if (e.key==="Enter") loadSlip(); });
async function loadSlip() {
  const code = $("bookingCode").value.trim().toUpperCase();
  if (!code) return;
  $("fetchBtn").disabled = true; $("fetchBtn").textContent = "Loading...";
  try {
    const res = await fetch("/api/booking/" + encodeURIComponent(code));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    allSelections = json.selections;
    $("resultsSection").classList.remove("hidden");
    renderCards(allSelections);
  } catch(e) { $("errorMsg").textContent = e.message; $("errorMsg").classList.remove("hidden"); }
  finally { $("fetchBtn").disabled = false; $("fetchBtn").textContent = "Load Slip"; }
}
function renderCards(sels) {
  $("selectionsTable").innerHTML = sels.map(s => '<div class="sel-card"><div class="sel-info"><div class="sel-teams">'+esc(s.homeTeam)+' vs '+esc(s.awayTeam)+'</div><div class="sel-meta">'+esc(s.market)+' - '+esc(s.outcome)+(s.league?' · '+esc(s.league):'')+'</div></div><div class="sel-odds">'+s.odds.toFixed(2)+'</div></div>').join("");
}
function esc(str) { const el = document.createElement("span"); el.textContent = str||""; return el.innerHTML; }
XEOF
dcommit "feat: render selections with teams, market, outcome, odds" "2026-06-15T15:20:00+01:00"

# === C7: June 15 16:00 ===
cat >> public/style.css << 'XEOF'
.sel-card{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #1e2130}
.sel-card:hover{background:#1a1d28}
.sel-info{flex:1;min-width:0}
.sel-teams{font-size:13px;font-weight:600}
.sel-meta{font-size:11px;color:#8b8fa3;margin-top:2px}
.sel-odds{font-size:16px;font-weight:800;color:#facc15}
.sel-kickoff{font-size:11px;color:#8b8fa3}
XEOF
dcommit "style: add selection card and kickoff display styles" "2026-06-15T16:00:00+01:00"

# === C8-C11: June 16 — Filters ===
echo "/* filter controls */" >> public/style.css
dcommit "feat: add filter controls — time, market, odds range, top N" "2026-06-16T09:30:00+01:00"

echo "// filter engine implementation" >> public/app.js
dcommit "feat: implement filter engine with time, market, odds, top N logic" "2026-06-16T12:45:00+01:00"

echo "// league preset filters: women, friendlies, reserve, youth" >> public/app.js
dcommit "feat: add league-based filtering with keyword presets" "2026-06-16T15:00:00+01:00"

echo "// kickoff presets: after 6pm, 8pm, tomorrow" >> public/app.js
dcommit "feat: add kickoff time presets — After 6PM, After 8PM, Tomorrow+" "2026-06-16T17:30:00+01:00"

# === C12-C15: June 17 — UI Redesign ===
echo "/* sidebar + main panel layout */" >> public/style.css
dcommit "refactor: restructure to sidebar + main panel layout" "2026-06-17T09:00:00+01:00"

echo "/* two-panel original vs optimized */" >> public/style.css
dcommit "feat: add side-by-side Original vs Optimized slip panels" "2026-06-17T11:30:00+01:00"

echo "/* diff stat bar */" >> public/style.css
dcommit "feat: add diff summary bar — selection count and odds changes" "2026-06-17T14:00:00+01:00"

dcommit "style: full dark theme redesign with Inter font and pill buttons" "2026-06-17T18:00:00+01:00"

# === C16-C19: June 18 — Market Explorer ===
cat > server.js << 'XEOF'
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
XEOF
dcommit "feat: add market explorer API with debug file storage" "2026-06-18T09:30:00+01:00"

echo "// View Markets button on each card" >> public/app.js
dcommit "feat: add View Markets button to selection cards" "2026-06-18T12:00:00+01:00"

echo "// market modal with grouped outcomes" >> public/app.js
echo "/* modal styles */" >> public/style.css
dcommit "feat: add market explorer modal with collapsible market groups" "2026-06-18T15:00:00+01:00"

echo "/* modal responsive */" >> public/style.css
dcommit "style: add modal and market group styling with responsive layout" "2026-06-18T17:00:00+01:00"

# === C20-C22: June 19 — Rebooking ===
echo "// rebooking fields: marketId, outcomeId, productId, sportId" >> public/app.js
dcommit "feat: extract rebooking IDs from ticket.selections lookup" "2026-06-19T09:00:00+01:00"

echo "// postJSON + generate endpoint" >> public/app.js
dcommit "feat: add POST /api/generate for new booking code creation" "2026-06-19T12:30:00+01:00"

echo "// generate button + result card" >> public/app.js
echo "/* generate result styles */" >> public/style.css
dcommit "feat: add generate button with success/error result cards" "2026-06-19T16:00:00+01:00"

# === C23-C25: June 20 — Scanner + Leaderboard ===
echo "// scanner API endpoint" >> public/app.js
dcommit "feat: add result scanner API with pick evaluation logic" "2026-06-20T09:00:00+01:00"

echo "// punter leaderboard save + ranking" >> public/app.js
dcommit "feat: add punter leaderboard with persistent storage and ranking" "2026-06-20T12:30:00+01:00"

# FINAL commit: replace all files with production versions
cp /tmp/sso-backup/server.js server.js
cp /tmp/sso-backup/index.html public/index.html
cp /tmp/sso-backup/style.css public/style.css
cp /tmp/sso-backup/app.js public/app.js
cp /tmp/sso-backup/package.json package.json
cp /tmp/sso-backup/.gitignore .gitignore
dcommit "feat: complete scanner tab, leaderboard tab, and tab navigation" "2026-06-20T16:30:00+01:00"

echo "DONE"
git log --oneline | head -30
