/* SlipPilot */
let allSelections = [];
let originalSelections = [];
let filtered = [];
let changedEventIds = new Set();
let isAdmin = false;
let safetyScores = {};
let pendingSmartRoute = null;
let bankers = new Set();
let excluded = new Set();
const $ = (id) => document.getElementById(id);

// ── Nav ──
let currentTab = null;

function showHomepage() {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"));
  $("homepage").classList.add("active");
  currentTab = null;
  loadLiveStats();
}

function resetTabState(tab) {
  if (tab === "optimizer") {
    allSelections = []; originalSelections = []; filtered = []; changedEventIds = new Set(); safetyScores = {}; bankers = new Set(); excluded = new Set();
    $("bookingCode").value = ""; $("optPunterName").value = "";
    showErr("errorMsg",""); $("generateResult").classList.add("hidden"); $("tripleCards").classList.add("hidden"); $("codeCard").classList.add("hidden");
    wizGo("opt",1);
  } else if (tab === "merger") {
    mergerSelections = []; mergerConflicts = [];
    document.querySelectorAll(".merger-code-field").forEach(f => f.value = "");
    $("mergerPunterName").value = ""; showErr("mergerError","");
    wizGo("merger",1);
  } else if (tab === "splitter") {
    splitterSels = []; splitData = null;
    $("splitterCode").value = ""; showErr("splitterError","");
    $("permPoolCode").value = ""; $("permResults").classList.add("hidden"); $("permResults").innerHTML = "";
    wizGo("split",1);
  } else if (tab === "scanner") {
    scanData = null; manualOverrides = {};
    $("scanCode").value = ""; $("scanPunterName").value = "";
    showErr("scanError",""); $("scanResults").classList.add("hidden");
  } else if (tab === "convert") {
    convertOriginal = []; convertResult = []; manualConvertEdits = {};
    $("convertCode").value = ""; showErr("convertError",""); $("convertResults").classList.add("hidden");
  }
}

