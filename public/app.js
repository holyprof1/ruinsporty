let allSelections = [];
let filtered = [];

const $ = (id) => document.getElementById(id);

// ── Tab Navigation ──
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "leaderboard") loadLeaderboard();
  });
});

const bookingCode = $("bookingCode");
const fetchBtn = $("fetchBtn");
const errorMsg = $("errorMsg");
const resultsSection = $("resultsSection");

fetchBtn.addEventListener("click", loadSlip);
bookingCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadSlip();
});
$("applyFilters").addEventListener("click", applyFilters);
$("resetFilters").addEventListener("click", resetFilters);

document.querySelectorAll(".preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.classList.toggle("active");
    applyFilters();
  });
});

async function loadSlip() {
  const code = bookingCode.value.trim().toUpperCase();
  if (!code) return showError("Enter a booking code");

  showError("");
  fetchBtn.disabled = true;
  fetchBtn.textContent = "Loading...";

  try {
    const res = await fetch(`/api/booking/${encodeURIComponent(code)}`);
    const json = await res.json();

    if (!res.ok) throw new Error(json.error || "Failed to load");
    if (!json.selections || json.selections.length === 0)
      throw new Error("No selections found for this code");

    allSelections = json.selections;

    console.log(
      `[SlipOptimizer] Loaded ${allSelections.length} selections from ${code}`
    );
    console.log("[SlipOptimizer] First selection:", allSelections[0]);

    resultsSection.classList.remove("hidden");
    populateFilterOptions();
    resetFilters();
  } catch (err) {
    showError(err.message);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = "Load Slip";
  }
}

function populateFilterOptions() {
  const markets = [...new Set(allSelections.map((s) => s.market))].sort();
  $("removeMarket").innerHTML = markets
    .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
    .join("");

  const leagues = [...new Set(allSelections.map((s) => s.league))].sort();
  $("removeLeague").innerHTML = leagues
    .map((l) => `<option value="${esc(l)}">${esc(l)}</option>`)
    .join("");

  const leagueKeywords = [
    { label: "Women", pattern: /women|female|w\)/i },
    { label: "Friendlies", pattern: /friend/i },
    { label: "Reserve", pattern: /reserve|u2[01]|u19|u18|u17/i },
    { label: "Youth", pattern: /youth|junior|u16|u15/i },
  ];

  const leaguePresetsEl = $("leaguePresets");
  leaguePresetsEl.innerHTML = "";
  leagueKeywords.forEach(({ label, pattern }) => {
    const matches = allSelections.some(
      (s) => pattern.test(s.league) || pattern.test(s.category)
    );
    if (matches) {
      const btn = document.createElement("button");
      btn.className = "preset";
      btn.dataset.action = `league-${label.toLowerCase()}`;
      btn.dataset.pattern = pattern.source;
      btn.dataset.flags = pattern.flags;
      btn.textContent = `Remove ${label}`;
      btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        applyFilters();
      });
      leaguePresetsEl.appendChild(btn);
    }
  });

  const marketKeywords = ["Over/Under", "Double Chance", "Both Teams To Score", "Correct Score", "Goal Bounds"];
  const marketPresetsEl = $("marketPresets");
  marketPresetsEl.innerHTML = "";
  marketKeywords.forEach((kw) => {
    const exists = allSelections.some(
      (s) => s.market.toLowerCase().includes(kw.toLowerCase())
    );
    if (exists) {
      const btn = document.createElement("button");
      btn.className = "preset";
      btn.dataset.action = `market-${kw}`;
      btn.textContent = `Remove ${kw}`;
      btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        applyFilters();
      });
      marketPresetsEl.appendChild(btn);
    }
  });
}

