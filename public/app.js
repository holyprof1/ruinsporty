/* SlipPilot */
let allSelections = [];
let originalSelections = [];
let filtered = [];
let changedEventIds = new Set();
let isAdmin = false;
const $ = (id) => document.getElementById(id);

// ── Nav ──
function showHomepage() {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"));
  $("homepage").classList.add("active");
  loadLiveStats();
}
function activateTab(tab) {
  $("homepage").classList.remove("active");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"));
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add("active");
  const pg = $(`tab-${tab}`);
  if (pg) pg.classList.add("active");
  if (tab === "leaderboard") loadLeaderboard();
}
function getSharedPunterName() {
  const match = location.pathname.match(/^\/punter\/([^/]+)/);
  return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : "";
}
$("logoBtn").addEventListener("click", showHomepage);
document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => activateTab(b.dataset.tab)));
document.querySelectorAll("[data-goto]").forEach(el => el.addEventListener("click", () => activateTab(el.dataset.goto)));
$("heroLoadBtn").addEventListener("click", () => { const c = $("heroCode").value.trim().toUpperCase(); if (!c) return; $("bookingCode").value = c; activateTab("optimizer"); loadSlip(); });
$("heroCode").addEventListener("keydown", e => { if (e.key === "Enter") $("heroLoadBtn").click(); });

// close filter dropdowns on outside click
document.addEventListener("click", e => {
  if (!e.target.closest(".filter-pill")) document.querySelectorAll(".filter-pill.open").forEach(p => p.classList.remove("open"));
});

// ── Animated count-up ──
function animateNum(el, target) {
  const start = Math.floor(target * 0.9);
  const dur = 1500;
  const t0 = performance.now();
  const fmt = n => n.toLocaleString("en-US");
  el.textContent = fmt(start);
  function tick(now) {
    const p = Math.min((now - t0) / dur, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.floor(start + (target - start) * ease));
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function loadLiveStats() {
  try {
    const r = await fetch("/api/stats"); const s = await r.json();
    animateNum($("statLoaded"), s.slipsLoaded || 0);
    animateNum($("statGenerated"), s.codesGenerated || 0);
    animateNum($("statScanned"), s.slipsScanned || 0);
    animateNum($("statPunters"), s.puntersTracked || s.puntersSaved || 0);
  } catch {}
}
loadLiveStats();

// ── Utils ──
function esc(s) { const e = document.createElement("span"); e.textContent = s || ""; return e.innerHTML; }
function jsArg(value) { return esc(JSON.stringify(String(value || ""))); }
function attr(value) { return esc(value).replace(/"/g, "&quot;"); }
function fmtKickoff(iso) { if (!iso) return "--"; const d = new Date(iso); if (isNaN(d)) return "--"; return d.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})+" "+d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}); }
function showToast(msg, type) { const t = document.createElement("div"); t.className = "toast toast-"+(type||"info"); t.textContent = msg; document.body.appendChild(t); requestAnimationFrame(() => t.classList.add("show")); setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2000); }
function copyToClipboard(text, btn) { navigator.clipboard.writeText(text).then(() => { if (btn) { const o = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => btn.textContent = o, 1500); } showToast("Copied!", "success"); }); }
function showErr(id, msg) { $(id).textContent = msg; $(id).classList.toggle("hidden", !msg); }

function renderGenResult(elId, json, kept) {
  const el = $(elId); el.classList.remove("hidden");
  if (json.success && json.shareCode) {
    const odds = kept.reduce((a,s) => a*s.odds, 1);
    el.innerHTML = `<div class="gen-success"><div class="gen-label">New Booking Code</div><div class="gen-code-row"><span class="gen-code mono">${esc(json.shareCode)}</span><button class="btn btn-ghost btn-copy" onclick="copyToClipboard(${jsArg(json.shareCode)},this)">Copy</button></div><div class="gen-details"><span>${kept.length} selections</span><span>Odds: ${odds.toFixed(2)}</span></div></div>`;
    showToast("Code: " + json.shareCode, "success");
  } else {
    el.innerHTML = `<div class="gen-error"><div class="gen-label">Failed</div><div class="gen-error-msg">${esc(json.error||"Unknown")}</div><details class="gen-debug"><summary>Debug</summary><pre>${esc(JSON.stringify(json,null,2))}</pre></details></div>`;
  }
}

function cardHtml(s, opts) {
  const rm = opts?.removed;
  const original = originalSelections.find(o => o.eventId === s.eventId);
  const changed = !rm && original && (original.marketId !== s.marketId || original.outcomeId !== s.outcomeId || original.specifier !== s.specifier);
  const meta = changed
    ? `<span class="sel-market">${esc(original.market)}</span> ${esc(original.outcome)} <span class="change-arrow">-&gt;</span> <span class="sel-market">${esc(s.market)}</span> ${esc(s.outcome)}`
    : `<span class="sel-market">${esc(s.market)}</span> — ${esc(s.outcome)}${s.league?" · "+esc(s.league):""}`;
  let btns = "";
  if (opts?.actions) btns = `<button class="btn-sm btn-stats" onclick="openH2H(${jsArg(s.eventId)},${jsArg(s.homeTeam)},${jsArg(s.awayTeam)})">Stats</button><button class="btn-sm btn-optimize" onclick="optimizePick(${jsArg(s.eventId)})">Optimize</button><button class="btn-sm btn-markets" onclick="openMarkets(${jsArg(s.eventId)})">Markets</button>`;
  if (opts?.removable) btns = `<button class="btn-rm-code" onclick="removeMergerGame(${jsArg(s.eventId)})">&times;</button>`;
  if (opts?.splitterRemovable) btns = `<button class="btn-rm-code" onclick="removeSplitterGame(${jsArg(s.eventId)})">&times;</button>`;
  return `<div class="sel-card ${rm?"removed-card":""} ${changed?"changed-card":""}"><div class="sel-info"><div class="sel-teams">${esc(s.homeTeam)} vs ${esc(s.awayTeam)}</div><div class="sel-meta">${meta}</div></div><span class="sel-odds">${Number(s.odds || 0).toFixed(2)}</span><span class="sel-kickoff">${fmtKickoff(s.kickoff)}</span>${btns}</div>`;
}
function renderCards(sels, opts) { return sels.map(s => cardHtml(s, opts)).join(""); }
function genPayload(sels) { return sels.map(s => ({eventId:s.eventId,marketId:s.marketId,outcomeId:s.outcomeId,specifier:s.specifier,productId:s.productId,sportId:s.sportId})); }