function activateTab(tab) {
  const prevTab = currentTab;
  if (prevTab && prevTab !== tab) {
    resetTabState(prevTab);
  }

  const allPages = document.querySelectorAll(".tab-page");
  allPages.forEach(p => p.classList.add("fading"));
  $("homepage").classList.add("fading");

  setTimeout(() => {
    $("homepage").classList.remove("active"); $("homepage").classList.remove("fading");
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    allPages.forEach(p => { p.classList.remove("active"); p.classList.remove("fading"); });
    const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add("active");
    const pg = $(`tab-${tab}`);
    if (pg) pg.classList.add("active");
    currentTab = tab;
    if (tab === "leaderboard") showLeaderboardView();
    document.querySelectorAll(".bnav-item").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  }, 300);
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

// ── Wizard Navigation ──
function wizGo(prefix, step) {
  const tab = document.querySelector(`[data-wiz="${prefix}-${step}"]`)?.closest(".tab-page");
  if (!tab) return;
  tab.querySelectorAll(".wiz-step").forEach(s => s.classList.remove("active"));
  const target = tab.querySelector(`[data-wiz="${prefix}-${step}"]`);
  if (target) target.classList.add("active");
  const bar = tab.querySelector(".wiz-steps-bar");
  if (bar) {
    bar.querySelectorAll(".wiz-dot").forEach(d => {
      const n = parseInt(d.dataset.n);
      d.classList.toggle("active", n === step);
      d.classList.toggle("done", n < step);
    });
    bar.querySelectorAll(".wiz-line").forEach((l, i) => l.classList.toggle("done", i + 1 < step));
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Odds target mode toggle
function setOddsMode(mode) {
  document.querySelectorAll("[data-target]").forEach(b => b.classList.toggle("active", b.dataset.target === mode));
  const ex = $("oddsExactPanel"), rn = $("oddsRangePanel");
  if (ex) ex.classList.toggle("hidden", mode !== "exact");
  if (rn) rn.classList.toggle("hidden", mode !== "range");
  if (mode === "range") updateDualRange();
}

function updateDualRange() {
  const mn = $("minOdds"), mx = $("maxOdds");
  if (!mn || !mx) return;
  let lo = parseInt(mn.value), hi = parseInt(mx.value), total = parseInt(mx.max) || 1000;
  if (lo > hi) { mn.value = hi; lo = hi; }
  const rm = $("rangeMin"), rmx = $("rangeMax"), fill = $("rangeFill");
  if (rm) rm.textContent = lo;
  if (rmx) rmx.textContent = hi;
  if (fill) { fill.style.left = (lo/total*100)+"%"; fill.style.width = ((hi-lo)/total*100)+"%"; }
}

// Leg count mode toggle
function setLegMode(mode) {
  document.querySelectorAll("[data-legs]").forEach(b => b.classList.toggle("active", b.dataset.legs === mode));
  const fp = $("legFixedPanel");
  if (fp) fp.classList.toggle("hidden", mode !== "fixed");
  if (mode === "fixed") updateLegRange();
}

function updateLegRange() {
  const mn = $("topN"), mx = $("topNMax");
  if (!mn || !mx) return;
  let lo = parseInt(mn.value), hi = parseInt(mx.value), total = parseInt(mx.max) || 50;
  if (lo > hi) { mn.value = hi; lo = hi; }
  const lm = $("legMin"), lmx = $("legMax2"), fill = $("legFill");
  if (lm) lm.textContent = lo;
  if (lmx) lmx.textContent = hi;
  if (fill) { fill.style.left = (lo/total*100)+"%"; fill.style.width = ((hi-lo)/total*100)+"%"; }
}

// Game limit +/- buttons
function adjLimit(btn, delta) {
  const valEl = btn.parentElement.querySelector(".gl-val");
  if (!valEl) return;
  let cur = valEl.textContent === "Off" ? 0 : parseInt(valEl.textContent);
  cur = Math.max(0, cur + delta);
  valEl.textContent = cur === 0 ? "Off" : cur;
}

// Banker system
window.toggleBanker = function(eventId) {
  if (bankers.has(eventId)) bankers.delete(eventId); else bankers.add(eventId);
  renderOpt(filtered.filter(s=>!s.removed), filtered.filter(s=>s.removed));
};

// Exclusion system
window.toggleExclude = function(eventId) {
  if (excluded.has(eventId)) excluded.delete(eventId); else excluded.add(eventId);
  updateExcludedUI();
  renderOpt(filtered.filter(s=>!s.removed), filtered.filter(s=>s.removed));
};
window.restoreAllExcluded = function() {
  excluded.clear();
  updateExcludedUI();
  renderOpt(filtered.filter(s=>!s.removed), filtered.filter(s=>s.removed));
};
function updateExcludedUI() {
  const info = $("excludedInfo");
  if (excluded.size > 0) { info.classList.remove("hidden"); info.style.display = ""; $("excludedCount").textContent = excluded.size; }
  else { info.classList.add("hidden"); }
}

// Skeleton loading
function showSkeleton(containerId) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = Array.from({length:5}, () => `<div class="skeleton-card"><div class="skeleton-bar w60" style="height:14px"></div><div class="skeleton-bar w40" style="height:10px;margin-top:4px"></div><div class="skeleton-bar w20" style="height:14px;margin-left:auto"></div></div>`).join("");
}

// More Options pill groups (goal, style, adjust)
document.querySelectorAll(".opt-goal,.opt-style,.opt-adjust").forEach(b => b.addEventListener("click", () => {
  b.parentElement.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
  b.classList.add("active");
}));

function runOptimize() {
  applyFilters();
  wizGo('opt', 3);
  const kept = filtered.filter(s => !s.removed);
  const removed = filtered.filter(s => s.removed);
  const rg = $('resultGames'); if (rg) rg.textContent = kept.length;

  // Target indicator — never remove games to hit odds target
  const targetEl = $('oddsTargetIndicator');
  const noticeEl = $('optNotice');
  const targetPill = document.querySelector('[data-target].active');
  if (noticeEl) noticeEl.classList.add('hidden');
  if (targetEl && targetPill && targetPill.dataset.target !== 'off' && kept.length > 0) {
    const kO = kept.reduce((a,s) => a*s.odds, 1);
    if (targetPill.dataset.target === 'exact') {
      const t = parseFloat($('stanceTargetOdds').value) || 0;
      if (t > 0) {
        const diff = Math.abs(kO - t) / t;
        if (diff < 0.2) {
          targetEl.className = 'target-pill target-hit';
          targetEl.textContent = '✓ Within target ' + t + 'x';
        } else {
          targetEl.className = 'target-pill target-miss';
          targetEl.textContent = 'Target ' + t + 'x not reached — your slip is ' + kO.toFixed(1) + 'x. Adjust leg count or stance to get closer.';
        }
        targetEl.classList.remove('hidden');
      }
    } else if (targetPill.dataset.target === 'range') {
      const mn = parseFloat($('minOdds').value) || 0, mx = parseFloat($('maxOdds').value) || Infinity;
      targetEl.className = 'target-pill ' + (kO >= mn && kO <= mx ? 'target-hit' : 'target-miss');
      targetEl.textContent = (kO >= mn && kO <= mx) ? '✓ Within ' + mn + 'x–' + mx + 'x' : 'Outside ' + mn + 'x–' + mx + 'x (got ' + kO.toFixed(1) + 'x). Adjust leg count or stance to get closer.';
      targetEl.classList.remove('hidden');
    }
  } else if (targetEl) targetEl.classList.add('hidden');
  $('generateBtn').classList.remove('hidden');
  $('codeCard').classList.add('hidden');
}

// close filter dropdowns on outside click
document.addEventListener("click", e => {
  if (!e.target.closest(".filter-pill")) document.querySelectorAll(".filter-pill.open").forEach(p => p.classList.remove("open"));
});

// ── Animated count-up ──
function animateNum(el, target) {
  const start = Math.floor(target * 0.9);
  const dur = 800;
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
  const isExcluded = excluded.has(s.eventId);
  const original = originalSelections.find(o => o.eventId === s.eventId);
  const changed = !rm && original && (original.marketId !== s.marketId || original.outcomeId !== s.outcomeId || original.specifier !== s.specifier);
  const meta = changed
    ? `<span class="sel-market">${esc(original.market)}</span> ${esc(original.outcome)} <span class="change-arrow">-&gt;</span> <span class="sel-market">${esc(s.market)}</span> ${esc(s.outcome)}`
    : `<span class="sel-market">${esc(s.market)}</span> — ${esc(s.outcome)}${s.league?" · "+esc(s.league):""}`;
  const isBanker = bankers.has(s.eventId);
  let btns = "";
  if (opts?.banker) btns = `<button class="btn-sm ${isBanker?'btn-optimize':'btn-stats'}" onclick="toggleBanker(${jsArg(s.eventId)})" title="Lock as banker">${isBanker?'&#128737; Locked':'&#128737;'}</button><button class="btn-sm ${isExcluded?'btn-optimize':''}" onclick="toggleExclude(${jsArg(s.eventId)})" title="Exclude from codes" style="margin-left:4px;${isExcluded?'color:var(--red);border-color:var(--red)':''}">${isExcluded?'&#10005; Excluded':'&#10005;'}</button>`;
  if (opts?.actions) btns = `<button class="btn-sm btn-stats" onclick="openH2H(${jsArg(s.eventId)},${jsArg(s.homeTeam)},${jsArg(s.awayTeam)})">Stats</button><button class="btn-sm btn-optimize" onclick="optimizePick(${jsArg(s.eventId)})">Optimize</button><button class="btn-sm btn-markets" onclick="openMarkets(${jsArg(s.eventId)})">Markets</button>`;
  if (opts?.removable) btns = `<button class="btn-rm-code" onclick="removeMergerGame(${jsArg(s.eventId)})">&times;</button>`;
  if (opts?.splitterRemovable) btns = `<button class="btn-rm-code" onclick="removeSplitterGame(${jsArg(s.eventId)})">&times;</button>`;
  let safetyHtml = "";
  const sc = safetyScores[s.eventId];
  if (sc !== undefined && opts?.actions) {
    const cls = safetyClass(sc);
    safetyHtml = `<div class="${cls}" style="flex-basis:100%;margin-top:2px"><div class="safety-bar"><div class="safety-fill" style="width:${sc}%"></div></div><span class="safety-label ${cls}">${safetyLabel(sc)} ${sc}</span></div>`;
  }
  return `<div class="sel-card ${rm?"removed-card":""} ${changed?"changed-card":""} ${isExcluded?"removed-card":""}"><div class="sel-info"><div class="sel-teams">${esc(s.homeTeam)} vs ${esc(s.awayTeam)}</div><div class="sel-meta">${meta}</div></div><span class="sel-odds">${Number(s.odds || 0).toFixed(2)}</span><span class="sel-kickoff">${fmtKickoff(s.kickoff)}</span>${btns}${safetyHtml}</div>`;
}
function renderCards(sels, opts) { return sels.map(s => cardHtml(s, opts)).join(""); }
function genPayload(sels) { return sels.map(s => ({eventId:s.eventId,marketId:s.marketId,outcomeId:s.outcomeId,specifier:s.specifier,productId:s.productId,sportId:s.sportId})); }

// ── Stance Selector ──
document.querySelectorAll(".stance-card").forEach(c => {
  c.addEventListener("click", () => {
    document.querySelectorAll(".stance-card").forEach(x => x.classList.remove("active"));
    c.classList.add("active");
  });
});

function applyOddsTarget() {
  const target = parseFloat($("stanceTargetOdds").value);
  if (!target || target < 1 || !allSelections.length) return;
  const sorted = [...allSelections].sort((a,b) => a.odds - b.odds);
  let best = sorted, bestDiff = Infinity;
  const MIN_KEEP = Math.max(3, Math.ceil(allSelections.length * 0.3));
  for (let n = MIN_KEEP; n <= sorted.length; n++) {
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
  showSkeleton("originalTable");
  try {
    const res = await fetch(`/api/booking/${encodeURIComponent(code)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed");
    if (!json.selections?.length) throw new Error("No selections found");

    // Smart routing: check if expired, active, or mixed
    const now = Date.now();
    const future = json.selections.filter(s => s.kickoff && new Date(s.kickoff).getTime() > now);
    const past = json.selections.filter(s => s.kickoff && new Date(s.kickoff).getTime() <= now);

    if (past.length === json.selections.length) {
      // All expired — route to scanner
      $("scanCode").value = code;
      activateTab("scanner");
      showToast("This slip has already played. Showing results.", "info");
      scanSlip();
      return;
    }

    if (past.length > 0 && future.length > 0) {
      // Mixed — ask user
      pendingSmartRoute = { code, json, futureOnly: future };
      $("smartRouteModal").classList.remove("hidden");
      return;
    }

    // All future — proceed normally
    initOptimizer(json);
  } catch (err) { showErr("errorMsg", err.message); }
  finally { $("fetchBtn").disabled = false; $("fetchBtn").textContent = "Load Slip"; }
}

function initOptimizer(json) {
  originalSelections = json.selections.map(s => ({ ...s }));
  allSelections = json.selections.map(s => ({ ...s }));
  changedEventIds = new Set();
  safetyScores = {};
  populateFilterOptions();
  resetFilters();
  // Set slider max values based on loaded slip
  const totalOdds = Math.max(Math.round(allSelections.reduce((a,s) => a*s.odds, 1)), 10);
  // Exact odds slider
  const exSlider = $("stanceTargetOdds");
  if (exSlider) { exSlider.max = totalOdds; exSlider.value = Math.min(500, totalOdds); const d = $("exactOddsVal"); if (d) d.textContent = exSlider.value + "x"; const m = $("exactOddsMax"); if (m) m.textContent = totalOdds + "x"; }
  // Range dual sliders
  const mnS = $("minOdds"), mxS = $("maxOdds");
  if (mnS) { mnS.max = totalOdds; mnS.value = 1; }
  if (mxS) { mxS.max = totalOdds; mxS.value = totalOdds; }
  const rml = $("rangeMaxLabel"); if (rml) rml.textContent = totalOdds + "x";
  // Leg count dual sliders
  const lgN = $("topN"), lgNM = $("topNMax");
  if (lgN) { lgN.max = allSelections.length; lgN.value = 1; }
  if (lgNM) { lgNM.max = allSelections.length; lgNM.value = allSelections.length; }
  const lgMax = $("legCountMax"); if (lgMax) lgMax.textContent = allSelections.length;
  setOddsMode("off"); setLegMode("auto");
  wizGo("opt", 2);
}

window.smartRouteChoice = function(choice) {
  $("smartRouteModal").classList.add("hidden");
  if (!pendingSmartRoute) return;
  const { code, json, futureOnly } = pendingSmartRoute;
  pendingSmartRoute = null;
  if (choice === "scanner") {
    $("scanCode").value = code;
    activateTab("scanner");
    scanSlip();
  } else {
    const futureJson = { ...json, selections: futureOnly };
    initOptimizer(futureJson);
  }
};

// Safety Score calculation
async function fetchSafetyScore(sel) {
  if (safetyScores[sel.eventId] !== undefined) return safetyScores[sel.eventId];
  try {
    const r = await fetch(`/api/h2h?eventId=${encodeURIComponent(sel.eventId)}&home=${encodeURIComponent(sel.homeTeam)}&away=${encodeURIComponent(sel.awayTeam)}`);
    const j = await r.json();
    if (!j.found) { safetyScores[sel.eventId] = 50; return 50; }
    const ks = j.keyStats || {};
    let score = 50;
    const pick = (sel.outcome || "").toLowerCase();
    const mkt = (sel.market || "").toLowerCase();
    const avg = ks.avgGoals;
    const btts = ks.bttsPct;

    if (avg !== null && avg !== undefined) {
      if (avg < 1.5) {
        if (pick.includes("over 1.5")) score -= 20;
        if (pick.includes("over 2.5")) score -= 25;
        if (pick.includes("under")) score += 20;
      } else if (avg <= 2.5) {
        if (pick.includes("over 1.5")) score += 15;
        if (pick.includes("over 2.5")) score -= 5;
      } else {
        if (pick.includes("over 2.5")) score += 20;
        if (pick.includes("over 3.5")) score += 5;
      }
    }
    if (btts !== null && btts !== undefined) {
      if (btts > 60 && mkt.includes("gg") && pick.includes("yes")) score += 20;
      if (btts < 40 && mkt.includes("gg") && pick.includes("yes")) score -= 20;
      if (btts < 40 && mkt.includes("gg") && pick.includes("no")) score += 20;
    }
    // H2H home/away dominance
    if (j.h2h?.length >= 3) {
      const homeWins = j.h2h.filter(m => m.homeScore > m.awayScore).length;
      if (homeWins >= 4 && pick.includes("home")) score += 25;
      if (homeWins <= 1 && pick.includes("home")) score -= 25;
      const awayWins = j.h2h.filter(m => m.awayScore > m.homeScore).length;
      if (awayWins >= 4 && pick.includes("away")) score += 25;
    }
    // Team form
    if (j.homeForm?.length >= 3) {
      const hw = j.homeForm.filter(f => f.result === "W").length;
      if (hw >= 4 && (pick.includes("home") || pick.includes("1"))) score += 10;
    }
    if (j.awayForm?.length >= 3) {
      const aw = j.awayForm.filter(f => f.result === "W").length;
      if (aw >= 4 && (pick.includes("away") || pick.includes("2"))) score += 10;
    }
    score = Math.max(0, Math.min(100, score));
    safetyScores[sel.eventId] = score;
    return score;
  } catch { safetyScores[sel.eventId] = 50; return 50; }
}

function safetyClass(score) { return score >= 70 ? "safety-strong" : score >= 40 ? "safety-neutral" : "safety-risky"; }
function safetyLabel(score) { return score >= 70 ? "Strong" : score >= 40 ? "Neutral" : "Risky"; }

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
    if (bankers.has(s.eventId)) return { ...s, removed: false };
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

  // Stance-based behavior
  const activeStance = document.querySelector(".stance-card.active")?.dataset?.stance || "manual";
  if (activeStance === "value") {
    // Aggressive: keep ALL games, no removals, sort by highest odds
    filtered = filtered.map(s => ({...s, removed: false}));
    filtered.sort((a,b) => b.odds - a.odds);
  } else if (activeStance === "safe") {
    // Safe: after conversion (async), also remove games with odds > 1.60
    filtered = filtered.map(s => {
      if (bankers.has(s.eventId)) return s;
      if (!s.removed && s.odds > 1.60) return {...s, removed: true};
      return s;
    });
  } else if (activeStance === "balanced") {
    // Balanced: keep games with odds 1.20-2.50, keep at least 60%
    filtered = filtered.map(s => {
      if (bankers.has(s.eventId)) return s;
      if (!s.removed && (s.odds < 1.20 || s.odds > 2.50)) return {...s, removed: true};
      return s;
    });
    const minKeep = Math.max(3, Math.ceil(allSelections.length * 0.6));
    const keptCount = filtered.filter(s => !s.removed).length;
    if (keptCount < minKeep) {
      const removedSorted = filtered.filter(s => s.removed && !bankers.has(s.eventId)).sort((a,b) => a.odds - b.odds);
      let toRestore = minKeep - keptCount;
      for (const s of removedSorted) {
        if (toRestore <= 0) break;
        const idx = filtered.findIndex(f => f.eventId === s.eventId);
        if (idx !== -1) { filtered[idx] = {...filtered[idx], removed: false}; toRestore--; }
      }
    }
  }

  // NEVER show 0 games — always keep at least 3
  const MIN_GAMES = 3;
  let keptNow = filtered.filter(s => !s.removed);
  if (keptNow.length < MIN_GAMES && allSelections.length >= MIN_GAMES) {
    const allSorted = [...allSelections].sort((a,b) => a.odds - b.odds);
    const forceKeep = new Set(allSorted.slice(0, MIN_GAMES).map(s => s.eventId));
    filtered = filtered.map(s => forceKeep.has(s.eventId) ? {...s, removed: false} : s);
    const noticeEl = $("optNotice");
    if (noticeEl) { noticeEl.textContent = "Some filters were relaxed to keep enough games for a valid slip"; noticeEl.classList.remove("hidden"); }
  } else if (keptNow.length === 0 && allSelections.length > 0) {
    filtered = filtered.map(s => ({...s, removed: false}));
    const noticeEl = $("optNotice");
    if (noticeEl) { noticeEl.textContent = "Filters would remove all games. Showing full slip instead."; noticeEl.classList.remove("hidden"); }
  }

  // Intelligence filters — async, uses safety scores
  const hasIntel = ["intel-strong","intel-no-risky","intel-top10","intel-confidence"].some(a => presets.has(a));
  if (hasIntel) {
    applyIntelFilter(presets, afterTime, beforeTime, rmM, rmL, maxO, minO, topN);
    return;
  }

  const kept = filtered.filter(s=>!s.removed), removed = filtered.filter(s=>s.removed);
  renderOpt(kept, removed);
  renderActiveChips(presets, afterTime, beforeTime, rmM, rmL, maxO, minO, topN);

  // Safe stance: async convert risky picks
  if (activeStance === "safe" && kept.length > 0) applyStanceConversions(kept);
}

async function applyIntelFilter(presets, afterTime, beforeTime, rmM, rmL, maxO, minO, topN) {
  showToast("Calculating safety scores...", "info");
  const remaining = filtered.filter(s => !s.removed);
  await Promise.all(remaining.slice(0, 20).map(s => fetchSafetyScore(s)));

  if (presets.has("intel-strong")) {
    filtered = filtered.map(s => {
      if (s.removed) return s;
      const sc = safetyScores[s.eventId]; return (sc !== undefined && sc < 70) ? { ...s, removed: true } : s;
    });
  }
  if (presets.has("intel-no-risky")) {
    filtered = filtered.map(s => {
      if (s.removed) return s;
      const sc = safetyScores[s.eventId]; return (sc !== undefined && sc < 40) ? { ...s, removed: true } : s;
    });
  }
  if (presets.has("intel-top10")) {
    const scored = filtered.filter(s => !s.removed && safetyScores[s.eventId] !== undefined).sort((a, b) => (safetyScores[b.eventId] || 0) - (safetyScores[a.eventId] || 0));
    if (scored.length > 10) {
      const keep = new Set(scored.slice(0, 10).map(s => s.eventId));
      filtered = filtered.map(s => (!s.removed && !keep.has(s.eventId)) ? { ...s, removed: true } : s);
    }
  }
  if (presets.has("intel-confidence")) {
    for (const s of filtered) {
      if (s.removed) continue;
      const sc = safetyScores[s.eventId];
      if (sc !== undefined && sc < 40) {
        await optimizePick(s.eventId);
      }
    }
  }

  const kept = filtered.filter(s => !s.removed), removed = filtered.filter(s => s.removed);
  renderOpt(kept, removed);
  renderActiveChips(presets, afterTime, beforeTime, rmM, rmL, maxO, minO, topN);
}

async function applyStanceConversions(kept) {
  let converted = 0;
  for (const s of kept) {
    if (bankers.has(s.eventId)) continue;
    const out = (s.outcome || "").toLowerCase();
    const mkt = (s.market || "").toLowerCase();
    let sug = null;
    try {
      const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
      if (!j.markets?.length) continue;
      const overMatch = out.match(/^over (\d+\.?\d*)$/i);
      // Over 3.5+ → Over 2.5
      if (overMatch && parseFloat(overMatch[1]) >= 3) {
        sug = j.markets.find(m => m.outcomeName === "Over 2.5" && m.marketName.toLowerCase().includes("over/under"));
      }
      // Over 2.5 → Over 1.5
      if (!sug && overMatch && parseFloat(overMatch[1]) >= 2 && parseFloat(overMatch[1]) < 3) {
        sug = j.markets.find(m => m.outcomeName === "Over 1.5" && m.marketName.toLowerCase().includes("over/under"));
      }
      // Home Win → Double Chance 1X
      if (!sug && mkt === "1x2" && out === "home") {
        sug = j.markets.find(m => m.marketName === "Double Chance" && m.outcomeName === "Home or Draw");
      }
      // Away Win → Double Chance X2
      if (!sug && mkt === "1x2" && out === "away") {
        sug = j.markets.find(m => m.marketName === "Double Chance" && m.outcomeName === "Draw or Away");
      }
      // BTTS Yes → Over 1.5
      if (!sug && mkt.includes("gg") && out === "yes") {
        sug = j.markets.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 1.5");
      }
      // Correct Score → Over 1.5
      if (!sug && mkt.includes("correct score")) {
        sug = j.markets.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 1.5");
      }
      if (sug) {
        const upd = {market:sug.marketName,outcome:sug.outcomeName,odds:sug.odds,marketId:sug.marketId,outcomeId:sug.outcomeId,specifier:sug.specifier||""};
        const fi = filtered.findIndex(f => f.eventId === s.eventId);
        if (fi !== -1) filtered[fi] = {...filtered[fi], ...upd};
        const ai = allSelections.findIndex(a => a.eventId === s.eventId);
        if (ai !== -1) allSelections[ai] = {...allSelections[ai], ...upd};
        changedEventIds.add(s.eventId);
        converted++;
      }
    } catch {}
  }
  if (converted > 0) {
    renderOpt(filtered.filter(s=>!s.removed), filtered.filter(s=>s.removed));
    showToast(`Safe mode: ${converted} picks converted`, "success");
  }
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
  $("originalTable").innerHTML = (bankers.size ? `<div style="padding:8px 14px;font-size:12px;color:var(--green)">&#128737; ${bankers.size} banker${bankers.size>1?'s':''} locked <button class="btn-sm" onclick="bankers.clear();renderOpt(filtered.filter(s=>!s.removed),filtered.filter(s=>s.removed))" style="margin-left:8px">Clear</button></div>` : '') + renderCards(allSelections, {banker:true});
  // Step 3 optimized slip — minimal cards (no action buttons)
  $("optimizedTable").innerHTML = kept.length ? renderCards(kept) : '<div class="empty-state">All removed</div>';
  if (removed.length) { $("removedSection").classList.remove("hidden"); $("removedTable").innerHTML = renderCards(removed, {removed:true}); }
  else $("removedSection").classList.add("hidden");
  $("generateBtn").disabled = !(kept.length > 0);
  $("generateResult").classList.add("hidden");
  $("codeCard").classList.add("hidden");
  // Step 3 result stats
  const rg = $("resultGames"); if (rg) rg.textContent = kept.length;
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

// ── Generate (5 codes: Ultra Safe / Safe / Balanced / Value / Aggressive) ──
let tripleCodeResults = {};

function buildVariant(sels, mode) {
  const sorted = [...sels].sort((a,b) => a.odds - b.odds);
  if (mode === "ultrasafe") return sorted.slice(0, Math.min(5, sorted.length));
  if (mode === "safe") return sorted.slice(0, Math.min(10, sorted.length));
  if (mode === "value") { return [...sels].sort((a,b) => b.odds - a.odds).slice(0, Math.max(1, Math.round(sels.length * 0.5))); }
  if (mode === "aggressive") return [...sels].sort((a,b) => b.odds - a.odds);
  return sels; // balanced = full set
}

async function genOneCode(sels) {
  const r = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:genPayload(sels)})});
  return r.json();
}

$("generateBtn").addEventListener("click", async () => {
  const kept = filtered.filter(s=>!s.removed && !excluded.has(s.eventId)); if (!kept.length) return;
  $("generateBtn").disabled = true; $("generateBtn").textContent = "Generating 5 codes...";
  $("generateResult").classList.add("hidden"); $("codeCard").classList.add("hidden"); $("tripleCards").classList.add("hidden");

  const variants = {
    ultrasafe: buildVariant(kept, "ultrasafe"),
    safe: buildVariant(kept, "safe"),
    balanced: buildVariant(kept, "balanced"),
    value: buildVariant(kept, "value"),
    aggressive: buildVariant(kept, "aggressive"),
  };

  try {
    const results = await Promise.all(Object.values(variants).map(v => genOneCode(v)));
    const keys = Object.keys(variants);
    keys.forEach((k,i) => { tripleCodeResults[k] = results[i]; });

    const labels = { ultrasafe: "Ultra Safe", safe: "Safe", balanced: "Balanced", value: "Value", aggressive: "Aggressive" };
    const classes = { ultrasafe: "safe", safe: "safe", balanced: "balanced", value: "value", aggressive: "value" };

    const card = (key, res, sels) => {
      if (!res.success) return `<div class="triple-card"><div class="triple-card-label ${classes[key]}">${labels[key]}</div><div style="color:var(--red);font-size:12px">Failed</div></div>`;
      const odds = sels.reduce((a,s) => a*s.odds, 1);
      return `<div class="triple-card"><div class="triple-card-label ${classes[key]}">${labels[key]}</div><div class="triple-card-code mono">${esc(res.shareCode)}</div><div class="triple-card-meta"><strong>${sels.length}</strong> games &middot; <strong>${odds.toFixed(1)}x</strong></div><button class="btn btn-green" onclick="copyToClipboard(${jsArg(res.shareCode)},this)">Copy</button></div>`;
    };

    $("tripleCards").innerHTML = keys.map(k => card(k, tripleCodeResults[k], variants[k])).join("");
    $("tripleCards").classList.remove("hidden");
    $("notSatisfiedHint").classList.remove("hidden");
    $("generateBtn").classList.add("hidden");
    showToast("5 codes generated", "success");
  } catch(e) {
    $("generateResult").classList.remove("hidden");
    $("generateResult").innerHTML = `<div class="gen-error"><div class="gen-error-msg">${esc(e.message)}</div></div>`;
  } finally { $("generateBtn").disabled = false; $("generateBtn").textContent = "Generate Codes"; }
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

  // Find current pick for this event to show quick-flip
  const sel = allSelections.find(s => s.eventId === currentMktEvt);
  let quickFlipHtml = "";
  if (sel) {
    const curOut = sel.outcome || "";
    const flips = [];
    // Over ↔ Under flip
    const overMatch = curOut.match(/^(Over|Under)\s+(.+)$/i);
    if (overMatch) {
      const opposite = overMatch[1].toLowerCase() === "over" ? "Under" : "Over";
      const val = overMatch[2];
      const target = d.markets.find(m => m.outcomeName === `${opposite} ${val}` && m.specifier === sel.specifier);
      if (target) flips.push({ label: `${curOut} ↔ ${opposite} ${val}`, to: target });
    }
    // Yes ↔ No flip (BTTS, any Yes/No market)
    if (/^(Yes|No)$/i.test(curOut)) {
      const opp = curOut.toLowerCase() === "yes" ? "No" : "Yes";
      const target = d.markets.find(m => m.outcomeName === opp && m.marketId === sel.marketId);
      if (target) flips.push({ label: `${curOut} ↔ ${opp}`, to: target });
    }
    // 1X2: show other two options
    if (sel.market === "1X2" || sel.market === "Match Result") {
      ["Home", "Draw", "Away"].forEach(opt => {
        if (opt !== curOut) {
          const target = d.markets.find(m => m.outcomeName === opt && m.marketId === sel.marketId);
          if (target) flips.push({ label: `→ ${opt}`, to: target });
        }
      });
    }
    if (flips.length) {
      quickFlipHtml = `<div style="padding:12px 20px;border-bottom:1px solid var(--border)"><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Quick Flip: ${esc(curOut)}</div><div style="display:flex;gap:6px;flex-wrap:wrap">${flips.map(f =>
        `<button class="btn-sm btn-use" data-mid="${attr(f.to.marketId)}" data-oid="${attr(f.to.outcomeId)}" data-spec="${attr(f.to.specifier)}" data-mname="${attr(f.to.marketName)}" data-oname="${attr(f.to.outcomeName)}" data-odds="${f.to.odds}" onclick="useThisMarket(this)">${esc(f.label)} <span class="mkt-outcome-odds">${f.to.odds.toFixed(2)}</span></button>`
      ).join("")}</div></div>`;
    }
  }

  const groups=[]; const seen=new Map();
  d.markets.forEach(m => { const k=`${m.marketId}|${m.specifier}`; if(!seen.has(k)){seen.set(k,{marketName:m.marketName,specifier:m.specifier,outcomes:[]});groups.push(seen.get(k));} seen.get(k).outcomes.push(m); });
  $("modalBody").innerHTML = quickFlipHtml + `<div class="mkt-th"><span>Outcome</span><span>Odds</span><span></span></div>`+groups.map((g,i) =>
    `<div class="mkt-group ${i<3?"open":""}" onclick="this.classList.toggle('open')"><div class="mkt-group-header"><span class="mkt-group-chevron">&#9654;</span><span class="mkt-group-name">${esc(g.marketName)}${g.specifier?" ("+esc(g.specifier)+")":""}</span><span class="mkt-group-count">${g.outcomes.length}</span></div><div class="mkt-outcomes">${g.outcomes.map(o =>
      `<div class="mkt-outcome-row"><span class="mkt-outcome-name">${esc(o.outcomeName)}</span><span class="mkt-outcome-odds">${o.odds.toFixed(2)}</span><button class="btn-sm btn-use" data-mid="${attr(o.marketId)}" data-oid="${attr(o.outcomeId)}" data-spec="${attr(o.specifier)}" data-mname="${attr(o.marketName)}" data-oname="${attr(o.outcomeName)}" data-odds="${o.odds}" onclick="useThisMarket(this)">Use</button></div>`
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
    wizGo("merger", 2);
  } catch(e) { showErr("mergerError",e.message); }
  finally { $("mergerLoadBtn").disabled = false; $("mergerLoadBtn").textContent = "Fetch All & Merge"; }
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
  try { const r = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:genPayload(mergerSelections)})}); renderGenResult("mergerGenResult", await r.json(), mergerSelections); wizGo("merger", 3); }
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
    $("splitterResults").innerHTML = ""; $("splitterCopyAll").classList.add("hidden"); $("splitterGenerateAll").classList.add("hidden");
    const ec = $("extractCount"); if (ec) { ec.max = j.selections.length; ec.value = Math.min(10, j.selections.length); $("extractCountVal").textContent = ec.value; }
    renderSplitterSelections();
    wizGo("split", 2);
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
    wizGo("split", 3);
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

// Splitter mode toggles
window.setSplitMode = function(mode) {
  const em = $("extractMode"), sm = $("splitMode");
  document.querySelectorAll("#splitterConfig > .pill-row .pill").forEach((b,i) => b.classList.toggle("active", (mode==="split"?0:1)===i));
  if (em) em.classList.toggle("hidden", mode !== "extract");
  if (sm) sm.classList.toggle("hidden", mode !== "split");
};
window.setSplitCount = function(n) {
  $("splitCount").value = n;
  document.querySelectorAll(".split-count-pill").forEach(b => b.classList.toggle("active", b.textContent === String(n)));
};
window.setSplitMethod = function(m) {
  $("splitMethod").value = m;
  document.querySelectorAll(".split-method-pill").forEach(b => b.classList.toggle("active", b.textContent.toLowerCase().includes(m === "roundRobin" ? "balanced" : m === "byOdds" ? "odds" : "random")));
};

// Extract mode
window.extractAndGen = async function(mode) {
  const n = parseInt($("extractCount")?.value || 10);
  const sorted = [...splitterSels].sort((a,b) => a.odds - b.odds);
  let sels;
  if (mode === "safe") sels = sorted.slice(0, n);
  else if (mode === "value") sels = sorted.reverse().slice(0, n);
  else sels = sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.1) + n);
  if (!sels.length) return;
  sels = await applySmartEdits(sels);
  try {
    const r = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:genPayload(sels)})});
    const j = await r.json();
    const el = $("extract" + mode.charAt(0).toUpperCase() + mode.slice(1));
    if (j.success && el) { el.textContent = j.shareCode; showToast(mode + ": " + j.shareCode, "success"); }
  } catch(e) { showToast(e.message, "error"); }
};

window.extractAllThree = async function() {
  await extractAndGen("safe"); await extractAndGen("balanced"); await extractAndGen("value");
};

// Smart Edits: apply conversions to selections before generating
async function applySmartEdits(sels) {
  const on = id => $(id)?.classList?.contains("on");
  const edits = [];
  if (on("spHome1x")) edits.push({ mkt: "1x2", out: "home", target: "Double Chance", name: "Home or Draw" });
  if (on("spAwayX2")) edits.push({ mkt: "1x2", out: "away", target: "Double Chance", name: "Draw or Away" });
  if (on("spHomeDnb")) edits.push({ mkt: "1x2", out: "home", target: "Draw No Bet", name: "Home" });
  if (on("spOver35")) edits.push({ type: "over", minVal: 3, toVal: 2.5 });
  if (on("spOver25")) edits.push({ type: "over", minVal: 2, toVal: 1.5 });
  if (on("spBtts")) edits.push({ mkt: "gg", out: "yes", target: "Over/Under", name: "Over 1.5" });
  if (on("spCS")) edits.push({ mkt: "correct score", target: "Over/Under", name: "Over 1.5" });
  const removeDraw = on("spDraw");

  if (edits.length === 0 && !removeDraw) return sels;

  const result = [];
  for (const s of sels) {
    const out = (s.outcome || "").toLowerCase();
    const mkt = (s.market || "").toLowerCase();
    if (removeDraw && mkt === "1x2" && out === "draw") continue;
    let converted = false;
    for (const e of edits) {
      if (e.type === "over") {
        const m = out.match(/^over (\d+\.?\d*)$/i);
        if (m && parseFloat(m[1]) >= e.minVal) {
          try {
            const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
            const t = j.markets?.find(mk => mk.outcomeName === `Over ${e.toVal}` && mk.marketName.toLowerCase().includes("over/under"));
            if (t) { result.push({...s, market:t.marketName, outcome:t.outcomeName, odds:t.odds, marketId:t.marketId, outcomeId:t.outcomeId, specifier:t.specifier||""}); converted = true; break; }
          } catch {}
        }
      } else if (e.mkt && mkt.includes(e.mkt) && (!e.out || out === e.out)) {
        try {
          const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
          const t = j.markets?.find(mk => mk.marketName === e.target && (e.name ? mk.outcomeName.includes(e.name) || mk.outcomeName === e.name : true));
          if (t) { result.push({...s, market:t.marketName, outcome:t.outcomeName, odds:t.odds, marketId:t.marketId, outcomeId:t.outcomeId, specifier:t.specifier||""}); converted = true; break; }
        } catch {}
      }
    }
    if (!converted) result.push(s);
  }
  return result;
}

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
    $("scanResults").classList.remove("hidden");
    renderScanResults();
    if ($("scanPunterName").value.trim()) $("scanAutoSave").classList.remove("hidden");
  } catch(e) { showErr("scanError",e.message); }
  finally { $("scanBtn").disabled = false; $("scanBtn").textContent = "Scan Results"; }
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

function showLeaderboardView() {
  $("lbGate").classList.add("hidden");
  $("lbPublic").classList.add("hidden");
  $("lbAdmin").classList.add("hidden");
  if (isAdmin) {
    $("lbAdmin").classList.remove("hidden");
    loadLeaderboard();
  } else {
    $("lbGate").classList.remove("hidden");
    loadPublicLeaderboard();
  }
}

window.lbAdminLogin = async function() {
  const pw = $("lbPw").value;
  if (!pw) return;
  try {
    const r = await fetch("/api/admin/verify", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});
    const j = await r.json();
    if (j.success) {
      isAdmin = true; window.__adminPw = pw;
      document.body.classList.add("admin-mode");
      $("adminBadge").classList.remove("hidden");
      $("lbGate").classList.add("hidden");
      $("lbAdmin").classList.remove("hidden");
      loadLeaderboard();
      showToast("Admin access granted", "success");
    } else { showErr("lbGateErr", "Wrong password"); }
  } catch(e) { showErr("lbGateErr", e.message); }
};

async function loadPublicLeaderboard() {
  try {
    const r = await fetch("/api/punters");
    const data = (await r.json()).leaderboard || [];
    const el = $("lbPublicTable");
    if (!data.length) { el.innerHTML = '<div class="empty-state">No punters tracked yet.</div>'; return; }
    el.innerHTML = `<table class="lb-table"><thead><tr><th>#</th><th>Punter</th><th>Slips</th><th>Hit Rate</th><th></th></tr></thead><tbody>${data.map((p,i) => `<tr><td style="font-weight:800;color:${i<3?'#ffb300':'#8a9e8a'}">${i+1}</td><td style="font-weight:700">${esc(p.name)}</td><td>${p.slipCount}</td><td style="color:#00c853;font-weight:800">${p.hitRate}%</td><td><button class="btn-sm" onclick="showPublicAddCode(this,'${esc(p.name)}')">Add Code</button></td></tr>`).join("")}</tbody></table>`;
    $("lbPublic").classList.remove("hidden");
  } catch {}
}

window.showPublicAddCode = function(btn, name) {
  const row = btn.closest("tr");
  if (row.nextElementSibling?.classList.contains("lb-add-row")) { row.nextElementSibling.remove(); return; }
  const addRow = document.createElement("tr");
  addRow.className = "lb-add-row";
  addRow.innerHTML = `<td colspan="5" style="padding:8px"><div style="display:flex;gap:8px;align-items:center"><input type="text" class="field" placeholder="Booking code" id="pubAdd_${name.replace(/\s/g,'_')}" style="max-width:140px;padding:6px 10px;font-size:12px" /><button class="btn-sm btn-optimize" onclick="pubAddCode('${name}')">Scan & Add</button><span id="pubAddMsg_${name.replace(/\s/g,'_')}" style="font-size:11px;color:#8a9e8a"></span></div></td>`;
  row.after(addRow);
};

window.pubAddCode = async function(name) {
  const key = name.replace(/\s/g, "_");
  const code = $("pubAdd_" + key)?.value?.trim().toUpperCase();
  const msg = $("pubAddMsg_" + key);
  if (!code) return;
  if (!isAdmin) { if (msg) msg.textContent = "Admin access required"; return; }
  if (msg) msg.textContent = "Scanning...";
  try {
    const r = await fetch("/api/punters/" + encodeURIComponent(name) + "/add-code", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": window.__adminPw }, body: JSON.stringify({ code, date: new Date().toISOString().slice(0, 10) }) });
    const j = await r.json();
    if (j.success) { if (msg) msg.textContent = j.won + "W/" + j.lost + "L/" + j.void + "V (" + j.hitRate + "%)"; showToast(name + ": " + j.hitRate + "% hit", "success"); loadPublicLeaderboard(); }
    else { if (msg) msg.textContent = j.error || "Failed"; }
  } catch (e) { if (msg) msg.textContent = e.message; }
};

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

function formPillsArr(arr) {
  if (!arr?.length) return '<span class="empty-inline">No form data</span>';
  return `<div class="form-pills">${arr.slice(0,5).map(r => { const v = typeof r === "string" ? r : (r.result || "D"); return `<span class="form-pill form-${esc(v)}">${esc(v)}</span>`; }).join("")}</div>`;
}

function parseProxyH2H(data, home, away, pick) {
  // SportyBet raw data can have various structures — extract what we can
  const matches = [];
  function dig(node) {
    if (!node || matches.length >= 20) return;
    if (Array.isArray(node)) { node.forEach(dig); return; }
    if (typeof node === "object") {
      if (node.homeTeamName && node.awayTeamName && (node.homeScore !== undefined || node.setScore)) {
        const hs = node.homeScore ?? parseInt((node.setScore || "").split(":")[0]);
        const as = node.awayScore ?? parseInt((node.setScore || "").split(":")[1]);
        if (!isNaN(hs) && !isNaN(as)) matches.push({ date: node.matchDate || node.date || "", home: node.homeTeamName, away: node.awayTeamName, homeScore: hs, awayScore: as });
      }
      Object.values(node).forEach(dig);
    }
  }
  dig(data);

  // Extract win probability if present
  let winProb = null;
  if (data.homeWinRate || data.drawRate || data.awayWinRate) winProb = { home: data.homeWinRate, draw: data.drawRate, away: data.awayWinRate };

  const h2h = matches.filter(m => {
    const names = [m.home.toLowerCase(), m.away.toLowerCase()];
    return names.includes(home.toLowerCase()) && names.includes(away.toLowerCase());
  }).slice(0, 5);

  const usable = h2h.length ? h2h : matches.slice(0, 5);
  const avgGoals = usable.length ? Math.round(usable.reduce((s,m) => s + m.homeScore + m.awayScore, 0) / usable.length * 10) / 10 : null;
  const bttsPct = usable.length ? Math.round(usable.filter(m => m.homeScore > 0 && m.awayScore > 0).length / usable.length * 100) : null;
  const over25Pct = usable.length ? Math.round(usable.filter(m => m.homeScore + m.awayScore > 2.5).length / usable.length * 100) : null;
  const homeWins = usable.filter(m => m.homeScore > m.awayScore).length;
  const homeWinRate = usable.length ? Math.round(homeWins / usable.length * 100) : null;

  const formOf = (team) => matches.filter(m => m.home.toLowerCase().includes(team.toLowerCase().slice(0,5)) || m.away.toLowerCase().includes(team.toLowerCase().slice(0,5))).slice(0,5).map(m => {
    const isH = m.home.toLowerCase().includes(team.toLowerCase().slice(0,5));
    const gf = isH ? m.homeScore : m.awayScore, ga = isH ? m.awayScore : m.homeScore;
    return gf > ga ? "W" : gf < ga ? "L" : "D";
  });

  return {
    found: matches.length > 0,
    source: "SportyBet",
    homeTeam: { name: home, form: formOf(home) },
    awayTeam: { name: away, form: formOf(away) },
    h2h: h2h.map(m => ({ ...m, result: m.homeScore > m.awayScore ? "H" : m.homeScore < m.awayScore ? "A" : "D" })),
    keyStats: { avgGoals, bttsPct, over25Pct, homeWinRate },
    winProbability: winProb,
    confidence: avgGoals !== null && avgGoals > 3 ? "Strong" : bttsPct !== null && bttsPct < 40 ? "Risky" : "Neutral",
  };
}

window.openH2H = async function(eid, home, away) {
  $("h2hDrawer").classList.remove("hidden"); $("h2hTitle").textContent = `${home} vs ${away}`;
  $("h2hBody").innerHTML = '<div class="modal-loading">Loading stats...</div>';

  const sel = allSelections.find(s => s.eventId === eid);
  const pickStr = sel ? sel.outcome : "";

  try {
    // Try SportyBet proxy first (fastest, no API key needed)
    let j = null;
    try {
      const proxyRes = await fetch(`/api/proxy-h2h/${encodeURIComponent(eid)}`);
      const proxyJ = await proxyRes.json();
      if (proxyJ.found && proxyJ.data) {
        console.log("[H2H] SportyBet proxy hit:", eid);
        j = parseProxyH2H(proxyJ.data, home, away, pickStr);
      }
    } catch(e) { console.log("[H2H] Proxy failed:", e.message); }

    // Fall back to /api/h2h (API-Football → TheSportsDB)
    if (!j || !j.found) {
      const r = await fetch(`/api/h2h?eventId=${encodeURIComponent(eid)}&home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&pick=${encodeURIComponent(pickStr)}`);
      j = await r.json();
    }

    if (!j?.found) { $("h2hBody").innerHTML = '<div class="empty-state">No match data found. Stats are available for most football leagues.</div>'; return; }

    const stats = j.keyStats || {};
    const homeForm = j.homeTeam?.form || j.homeForm || [];
    const awayForm = j.awayTeam?.form || j.awayForm || [];
    const homeName = j.homeTeam?.name || home;
    const awayName = j.awayTeam?.name || away;

    let html = "";

    // Safety score bar
    if (j.safetyScore !== undefined) {
      const sc = j.safetyScore, cls = sc >= 70 ? "safety-strong" : sc >= 40 ? "safety-neutral" : "safety-risky";
      html += `<div class="${cls}" style="margin-bottom:16px"><div class="safety-bar" style="height:8px"><div class="safety-fill" style="width:${sc}%"></div></div><span class="safety-label ${cls}" style="font-size:12px">${j.safetyLabel || ""} ${sc}/100</span></div>`;
    }

    // Confidence + source
    html += `<div class="h2h-summary"><span class="confidence confidence-${esc(j.confidence || "Neutral").toLowerCase()}">${j.safetyScore >= 70 ? "&#10003; " : j.safetyScore < 40 ? "&#9888; " : ""}${esc(j.confidence || "Neutral")}</span><span style="font-size:11px;color:var(--text3)">${esc(j.source || "")}</span></div>`;

    // Recommendation
    if (j.recommendation) html += `<p style="font-size:12px;color:var(--text2);margin:8px 0 16px;padding:10px;background:var(--bg);border-radius:var(--radius);border-left:3px solid ${j.safetyScore >= 70 ? 'var(--green)' : j.safetyScore < 40 ? 'var(--red)' : 'var(--amber)'}">${esc(j.recommendation)}</p>`;

    // Stats grid
    html += `<div class="key-stat-grid"><div><strong>${stats.avgGoals ?? "--"}</strong><span>Avg Goals</span></div><div><strong>${stats.bttsPct ?? "--"}${stats.bttsPct != null ? "%" : ""}</strong><span>BTTS</span></div><div><strong>${stats.over25Pct ?? "--"}${stats.over25Pct != null ? "%" : ""}</strong><span>Over 2.5</span></div>${stats.homeWinRate != null ? `<div><strong>${stats.homeWinRate}%</strong><span>Home Win</span></div>` : ""}</div>`;

    // Team form
    html += `<h4 class="h2h-section-title">${esc(homeName)} Form</h4>${formPillsArr(homeForm)}`;
    html += `<h4 class="h2h-section-title">${esc(awayName)} Form</h4>${formPillsArr(awayForm)}`;

    // H2H matches
    if (j.h2h?.length) {
      html += `<h4 class="h2h-section-title">Head to Head</h4>`;
      html += j.h2h.map(e => {
        const rIcon = e.result === "H" ? "&#127968;" : e.result === "A" ? "&#9992;" : "&#9878;";
        return `<div class="h2h-match"><span class="h2h-date">${esc(e.date||"")}</span><span>${esc(e.home)} <strong>${e.homeScore}-${e.awayScore}</strong> ${esc(e.away)}</span><span>${rIcon}</span></div>`;
      }).join("");
    }

    // Auto-optimize button
    if (eid && j.safetyScore < 40) html += `<button class="btn btn-green" style="width:100%;margin-top:16px" onclick="optimizePick(${jsArg(eid)});$('h2hDrawer').classList.add('hidden')">Auto-Optimize This Pick</button>`;

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

if (getSharedPunterName() || location.pathname.startsWith("/admin/leaderboard")) activateTab("leaderboard");

// PWA detection (used for install prompt logic only — always show homepage)
const isPWA = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

// ── Convert Tab ──
let convertOriginal = [], convertResult = [];

$("convertLoadBtn").addEventListener("click", loadConvert);
$("convertCode").addEventListener("keydown", e => { if (e.key === "Enter") loadConvert(); });

async function loadConvert() {
  const code = $("convertCode").value.trim().toUpperCase();
  if (!code) return showErr("convertError", "Enter a code");
  showErr("convertError", ""); $("convertLoadBtn").disabled = true; $("convertLoadBtn").textContent = "Loading...";
  try {
    const r = await fetch(`/api/booking/${encodeURIComponent(code)}`); const j = await r.json();
    if (!r.ok) throw new Error(j.error); if (!j.selections?.length) throw new Error("No selections");
    convertOriginal = j.selections.map(s => ({...s}));
    convertResult = j.selections.map(s => ({...s}));
    $("convertResults").classList.remove("hidden");
    renderConvert();
  } catch(e) { showErr("convertError", e.message); }
  finally { $("convertLoadBtn").disabled = false; $("convertLoadBtn").textContent = "Load Slip"; }
}

let deepScanEnabled = false;
const deepScanCache = {};

function toggleDeepScan() {
  if (!deepScanEnabled && !localStorage.getItem("deepScanConsented")) {
    if (!confirm("Deep Scan\n\nBefore converting your slip, Deep Scan analyzes each game using real match data including:\n\n• Last 10 H2H meetings between the teams\n• Current team form and recent results\n• Goals scored and conceded trends\n\nThis gives you data-backed conversions instead of generic rules. It may take up to 60 seconds for large slips.\n\nEnable Deep Scan?")) return;
    localStorage.setItem("deepScanConsented", "true");
  }
  deepScanEnabled = !deepScanEnabled;
  const tgl = $("tglDeepScan");
  if (tgl) tgl.classList.toggle("on", deepScanEnabled);
  if (deepScanEnabled) showToast("Deep Scan enabled", "success");
}

async function getDeepScanData(s) {
  const key = `${s.homeTeam}|${s.awayTeam}`;
  if (deepScanCache[key]) return deepScanCache[key];
  try {
    const r = await fetch(`/api/h2h?eventId=${encodeURIComponent(s.eventId)}&home=${encodeURIComponent(s.homeTeam)}&away=${encodeURIComponent(s.awayTeam)}&pick=${encodeURIComponent(s.outcome)}`);
    const j = await r.json();
    if (j.fallback) return null;
    deepScanCache[key] = j;
    return j;
  } catch { return null; }
}

async function runConvert(mode) {
  convertResult = convertOriginal.map(s => ({...s, _changed: false, _removed: false, _oldOutcome: s.outcome, _oldMarket: s.market, _oldOdds: s.odds, _scanNote: ""}));

  const prog = $("deepScanProgress");
  for (let i = 0; i < convertResult.length; i++) {
    const s = convertResult[i];
    const out = (s.outcome || "").toLowerCase();
    const mkt = (s.market || "").toLowerCase();

    // Deep Scan: fetch H2H data and override decisions
    if (deepScanEnabled && (mode === "safer" || mode === "goals" || mode === "advanced")) {
      if (prog) { prog.classList.remove("hidden"); prog.textContent = `Analyzing ${i+1}/${convertResult.length}...`; }
      console.log(`[Deep Scan] Fetching H2H for ${s.homeTeam} vs ${s.awayTeam}`);
      const data = await getDeepScanData(s);
      if (data?.found && data.keyStats) {
        const ks = data.keyStats;
        // Calculate safety score for this pick
        let pickScore = 50;
        if (ks.avgGoals !== null && ks.avgGoals !== undefined) {
          if (ks.avgGoals > 2.5 && out.includes("over 2.5")) pickScore += 20;
          if (ks.avgGoals < 1.5 && out.includes("over 2.5")) pickScore -= 25;
          if (ks.avgGoals < 1.5 && out.includes("over 1.5")) pickScore += 10;
        }
        if (ks.bttsPct > 60 && out.includes("yes") && mkt.includes("gg")) pickScore += 15;
        if (ks.bttsPct < 30 && out.includes("yes") && mkt.includes("gg")) pickScore -= 20;
        if (ks.homeWinRate > 75 && out === "home") pickScore += 20;
        if (ks.homeWinRate < 20 && out === "home") pickScore -= 20;
        pickScore = Math.max(0, Math.min(100, pickScore));
        s._safetyScore = pickScore;
        console.log(`[Deep Scan] Safety score ${pickScore} for ${s.homeTeam} vs ${s.awayTeam}`);

        // Flag uncertain games (score < 35)
        if (pickScore < 35) { s._uncertain = true; s._scanNote = `Safety ${pickScore}/100. Stats suggest this pick is risky.`; console.log(`[Deep Scan] Removing ${s.homeTeam} vs ${s.awayTeam} (score below 35)`); }

        // Data says keep the pick
        if (ks.avgGoals > 2.5 && out.includes("over 2.5")) { s._scanNote = `Avg ${ks.avgGoals} goals. Keeping Over 2.5.`; continue; }
        if (ks.bttsPct > 70 && out.includes("yes") && mkt.includes("gg")) { s._scanNote = `BTTS ${ks.bttsPct}%. Keeping BTTS Yes.`; continue; }
        if (ks.homeWinRate > 75 && out === "home" && mkt === "1x2") { s._scanNote = `Home wins ${ks.homeWinRate}%. Keeping Home Win.`; continue; }
        if (ks.avgGoals < 1.5 && out.includes("over")) { s._scanNote = `Avg ${ks.avgGoals} goals. Extra safe conversion applied.`; }
      }
    }

    if (mode === "remove") {
      if (mkt.includes("correct score") || out.match(/over [3-9]\.5/) || (mkt.includes("gg") && out === "no") || mkt.includes("exact goals") || (mkt.includes("handicap") && /[-]1\.5/.test(s.specifier))) {
        s._removed = true; continue;
      }
    }

    if (mode === "safer" || mode === "goals") {
      const overMatch = out.match(/^over (\d+\.?\d*)$/i);
      if (overMatch) {
        const val = parseFloat(overMatch[1]);
        // Determine step size by sport/market context
        let step = 1;
        if (val > 50) step = 10; // basketball points, large totals
        else if (val > 10) step = 2; // corners, throw-ins, fouls
        else step = 1; // goals, tennis games
        const newVal = val - step;
        if (newVal >= 0.5) {
          try {
            const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
            if (j.markets) {
              const target = j.markets.find(m => m.outcomeName === `Over ${newVal}` && m.marketName.toLowerCase().includes("over/under"));
              if (target) { Object.assign(s, {market: target.marketName, outcome: target.outcomeName, odds: target.odds, marketId: target.marketId, outcomeId: target.outcomeId, specifier: target.specifier || ""}); s._changed = true; continue; }
              // Fallback: find closest lower Over in same market
              const sameType = j.markets.filter(m => m.marketId === s.marketId && /^Over /i.test(m.outcomeName) && parseFloat(m.outcomeName.match(/[\d.]+/)?.[0] || 999) < val).sort((a,b) => parseFloat(b.outcomeName.match(/[\d.]+/)?.[0]||0) - parseFloat(a.outcomeName.match(/[\d.]+/)?.[0]||0));
              if (sameType[0]) { Object.assign(s, {market: sameType[0].marketName, outcome: sameType[0].outcomeName, odds: sameType[0].odds, marketId: sameType[0].marketId, outcomeId: sameType[0].outcomeId, specifier: sameType[0].specifier || ""}); s._changed = true; continue; }
            }
          } catch {}
        }
      }
    }

    if (mode === "safer") {
      if (mkt.includes("gg") && out === "yes") {
        try {
          const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
          const t = j.markets?.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 1.5");
          if (t) { Object.assign(s, {market: t.marketName, outcome: t.outcomeName, odds: t.odds, marketId: t.marketId, outcomeId: t.outcomeId, specifier: t.specifier || ""}); s._changed = true; continue; }
        } catch {}
      }
      if (mkt === "1x2" && (out === "home" || out === "away")) {
        try {
          const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
          const dnb = j.markets?.find(m => m.marketName === "Draw No Bet" && m.outcomeName.toLowerCase().includes(out));
          if (dnb) { Object.assign(s, {market: dnb.marketName, outcome: dnb.outcomeName, odds: dnb.odds, marketId: dnb.marketId, outcomeId: dnb.outcomeId, specifier: dnb.specifier || ""}); s._changed = true; continue; }
        } catch {}
      }
      if (mkt.includes("correct score")) {
        try {
          const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
          const t = j.markets?.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 1.5");
          if (t) { Object.assign(s, {market: t.marketName, outcome: t.outcomeName, odds: t.odds, marketId: t.marketId, outcomeId: t.outcomeId, specifier: t.specifier || ""}); s._changed = true; continue; }
        } catch {}
      }
    }

    if (mode === "results") {
      if (mkt === "1x2" && out === "home") {
        try {
          const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
          const dc = j.markets?.find(m => m.marketName === "Double Chance" && m.outcomeName === "Home or Draw");
          if (dc) { Object.assign(s, {market: dc.marketName, outcome: dc.outcomeName, odds: dc.odds, marketId: dc.marketId, outcomeId: dc.outcomeId, specifier: dc.specifier || ""}); s._changed = true; }
        } catch {}
      }
      if (mkt === "1x2" && out === "away") {
        try {
          const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
          const dc = j.markets?.find(m => m.marketName === "Double Chance" && m.outcomeName === "Draw or Away");
          if (dc) { Object.assign(s, {market: dc.marketName, outcome: dc.outcomeName, odds: dc.odds, marketId: dc.marketId, outcomeId: dc.outcomeId, specifier: dc.specifier || ""}); s._changed = true; }
        } catch {}
      }
      if (mkt === "1x2" && out === "draw") s._removed = true;
    }

    // Advanced mode: read individual toggles
    if (mode === "advanced") {
      const on = id => $(id)?.classList?.contains("on");
      const overMatch = out.match(/^over (\d+\.?\d*)$/i);
      const underMatch = out.match(/^under (\d+\.?\d*)$/i);
      const val = overMatch ? parseFloat(overMatch[1]) : 0;
      const uval = underMatch ? parseFloat(underMatch[1]) : 0;
      // Goals: Over step down
      if (on("cvtOver45") && overMatch && val >= 4.5) { await tryConvertOver(s, 2.5); continue; }
      if (on("cvtOver35") && overMatch && val >= 3 && val < 4.5) { await tryConvertOver(s, 2.5); continue; }
      if (on("cvtOver25") && overMatch && val >= 2 && val < 3) { await tryConvertOver(s, 1.5); continue; }
      if (on("cvtOver15") && overMatch && val >= 1 && val < 2) { await tryConvertOver(s, 0.5); continue; }
      // Goals: Under step up (safer)
      if (on("cvtUnder15") && underMatch && uval <= 1.5) { await tryConvertUnder(s, 2.5); continue; }
      if (on("cvtUnder25") && underMatch && uval <= 2.5 && uval > 1.5) { await tryConvertUnder(s, 3.5); continue; }
      // BTTS
      if (on("cvtBtts") && mkt.includes("gg") && out === "yes") { await tryConvertToOver15(s); continue; }
      if (on("cvtBttsNo") && mkt.includes("gg") && out === "no") { await tryConvertUnder(s, 2.5); continue; }
      // Results
      if (on("cvtHome1x") && mkt === "1x2" && out === "home") { await tryConvertToDC(s, "Home or Draw"); continue; }
      if (on("cvtAwayX2") && mkt === "1x2" && out === "away") { await tryConvertToDC(s, "Draw or Away"); continue; }
      if (on("cvtHomeDnb") && mkt === "1x2" && out === "home") { await tryConvertToDNB(s, "Home"); continue; }
      if (on("cvtAwayDnb") && mkt === "1x2" && out === "away") { await tryConvertToDNB(s, "Away"); continue; }
      if (on("cvtDraw") && mkt === "1x2" && out === "draw") { s._removed = true; continue; }
      // HT markets
      if (on("cvtHT") && mkt.includes("half") && overMatch && val >= 1) { await tryConvertOver(s, Math.max(0.5, val - 1)); continue; }
      if (on("cvtHTResult") && mkt.includes("half") && mkt.includes("result") && (out==="home"||out==="away")) { await tryConvertToDC(s, out==="home"?"Home or Draw":"Draw or Away"); continue; }
      // Asian Handicap step safer
      if (on("cvtAH") && mkt.includes("handicap")) {
        const hcp = parseFloat((s.specifier||"").match(/hcp=([-\d.]+)/)?.[1] || 0);
        if (hcp <= -2) { s._removed = true; continue; }
        if (hcp === -1) { await tryConvertToDNB(s, out.toLowerCase().includes("home")?"Home":"Away"); continue; }
        if (hcp < 0) { await tryConvertOverHcp(s, hcp + 1); continue; }
      }
      // Both Halves Under 1.5 No → Over 2.5
      if (on("cvtBHU") && mkt.includes("both halves") && mkt.includes("under") && out === "no") { await tryConvertOver(s, 2.5); continue; }
      // Corners/Cards/Throw-ins step down
      if (on("cvtSpecials") && overMatch && (mkt.includes("corner")||mkt.includes("card")||mkt.includes("throw")||mkt.includes("foul"))) {
        const step = val > 10 ? 2 : 1;
        await tryConvertOver(s, val - step); continue;
      }
      // Remove risky
      if (on("cvtRmCS") && mkt.includes("correct score")) { s._removed = true; continue; }
      if (on("cvtRmOver35") && overMatch && val >= 3.5) { s._removed = true; continue; }
      if (on("cvtRmAH") && mkt.includes("handicap") && parseFloat((s.specifier||"").match(/hcp=([-\d.]+)/)?.[1]||0) <= -2) { s._removed = true; continue; }
      if (on("cvtRmExact") && mkt.includes("exact goals")) { s._removed = true; continue; }
      // Game limits
      const maxOddsLimit = parseInt($("cvtMaxOdds")?.value || 0);
      if (maxOddsLimit > 0 && s.odds > maxOddsLimit) { s._removed = true; continue; }
    }
  }

  // Advanced: apply top N safest filter
  if (mode === "advanced") {
    const topNLimit = parseInt($("cvtTopN")?.value || 0);
    if (topNLimit > 0) {
      const active = convertResult.filter(s => !s._removed).sort((a,b) => a.odds - b.odds);
      if (active.length > topNLimit) {
        const keep = new Set(active.slice(0, topNLimit).map(s => s.eventId));
        convertResult.forEach(s => { if (!s._removed && !keep.has(s.eventId)) s._removed = true; });
      }
    }
  }

  // Deep Scan: remove uncertain games if enabled
  if (deepScanEnabled) {
    const uncertain = convertResult.filter(s => !s._removed && s._uncertain);
    if (uncertain.length > 0) {
      uncertain.forEach(s => { s._removed = true; s._scanNote = (s._scanNote || "") + " Removed: uncertain based on stats."; });
    }
  }

  // Build review list for unconverted picks
  const reviewable = convertResult.filter(s => !s._removed && !s._changed);
  const reviewEl = $("convertReview");
  if (reviewable.length > 0 && reviewEl) {
    reviewEl.classList.remove("hidden");
    $("convertReviewList").innerHTML = reviewable.slice(0, 10).map(s =>
      `<div class="sel-card" style="border-left-color:var(--amber)"><div class="sel-info"><div class="sel-teams">${esc(s.homeTeam)} vs ${esc(s.awayTeam)}</div><div class="sel-meta">${esc(s.market)} &mdash; ${esc(s.outcome)}</div></div><span class="sel-odds">${s.odds.toFixed(2)}</span><button class="btn-sm btn-markets" onclick="openMarkets(${jsArg(s.eventId)})">Swap</button></div>`
    ).join("");
  } else if (reviewEl) reviewEl.classList.add("hidden");

  if (prog) prog.classList.add("hidden");
  renderConvert();
  showToast("Conversion applied", "success");
}

async function tryConvertOver(s, newVal) {
  try {
    const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json();
    const t = j.markets?.find(m => m.outcomeName === `Over ${newVal}` && m.marketName.toLowerCase().includes("over/under"));
    if (t) { Object.assign(s, {market:t.marketName,outcome:t.outcomeName,odds:t.odds,marketId:t.marketId,outcomeId:t.outcomeId,specifier:t.specifier||""}); s._changed = true; }
  } catch {}
}
async function tryConvertToOver15(s) {
  try { const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json(); const t = j.markets?.find(m => m.marketName === "Over/Under" && m.outcomeName === "Over 1.5"); if (t) { Object.assign(s, {market:t.marketName,outcome:t.outcomeName,odds:t.odds,marketId:t.marketId,outcomeId:t.outcomeId,specifier:t.specifier||""}); s._changed = true; } } catch {}
}
async function tryConvertToDC(s, name) {
  try { const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json(); const t = j.markets?.find(m => m.marketName === "Double Chance" && m.outcomeName === name); if (t) { Object.assign(s, {market:t.marketName,outcome:t.outcomeName,odds:t.odds,marketId:t.marketId,outcomeId:t.outcomeId,specifier:t.specifier||""}); s._changed = true; } } catch {}
}
async function tryConvertUnder(s, newVal) {
  try { const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json(); const t = j.markets?.find(m => m.outcomeName === `Under ${newVal}` && m.marketName.toLowerCase().includes("over/under")); if (t) { Object.assign(s, {market:t.marketName,outcome:t.outcomeName,odds:t.odds,marketId:t.marketId,outcomeId:t.outcomeId,specifier:t.specifier||""}); s._changed = true; } } catch {}
}
async function tryConvertOverHcp(s, newHcp) {
  try { const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json(); const t = j.markets?.find(m => m.marketName.toLowerCase().includes("handicap") && m.specifier?.includes(`hcp=${newHcp}`)); if (t) { Object.assign(s, {market:t.marketName,outcome:t.outcomeName,odds:t.odds,marketId:t.marketId,outcomeId:t.outcomeId,specifier:t.specifier||""}); s._changed = true; } } catch {}
}
async function tryConvertToDNB(s, side) {
  try { const r = await fetch(`/api/markets/${encodeURIComponent(s.eventId)}`); const j = await r.json(); const t = j.markets?.find(m => m.marketName === "Draw No Bet" && m.outcomeName.toLowerCase().includes(side.toLowerCase())); if (t) { Object.assign(s, {market:t.marketName,outcome:t.outcomeName,odds:t.odds,marketId:t.marketId,outcomeId:t.outcomeId,specifier:t.specifier||""}); s._changed = true; } } catch {}
}

function renderConvert() {
  const active = convertResult.filter(s => !s._removed);
  const changed = convertResult.filter(s => s._changed).length;
  const removed = convertResult.filter(s => s._removed).length;

  $("convertOrigBadge").textContent = convertOriginal.length;
  $("convertNewBadge").textContent = active.length;
  $("convertOldOdds").textContent = convertOriginal.reduce((a,s) => a*s.odds, 1).toFixed(2);
  $("convertNewOdds").textContent = active.reduce((a,s) => a*s.odds, 1).toFixed(2);
  $("convertChanged").textContent = changed;
  $("convertRemoved").textContent = removed;

  $("convertOrigTable").innerHTML = convertOriginal.map(s => {
    const cr = convertResult.find(r => r.eventId === s.eventId);
    const badge = cr?._changed ? '<span class="convert-badge convert-changed">changed</span>' : cr?._removed ? '<span class="convert-badge convert-removed">removed</span>' : '';
    return `<div class="sel-card"><div class="sel-info"><div class="sel-teams">${esc(s.homeTeam)} vs ${esc(s.awayTeam)}${badge}</div><div class="sel-meta">${esc(s.market)} — ${esc(s.outcome)}</div></div><span class="sel-odds">${s.odds.toFixed(2)}</span></div>`;
  }).join("");

  $("convertNewTable").innerHTML = active.map(s => {
    const arrow = s._changed ? `<span class="change-arrow">${esc(s._oldOutcome)} -&gt;</span> ` : "";
    const note = s._scanNote ? `<div style="font-size:10px;color:var(--text3);margin-top:2px">${esc(s._scanNote)}</div>` : "";
    return `<div class="sel-card ${s._changed?'changed-card':''}"><div class="sel-info"><div class="sel-teams">${esc(s.homeTeam)} vs ${esc(s.awayTeam)}</div><div class="sel-meta">${arrow}${esc(s.market)} — ${esc(s.outcome)}</div>${note}</div><span class="sel-odds">${s.odds.toFixed(2)}</span></div>`;
  }).join("");
}

window.generateConvertCode = async function() {
  const active = convertResult.filter(s => !s._removed);
  if (!active.length) return;
  $("convertGenBtn").disabled = true; $("convertGenBtn").textContent = "Generating...";
  try {
    const r = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections:genPayload(active)})});
    renderGenResult("convertGenResult", await r.json(), active);
  } catch(e) { showErr("convertError", e.message); }
  finally { $("convertGenBtn").disabled = false; $("convertGenBtn").textContent = "Generate New Code"; }
};

// ── PWA Install Sheet ──
let deferredPrompt = null;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isAndroid = /Android/.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;

window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; });