function applyFilters() {
  const activePresets = new Set();
  document.querySelectorAll(".preset.active").forEach((btn) => {
    activePresets.add(btn.dataset.action);
  });

  const afterTimeVal = $("removeAfterTime").value;
  const beforeTimeVal = $("removeBeforeTime").value;
  const afterTime = afterTimeVal ? new Date(afterTimeVal) : null;
  const beforeTime = beforeTimeVal ? new Date(beforeTimeVal) : null;

  const removedMarkets = Array.from(
    $("removeMarket").selectedOptions
  ).map((o) => o.value);
  const removedLeagues = Array.from(
    $("removeLeague").selectedOptions
  ).map((o) => o.value);

  const maxOdds = $("maxOdds").value ? parseFloat($("maxOdds").value) : null;
  const minOdds = $("minOdds").value ? parseFloat($("minOdds").value) : null;
  const topN = $("topN").value ? parseInt($("topN").value, 10) : null;

  const now = new Date();
  let today6pm = new Date(now);
  today6pm.setHours(18, 0, 0, 0);
  let today8pm = new Date(now);
  today8pm.setHours(20, 0, 0, 0);
  let tomorrowStart = new Date(now);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);

  filtered = allSelections.map((s) => {
    let removed = false;
    const kickoff = s.kickoff ? new Date(s.kickoff) : null;

    if (activePresets.has("after-6pm") && kickoff && kickoff > today6pm)
      removed = true;
    if (activePresets.has("after-8pm") && kickoff && kickoff > today8pm)
      removed = true;
    if (activePresets.has("tomorrow") && kickoff && kickoff >= tomorrowStart)
      removed = true;

    if (afterTime && kickoff && kickoff > afterTime) removed = true;
    if (beforeTime && kickoff && kickoff < beforeTime) removed = true;

    if (removedMarkets.length > 0 && removedMarkets.includes(s.market))
      removed = true;
    if (removedLeagues.length > 0 && removedLeagues.includes(s.league))
      removed = true;

    activePresets.forEach((action) => {
      if (action.startsWith("league-")) {
        const btn = document.querySelector(
          `.preset[data-action="${action}"]`
        );
        if (btn) {
          const re = new RegExp(btn.dataset.pattern, btn.dataset.flags);
          if (re.test(s.league) || re.test(s.category)) removed = true;
        }
      }
      if (action.startsWith("market-")) {
        const marketName = action.replace("market-", "");
        if (s.market.toLowerCase().includes(marketName.toLowerCase()))
          removed = true;
      }
    });

    if (maxOdds !== null && s.odds > maxOdds) removed = true;
    if (minOdds !== null && s.odds < minOdds) removed = true;

    return { ...s, removed };
  });

  // Top N: among those not yet removed, keep only N lowest odds
  if (topN !== null && topN > 0) {
    const kept = filtered
      .filter((s) => !s.removed)
      .sort((a, b) => a.odds - b.odds);

    if (kept.length > topN) {
      const keepSet = new Set(kept.slice(0, topN).map((s) => s.eventId));
      filtered = filtered.map((s) => {
        if (!s.removed && !keepSet.has(s.eventId)) {
          return { ...s, removed: true };
        }
        return s;
      });
    }
  }

  // Also handle top-N presets
  [5, 10, 15].forEach((n) => {
    if (activePresets.has(`top-${n}`)) {
      const kept = filtered
        .filter((s) => !s.removed)
        .sort((a, b) => a.odds - b.odds);
      if (kept.length > n) {
        const keepSet = new Set(kept.slice(0, n).map((s) => s.eventId));
        filtered = filtered.map((s) => {
          if (!s.removed && !keepSet.has(s.eventId)) {
            return { ...s, removed: true };
          }
          return s;
        });
      }
    }
  });

  const keptSelections = filtered.filter((s) => !s.removed);
  const removedSelections = filtered.filter((s) => s.removed);

  console.log(
    `[SlipOptimizer] Filter applied: ${allSelections.length} original → ${keptSelections.length} kept, ${removedSelections.length} removed`
  );

  render(keptSelections, removedSelections);
}