// ── Stance Selector ──
document.querySelectorAll(".stance-card").forEach(c => {
  c.addEventListener("click", () => {
    document.querySelectorAll(".stance-card").forEach(x => x.classList.remove("active"));
    c.classList.add("active");
    const stance = c.dataset.stance;
    resetFilters();
    if (stance === "safe") { const b = document.querySelector('.preset[data-action="top-10"]'); if (b) { b.classList.add("active"); applyFilters(); } }
    else if (stance === "balanced") { $("minOdds").value = "1.15"; $("maxOdds").value = "2.50"; applyFilters(); }
    else if (stance === "value") { $("minOdds").value = "1.50"; applyFilters(); }
    else if (stance === "fixedcount") { const n = $("stanceFixedN").value; if (n) { $("topN").value = n; applyFilters(); } }
    else if (stance === "oddstarget") { applyOddsTarget(); }
  });
});

function applyOddsTarget() {
  const target = parseFloat($("stanceTargetOdds").value);
  if (!target || target < 1 || !allSelections.length) return;
  const sorted = [...allSelections].sort((a,b) => a.odds - b.odds);
  let best = sorted, bestDiff = Infinity;
  for (let n = 1; n <= sorted.length; n++) {
    const sub = sorted.slice(0, n);
    const odds = sub.reduce((a,s) => a*s.odds, 1);
    const diff = Math.abs(odds - target);
    if (diff < bestDiff) { bestDiff = diff; best = sub; }
    if (odds > target * 1.5) break;
  }
  const keepIds = new Set(best.map(s => s.eventId));
  filtered = allSelections.map(s => ({...s, removed: !keepIds.has(s.eventId)}));
  renderOpt(filtered.filter(s=>!s.removed), filtered.filter(s=>s.removed));
}

// ── Optimizer ──
$("fetchBtn").addEventListener("click", loadSlip);
$("bookingCode").addEventListener("keydown", e => { if (e.key === "Enter") loadSlip(); });
$("applyFilters").addEventListener("click", applyFilters);
$("resetFilters").addEventListener("click", resetFilters);
document.querySelectorAll(".preset").forEach(b => b.addEventListener("click", () => { b.classList.toggle("active"); applyFilters(); }));