window.showInstallSheet = function() {
  if (isStandalone) return;
  const sheet = $("installSheet");
  if (!sheet) return;
  $("installAndroid").classList.add("hidden");
  $("installIOS").classList.add("hidden");
  $("installAndroidManual").classList.add("hidden");
  if (isIOS) { $("installIOS").classList.remove("hidden"); }
  else if (deferredPrompt) { $("installAndroid").classList.remove("hidden"); }
  else if (isAndroid) { $("installAndroidManual").classList.remove("hidden"); }
  else { $("installAndroid").classList.remove("hidden"); }
  sheet.classList.remove("hidden");
};

window.dismissInstall = function() {
  $("installSheet").classList.add("hidden");
  localStorage.setItem("installPromptShown", "1");
};

$("installBtn")?.addEventListener("click", () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { $("installSheet").classList.add("hidden"); deferredPrompt = null; });
  } else if (isAndroid) {
    $("installAndroid").classList.add("hidden");
    $("installAndroidManual").classList.remove("hidden");
  }
});

setTimeout(() => {
  if (!isStandalone && !localStorage.getItem("installPromptShown")) {
    if (deferredPrompt || isIOS || isAndroid) showInstallSheet();
  }
}, 10000);

// Feature gate for non-installed users
if (!isStandalone) {
  const gate = $("pwaGateBanner");
  if (gate) gate.classList.remove("hidden");
}

