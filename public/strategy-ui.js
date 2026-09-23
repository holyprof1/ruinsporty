/* Strategy Engine Panel — strategy-ui.js */

function $s(id) { return document.getElementById(id); }
function sEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let STRAT_DESCRIPTIONS = {};

async function stratLoadList() {
  try {
    const r = await fetch('/api/admin/strategy-list', { headers: { 'x-admin-password': window.adminPw || '' } });
    const j = await r.json();
    if (j.success) {
      STRAT_DESCRIPTIONS = {};
      j.strategies.forEach(s => { STRAT_DESCRIPTIONS[s.key] = s.description; });
      stratUpdateDesc();
    }
  } catch (_) { /* dropdown still works without descriptions */ }
}

function stratUpdateDesc() {
  const sel = $s('strat-select');
  const desc = $s('strat-desc');
  if (!sel || !desc) return;
  if (sel.value === 'all') {
    desc.textContent = 'Builds every strategy below from today\'s pool, then ranks all resulting tickets safest → riskiest and recommends the best 3 for staking.';
  } else {
    desc.textContent = STRAT_DESCRIPTIONS[sel.value] || '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sel = $s('strat-select');
  if (sel) sel.addEventListener('change', stratUpdateDesc);
});

// ── Run ────────────────────────────────────────────────────────────────────────
window.stratRun = async function () {
  const btn = $s('strat-run-btn');
  const status = $s('strat-status');
  const logEl = $s('strat-log');
  const top3El = $s('strat-top3');
  const resultsEl = $s('strat-results');

  if (!Object.keys(STRAT_DESCRIPTIONS).length) await stratLoadList();

  const strategy = ($s('strat-select') || {}).value || 'all';

  btn.disabled = true;
  btn.textContent = '⏳ Building…';
  status.textContent = '';
  logEl.style.display = 'block';
  logEl.textContent = '';
  top3El.style.display = 'none';
  resultsEl.style.display = 'none';

  try {
    const r = await fetch('/api/admin/strategy-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': window.adminPw || '' },
      body: JSON.stringify({ strategy }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(590000) : undefined,
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (_) { throw new Error('Server returned non-JSON. Is it running in dev mode?'); }
    if (!j.success) throw new Error(j.error || 'Strategy build failed');

    logEl.textContent = (j.logs || []).join('\n');
    logEl.scrollTop = logEl.scrollHeight;

    stratRenderTop3(j.top3 || []);
    stratRenderResults(j.strategies || []);

    const built = (j.strategies || []).filter(t => !t.skipped).length;
    const skipped = (j.strategies || []).length - built;
    status.textContent = `✓ ${built} portfolio(s) built${skipped ? `, ${skipped} skipped (not enough qualifying games)` : ''}`;
    status.style.color = '#00c853';
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.style.color = '#e53935';
    logEl.textContent += '\nERROR: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🧩 Build Portfolio(s)';
  }
};

// ── Render: Top 3 recommendation banner ────────────────────────────────────────
function stratRenderTop3(top3) {
  const el = $s('strat-top3');
  if (!top3 || !top3.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `<div class="strat-top3-banner">
    <div style="font-size:13px;font-weight:800;color:#00c853;margin-bottom:8px">★ Recommended for staking (safest → riskiest)</div>
    ${top3.map(t => `<div class="strat-top3-item">
      <span class="strat-rank-badge">#${t.riskRank}</span>
      <b style="color:#e8edf4">${sEsc(t.name)}</b>
      <span>${sEsc(t.rationale)}</span>
    </div>`).join('')}
  </div>`;
}

// ── Render: ticket list ──────────────────────────────────────────────────────
function stratRenderResults(tickets) {
  const resultsEl = $s('strat-results');
  const listEl = $s('strat-list');
  const summaryEl = $s('strat-summary');
  resultsEl.style.display = 'block';
  summaryEl.textContent = `${tickets.length} strategy(ies)`;
  listEl.innerHTML = tickets.map((t, i) => stratCardHtml(t, i)).join('');
}

function stratCardHtml(t, i) {
  if (t.skipped) {
    return `<div class="gen-code-card strat-card skipped">
      <div class="gen-code-head">
        <b style="color:#e8edf4">${sEsc(t.name)}</b>
        <span class="gen-code-meta"><span style="color:#ffb300">⚠ Skipped</span></span>
      </div>
      <div style="font-size:12px;color:#8a9e8a">${sEsc(t.reason)}</div>
      ${stratRejectionsHtml(t, i)}
    </div>`;
  }

  const copyId = 'strat-code-' + i;
  const picksId = 'strat-picks-' + i;
  const rejectId = 'strat-reject-' + i;
  const rankBadge = t.riskRank ? `<span class="strat-rank-badge">#${t.riskRank} safest</span>` : '';
  const convCount = (t.conversions || []).length;
  const convBadge = convCount ? `<span class="gen-conv-badge">↻ ${convCount} converted</span>` : '';

  const picksHtml = (t.picks || []).length ? `
    <table class="gen-pick-table">
      <thead><tr><th>Match</th><th>Market</th><th>Odds</th><th>Conf</th><th>Why chosen</th></tr></thead>
      <tbody>${t.picks.map(p => `<tr>
        <td><strong>${sEsc(p.home)} vs ${sEsc(p.away)}</strong><br><span style="color:#4a7a4a;font-size:10px">${sEsc(p.league)}</span></td>
        <td>${sEsc(p.market)}${p.converted ? '<span class="gen-conv-badge">converted</span>' : ''}</td>
        <td style="color:${p.converted ? '#00c853' : '#e8edf4'};font-weight:700">${typeof p.odds === 'number' ? p.odds.toFixed(2) : '—'}</td>
        <td style="color:${(p.confidence || 0) >= 80 ? '#00c853' : (p.confidence || 0) >= 60 ? '#ffb300' : '#e53935'}">${p.confidence}%</td>
        <td style="color:#8a9e8a">${sEsc(p.reason)}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<p style="font-size:11px;color:#8a9e8a">No pick detail available.</p>';

  const replacementHtml = t.replacement ? `
    <div class="strat-block-hdr">Safer replacement (for weakest pick)</div>
    <div style="font-size:11px;color:#ccc">If <b>${sEsc(t.replacement.forWeakest)}</b> is removed, swap in: ${sEsc(t.replacement.suggestion)}</div>
  ` : '';

  const conversionsHtml = convCount ? `
    <div class="strat-block-hdr">Market conversions applied</div>
    ${t.conversions.map(c => `<div style="font-size:11px;color:#ccc">${sEsc(c.home)} vs ${sEsc(c.away)} — ${sEsc(c.note)} <span style="color:#4a7a4a">(${sEsc(c.source)})</span></div>`).join('')}
  ` : '';

  return `<div class="gen-code-card strat-card">
    <div class="gen-code-head">
      ${rankBadge}
      <span id="${copyId}" class="gen-code-code"
        onclick="navigator.clipboard.writeText('${sEsc(t.code)}').then(()=>{ const el=document.getElementById('${copyId}'); const orig=el.textContent; el.textContent='✓ Copied!'; setTimeout(()=>el.textContent=orig,1500); })"
        title="Click to copy">${sEsc(t.code || '—')}</span>
      <div class="gen-code-meta">
        <span><b>${sEsc(t.name)}</b></span>
        <span>${t.gameCount} games</span>
        <span style="color:#00c853">${typeof t.totalOdds === 'number' ? t.totalOdds.toFixed(2) : '—'}x</span>
        <span>Avg conf: ${t.avgConfidence}%</span>
        <span>Floor: ${t.minConfidence}%</span>
        <span>Survival est: ${t.survivalPct}%</span>
        ${convBadge}
      </div>
    </div>
    <div style="font-size:11px;color:#8a9e8a;margin-bottom:6px">${sEsc(t.description)}</div>
    <div class="strat-meta-row">
      <span>Strongest: <b>${sEsc(t.strongestPick.home)} vs ${sEsc(t.strongestPick.away)}</b> ${sEsc(t.strongestPick.market)} @${t.strongestPick.odds} (${t.strongestPick.confidence}%)</span>
    </div>
    <div class="strat-meta-row">
      <span>Weakest: <b>${sEsc(t.weakestPick.home)} vs ${sEsc(t.weakestPick.away)}</b> ${sEsc(t.weakestPick.market)} @${t.weakestPick.odds} (${t.weakestPick.confidence}%)</span>
    </div>
    ${conversionsHtml}
    ${replacementHtml}
    <span class="gen-pick-toggle" onclick="stratTogglePicks('${picksId}', this)">▼ Show pick breakdown</span>
    <div id="${picksId}" style="display:none">${picksHtml}</div>
    ${stratRejectionsHtml(t, i, rejectId)}
  </div>`;
}

function stratRejectionsHtml(t, i, rejectId) {
  rejectId = rejectId || ('strat-reject-' + i);
  const sample = (t.rejections && t.rejections.sample) || [];
  if (!sample.length) return '';
  const summary = t.rejections.summary || {};
  const summaryStr = Object.entries(summary).slice(0, 6).map(([k, n]) => `${sEsc(k)} (${n})`).join(' · ');
  return `<span class="gen-pick-toggle" onclick="stratTogglePicks('${rejectId}', this)">▼ Why games were rejected</span>
    <div id="${rejectId}" style="display:none">
      <div style="font-size:10px;color:#8a9e8a;margin:4px 0">${summaryStr}</div>
      ${sample.map(r => `<div class="strat-reject-row">${sEsc(r.home)} vs ${sEsc(r.away)} <span style="color:#4a7a4a">[${sEsc(r.league)}]</span> — ${sEsc(r.reason)}</div>`).join('')}
    </div>`;
}

// ── Refine My Code (H2H Favorites) ──────────────────────────────────────────────
window.h2hRefineRun = async function () {
  const btn = $s('h2h-refine-btn');
  const status = $s('h2h-refine-status');
  const summaryEl = $s('h2h-refine-summary');
  const genEl = $s('h2h-refine-generated');
  const resultsEl = $s('h2h-refine-results');
  const code = ($s('h2h-refine-code') || {}).value?.trim();

  if (!code) { status.textContent = 'Paste at least one booking code first'; status.style.color = '#e53935'; return; }

  btn.disabled = true;
  btn.textContent = '⏳ Checking…';
  status.textContent = '';
  summaryEl.textContent = '';
  genEl.innerHTML = '';
  resultsEl.innerHTML = '';

  try {
    const r = await fetch('/api/admin/h2h-refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': window.adminPw || '' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(290000) : undefined,
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (_) { throw new Error('Server returned non-JSON. Is it running in dev mode?'); }
    if (!j.success) throw new Error(j.error || 'Refine failed');

    summaryEl.textContent = `${j.codesUsed.join(' + ')} — ${j.legCount} unique legs — ${j.summary.keep} already fine, ${j.summary.edit} have a suggested swap, ${j.summary.drop} have no safe favourite on that fixture`;
    genEl.innerHTML = h2hGeneratedHtml(j.generated);
    resultsEl.innerHTML = j.legs.map(h2hRefineRowHtml).join('');
    status.textContent = '✓ Done';
    status.style.color = '#00c853';
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.style.color = '#e53935';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze';
  }
};

function h2hGeneratedHtml(g) {
  if (!g || g.skipped) {
    return `<div style="font-size:12px;color:#ffb300">⚠ No code generated — ${sEsc((g && g.reason) || 'unknown reason')}</div>`;
  }
  const copyId = 'h2h-gen-code';
  return `<div class="gen-code-card strat-card" style="border-color:rgba(0,200,83,0.4)">
    <div class="gen-code-head">
      <span id="${copyId}" class="gen-code-code"
        onclick="navigator.clipboard.writeText('${sEsc(g.shareCode)}').then(()=>{ const el=document.getElementById('${copyId}'); const orig=el.textContent; el.textContent='✓ Copied!'; setTimeout(()=>el.textContent=orig,1500); })"
        title="Click to copy">${sEsc(g.shareCode)}</span>
      <div class="gen-code-meta">
        <span><b>Refined code</b></span>
        <span>${g.legCount} legs</span>
      </div>
    </div>
  </div>`;
}

function h2hRefineRowHtml(leg) {
  const color = leg.verdict === 'KEEP' ? '#00c853' : leg.verdict === 'EDIT' ? '#ffb300' : '#e53935';
  const badge = leg.verdict === 'KEEP' ? '✓ KEEP' : leg.verdict === 'EDIT' ? '↻ EDIT' : '✗ DROP';
  const suggestionHtml = leg.suggestion
    ? `<div style="color:#00c853;font-size:11px">→ ${sEsc(leg.suggestion.marketName)}: ${sEsc(leg.suggestion.outcomeName)} @${leg.suggestion.odds}</div>`
    : '';
  return `<div class="strat-reject-row" style="border-left:3px solid ${color};padding-left:8px;margin-bottom:6px">
    <span style="color:${color};font-weight:700">${badge}</span>
    <b style="color:#e8edf4">${sEsc(leg.homeTeam)} vs ${sEsc(leg.awayTeam)}</b>
    <span style="color:#4a7a4a;font-size:10px">[${sEsc(leg.league)}]</span>
    <div style="font-size:11px;color:#8a9e8a">${sEsc(leg.market)}: ${sEsc(leg.outcome)} @${leg.odds}${leg.verdict !== 'KEEP' ? ' — ' + sEsc(leg.reason) : ''}</div>
    ${suggestionHtml}
  </div>`;
}

window.stratTogglePicks = function (id, toggle) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  const isReject = id.startsWith('strat-reject-');
  toggle.textContent = open
    ? (isReject ? '▼ Why games were rejected' : '▼ Show pick breakdown')
    : (isReject ? '▲ Hide rejection reasons' : '▲ Hide picks');
};
