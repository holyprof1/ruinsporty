const http = require("http");
const fs = require("fs");

function get(p) {
  return new Promise((ok) => {
    http.get("http://localhost:3000" + p, { headers: { "x-admin-password": "HPfirstpJ" } }, r => {
      let d = ""; r.on("data", c => d += c);
      r.on("end", () => { try { ok({ s: r.statusCode, d: JSON.parse(d) }); } catch { ok({ s: r.statusCode, raw: d.slice(0, 200) }); } });
    }).on("error", e => ok({ s: 0, err: e.message }));
  });
}
function post(p, body) {
  return new Promise((ok) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: "localhost", port: 3000, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "x-admin-password": "HPfirstpJ" }
    }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => { try { ok({ s: r.statusCode, d: JSON.parse(d) }); } catch { ok({ s: r.statusCode, raw: d.slice(0, 200) }); } }); });
    req.on("error", e => ok({ s: 0, err: e.message })); req.write(payload); req.end();
  });
}

(async () => {
  console.log("====================================================");
  console.log("  SLIPPILOT PRE-DEPLOYMENT VERIFICATION");
  console.log("  " + new Date().toISOString());
  console.log("====================================================\n");

  const results = [];
  function t(name, pass, detail) {
    results.push({ name, pass });
    console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail && !pass ? " — " + detail : ""));
  }

  // Pages
  console.log("-- Page Loads --");
  for (const [name, path] of [["Homepage", "/"], ["Admin", "/admin"], ["Optimizer SEO", "/optimize-sportybet-slip"]]) {
    const r = await get(path);
    t(name, r.s === 200 || r.s === 302);
  }
  for (const [name, path] of [["Optimizer redirect", "/optimizer"], ["Scanner redirect", "/scanner"], ["Convert redirect", "/convert"], ["Merger redirect", "/merger"]]) {
    const r = await get(path);
    t(name, r.s === 200 || r.s === 302);
  }

  // Core APIs
  console.log("\n-- Core APIs --");
  let r;
  r = await get("/api/stats"); t("stats", r.s === 200 && r.d.slipsLoaded > 0);
  r = await get("/api/booking/GBVV9A"); t("booking", r.s === 200 && r.d.selections && r.d.selections.length > 0);
  r = await get("/api/page-locks"); t("page-locks", r.s === 200);
  r = await get("/api/header-inject"); t("header-inject", r.s === 200);
  r = await get("/api/usage"); t("usage", r.s === 200);

  // Leaderboard
  console.log("\n-- Leaderboard --");
  r = await get("/api/leaderboard"); t("leaderboard loads", r.s === 200 && r.d.total > 0);
  r = await get("/api/leaderboard?sort=trust&order=desc");
  t("sort by trust", r.d.leaderboard[0].trustScore >= r.d.leaderboard[1].trustScore);
  r = await get("/api/leaderboard?sort=wins&order=desc");
  t("sort by wins", (r.d.leaderboard[0].won || 0) >= (r.d.leaderboard[1].won || 0));
  r = await get("/api/leaderboard?sort=hitRate&order=desc");
  t("sort by hitRate", (r.d.leaderboard[0].hitRate || 0) >= (r.d.leaderboard[1].hitRate || 0));
  r = await get("/api/leaderboard?search=Princewill");
  t("search Princewill", r.d.total === 1 && r.d.leaderboard[0].punter === "Princewill");
  r = await get("/api/leaderboard");
  t("badges assigned", r.d.leaderboard.some(p => p.badges && p.badges.length > 0));
  t("trust scores present", r.d.leaderboard.some(p => p.trustScore > 0));
  t("win/loss present", r.d.leaderboard.some(p => (p.won || 0) > 0));
  t("code history present", r.d.leaderboard.some(p => p.codes && p.codes.length > 0));
  t("handle present", r.d.leaderboard.some(p => p.handle && p.handle.length > 0));
  t("consensusRate present", r.d.leaderboard.some(p => (p.consensusRate || 0) > 0));

  // Admin APIs
  console.log("\n-- Admin APIs --");
  r = await get("/api/punter-profiles"); t("punter-profiles", r.s === 200);
  r = await get("/api/generated-codes"); t("generated-codes", r.s === 200 && Object.keys(r.d).length > 0);
  r = await get("/api/admin/punter-codes"); t("punter-codes", r.s === 200 && Object.keys(r.d).length > 0);
  r = await get("/api/support"); t("support", r.s === 200);
  r = await get("/api/admin/visitors"); t("visitors", r.s === 200);
  r = await get("/api/admin/header-code"); t("header-code", r.s === 200);

  // Session
  console.log("\n-- Session --");
  r = await get("/api/session/today"); t("session-today", r.s === 200 && r.d.date !== undefined);
  r = await get("/api/session/history"); t("session-history", r.s === 200);
  r = await get("/api/session/status"); t("session-status", r.s === 200 && r.d.running === false);
  r = await get("/api/session/logs?since=0"); t("session-logs", r.s === 200);

  // Code tracking
  console.log("\n-- Code Tracking --");
  r = await get("/api/code-history"); t("code-history", r.s === 200 && r.d.total > 0);
  r = await get("/api/weak-matches"); t("weak-matches", r.s === 200);

  // User submissions
  console.log("\n-- User Submissions --");
  r = await post("/api/submit-code", { code: "QAFINAL", punter: "QA Final Test" });
  t("submit-code POST", r.d && r.d.success === true);
  r = await get("/api/admin/submissions");
  t("submissions GET", r.s === 200 && r.d.total > 0);
  const hasQAEntry = r.d.recent && r.d.recent.some(s => s.code === "QAFINAL");
  t("submission persisted", hasQAEntry);

  // Data persistence
  console.log("\n-- Data Persistence After Clean Restart --");
  const checks = [
    ["code-history.json", f => JSON.parse(f).length > 0],
    ["session-today.json", f => !!JSON.parse(f).date],
    ["leaderboard.json", f => { const j = JSON.parse(f); return j.length > 0 && j.some(p => p.trustScore > 0); }],
    ["generated-codes.json", f => Object.keys(JSON.parse(f)).length > 0],
    ["punter-profiles.json", f => Object.keys(JSON.parse(f)).length > 0],
    ["punter-codes.json", f => Object.keys(JSON.parse(f)).length > 0],
    ["weak-matches.json", f => Object.keys(JSON.parse(f)).length > 0],
    ["stats.json", f => Object.keys(JSON.parse(f)).length > 0],
  ];
  for (const [file, check] of checks) {
    try {
      const c = fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/data/" + file, "utf-8");
      t(file, check(c));
    } catch (e) { t(file, false, e.message.slice(0, 50)); }
  }

  // JS syntax
  console.log("\n-- JS Syntax --");
  const adminHtml = fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/public/admin.html", "utf-8");
  const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
  try { new Function(scriptMatch[1]); t("admin.html JS", true); } catch (e) { t("admin.html JS", false, e.message); }

  const appJs = fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/public/app.js", "utf-8");
  try { new Function(appJs); t("app.js", true); } catch (e) { t("app.js", false, e.message); }

  const idxHtml = fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/public/index.html", "utf-8");
  const inlines = idxHtml.match(/<script>([^<]+)<\/script>/g) || [];
  let ok = true;
  for (const s of inlines) { try { new Function(s.replace(/<\/?script>/g, "")); } catch { ok = false; } }
  t("index.html inline scripts", ok);

  // Module load
  try { require("./session-engine"); t("session-engine.js loads", true); } catch (e) { t("session-engine.js loads", false, e.message); }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log("\n====================================================");
  console.log("  RESULT: " + passed + "/" + results.length + " PASSED" + (failed ? ", " + failed + " FAILED" : ""));
  if (failed) {
    console.log("  FAILURES:");
    results.filter(r => !r.pass).forEach(r => console.log("    x " + r.name));
  } else {
    console.log("  ALL CLEAR — PRODUCTION SAFE");
  }
  console.log("====================================================");

  // Detailed audit
  console.log("\n-- Code Count Audit --");
  const ch = JSON.parse(fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/data/code-history.json", "utf-8"));
  console.log("code-history.json: " + ch.length + " codes");
  const gc = JSON.parse(fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/data/generated-codes.json", "utf-8"));
  console.log("generated-codes.json: " + Object.values(gc).flat().filter(c => c && c.code).length + " codes");
  const gt = JSON.parse(fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/data/generated-today.json", "utf-8"));
  console.log("generated-today.json: " + Object.values(gt.groups || {}).flat().filter(c => c.code).length + " codes");
  const st = JSON.parse(fs.readFileSync("c:/Users/HP/OneDrive/Desktop/betting/data/session-today.json", "utf-8"));
  console.log("session-today.json: " + Object.values(st.groups || {}).flat().filter(c => c.code).length + " codes");
})();