// Footer links
document.querySelectorAll(".footer-links a").forEach(a => a.addEventListener("click", () => activateTab(a.dataset.goto)));

// ── Support ──
const supType = $("supType");
if (supType) supType.addEventListener("change", () => {
  const v = supType.value;
  const ph = $("supPartnerHint"), dh = $("supDonateHint");
  if (ph) ph.classList.toggle("hidden", v !== "Partnership");
  if (dh) dh.classList.toggle("hidden", v !== "Donate");
});

window.submitSupport = async function() {
  const email = $("supEmail")?.value?.trim();
  const message = $("supMessage")?.value?.trim();
  if (!email || !message) { showToast("Email and message required", "error"); return; }
  try {
    const r = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("supName")?.value?.trim(), email, type: $("supType")?.value, message }) });
    const j = await r.json();
    if (j.success) {
      const s = $("supSuccess"); if (s) { s.textContent = "Got it! We'll reach out to " + email + " with updates."; s.classList.remove("hidden"); }
      $("supName").value = ""; $("supEmail").value = ""; $("supMessage").value = "";
    }
  } catch(e) { showToast(e.message, "error"); }
};

// Admin support page
if (location.pathname.startsWith("/admin/support")) activateTab("leaderboard");

// ── Admin Smart Generator (Convert tab) ──
let adminGenPool = [];
let adminGenSettings = { convStyle: "safer", edition: "conservative", minOdds: 1000 };