function resetFilters() {
  $("removeAfterTime").value = "";
  $("removeBeforeTime").value = "";
  $("maxOdds").value = "";
  $("minOdds").value = "";
  $("topN").value = "";
  Array.from($("removeMarket").options).forEach((o) => (o.selected = false));
  Array.from($("removeLeague").options).forEach((o) => (o.selected = false));
  document.querySelectorAll(".preset.active").forEach((b) => b.classList.remove("active"));

  filtered = allSelections.map((s) => ({ ...s, removed: false }));
  render(allSelections, []);
}

function render(kept, removed) {
  const origOdds = allSelections.reduce((a, s) => a * s.odds, 1);
  const keptOdds = kept.length > 0 ? kept.reduce((a, s) => a * s.odds, 1) : 0;

  $("origCount").textContent = allSelections.length;
  $("optCount").textContent = kept.length;
  $("removedCount").textContent = removed.length;
  $("origOdds").textContent = origOdds.toFixed(2);
  $("optOdds").textContent = keptOdds.toFixed(2);
  $("origBadge").textContent = allSelections.length;
  $("optBadge").textContent = kept.length;
  $("removedBadge").textContent = removed.length;

  $("originalTable").innerHTML = renderCards(allSelections);
  $("optimizedTable").innerHTML =
    kept.length > 0
      ? renderCards(kept)
      : '<div class="empty-state">All selections removed</div>';

  if (removed.length > 0) {
    $("removedSection").classList.remove("hidden");
    $("removedTable").innerHTML = renderCards(removed, true);
  } else {
    $("removedSection").classList.add("hidden");
  }

  // Enable generate button only when slip has been modified and has selections
  const generateBtn = $("generateBtn");
  const slipChanged = removed.length > 0 && kept.length > 0;
  generateBtn.disabled = !slipChanged;

  // Hide the result card when the slip changes
  $("generateResult").classList.add("hidden");
}

function renderCards(selections, isRemoved) {
  return selections
    .map(
      (s) => `
    <div class="sel-card ${isRemoved ? "removed-card" : ""}">
      <div class="sel-info">
        <div class="sel-teams">${esc(s.homeTeam)} vs ${esc(s.awayTeam)}</div>
        <div class="sel-meta">
          <span class="sel-market">${esc(s.market)}</span> — ${esc(s.outcome)}
          ${s.league ? ` · ${esc(s.league)}` : ""}
        </div>
      </div>
      <div class="sel-odds">${s.odds.toFixed(2)}</div>
      <div class="sel-kickoff">${fmtKickoff(s.kickoff)}</div>
      <button class="btn-markets" onclick="openMarkets('${esc(s.eventId)}')">View Markets</button>
    </div>`
    )
    .join("");
}