async function loadSlip() {
  const code = $("bookingCode").value.trim().toUpperCase();
  if (!code) return showErr("errorMsg", "Enter a booking code");
  showErr("errorMsg", "");
  $("fetchBtn").disabled = true; $("fetchBtn").textContent = "Loading...";
  try {
    const res = await fetch(`/api/booking/${encodeURIComponent(code)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed");
    if (!json.selections?.length) throw new Error("No selections found");
    originalSelections = json.selections.map(s => ({ ...s }));
    allSelections = json.selections.map(s => ({ ...s }));
    changedEventIds = new Set();
    $("stanceSelector").classList.remove("hidden");
    $("resultsSection").classList.remove("hidden");
    populateFilterOptions();
    resetFilters();
  } catch (err) { showErr("errorMsg", err.message); }
  finally { $("fetchBtn").disabled = false; $("fetchBtn").textContent = "Load Slip"; }
}

function populateFilterOptions() {
  $("removeMarket").innerHTML = [...new Set(allSelections.map(s=>s.market))].sort().map(m=>`<option value="${attr(m)}">${esc(m)}</option>`).join("");
  $("removeLeague").innerHTML = [...new Set(allSelections.map(s=>s.league))].sort().map(l=>`<option value="${attr(l)}">${esc(l)}</option>`).join("");
  const lp = $("leaguePresets"); lp.innerHTML = "";
  [{label:"Women",p:/women|female|w\)/i},{label:"Friendlies",p:/friend/i},{label:"Reserve",p:/reserve|u2[01]|u19|u18|u17/i},{label:"Youth",p:/youth|junior|u16|u15/i}].forEach(({label,p}) => {
    if (!allSelections.some(s => p.test(s.league)||p.test(s.category))) return;
    const b = document.createElement("button"); b.className = "preset chip"; b.dataset.action = `league-${label.toLowerCase()}`; b.dataset.pattern = p.source; b.dataset.flags = p.flags; b.textContent = label;
    b.addEventListener("click", () => { b.classList.toggle("active"); applyFilters(); }); lp.appendChild(b);
  });
  const mp = $("marketPresets"); mp.innerHTML = "";
  ["Over/Under","Double Chance","Both Teams To Score","Correct Score","Goal Bounds"].forEach(kw => {
    if (!allSelections.some(s => s.market.toLowerCase().includes(kw.toLowerCase()))) return;
    const b = document.createElement("button"); b.className = "preset chip"; b.dataset.action = `market-${kw}`; b.textContent = kw;
    b.addEventListener("click", () => { b.classList.toggle("active"); applyFilters(); }); mp.appendChild(b);
  });
}

function applyFilters() {
  const presets = new Set(); document.querySelectorAll(".preset.active").forEach(b => presets.add(b.dataset.action));
  const afterTime = $("removeAfterTime").value ? new Date($("removeAfterTime").value) : null;
  const beforeTime = $("removeBeforeTime").value ? new Date($("removeBeforeTime").value) : null;
  const rmM = Array.from($("removeMarket").selectedOptions).map(o=>o.value);
  const rmL = Array.from($("removeLeague").selectedOptions).map(o=>o.value);
  const maxO = $("maxOdds").value ? parseFloat($("maxOdds").value) : null;
  const minO = $("minOdds").value ? parseFloat($("minOdds").value) : null;
  const topN = $("topN").value ? parseInt($("topN").value,10) : null;
  const now = new Date();
  const t6 = new Date(now); t6.setHours(18,0,0,0);
  const t8 = new Date(now); t8.setHours(20,0,0,0);
  const tmr = new Date(now); tmr.setDate(tmr.getDate()+1); tmr.setHours(0,0,0,0);

  filtered = allSelections.map(s => {
    let rm = false; const k = s.kickoff ? new Date(s.kickoff) : null;
    if (presets.has("after-6pm") && k && k > t6) rm = true;
    if (presets.has("after-8pm") && k && k > t8) rm = true;
    if (presets.has("tomorrow") && k && k >= tmr) rm = true;
    if (afterTime && k && k > afterTime) rm = true;
    if (beforeTime && k && k < beforeTime) rm = true;
    if (rmM.length && rmM.includes(s.market)) rm = true;
    if (rmL.length && rmL.includes(s.league)) rm = true;
    presets.forEach(a => {
      if (a.startsWith("league-")) { const b = document.querySelector(`.preset[data-action="${a}"]`); if (b) { const re = new RegExp(b.dataset.pattern, b.dataset.flags); if (re.test(s.league)||re.test(s.category)) rm = true; } }
      if (a.startsWith("market-")) { if (s.market.toLowerCase().includes(a.replace("market-","").toLowerCase())) rm = true; }
    });
    if (maxO !== null && s.odds > maxO) rm = true;
    if (minO !== null && s.odds < minO) rm = true;
    return { ...s, removed: rm };
  });

  const doTopN = n => { const k = filtered.filter(s=>!s.removed).sort((a,b)=>a.odds-b.odds); if (k.length > n) { const keep = new Set(k.slice(0,n).map(s=>s.eventId)); filtered = filtered.map(s => (!s.removed && !keep.has(s.eventId)) ? {...s, removed:true} : s); } };
  if (topN !== null && topN > 0) doTopN(topN);
  [5,10,15,20].forEach(n => { if (presets.has(`top-${n}`)) doTopN(n); });

  const kept = filtered.filter(s=>!s.removed), removed = filtered.filter(s=>s.removed);
  renderOpt(kept, removed);
  renderActiveChips(presets, afterTime, beforeTime, rmM, rmL, maxO, minO, topN);
}

function resetFilters() {
  ["removeAfterTime","removeBeforeTime","maxOdds","minOdds","topN"].forEach(id => $(id).value = "");
  [$("removeMarket"),$("removeLeague")].forEach(sel => Array.from(sel.options).forEach(o => o.selected = false));
  document.querySelectorAll(".preset.active").forEach(b => b.classList.remove("active"));
  filtered = allSelections.map(s => ({...s, removed: false}));
  renderOpt(allSelections, []);
  $("activeChips").classList.add("hidden"); $("activeChips").innerHTML = "";
}

function renderOpt(kept, removed) {
  const oO = allSelections.reduce((a,s)=>a*s.odds,1), kO = kept.length ? kept.reduce((a,s)=>a*s.odds,1) : 0;
  $("origCount").textContent = allSelections.length; $("optCount").textContent = kept.length;
  $("removedCount").textContent = removed.length;
  $("origOdds").textContent = oO.toFixed(2); $("optOdds").textContent = kO.toFixed(2);
  $("origBadge").textContent = allSelections.length; $("optBadge").textContent = kept.length; $("removedBadge").textContent = removed.length;
  $("originalTable").innerHTML = renderCards(allSelections);
  $("optimizedTable").innerHTML = kept.length ? renderCards(kept, {actions:true}) : '<div class="empty-state">All removed</div>';
  if (removed.length) { $("removedSection").classList.remove("hidden"); $("removedTable").innerHTML = renderCards(removed, {removed:true}); }
  else $("removedSection").classList.add("hidden");
  $("generateBtn").disabled = !(kept.length > 0 && (removed.length > 0 || changedEventIds.size > 0));
  $("generateResult").classList.add("hidden");
}

function renderActiveChips(presets, after, before, mks, lgs, maxO, minO, topN) {
  const chips = [];
  const add = (label, action) => chips.push(`<span class="active-chip">${esc(label)}<button onclick="removeFilter(${jsArg(action)})">&times;</button></span>`);
  presets.forEach(p => add(p.replace("market-","").replace("league-","").replace("after-","After ").replace("top-","Top "), p));
  if (after) add("After "+fmtKickoff(after.toISOString()), "clear-after");
  if (before) add("Before "+fmtKickoff(before.toISOString()), "clear-before");
  mks.forEach(m => add(m, "clear-market-"+m));
  lgs.forEach(l => add(l, "clear-league-"+l));
  if (maxO) add("Max "+maxO, "clear-maxodds");
  if (minO) add("Min "+minO, "clear-minodds");
  if (topN) add("Top "+topN, "clear-topn");
  const el = $("activeChips");
  if (chips.length) { el.innerHTML = chips.join(""); el.classList.remove("hidden"); } else el.classList.add("hidden");
}

window.removeFilter = function(action) {
  if (action === "clear-after") $("removeAfterTime").value = "";
  else if (action === "clear-before") $("removeBeforeTime").value = "";
  else if (action.startsWith("clear-market-")) { Array.from($("removeMarket").options).forEach(o => { if (o.value===action.replace("clear-market-","")) o.selected=false; }); }
  else if (action.startsWith("clear-league-")) { Array.from($("removeLeague").options).forEach(o => { if (o.value===action.replace("clear-league-","")) o.selected=false; }); }
  else if (action === "clear-maxodds") $("maxOdds").value = "";
  else if (action === "clear-minodds") $("minOdds").value = "";
  else if (action === "clear-topn") $("topN").value = "";
  else { const b = document.querySelector(`.preset[data-action="${action}"]`); if (b) b.classList.remove("active"); }
  applyFilters();
};

// ── Generate ──
$("generateBtn").addEventListener("click", async () => {
  const kept = filtered.filter(s=>!s.removed); if (!kept.length) return;
  $("generateBtn").disabled = true; $("generateBtn").textContent = "Generating..."; $("generateResult").classList.add("hidden");
  try { const r = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:genPayload(kept)})}); renderGenResult("generateResult", await r.json(), kept); }
  catch(e) { $("generateResult").classList.remove("hidden"); $("generateResult").innerHTML = `<div class="gen-error"><div class="gen-error-msg">${esc(e.message)}</div></div>`; }
  finally { $("generateBtn").disabled = false; $("generateBtn").textContent = "Generate New Code"; }
});

// ── Per-pick Optimize ──
const OPT_RULES = [
  { match:/Over (\d+\.?\d*)/i, mkt:"Over/Under", fn:(m,all) => { const v=parseFloat(m[1]); for(const t of [v-1,v-0.5].filter(x=>x>=0.5)){const f=all.find(mk=>mk.marketName==="Over/Under"&&mk.outcomeName===`Over ${t}`&&mk.specifier===`total=${t}`);if(f)return f;} return null; }},
  { match:/Yes/i, mkt:"GG/NG", fn:(m,all) => all.find(mk=>mk.marketName==="Over/Under"&&/Over 1\.5/.test(mk.outcomeName)) },
  { match:/No/i, mkt:"Both Halves Under", fn:(m,all) => all.find(mk=>mk.marketName==="Over/Under"&&/Over 0\.5/.test(mk.outcomeName))||all.find(mk=>mk.marketName==="Over/Under"&&/Over 1\.5/.test(mk.outcomeName)) },
  { match:/Home/i, mkt:"1X2", fn:(m,all) => all.find(mk=>mk.marketName==="Draw No Bet"&&/Home/.test(mk.outcomeName))||all.find(mk=>mk.marketName==="Double Chance"&&/Home or Draw/.test(mk.outcomeName)) },
  { match:/Away/i, mkt:"1X2", fn:(m,all) => all.find(mk=>mk.marketName==="Draw No Bet"&&/Away/.test(mk.outcomeName))||all.find(mk=>mk.marketName==="Double Chance"&&/Draw or Away/.test(mk.outcomeName)) },
  { match:/.*/, mkt:"Correct Score", fn:(m,all) => all.find(mk=>mk.marketName==="Over/Under"&&/Over 1\.5/.test(mk.outcomeName)) },
];

window.optimizePick = async function(eventId) {
  const idx = filtered.findIndex(s => s.eventId===eventId&&!s.removed); if (idx===-1) return;
  const sel = filtered[idx];
  try {
    const res = await fetch(`/api/markets/${encodeURIComponent(eventId)}`); const json = await res.json();
    if (!res.ok||!json.markets?.length) { showToast("No markets","error"); return; }
    let sug = null;
    for (const rule of OPT_RULES) { const m = sel.outcome.match(rule.match); if (m && sel.market.toLowerCase().includes(rule.mkt.toLowerCase())) { sug = rule.fn(m, json.markets); if (sug) break; } }
    if (!sug) { const safer = json.markets.filter(m => m.odds>1&&m.odds<sel.odds).sort((a,b) => b.odds-a.odds); sug = safer[0]; }
    if (sug) {
      const oldO = sel.odds;
      const upd = {market:sug.marketName,outcome:sug.outcomeName,odds:sug.odds,marketId:sug.marketId,outcomeId:sug.outcomeId,specifier:sug.specifier||""};
      filtered[idx] = {...filtered[idx],...upd};
      const ai = allSelections.findIndex(s=>s.eventId===eventId); if(ai!==-1) allSelections[ai]={...allSelections[ai],...upd};
      changedEventIds.add(eventId);
      renderOpt(filtered.filter(s=>!s.removed),filtered.filter(s=>s.removed));
      showToast(`${sug.outcomeName} @ ${sug.odds.toFixed(2)} (was ${oldO.toFixed(2)})`,"success");
    } else { showToast("No safer alternative","info"); openMarkets(eventId); }
  } catch(e) { showToast(e.message,"error"); }
};

// ── Market Explorer ──
const marketModal = $("marketModal");
$("modalClose").addEventListener("click", () => marketModal.classList.add("hidden"));
marketModal.querySelector(".modal-backdrop").addEventListener("click", () => marketModal.classList.add("hidden"));
document.addEventListener("keydown", e => { if (e.key==="Escape") { marketModal.classList.add("hidden"); $("h2hDrawer").classList.add("hidden"); } });
const marketsCache = {};
let currentMktEvt = null;

window.openMarkets = async function(eventId) {
  currentMktEvt = eventId; marketModal.classList.remove("hidden");
  $("modalTitle").textContent = "Loading..."; $("modalSub").textContent = ""; $("modalStats").innerHTML = "";
  $("modalBody").innerHTML = '<div class="modal-loading">Fetching markets...</div>';
  if (marketsCache[eventId]) { renderMarketModal(marketsCache[eventId]); return; }
  try { const r = await fetch(`/api/markets/${encodeURIComponent(eventId)}`); const j = await r.json(); if (!r.ok) throw new Error(j.error); marketsCache[eventId] = j; renderMarketModal(j); }
  catch(e) { $("modalBody").innerHTML = `<div class="modal-loading" style="color:var(--red)">${esc(e.message)}</div>`; }
};

function renderMarketModal(d) {
  $("modalTitle").textContent = `${d.homeTeam} vs ${d.awayTeam}`;
  $("modalSub").textContent = `${d.sport} · ${d.league}`;
  $("modalStats").innerHTML = `<span>Markets: <span class="ms-val">${d.marketCount}</span></span><span>Outcomes: <span class="ms-val">${d.outcomeCount}</span></span>`;
  const groups=[]; const seen=new Map();
  d.markets.forEach(m => { const k=`${m.marketId}|${m.specifier}`; if(!seen.has(k)){seen.set(k,{marketName:m.marketName,specifier:m.specifier,outcomes:[]});groups.push(seen.get(k));} seen.get(k).outcomes.push(m); });
  $("modalBody").innerHTML = `<div class="mkt-th"><span>Outcome</span><span>Odds</span><span></span></div>`+groups.map((g,i) =>
    `<div class="mkt-group ${i<3?"open":""}" onclick="this.classList.toggle('open')"><div class="mkt-group-header"><span class="mkt-group-chevron">&#9654;</span><span class="mkt-group-name">${esc(g.marketName)}${g.specifier?" ("+esc(g.specifier)+")":""}</span><span class="mkt-group-count">${g.outcomes.length}</span></div><div class="mkt-outcomes">${g.outcomes.map(o =>
      `<div class="mkt-outcome-row"><span class="mkt-outcome-name">${esc(o.outcomeName)}</span><span class="mkt-outcome-odds">${o.odds.toFixed(2)}</span><button class="btn-sm btn-use" data-mid="${attr(o.marketId)}" data-oid="${attr(o.outcomeId)}" data-spec="${attr(o.specifier)}" data-mname="${attr(o.marketName)}" data-oname="${attr(o.outcomeName)}" data-odds="${o.odds}" onclick="useThisMarket(this)">Use This</button></div>`
    ).join("")}</div></div>`
  ).join("");
}

window.useThisMarket = function(btn) {
  const eid = currentMktEvt; if (!eid) return;
  const upd = {market:btn.dataset.mname,outcome:btn.dataset.oname,odds:parseFloat(btn.dataset.odds),marketId:btn.dataset.mid,outcomeId:btn.dataset.oid,specifier:btn.dataset.spec};
  [allSelections,filtered].forEach(arr => { const i=arr.findIndex(s=>s.eventId===eid); if(i!==-1)arr[i]={...arr[i],...upd}; });
  changedEventIds.add(eid);
  marketModal.classList.add("hidden");
  renderOpt(filtered.filter(s=>!s.removed),filtered.filter(s=>s.removed));
  showToast(`Swapped to ${upd.outcome} @ ${upd.odds.toFixed(2)}`,"success");
};

// ── Merger ──
let mergerSelections = [];
let mergerConflicts = [];

$("addCodeBtn").addEventListener("click", () => {
  const rows = document.querySelectorAll(".merger-code-row");
  if (rows.length >= 5) return;
  const row = document.createElement("div"); row.className = "merger-code-row";
  row.innerHTML = `<input type="text" class="field merger-code-field" placeholder="Booking code ${rows.length+1}" /><button class="btn-rm-code" onclick="this.parentElement.remove()">&times;</button>`;
  $("mergerInputs").appendChild(row);
});

$("mergerLoadBtn").addEventListener("click", loadMerger);
$("mergerGenerateBtn").addEventListener("click", genMerger);

async function loadMerger() {
  const inputs = document.querySelectorAll(".merger-code-field");
  const codes = Array.from(inputs).map(i => i.value.trim().toUpperCase()).filter(Boolean);
  if (codes.length < 2) return showErr("mergerError","Enter at least 2 codes");
  showErr("mergerError",""); $("mergerLoadBtn").disabled = true; $("mergerLoadBtn").textContent = "Fetching...";
  try {
    const r = await fetch("/api/merge",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({codes})});
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    mergerSelections = j.selections;
    mergerConflicts = j.conflicts || [];
    $("mergerCodesCount").textContent = codes.length; $("mergerTotal").textContent = j.mergedCount;
    $("mergerDupes").textContent = j.dupesRemoved; $("mergerOdds").textContent = j.totalOdds.toFixed(2);
    $("mergerBadge").textContent = j.mergedCount;
    renderMergerTable();
    renderMergerConflicts();
    $("mergerResults").classList.remove("hidden");
  } catch(e) { showErr("mergerError",e.message); }
  finally { $("mergerLoadBtn").disabled = false; $("mergerLoadBtn").textContent = "Fetch All"; }
}

function renderMergerTable() {
  $("mergerTable").innerHTML = renderCards(mergerSelections, {removable:true});
  $("mergerBadge").textContent = mergerSelections.length;
  $("mergerTotal").textContent = mergerSelections.length;
  $("mergerOdds").textContent = mergerSelections.reduce((a,s)=>a*s.odds,1).toFixed(2);
}

function renderMergerConflicts() {
  const panel = $("mergerConflictsPanel");
  if (!mergerConflicts.length) {
    panel.classList.add("hidden");
    return;
  }
  $("mergerConflictsBadge").textContent = mergerConflicts.length;
  $("mergerConflicts").innerHTML = mergerConflicts.map((c, ci) => `
    <div class="conflict-card">
      <div class="conflict-title">${esc(c.homeTeam)} vs ${esc(c.awayTeam)}</div>
      <div class="conflict-options">
        ${(c.options || []).map((o, oi) => `
          <button class="conflict-option" onclick="chooseMergerConflict(${ci},${oi})">
            <span>${esc(o.market)} - ${esc(o.outcome)}</span>
            <strong>${Number(o.odds || 0).toFixed(2)}</strong>
            <small>${esc(o.sourceCode || "")}</small>
          </button>
        `).join("")}
      </div>
    </div>
  `).join("");
  panel.classList.remove("hidden");
}

window.chooseMergerConflict = function(conflictIndex, optionIndex) {
  const choice = mergerConflicts[conflictIndex]?.options?.[optionIndex];
  if (!choice) return;
  const idx = mergerSelections.findIndex(s => s.eventId === choice.eventId);
  if (idx === -1) mergerSelections.push(choice);
  else mergerSelections[idx] = choice;
  mergerConflicts.splice(conflictIndex, 1);
  renderMergerConflicts();
  renderMergerTable();
};

window.removeMergerGame = function(eventId) {
  mergerSelections = mergerSelections.filter(s => s.eventId !== eventId);
  renderMergerTable();
};

async function genMerger() {
  if (!mergerSelections.length) return;
  $("mergerGenerateBtn").disabled = true; $("mergerGenerateBtn").textContent = "Generating...";
  try { const r = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:genPayload(mergerSelections)})}); renderGenResult("mergerGenResult", await r.json(), mergerSelections); }
  catch(e) { showErr("mergerError",e.message); }
  finally { $("mergerGenerateBtn").disabled = false; $("mergerGenerateBtn").textContent = "Generate Merged Code"; }
}

// ── Splitter ──
let splitterSels = [], splitData = null;
$("splitterLoadBtn").addEventListener("click", loadSplitter);
$("splitterSplitBtn").addEventListener("click", doSplit);

async function loadSplitter() {
  const code = $("splitterCode").value.trim().toUpperCase();
  if (!code) return showErr("splitterError","Enter a code");
  showErr("splitterError",""); $("splitterLoadBtn").disabled = true; $("splitterLoadBtn").textContent = "Loading...";
  try {
    const r = await fetch(`/api/booking/${encodeURIComponent(code)}`); const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    splitterSels = j.selections;
    $("splitterTotal").textContent = j.selections.length; $("splitterOdds").textContent = j.totalOdds.toFixed(2);
    $("splitterConfig").classList.remove("hidden"); $("splitterResults").innerHTML = ""; $("splitterCopyAll").classList.add("hidden"); $("splitterGenerateAll").classList.add("hidden");
    renderSplitterSelections();
  } catch(e) { showErr("splitterError",e.message); }
  finally { $("splitterLoadBtn").disabled = false; $("splitterLoadBtn").textContent = "Load Slip"; }
}

function renderSplitterSelections() {
  $("splitterSelTable").innerHTML = renderCards(splitterSels, {splitterRemovable:true});
  $("splitterTotal").textContent = splitterSels.length;
  $("splitterOdds").textContent = splitterSels.reduce((a,s)=>a*s.odds,1).toFixed(2);
}

window.removeSplitterGame = function(eventId) {
  splitterSels = splitterSels.filter(s => s.eventId !== eventId);
  renderSplitterSelections();
};

async function doSplit() {
  $("splitterSplitBtn").disabled = true;
  try {
    const r = await fetch("/api/split",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:splitterSels,count:parseInt($("splitCount").value)||2,method:$("splitMethod").value})});
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    splitData = j.slips;
    $("splitterResults").innerHTML = j.slips.map((sl,i) =>
      `<section class="panel splitter-panel"><div class="panel-head"><h3>Slip ${i+1}</h3><span class="badge">${sl.count}</span><span class="sel-odds">${sl.totalOdds.toFixed(2)}</span></div><div class="panel-scroll">${renderCards(sl.selections)}</div><div class="cta-row split-cta"><button class="btn btn-green" onclick="genSplitCode(${i})">Generate</button><span id="splitCode${i}" class="gen-code-inline mono"></span></div></section>`
    ).join("");
    $("splitterGenerateAll").classList.remove("hidden");
    $("splitterCopyAll").classList.remove("hidden");
  } catch(e) { showErr("splitterError",e.message); }
  finally { $("splitterSplitBtn").disabled = false; }
}

window.genSplitCode = async function(idx) {
  if (!splitData?.[idx]) return;
  try {
    const r = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:genPayload(splitData[idx].selections)})});
    const j = await r.json(); const el = $(`splitCode${idx}`);
    if (j.success) { el.textContent = j.shareCode; el.style.color = ""; showToast("Slip "+(idx+1)+": "+j.shareCode,"success"); }
    else { el.textContent = "Failed"; el.style.color = "var(--red)"; }
  } catch(e) { showToast(e.message,"error"); }
};

window.genAllSplitCodes = async function() {
  if (!splitData?.length) return;
  const btn = $("splitterGenerateAll").querySelector("button");
  btn.disabled = true;
  btn.textContent = "Generating...";
  for (let i = 0; i < splitData.length; i++) await window.genSplitCode(i);
  btn.disabled = false;
  btn.textContent = "Generate All Codes";
};

window.copyAllSplitCodes = function() {
  if (!splitData) return;
  const codes = splitData.map((_,i) => $(`splitCode${i}`)?.textContent).filter(c => c && c !== "Failed");
  if (codes.length) copyToClipboard(codes.join("\n"));
};

// ── Scanner ──
let scanData = null, manualOverrides = {};
$("scanBtn").addEventListener("click", scanSlip);
$("scanCode").addEventListener("keydown", e => { if (e.key==="Enter") scanSlip(); });
$("autoSaveYes").addEventListener("click", saveScanPunter);
$("autoSaveNo").addEventListener("click", () => $("scanAutoSave").classList.add("hidden"));

async function scanSlip() {
  const code = $("scanCode").value.trim().toUpperCase();
  if (!code) return showErr("scanError","Enter a code");
  showErr("scanError",""); $("scanBtn").disabled = true; $("scanBtn").textContent = "Scanning...";
  $("scanResults").classList.add("hidden"); manualOverrides = {};
  try {
    const r = await fetch(`/api/scan/${encodeURIComponent(code)}`); const j = await r.json();
    if (!r.ok) throw new Error(j.error); scanData = j;
    $("scanResults").classList.remove("hidden"); renderScanResults();
    if ($("scanPunterName").value.trim()) $("scanAutoSave").classList.remove("hidden");
  } catch(e) { showErr("scanError",e.message); }
  finally { $("scanBtn").disabled = false; $("scanBtn").textContent = "Scan"; }
}

function renderScanResults() {
  const results = scanData.results.map(r => manualOverrides[r.eventId] ? {...r,verdict:manualOverrides[r.eventId]} : r);
  const won=results.filter(r=>r.verdict==="WON"), lost=results.filter(r=>r.verdict==="LOST");
  const voided=results.filter(r=>r.verdict==="VOID"), pending=results.filter(r=>r.verdict==="PENDING");
  const settled=won.length+lost.length, hitRate=settled?Math.round(won.length/settled*100):0;
  $("scanWon").textContent=won.length; $("scanLost").textContent=lost.length;
  $("scanVoid").textContent=voided.length; $("scanPending").textContent=pending.length;
  $("scanHitRate").textContent=hitRate+"%";
  $("killersBadge").textContent=lost.length; $("safeBadge").textContent=won.length; $("scanTotalBadge").textContent=results.length;
  $("killersTable").innerHTML = lost.length ? lost.map(scanCard).join("") : '<div class="empty-state">No killers</div>';
  $("safeTable").innerHTML = won.length ? won.map(scanCard).join("") : '<div class="empty-state">No safe picks</div>';
  $("scanAllTable").innerHTML = results.map(scanCard).join("");
}

function scanCard(r) {
  const vc={WON:"v-won",LOST:"v-lost",VOID:"v-void",PENDING:"v-pending"}[r.verdict]||"v-pending";
  const manual = r.verdict==="PENDING" ? `<button class="btn-manual" onclick="setManual(${jsArg(r.eventId)},'WON')">W</button><button class="btn-manual" onclick="setManual(${jsArg(r.eventId)},'LOST')">L</button><button class="btn-manual" onclick="setManual(${jsArg(r.eventId)},'VOID')">V</button>` : "";
  return `<div class="sel-card"><div class="sel-info"><div class="sel-teams">${esc(r.homeTeam)} vs ${esc(r.awayTeam)}</div><div class="sel-meta"><span class="sel-market">${esc(r.market)}</span> — ${esc(r.outcome)}${r.league?" · "+esc(r.league):""}</div></div><span class="scan-score">${esc(r.score||"--")}</span><span class="sel-odds">${r.odds.toFixed(2)}</span><span class="v-pill ${vc}">${r.verdict}</span>${manual}</div>`;
}

window.setManual = function(eid,v) { manualOverrides[eid]=v; renderScanResults(); };

async function saveScanPunter() {
  const name = $("scanPunterName").value.trim(); if (!name||!scanData) return;
  const results = scanData.results.map(r => manualOverrides[r.eventId] ? {...r,verdict:manualOverrides[r.eventId]} : r);
  try {
    const r = await fetch("/api/punters",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,code:scanData.shareCode,results})});
    if ((await r.json()).success) { $("scanAutoSave").classList.add("hidden"); showToast("Saved "+name,"success"); }
  } catch(e) { showToast(e.message,"error"); }
}

// ── Leaderboard ──
let lbData = [];
async function loadLeaderboard() {
  try { const r = await fetch("/api/punters"); lbData = (await r.json()).leaderboard||[]; renderLeaderboard(); }
  catch(e) { $("leaderboardTable").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

function renderLeaderboard() {
  const sharedName = getSharedPunterName();
  const rows = sharedName ? lbData.filter(p => p.name.toLowerCase() === sharedName.toLowerCase()) : lbData;
  if (!rows.length) { $("leaderboardTable").innerHTML = `<div class="empty-state">${sharedName ? "No history found for this punter." : "No punters saved yet."}</div>`; return; }
  const rc = i => i===0?"lb-rank lb-rank-1":i===1?"lb-rank lb-rank-2":i===2?"lb-rank lb-rank-3":"lb-rank";
  $("leaderboardTable").innerHTML = `<table class="lb-table"><thead><tr><th>#</th><th>Punter</th><th>Slips</th><th>Games</th><th>Won</th><th>Lost</th><th>Void</th><th>Hit Rate</th><th></th></tr></thead><tbody>${rows.map((p,i) => {
    const del = isAdmin ? `<button class="btn-manual admin-delete" onclick="event.stopPropagation();deletePunter(${jsArg(p.name)})">X</button>` : "";
    const share = `<button class="btn-manual" onclick="event.stopPropagation();copyToClipboard(${jsArg(location.origin + (p.sharePath || `/punter/${encodeURIComponent(p.name)}`))},this)">Share</button>`;
    const slipRows = p.slips.map(s => `<tr><td></td><td class="mono">${esc(s.code)}</td><td>${s.total}</td><td>${s.won}</td><td>${s.lost}</td><td>${s.void||0}</td><td>${s.hitRate}%</td><td>${new Date(s.date).toLocaleDateString("en-GB")}</td></tr>`).join("");
    return `<tr class="lb-row" onclick="this.nextElementSibling.classList.toggle('hidden')"><td class="${rc(i)}">${sharedName ? p.rank || i+1 : i+1}</td><td class="lb-name">${esc(p.name)}</td><td>${p.slipCount}</td><td>${p.totalGames}</td><td class="lb-won">${p.won}</td><td class="lb-lost">${p.lost}</td><td>${p.void}</td><td class="lb-rate">${p.hitRate}%</td><td class="lb-actions">${share}${del}</td></tr><tr class="lb-detail hidden"><td colspan="9"><table class="lb-detail-table"><thead><tr><th></th><th>Code</th><th>Games</th><th>Won</th><th>Lost</th><th>Void</th><th>Rate</th><th>Date</th></tr></thead><tbody>${slipRows}</tbody></table></td></tr>`;
  }).join("")}</tbody></table>`;
}

window.deletePunter = async function(name) {
  if (!isAdmin||!window.__adminPw) return;
  try { await fetch(`/api/punters/${encodeURIComponent(name)}`,{method:"DELETE",headers:{"x-admin-password":window.__adminPw}}); showToast("Deleted "+name,"success"); loadLeaderboard(); }
  catch(e) { showToast(e.message,"error"); }
};

// ── H2H ──
$("h2hClose").addEventListener("click", () => $("h2hDrawer").classList.add("hidden"));
function formPills(items) {
  if (!items?.length) return '<span class="empty-inline">No form data</span>';
  return `<div class="form-pills">${items.slice(0,5).map(i => `<span class="form-pill form-${esc(i.result || "D")}">${esc(i.result || "D")}</span>`).join("")}</div>`;
}
window.openH2H = async function(eid, home, away) {
  $("h2hDrawer").classList.remove("hidden"); $("h2hTitle").textContent = `${home} vs ${away}`;
  $("h2hBody").innerHTML = '<div class="modal-loading">Loading stats...</div>';
  try {
    const r = await fetch(`/api/h2h?eventId=${encodeURIComponent(eid)}&home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
    const j = await r.json();
    if (!j.found) { $("h2hBody").innerHTML = `<div class="empty-state">Stats unavailable for this match${j.sportyDebugFile ? `<br><small>${esc(j.sportyDebugFile)}</small>` : ""}</div>`; return; }
    const stats = j.keyStats || {};
    let html = `<div class="h2h-summary"><span class="confidence confidence-${esc(j.confidence || "Neutral").toLowerCase()}">${esc(j.confidence || "Neutral")}</span><span>${esc(j.source || "stats")}</span></div>`;
    html += `<div class="key-stat-grid"><div><strong>${stats.avgGoals ?? "--"}</strong><span>Avg goals</span></div><div><strong>${stats.bttsPct ?? "--"}${stats.bttsPct == null ? "" : "%"}</strong><span>BTTS</span></div><div><strong>${stats.over25Pct ?? "--"}${stats.over25Pct == null ? "" : "%"}</strong><span>Over 2.5</span></div></div>`;
    html += `<h4 class="h2h-section-title">${esc(home)} Form</h4>${formPills(j.homeForm)}`;
    html += `<h4 class="h2h-section-title">${esc(away)} Form</h4>${formPills(j.awayForm)}`;
    if (j.h2h?.length) { html += `<h4 class="h2h-section-title">Head to Head</h4>`; html += j.h2h.map(e => `<div class="h2h-match"><span class="h2h-date">${esc(e.date||"")}</span><span>${esc(e.home)} <strong>${e.homeScore}-${e.awayScore}</strong> ${esc(e.away)}</span></div>`).join(""); }
    $("h2hBody").innerHTML = html || '<div class="empty-state">No data</div>';
  } catch(e) { $("h2hBody").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
};

// ── Admin (Ctrl+Shift+A) ──
document.addEventListener("keydown", e => {
  if (e.ctrlKey && e.shiftKey && e.key === "A") {
    e.preventDefault();
    if (isAdmin) { isAdmin=false; document.body.classList.remove("admin-mode"); $("adminBadge").classList.add("hidden"); showToast("Admin off","info"); renderLeaderboard(); return; }
    const pw = prompt("Admin password:"); if (!pw) return;
    fetch("/api/admin/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})}).then(r=>r.json()).then(j => {
      if (j.success) { isAdmin=true; window.__adminPw=pw; document.body.classList.add("admin-mode"); $("adminBadge").classList.remove("hidden"); showToast("Admin on","success"); renderLeaderboard(); }
      else showToast("Wrong password","error");
    });
  }
});

if (getSharedPunterName()) activateTab("leaderboard");