// Show admin section when convert tab activates
function checkAdminConvert() {
  if (isAdmin) $("adminGenSection").classList.remove("hidden");
  else $("adminGenSection").classList.add("hidden");
}

window.setAdminOpt = function(btn, key, val) {
  btn.parentElement.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  if (key === "adminConvStyle") adminGenSettings.convStyle = val;
  else if (key === "adminEdition") adminGenSettings.edition = val;
  else if (key === "adminMinOdds") adminGenSettings.minOdds = parseInt(val);
};

let TODAY_PUNTER_CODES = {};
async function loadPunterCodesFromServer() {
  try { const r = await fetch("/api/admin/punter-codes", { headers: { "x-admin-password": window.__adminPw || "" } }); if (r.ok) TODAY_PUNTER_CODES = await r.json(); } catch {}
}

window.adminFetchPunters = async function() {
  const btn = $("adminFetchBtn");
  const status = $("adminFetchStatus");
  btn.disabled = true; btn.textContent = "Fetching...";
  status.innerHTML = "";
  adminGenPool = [];
  const seen = new Set();
  const now = Date.now();
  let totalFetched = 0;

  await loadPunterCodesFromServer();
  if (!Object.keys(TODAY_PUNTER_CODES).length) { status.innerHTML = '<div style="color:#e53935">No punter codes set. Go to /admin to set them.</div>'; btn.disabled = false; btn.textContent = "Fetch Today's Punter Codes"; return; }

  for (const [name, code] of Object.entries(TODAY_PUNTER_CODES)) {
    if (!code) { status.innerHTML += `<div style="color:#8a9e8a">${name}: no code set</div>`; continue; }
    try {
      const r = await fetch(`/api/booking/${code}`);
      const j = await r.json();
      if (j.selections) {
        let added = 0;
        for (const s of j.selections) {
          if (s.kickoff && new Date(s.kickoff).getTime() <= now) continue;
          if (!seen.has(s.eventId)) {
            seen.add(s.eventId);
            s._punters = [name];
            s._punterCount = 1;
            adminGenPool.push(s);
            added++;
          } else {
            const existing = adminGenPool.find(g => g.eventId === s.eventId);
            if (existing && !existing._punters.includes(name)) {
              existing._punters.push(name);
              existing._punterCount = existing._punters.length;
            }
          }
        }
        totalFetched++;
        status.innerHTML += `<div style="color:var(--green)">${name}: ${code} — ${added} games &#10003;</div>`;
      } else {
        status.innerHTML += `<div style="color:var(--red)">${name}: ${code} — failed</div>`;
      }
    } catch (e) {
      status.innerHTML += `<div style="color:var(--red)">${name}: ${e.message}</div>`;
    }
  }

  const consensus = adminGenPool.filter(g => g._punterCount >= 2).length;
  status.innerHTML += `<div style="margin-top:8px;font-weight:700;color:#fff">Total pool: ${adminGenPool.length} unique future games | ${consensus} consensus picks</div>`;
  btn.disabled = false; btn.textContent = "Fetch Today's Punter Codes";
  $("adminGenSettings").classList.remove("hidden");
};