function fmtKickoff(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  if (isNaN(d)) return "--";
  const day = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

function esc(str) {
  const el = document.createElement("span");
  el.textContent = str || "";
  return el.innerHTML;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.toggle("hidden", !msg);
}

// ── Booking Code Generation ──

const generateBtn = $("generateBtn");
generateBtn.addEventListener("click", generateCode);

async function generateCode() {
  const kept = filtered.filter((s) => !s.removed);
  if (kept.length === 0) return;

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating...";
  $("generateResult").classList.add("hidden");

  const payload = kept.map((s) => ({
    eventId: s.eventId,
    marketId: s.marketId,
    outcomeId: s.outcomeId,
    specifier: s.specifier,
    productId: s.productId,
    sportId: s.sportId,
  }));

  console.log("[Generate] Sending", payload.length, "selections");
  console.log("[Generate] Payload:", JSON.stringify(payload, null, 2));

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: payload }),
    });
    const json = await res.json();

    console.log("[Generate] Response:", JSON.stringify(json, null, 2));

    const resultEl = $("generateResult");
    resultEl.classList.remove("hidden");

    if (json.success && json.shareCode) {
      const keptOdds = kept.reduce((a, s) => a * s.odds, 1);
      resultEl.innerHTML = `
        <div class="gen-success">
          <div class="gen-label">New Booking Code</div>
          <div class="gen-code-row">
            <span class="gen-code">${esc(json.shareCode)}</span>
            <button class="btn btn-ghost btn-copy" onclick="copyCode('${esc(json.shareCode)}', this)">Copy</button>
          </div>
          <div class="gen-details">
            <span>${kept.length} selections</span>
            <span>Odds: ${keptOdds.toFixed(2)}</span>
          </div>
          ${json.shareURL ? `<a class="gen-link" href="${esc(json.shareURL)}" target="_blank" rel="noopener">Open on SportyBet</a>` : ""}
        </div>`;
    } else {
      resultEl.innerHTML = `
        <div class="gen-error">
          <div class="gen-label">Generation Failed</div>
          <div class="gen-error-msg">${esc(json.error || "Unknown error")}</div>
          <details class="gen-debug">
            <summary>Debug Info</summary>
            <pre>${esc(JSON.stringify(json, null, 2))}</pre>
          </details>
        </div>`;
    }
  } catch (err) {
    console.error("[Generate] Error:", err);
    const resultEl = $("generateResult");
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = `
      <div class="gen-error">
        <div class="gen-label">Request Failed</div>
        <div class="gen-error-msg">${esc(err.message)}</div>
      </div>`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate New Booking Code";
  }
}

function copyCode(code, btn) {
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  });
}

// ── Market Explorer ──

const marketModal = $("marketModal");
const modalClose = $("modalClose");
const modalBackdrop = marketModal.querySelector(".modal-backdrop");

modalClose.addEventListener("click", closeMarkets);
modalBackdrop.addEventListener("click", closeMarkets);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMarkets();
});

function closeMarkets() {
  marketModal.classList.add("hidden");
}

const marketsCache = {};