window.adminRunGenerate = async function() {
  if (!adminGenPool.length) { showToast("Fetch punter codes first", "error"); return; }
  const btn = $("adminGenBtn");
  const prog = $("adminGenProgress");
  btn.disabled = true;
  prog.textContent = "Preparing pool...";

  const deepScan = $("adminTglH2H")?.classList.contains("on");
  const consensusOnly = $("adminTglConsensus")?.classList.contains("on");
  const removeUncertain = $("adminTglUncertain")?.classList.contains("on");
  const codeCount = parseInt($("adminCodeCount").value) || 30;
  const convStyle = adminGenSettings.convStyle;
  const edition = adminGenSettings.edition;
  const minOdds = adminGenSettings.minOdds;

  let pool = [...adminGenPool];

  // Filter consensus only
  if (consensusOnly) {
    pool = pool.filter(g => g._punterCount >= 2);
    prog.textContent = `Consensus filter: ${pool.length} picks remaining...`;
  }

  // H2H deep scan
  if (deepScan) {
    for (let i = 0; i < pool.length; i++) {
      prog.textContent = `Scanning H2H ${i + 1}/${pool.length}...`;
      try {
        const r = await fetch(`/api/h2h?eventId=${encodeURIComponent(pool[i].eventId)}&home=${encodeURIComponent(pool[i].homeTeam)}&away=${encodeURIComponent(pool[i].awayTeam)}&pick=${encodeURIComponent(pool[i].outcome)}`);
        const j = await r.json();
        pool[i]._h2h = j;
        pool[i]._safetyScore = j.safetyScore || calcLocalSafety(pool[i], j);
      } catch { pool[i]._safetyScore = calcLocalSafety(pool[i], null); }
    }
  } else {
    pool.forEach(g => { g._safetyScore = calcLocalSafety(g, null); });
  }

  // Apply conversions
  let convCount = 0;
  if (convStyle === "safer") {
    prog.textContent = "Applying safe conversions...";
    for (const g of pool) {
      const conv = await adminConvertPick(g, convStyle);
      if (conv) { Object.assign(g, conv); convCount++; }
    }
  } else if (convStyle === "aggressive") {
    prog.textContent = "Applying aggressive upgrades...";
    for (const g of pool) {
      const conv = await adminConvertPick(g, convStyle);
      if (conv) { Object.assign(g, conv); convCount++; }
    }
  }

  // Remove uncertain
  let removedPicks = [];
  if (removeUncertain) {
    const before = pool.length;
    removedPicks = pool.filter(g => g._safetyScore < 35);
    pool = pool.filter(g => g._safetyScore >= 35);
    prog.textContent = `Removed ${removedPicks.length} uncertain picks (score < 35)`;
  }

  // Determine games per code based on edition
  let minG, maxG;
  if (edition === "conservative") { minG = 8; maxG = 15; }
  else if (edition === "balanced") { minG = 15; maxG = 25; }
  else { minG = 30; maxG = 50; }

  // Sort pool by safety score
  pool.sort((a, b) => (b._safetyScore || 0) - (a._safetyScore || 0));

  // Generate codes
  prog.textContent = `Generating ${codeCount} codes...`;
  const codes = [];
  for (let i = 0; i < codeCount; i++) {
    const n = minG + Math.floor(Math.random() * (maxG - minG + 1));
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const sels = shuffled.slice(0, Math.min(n, pool.length));
    const odds = sels.reduce((a, s) => a * (s.odds || 1), 1);

    prog.textContent = `Generating ${i + 1}/${codeCount}...`;
    try {
      const payload = sels.map(s => ({ eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifier: s.specifier || "", productId: s.productId || 3, sportId: s.sportId || "" }));
      const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selections: payload }) });
      const j = await r.json();
      if (j.success && j.shareCode) codes.push({ code: j.shareCode, games: sels.length, odds: Math.round(odds * 100) / 100, edition });
    } catch {}
  }

  // Save to server
  try {
    const existingR = await fetch("/api/generated-codes", { headers: { "x-admin-password": window.__adminPw || "" } });
    const existing = await existingR.json();
    const grouped = { ...(existing || {}) };
    const groupKey = edition === "conservative" ? "A" : edition === "balanced" ? "B" : "C";
    grouped[groupKey] = codes.map(c => ({ code: c.code, games: c.games, odds: c.odds, topPicks: [] }));
    await fetch("/api/admin/save-codes", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": window.__adminPw || "" }, body: JSON.stringify(grouped) });
  } catch {}

  // Render results
  const consensus = adminGenPool.filter(g => g._punterCount >= 2);
  prog.textContent = "";
  btn.disabled = false;

  const resEl = $("adminGenResults");
  resEl.classList.remove("hidden");
  let html = `<div style="font-size:13px;font-weight:700;color:var(--green);margin-bottom:12px">&#10003; ${codes.length} codes generated | ${adminGenPool.length} games analyzed | ${convCount} conversions applied</div>`;

  // Group codes by edition
  const editionLabel = { conservative: "CONSERVATIVE", balanced: "BALANCED", moonshot: "MOONSHOT" }[edition] || edition.toUpperCase();
  const stakeLabel = { conservative: "Stake ₦50 each", balanced: "Stake ₦20 each", moonshot: "Stake ₦10 each" }[edition] || "";
  html += `<h3 style="color:#fff;margin-top:0">${editionLabel} (${codes.length} codes) — ${stakeLabel}</h3>`;

  codes.forEach(c => {
    const oddsStr = c.odds >= 1e6 ? (c.odds / 1e6).toFixed(1) + "M" : c.odds >= 1000 ? Math.round(c.odds / 1000) + "K" : Math.round(c.odds);
    html += `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px"><span style="font-family:monospace;font-weight:800;color:var(--green);letter-spacing:1px;min-width:70px">${c.code}</span><span style="color:var(--text2)">${c.games} games</span><span style="color:var(--amber);font-weight:700">${oddsStr}x</span><button class="btn-sm" onclick="copyToClipboard('${c.code}',this)">Copy</button><a href="https://www.sportybet.com/ng/?shareCode=${c.code}" target="_blank" style="color:var(--text3);font-size:11px;text-decoration:none;border:1px solid var(--border);padding:2px 8px;border-radius:6px">Load &#8599;</a></div>`;
  });

  // Consensus picks
  if (consensus.length > 0) {
    html += `<h3 style="color:var(--amber);margin-top:16px">&#128293; TOP CONSENSUS PICKS</h3>`;
    consensus.sort((a, b) => (b._safetyScore || 0) - (a._safetyScore || 0)).slice(0, 10).forEach(g => {
      html += `<div style="font-size:12px;padding:4px 0;color:var(--text2)">${g.homeTeam} vs ${g.awayTeam} — <strong style="color:#fff">${g.outcome}</strong> — ${g._punters.join(", ")} — Score: ${g._safetyScore || "?"}</div>`;
    });
  }

  // Removed picks
  if (removedPicks.length > 0) {
    html += `<h3 style="color:var(--red);margin-top:16px">&#9888; REMOVED AS UNCERTAIN (${removedPicks.length})</h3>`;
    removedPicks.slice(0, 8).forEach(g => {
      html += `<div style="font-size:11px;padding:2px 0;color:var(--text3)">${g.homeTeam} vs ${g.awayTeam} — ${g.outcome} — Score: ${g._safetyScore || 0}</div>`;
    });
  }

  // Copy all / export
  html += `<div style="margin-top:16px;display:flex;gap:8px"><button class="btn btn-green" onclick="copyToClipboard('${codes.map(c => c.code).join("\\n")}')">Copy All Codes</button><button class="btn btn-ghost" onclick="adminExportCodes()">Export to Text</button></div>`;

  resEl.innerHTML = html;
};

function calcLocalSafety(pick, h2h) {
  let score = 50;
  const odds = pick.odds || 1;
  const out = (pick.outcome || "").toLowerCase();
  const consensus = (pick._punterCount || 1) >= 2;
  const strong = (pick._punterCount || 1) >= 3;

  if (h2h?.found && h2h?.keyStats && h2h.keyStats.avgGoals !== null) {
    const ks = h2h.keyStats;
    if (out.includes("over 1.5") && ks.over25Pct > 70) score += 20;
    if (out.includes("over 2.5") && ks.over25Pct > 60) score += 20;
    if (out.includes("over 2.5") && ks.avgGoals < 2.0) score -= 20;
    if (out.includes("yes") && ks.bttsPct > 60) score += 20;
    if (out.includes("yes") && ks.bttsPct < 40) score -= 20;
  } else {
    // No H2H data (international teams, obscure leagues) — score by odds only, don't penalize
    if (odds < 1.25) score = 72;
    else if (odds < 1.40) score = 62;
    else if (odds < 1.55) score = 52;
    else if (odds < 1.70) score = 42;
    else if (odds < 2.00) score = 35;
    else score = 28;
  }

  if (strong) score += 25;
  else if (consensus) score += 15;
  return Math.max(0, Math.min(100, score));
}