async function openMarkets(eventId) {
  marketModal.classList.remove("hidden");
  $("modalTitle").textContent = "Loading markets...";
  $("modalSub").textContent = eventId;
  $("modalStats").innerHTML = "";
  $("modalBody").innerHTML = '<div class="modal-loading">Fetching all markets...</div>';

  if (marketsCache[eventId]) {
    renderMarketModal(marketsCache[eventId]);
    return;
  }

  try {
    const res = await fetch(`/api/markets/${encodeURIComponent(eventId)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed");

    marketsCache[eventId] = json;
    console.log(
      `[MarketExplorer] ${json.homeTeam} vs ${json.awayTeam}: ${json.marketCount} markets, ${json.outcomeCount} outcomes`
    );
    console.log(`[MarketExplorer] Debug file: ${json.debugFile}`);

    renderMarketModal(json);
  } catch (err) {
    $("modalBody").innerHTML = `<div class="modal-loading" style="color:#f87171">${esc(err.message)}</div>`;
  }
}

function renderMarketModal(data) {
  $("modalTitle").textContent = `${data.homeTeam} vs ${data.awayTeam}`;
  $("modalSub").textContent = `${data.sport} · ${data.league} · ${data.eventId}`;
  $("modalStats").innerHTML = `
    <span>Markets: <span class="ms-val">${data.marketCount}</span></span>
    <span>Outcomes: <span class="ms-val">${data.outcomeCount}</span></span>
    <span>Debug: <span class="ms-val">${data.debugFile}</span></span>
  `;

  // Group outcomes by marketId+specifier
  const groups = [];
  const seen = new Map();
  data.markets.forEach((m) => {
    const key = `${m.marketId}|${m.specifier}`;
    if (!seen.has(key)) {
      seen.set(key, { marketId: m.marketId, marketName: m.marketName, specifier: m.specifier, group: m.group, outcomes: [] });
      groups.push(seen.get(key));
    }
    seen.get(key).outcomes.push(m);
  });

  const html = `
    <div class="mkt-th">
      <span>Outcome</span>
      <span>Odds</span>
      <span>MarketId</span>
      <span>OutcomeId</span>
      <span>Specifier</span>
    </div>
    ${groups
      .map(
        (g, i) => `
      <div class="mkt-group ${i < 3 ? "open" : ""}" onclick="this.classList.toggle('open')">
        <div class="mkt-group-header">
          <span class="mkt-group-chevron">&#9654;</span>
          <span class="mkt-group-name">${esc(g.marketName)}${g.specifier ? ` (${esc(g.specifier)})` : ""}</span>
          <span class="mkt-group-count">${g.outcomes.length} outcomes</span>
        </div>
        <div class="mkt-outcomes">
          ${g.outcomes
            .map(
              (o) => `
            <div class="mkt-outcome-row">
              <span class="mkt-outcome-name">${esc(o.outcomeName)}</span>
              <span class="mkt-outcome-odds">${o.odds.toFixed(2)}</span>
              <span class="mkt-market-id">${esc(o.marketId)}</span>
              <span class="mkt-outcome-id">${esc(o.outcomeId)}</span>
              <span class="mkt-spec">${esc(o.specifier) || "—"}</span>
            </div>`
            )
            .join("")}
        </div>
      </div>`
      )
      .join("")}
  `;

  $("modalBody").innerHTML = html;
}

// ══════════════════════════════════════
// Result Scanner
// ══════════════════════════════════════

let scanData = null;
let manualOverrides = {};

$("scanBtn").addEventListener("click", scanSlip);
$("scanCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") scanSlip();
});
$("savePunterBtn").addEventListener("click", savePunter);

async function scanSlip() {
  const code = $("scanCode").value.trim().toUpperCase();
  if (!code) return showScanError("Enter a booking code");

  showScanError("");
  $("scanBtn").disabled = true;
  $("scanBtn").textContent = "Scanning...";
  $("scanResults").classList.add("hidden");
  manualOverrides = {};

  try {
    const res = await fetch(`/api/scan/${encodeURIComponent(code)}`);
    const json = await res.json();

    if (!res.ok) throw new Error(json.error || "Failed to scan");
    if (!json.results || json.results.length === 0)
      throw new Error("No selections found");

    scanData = json;
    console.log(`[Scanner] ${code}: ${json.total} picks, ${json.won}W ${json.lost}L ${json.void}V ${json.pending}P (${json.hitRate}%)`);
    $("scanResults").classList.remove("hidden");
    renderScanResults();
  } catch (err) {
    showScanError(err.message);
  } finally {
    $("scanBtn").disabled = false;
    $("scanBtn").textContent = "Scan Results";
  }
}

function renderScanResults() {
  const results = applyScanOverrides(scanData.results);
  const won = results.filter((r) => r.verdict === "WON");
  const lost = results.filter((r) => r.verdict === "LOST");
  const voided = results.filter((r) => r.verdict === "VOID");
  const pending = results.filter((r) => r.verdict === "PENDING");
  const settled = won.length + lost.length;
  const hitRate = settled > 0 ? Math.round((won.length / settled) * 100) : 0;

  $("scanWon").textContent = won.length;
  $("scanLost").textContent = lost.length;
  $("scanVoid").textContent = voided.length;
  $("scanPending").textContent = pending.length;
  $("scanHitRate").textContent = hitRate + "%";

  $("killersBadge").textContent = lost.length;
  $("safeBadge").textContent = won.length;
  $("scanTotalBadge").textContent = results.length;

  $("killersTable").innerHTML = lost.length > 0
    ? lost.map((r) => scanCard(r)).join("")
    : '<div class="empty-state">No killers</div>';

  $("safeTable").innerHTML = won.length > 0
    ? won.map((r) => scanCard(r)).join("")
    : '<div class="empty-state">No safe picks</div>';

  $("scanAllTable").innerHTML = results.map((r) => scanCard(r)).join("");
}

function applyScanOverrides(results) {
  return results.map((r) => {
    if (manualOverrides[r.eventId]) {
      return { ...r, verdict: manualOverrides[r.eventId] };
    }
    return r;
  });
}

function scanCard(r) {
  const vClass = { WON: "v-won", LOST: "v-lost", VOID: "v-void", PENDING: "v-pending" }[r.verdict] || "v-pending";
  const scoreDisplay = r.score || "--";
  const manualBtns = r.verdict === "PENDING" ? `
    <button class="btn-manual" onclick="setManual('${esc(r.eventId)}','WON')">W</button>
    <button class="btn-manual" onclick="setManual('${esc(r.eventId)}','LOST')">L</button>
    <button class="btn-manual" onclick="setManual('${esc(r.eventId)}','VOID')">V</button>
  ` : "";

  return `
    <div class="sel-card">
      <div class="sel-info">
        <div class="sel-teams">${esc(r.homeTeam)} vs ${esc(r.awayTeam)}</div>
        <div class="sel-meta">
          <span class="sel-market">${esc(r.market)}</span> — ${esc(r.outcome)}
          ${r.league ? ` · ${esc(r.league)}` : ""}
        </div>
      </div>
      <span class="scan-score">${esc(scoreDisplay)}</span>
      <span class="sel-odds">${r.odds.toFixed(2)}</span>
      <span class="v-pill ${vClass}">${r.verdict}</span>
      ${manualBtns}
    </div>`;
}

function setManual(eventId, verdict) {
  manualOverrides[eventId] = verdict;
  renderScanResults();
}

async function savePunter() {
  const name = $("punterName").value.trim();
  if (!name) return;
  if (!scanData) return;

  const results = applyScanOverrides(scanData.results);

  try {
    const res = await fetch("/api/punters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        code: scanData.shareCode,
        results,
      }),
    });
    const json = await res.json();
    if (json.success) {
      const msg = $("saveMsg");
      msg.textContent = "Saved!";
      msg.classList.remove("hidden");
      setTimeout(() => msg.classList.add("hidden"), 2000);
    }
  } catch (err) {
    console.error("[Scanner] Save error:", err);
  }
}

function showScanError(msg) {
  $("scanError").textContent = msg;
  $("scanError").classList.toggle("hidden", !msg);
}

// ══════════════════════════════════════
// Leaderboard
// ══════════════════════════════════════

async function loadLeaderboard() {
  try {
    const res = await fetch("/api/punters");
    const json = await res.json();
    renderLeaderboard(json.leaderboard || []);
  } catch (err) {
    $("leaderboardTable").innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderLeaderboard(lb) {
  if (lb.length === 0) {
    $("leaderboardTable").innerHTML = '<div class="empty-state">No punters saved yet. Scan a slip and save it.</div>';
    return;
  }

  const rankClass = (i) => {
    if (i === 0) return "lb-rank lb-rank-1";
    if (i === 1) return "lb-rank lb-rank-2";
    if (i === 2) return "lb-rank lb-rank-3";
    return "lb-rank";
  };

  $("leaderboardTable").innerHTML = `
    <table class="lb-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Punter</th>
          <th>Slips</th>
          <th>Games</th>
          <th>Won</th>
          <th>Lost</th>
          <th>Void</th>
          <th>Hit Rate</th>
        </tr>
      </thead>
      <tbody>
        ${lb.map((p, i) => `
          <tr>
            <td class="${rankClass(i)}">${i + 1}</td>
            <td class="lb-name">${esc(p.name)}</td>
            <td>${p.slips}</td>
            <td>${p.totalGames}</td>
            <td class="lb-won">${p.won}</td>
            <td class="lb-lost">${p.lost}</td>
            <td>${p.void}</td>
            <td class="lb-rate">${p.hitRate}%</td>
          </tr>
        `).join("")}
      </tbody>
    </table>`;
}