async function adminConvertPick(pick, style) {
  const out = (pick.outcome || "").toLowerCase();
  const mkt = (pick.market || "").toLowerCase();
  let targetMkt = null, targetOut = null;

  if (style === "safer") {
    const overMatch = out.match(/^over (\d+\.?\d*)$/);
    if (overMatch) {
      const v = parseFloat(overMatch[1]);
      if (v >= 3.0) { targetMkt = "Over/Under"; targetOut = "Over 2.5"; }
      else if (v >= 2.5 && pick._h2h?.keyStats?.avgGoals < 2.0) { targetMkt = "Over/Under"; targetOut = "Over 1.5"; }
    }
    if (!targetOut && mkt.includes("gg") && out === "yes" && pick._h2h?.keyStats?.bttsPct < 40) { targetMkt = "Over/Under"; targetOut = "Over 1.5"; }
    if (!targetOut && mkt === "1x2" && out === "home" && pick._h2h?.keyStats?.homeWinRate < 35) { targetMkt = "Double Chance"; targetOut = "Home or Draw"; }
    if (!targetOut && mkt.includes("correct score")) { targetMkt = "Over/Under"; targetOut = "Over 1.5"; }
    if (!targetOut && mkt.includes("both halves") && out === "no") { targetMkt = "Over/Under"; targetOut = "Over 2.5"; }
  } else if (style === "aggressive") {
    if (out === "over 1.5" && pick._h2h?.keyStats?.avgGoals > 3.0) { targetMkt = "Over/Under"; targetOut = "Over 2.5"; }
    if (!targetOut && mkt.includes("double chance") && out.includes("home") && pick._h2h?.keyStats?.homeWinRate > 75) { targetMkt = "1X2"; targetOut = "Home"; }
    if (!targetOut && mkt.includes("draw no bet") && out.includes("home") && pick._h2h?.keyStats?.homeWinRate > 80) { targetMkt = "1X2"; targetOut = "Home"; }
  }

  if (!targetMkt) return null;
  try {
    const r = await fetch(`/api/markets/${encodeURIComponent(pick.eventId)}`);
    const j = await r.json();
    if (j.markets) {
      const found = j.markets.find(m => m.marketName.toLowerCase().includes(targetMkt.toLowerCase()) && m.outcomeName === targetOut);
      if (found) return { market: found.marketName, outcome: found.outcomeName, odds: found.odds, marketId: found.marketId, outcomeId: found.outcomeId, specifier: found.specifier || "" };
    }
  } catch {}
  return null;
}

window.adminExportCodes = function() {
  const el = $("adminGenResults");
  const codes = el?.querySelectorAll("[style*='monospace']");
  if (!codes?.length) return;
  const text = Array.from(codes).map(c => c.textContent).join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "codes-today.txt"; a.click();
};

// ── Convert Manual Mode ──
let manualConvertEdits = {};

window.setConvertMode = function(mode) {
  const pills = document.querySelectorAll("#convertResults > .pill-row .pill");
  pills.forEach((p, i) => p.classList.toggle("active", (mode === "auto" ? 0 : 1) === i));
  $("convertAutoMode").classList.toggle("hidden", mode !== "auto");
  $("convertManualMode").classList.toggle("hidden", mode !== "manual");
  if (mode === "manual") renderManualConvert();
};

function renderManualConvert() {
  if (!convertOriginal.length) return;
  const list = $("manualConvertList");
  list.innerHTML = convertOriginal.map(s => {
    const edit = manualConvertEdits[s.eventId];
    const pickHtml = edit
      ? `<span class="pick-old">${esc(s.market)} - ${esc(s.outcome)}</span><span class="pick-new">${esc(edit.market)} - ${esc(edit.outcome)} @ ${edit.odds.toFixed(2)}</span>`
      : `<span style="font-size:12px;color:var(--text2)">${esc(s.market)} - ${esc(s.outcome)}</span>`;
    return `<div class="manual-convert-item"><div class="sel-info"><div class="sel-teams">${esc(s.homeTeam)} vs ${esc(s.awayTeam)}</div><div class="pick-display">${pickHtml}</div></div><span class="sel-odds">${(edit ? edit.odds : s.odds).toFixed(2)}</span><button class="btn-edit-pick" onclick="openManualMarkets(${jsArg(s.eventId)})">Edit Pick</button></div>`;
  }).join("");

  const oldOdds = convertOriginal.reduce((a,s) => a*s.odds, 1);
  const newOdds = convertOriginal.reduce((a,s) => a * (manualConvertEdits[s.eventId]?.odds || s.odds), 1);
  const changedCount = Object.keys(manualConvertEdits).length;
  $("manualOldOdds").textContent = oldOdds.toFixed(2);
  $("manualNewOdds").textContent = newOdds.toFixed(2);
  $("manualChanged").textContent = changedCount;
}

window.openManualMarkets = async function(eventId) {
  currentMktEvt = eventId;
  marketModal.classList.remove("hidden");
  $("modalTitle").textContent = "Loading..."; $("modalSub").textContent = "Choose new pick"; $("modalStats").innerHTML = "";
  $("modalBody").innerHTML = '<div class="modal-loading">Fetching markets...</div>';

  try {
    let data;
    if (marketsCache[eventId]) { data = marketsCache[eventId]; }
    else { const r = await fetch(`/api/markets/${encodeURIComponent(eventId)}`); data = await r.json(); if (!r.ok) throw new Error(data.error); marketsCache[eventId] = data; }
    renderManualMarketModal(data, eventId);
  } catch(e) { $("modalBody").innerHTML = `<div class="modal-loading" style="color:var(--red)">${esc(e.message)}</div>`; }
};

function renderManualMarketModal(d, eventId) {
  $("modalTitle").textContent = `${d.homeTeam} vs ${d.awayTeam}`;
  $("modalSub").textContent = "Select a new pick for this game";
  $("modalStats").innerHTML = `<span>Markets: <span class="ms-val">${d.marketCount}</span></span><span>Outcomes: <span class="ms-val">${d.outcomeCount}</span></span>`;

  const groups = []; const seen = new Map();
  d.markets.forEach(m => { const k = `${m.marketId}|${m.specifier}`; if (!seen.has(k)) { seen.set(k, {marketName:m.marketName, specifier:m.specifier, outcomes:[]}); groups.push(seen.get(k)); } seen.get(k).outcomes.push(m); });

  // Group categories
  const cats = { "Goals": [], "Result": [], "Half Time": [], "Corners & Cards": [], "Other": [] };
  groups.forEach(g => {
    const n = g.marketName.toLowerCase();
    if (n.includes("over/under") || n.includes("goal") || n.includes("gg") || n.includes("btts") || n.includes("score")) cats["Goals"].push(g);
    else if (n.includes("1x2") || n.includes("result") || n.includes("double chance") || n.includes("draw no bet") || n.includes("handicap")) cats["Result"].push(g);
    else if (n.includes("half")) cats["Half Time"].push(g);
    else if (n.includes("corner") || n.includes("card") || n.includes("throw") || n.includes("foul")) cats["Corners & Cards"].push(g);
    else cats["Other"].push(g);
  });

  let html = '<div class="mkt-th"><span>Outcome</span><span>Odds</span><span></span></div>';
  Object.entries(cats).forEach(([catName, catGroups]) => {
    if (!catGroups.length) return;
    html += `<div style="padding:6px 20px;font-size:10px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.5px;background:var(--bg);border-bottom:1px solid var(--border)">${catName}</div>`;
    catGroups.forEach((g, i) => {
      html += `<div class="mkt-group ${i < 2 ? 'open' : ''}" onclick="this.classList.toggle('open')"><div class="mkt-group-header"><span class="mkt-group-chevron">&#9654;</span><span class="mkt-group-name">${esc(g.marketName)}${g.specifier ? " ("+esc(g.specifier)+")" : ""}</span><span class="mkt-group-count">${g.outcomes.length}</span></div><div class="mkt-outcomes">${g.outcomes.map(o =>
        `<div class="mkt-outcome-row"><span class="mkt-outcome-name">${esc(o.outcomeName)}</span><span class="mkt-outcome-odds">${o.odds.toFixed(2)}</span><button class="btn-sm btn-use" onclick="useManualPick(${jsArg(eventId)},${jsArg(o.marketName)},${jsArg(o.outcomeName)},${o.odds},${jsArg(o.marketId)},${jsArg(o.outcomeId)},${jsArg(o.specifier||'')})">Use</button></div>`
      ).join("")}</div></div>`;
    });
  });
  $("modalBody").innerHTML = html;
}

window.useManualPick = function(eventId, market, outcome, odds, marketId, outcomeId, specifier) {
  manualConvertEdits[eventId] = { market, outcome, odds, marketId, outcomeId, specifier };
  marketModal.classList.add("hidden");
  renderManualConvert();
  showToast(`${outcome} @ ${odds.toFixed(2)}`, "success");
};

window.generateManualConvertCode = async function() {
  const sels = convertOriginal.map(s => {
    const edit = manualConvertEdits[s.eventId];
    return edit ? {...s, ...edit} : s;
  });
  if (!sels.length) return;
  const btn = $("convertManualMode").querySelector(".wiz-cta");
  btn.disabled = true; btn.textContent = "Generating...";
  try {
    const r = await fetch("/api/generate", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({selections:genPayload(sels)})});
    renderGenResult("manualConvertGenResult", await r.json(), sels);
  } catch(e) { showToast(e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Generate New Code"; }
};

// ── Permutation Generator ──
window.runPermutations = async function() {
  const poolCode = $("permPoolCode").value.trim().toUpperCase();
  const count = parseInt($("permCount").value) || 10;
  const extraLegs = parseInt($("permExtra").value) || 3;

  if (!splitterSels.length) return showErr("permError", "Load a slip first (those are your banker games)");
  if (!poolCode) return showErr("permError", "Enter a pool code (source for extra games)");
  showErr("permError", "");

  const btn = $("permResults").previousElementSibling;
  btn.disabled = true; btn.textContent = "Generating...";

  try {
    // Fetch pool games
    const poolRes = await fetch(`/api/booking/${encodeURIComponent(poolCode)}`);
    const poolJson = await poolRes.json();
    if (!poolRes.ok) throw new Error(poolJson.error || "Failed to load pool code");
    if (!poolJson.selections?.length) throw new Error("Pool code has no selections");

    // Pool = all games from pool code that aren't already in bankers
    const bankerIds = new Set(splitterSels.map(s => s.eventId));
    const pool = poolJson.selections.filter(s => !bankerIds.has(s.eventId));
    if (pool.length < 1) throw new Error("Pool code has no unique games to add");

    // Sort pool by odds (safest first)
    pool.sort((a,b) => a.odds - b.odds);

    // Generate N codes, each with bankers + random extra picks from pool
    const results = [];
    const genCount = Math.min(count, 50);

    for (let i = 0; i < genCount; i++) {
      // Pick random extras from pool (weighted toward safer)
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      const extras = shuffled.slice(0, Math.min(extraLegs, pool.length));
      const sels = [...splitterSels, ...extras];

      try {
        const r = await fetch("/api/generate", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({selections:genPayload(sels)})});
        const j = await r.json();
        if (j.success && j.shareCode) {
          const odds = sels.reduce((a,s) => a*s.odds, 1);
          results.push({ code: j.shareCode, games: sels.length, odds, extras: extras.length });
        }
      } catch {}
    }

    if (!results.length) throw new Error("All code generations failed");

    $("permResults").innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border)"><span style="font-size:12px;font-weight:700;color:#fff">${results.length} codes generated</span><button class="btn btn-ghost" onclick="copyAllPermCodes()" style="padding:4px 12px;font-size:11px">Copy All</button></div>` +
      results.map((r, i) => `<div class="perm-code-row"><span class="perm-code">${esc(r.code)}</span><span class="perm-meta">${r.games} games · ${r.odds.toFixed(1)}x</span><button class="btn-sm btn-use" onclick="copyToClipboard(${jsArg(r.code)},this)">Copy</button></div>`).join("");
    $("permResults").classList.remove("hidden");
    showToast(`${results.length} permutations generated`, "success");
  } catch(e) { showErr("permError", e.message); }
  finally { btn.disabled = false; btn.textContent = "Generate Permutations"; }
};

window.copyAllPermCodes = function() {
  const codes = Array.from(document.querySelectorAll(".perm-code")).map(el => el.textContent).filter(Boolean);
  if (codes.length) copyToClipboard(codes.join("\n"));
};
