/* SlipPilot X Assistant — public/x-assistant.js
 * Paste a tweet URL / text, run it through the deterministic Intent Engine +
 * Scanner / Optimizer / Converter, get a template reply. No LLM, no paid X API —
 * you copy the result and post manually.
 * Reuses adminPw + the P/F canvas palette already defined by admin.html / studio.js.
 */
'use strict';

function xaSwitchTab(id) {
  document.querySelectorAll('#tab-xassistant .cs-stab').forEach(b => b.classList.toggle('active', b.dataset.xtab === id));
  document.querySelectorAll('#tab-xassistant .xa-content').forEach(c => c.classList.toggle('active', c.dataset.xtab === id));
  if (id === 'history') loadXaHistory();
}

function xaShowError(msg) {
  const box = document.getElementById('xa-error-box');
  box.textContent = msg;
  box.style.display = 'block';
}
function xaHideError() {
  document.getElementById('xa-error-box').style.display = 'none';
}

async function xaAnalyze() {
  xaHideError();
  const raw = document.getElementById('xa-input').value.trim();
  if (!raw) { xaShowError('Paste a tweet URL, tweet text, or a direct command first.'); return; }

  const body = {};
  if (/^https?:\/\/(twitter|x)\.com\//i.test(raw)) body.tweetUrl = raw;
  else body.tweetText = raw;

  const btn = document.getElementById('xa-analyze-btn');
  const original = btn.textContent;
  btn.textContent = 'Analyzing…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/admin/x-assistant/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPw },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { xaShowError(data.error || 'Analysis failed'); return; }
    if (data.needsManualText) {
      xaShowError((data.warnings || []).join(' ') + ' Paste the tweet text below and click Analyze again.');
      return;
    }
    xaRenderResult(data);
  } catch (e) {
    xaShowError('Request failed: ' + e.message);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

function xaFormatAction(a) {
  switch (a.type) {
    case 'remove_league': return 'Removed league: ' + a.league;
    case 'remove_team': return 'Removed team: ' + a.team;
    case 'remove_any': return 'Removed: ' + a.term;
    case 'remove_market_type': return 'Removed markets matching: ' + a.keyword;
    case 'keep_only_league': return 'Kept only league: ' + a.league;
    case 'remove_last_n': return 'Removed last ' + a.n + ' selections';
    case 'keep_today_only': return "Kept today's games only";
    case 'remove_tomorrow': return "Removed tomorrow's games";
    case 'reduce_risk': return 'Reduced risk (dropped low-confidence picks)';
    case 'maximize_confidence': return 'Maximized confidence (kept only high-scoring picks)';
    case 'reduce_to_target_odds': return 'Reduced odds toward ~' + a.target;
    case 'increase_to_target_odds': return 'Attempted to increase odds' + (a.target ? ' toward ~' + a.target : '');
    case 'convert_market': return 'Converted market to: ' + a.to;
    case 'lock': return 'Locked: ' + a.team;
    case 'unlock': return 'Unlocked: ' + a.team;
    case 'rebuild': return 'Rebuilt slip';
    default: return a.type;
  }
}

function xaCopy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  });
}

function xaRow(k, v) {
  if (v === null || v === undefined || v === '') return '';
  return `<div class="xa-row"><div class="xa-k">${k}</div><div class="xa-v">${v}</div></div>`;
}

function xaRenderResult(data) {
  const el = document.getElementById('xa-result');
  el.style.display = 'block';

  const warnings = (data.warnings || []).map(w => `<div class="xa-warn">⚠️ ${w}</div>`).join('');
  const actions = (data.actionsPerformed || []).map(xaFormatAction);

  let scanBlock = '';
  if (data.scan && data.scan.results) {
    scanBlock = xaRow('Scan Result', `${data.scan.won}W / ${data.scan.lost}L / ${data.scan.void}V / ${data.scan.pending} pending — Hit Rate ${data.scan.hitRate}%`);
  }

  let replyBlock = '';
  if (data.reply) {
    const id = 'xa-reply-' + data.id;
    replyBlock = `<h2 style="margin:20px 0 10px">Suggested Reply</h2>
      <div class="xa-reply-card">
        <div class="xa-reply-text" id="${id}">${data.reply}</div>
        <button class="xa-copy-btn" onclick="xaCopy(document.getElementById('${id}').textContent, this)">Copy Reply</button>
      </div>`;
    if (data.firstReply) {
      replyBlock += `<div class="xa-reply-card" style="border-color:rgba(0,200,83,0.25)">
        <div class="xa-reply-lbl" style="color:#00c853">Suggested First Reply (continue the thread)</div>
        <div class="xa-reply-text" id="xa-firstreply-${data.id}">${data.firstReply}</div>
        <button class="xa-copy-btn" onclick="xaCopy(document.getElementById('xa-firstreply-${data.id}').textContent, this)">Copy</button>
      </div>`;
    }
  }

  el.innerHTML = `
    <h2 style="margin:20px 0 10px">Result</h2>
    ${warnings}
    ${xaRow('Original Tweet', data.tweetText ? data.tweetText.replace(/\n/g, '<br>') : '')}
    ${xaRow('Original Booking Code', data.detectedCode)}
    ${xaRow('Detected Intent', data.intentSummary)}
    ${actions.length ? xaRow('Actions Performed', actions.join('<br>')) : ''}
    ${scanBlock}
    ${xaRow('Old Odds', data.oldOdds)}
    ${xaRow('New Odds', data.newOdds)}
    ${xaRow('Confidence Score', data.confidence !== null && data.confidence !== undefined ? data.confidence + ' / 100' : null)}
    ${data.newBookingCode ? xaRow('New Booking Code', `<strong style="color:#00c853;font-family:'JetBrains Mono',monospace">${data.newBookingCode}</strong> <button class="xa-copy-btn" onclick="xaCopy('${data.newBookingCode}', this)">Copy Code</button>`) : ''}
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-sm" onclick="xaCopy(${JSON.stringify(JSON.stringify(data, null, 2))}, this)">Copy Full Analysis</button>
      ${data.tweetText ? `<button class="btn-sm" onclick="xaCopy(${JSON.stringify(data.tweetText)}, this)">Copy Tweet</button>` : ''}
    </div>
    ${replyBlock}
    ${data.newBookingCode ? '<h2 style="margin:20px 0 10px">Shareable Card</h2><div id="xa-card-wrap"></div>' : ''}
  `;

  if (data.newBookingCode) xaRenderCard(data);
}

// ── Shareable "before/after" card — reuses P (palette) / F (fonts) from studio.js ──
function xaRenderCard(data) {
  const wrap = document.getElementById('xa-card-wrap');
  const canvas = document.createElement('canvas');
  const W = 1200, H = 675;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const pal = (typeof P !== 'undefined') ? P : { bg: '#0d1117', text: '#e6edf3', muted: '#848d97', green: '#3fb950', border: '#21262d' };
  const font = (typeof F !== 'undefined') ? F : { sans: 'Arial, sans-serif', mono: 'monospace' };

  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = pal.text;
  ctx.font = `800 34px ${font.sans}`;
  ctx.fillText('SlipPilot — Slip Optimized', 50, 70);

  ctx.font = `600 16px ${font.sans}`;
  ctx.fillStyle = pal.muted;
  ctx.fillText('slippilot.com/ng', 50, 100);

  ctx.font = `600 20px ${font.sans}`;
  ctx.fillStyle = pal.muted;
  ctx.fillText('OLD ODDS', 80, 220);
  ctx.fillText('NEW ODDS', 620, 220);

  ctx.font = `900 64px ${font.mono}`;
  ctx.fillStyle = pal.muted;
  ctx.fillText(String(data.oldOdds ?? '—'), 80, 300);
  ctx.fillStyle = pal.green;
  ctx.fillText(String(data.newOdds ?? '—'), 620, 300);

  ctx.strokeStyle = pal.border;
  ctx.beginPath(); ctx.moveTo(560, 160); ctx.lineTo(560, 340); ctx.stroke();

  ctx.font = `700 24px ${font.sans}`;
  ctx.fillStyle = pal.text;
  ctx.fillText('New Booking Code', 80, 420);
  ctx.font = `900 48px ${font.mono}`;
  ctx.fillStyle = pal.green;
  ctx.fillText(data.newBookingCode || '', 80, 480);

  if (data.confidence !== null && data.confidence !== undefined) {
    ctx.font = `600 20px ${font.sans}`;
    ctx.fillStyle = pal.muted;
    ctx.fillText('Confidence: ' + data.confidence + ' / 100', 80, 540);
  }

  canvas.style.width = '100%';
  canvas.style.borderRadius = '10px';
  canvas.style.border = '1px solid rgba(124,58,237,0.25)';
  wrap.innerHTML = '';
  wrap.appendChild(canvas);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap';
  const dlBtn = document.createElement('button');
  dlBtn.className = 'xa-copy-btn';
  dlBtn.textContent = 'Download Image';
  dlBtn.onclick = () => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'slippilot-' + (data.newBookingCode || 'card') + '.png';
    a.click();
  };
  btnRow.appendChild(dlBtn);

  if (navigator.clipboard && window.ClipboardItem) {
    const copyImgBtn = document.createElement('button');
    copyImgBtn.className = 'xa-copy-btn';
    copyImgBtn.textContent = 'Copy Image';
    copyImgBtn.onclick = () => {
      canvas.toBlob((blob) => {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
          copyImgBtn.textContent = 'Copied!';
          setTimeout(() => { copyImgBtn.textContent = 'Copy Image'; }, 1200);
        });
      });
    };
    btnRow.appendChild(copyImgBtn);
  }
  wrap.appendChild(btnRow);
}

// ── History ──
async function loadXaHistory() {
  const el = document.getElementById('xa-history-list');
  el.innerHTML = '<p style="color:#8a9e8a;font-size:12px">Loading...</p>';
  try {
    const r = await fetch('/api/admin/x-assistant/history', { headers: { 'x-admin-password': adminPw } });
    const list = await r.json();
    if (!list.length) { el.innerHTML = '<p style="color:#8a9e8a;font-size:12px">No interactions yet.</p>'; return; }
    el.innerHTML = list.map(item => `
      <div class="xa-hist-item" onclick='xaReopen(${JSON.stringify(item.id)})'>
        <div style="color:#fff;margin-bottom:4px">${(item.tweetText || '').slice(0, 90).replace(/</g, '&lt;')}${(item.tweetText || '').length > 90 ? '…' : ''}</div>
        <div style="color:#8a9e8a">${new Date(item.timestamp).toLocaleString()} ${item.detectedCode ? '· ' + item.detectedCode : ''} ${item.newBookingCode ? '→ ' + item.newBookingCode : ''}</div>
      </div>
    `).join('');
    window.__xaHistoryCache = list;
  } catch (e) {
    el.innerHTML = '<p style="color:#8a9e8a;font-size:12px">Could not load history.</p>';
  }
}

function xaReopen(id) {
  const item = (window.__xaHistoryCache || []).find(x => x.id === id);
  if (!item) return;
  xaSwitchTab('new');
  document.getElementById('xa-input').value = item.tweetUrl || item.tweetText || '';
  xaRenderResult(item);
}

// ── Daily Post ────────────────────────────────────────────────────────────────

// v25 — this used to fetch /api/admin/regen-merged and post the result as
// one "MERGED" slip on top of the individual codes — dropped per feedback:
// only each punter's own real code is ever shown, never a synthetic
// combined one. loadDailyPost/generateDailyPost/generateDailyPostImage all
// share one fetch of today's codes + their frozen odds (see the v24 odds
// freeze on /api/admin/punter-codes) so the list, the post text, and the
// image card can never disagree with each other.
async function fetchTodaysPunterCodes() {
  const r = await fetch('/api/admin/punter-codes', { headers: { 'x-admin-password': adminPw } });
  const j = await r.json();
  const oddsFrozen = j._oddsFrozen || {};
  const codes = { ...j }; delete codes._oddsFrozen;
  const entries = Object.entries(codes).filter(([, v]) => v).map(([name, code]) => ({
    name, code, odds: oddsFrozen[code.toUpperCase()] || null,
  }));
  return entries;
}

async function loadDailyPost() {
  const el = document.getElementById('dp-punters');
  try {
    const entries = await fetchTodaysPunterCodes();
    if (!entries.length) {
      el.innerHTML = '<p style="color:#64748B;font-size:12px;margin:0">No punter codes saved yet for today.</p>';
    } else {
      el.innerHTML = entries.map(({ name, code, odds }) =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(37,99,235,0.1)">
          <span style="font-size:12px;font-weight:600;color:#F1F5F9">${esc(name)}</span>
          <span>
            <span style="font-family:monospace;font-size:13px;font-weight:800;color:#06B6D4;letter-spacing:1px">${esc(code)}</span>
            ${odds ? `<span style="font-size:11px;color:#00c853;margin-left:8px">${odds.odds.toLocaleString()}x · ${odds.legs} legs 🔒</span>` : ''}
          </span>
        </div>`
      ).join('');
    }
  } catch (e) {
    el.innerHTML = `<p style="color:#e53935;font-size:12px;margin:0">${e.message}</p>`;
  }
  checkThemedRepostStatus(); // v38 — "come back and meet it": resumes/shows the last Themed Repost job on every tab open
}

async function generateDailyPost() {
  const msg = document.getElementById('dp-msg');
  const btn = document.getElementById('dp-gen-btn');
  const out = document.getElementById('dp-output');

  btn.disabled = true;
  btn.textContent = 'Merging codes…';
  msg.textContent = '';
  out.style.display = 'none';

  try {
    const entries = await fetchTodaysPunterCodes();
    if (!entries.length) {
      msg.textContent = 'No punter codes saved for today yet.';
      btn.disabled = false; btn.textContent = 'Generate Post';
      return;
    }

    // v25 — REAL BUG: this call (and the "🔗 MERGED" line below) was
    // removed on a misreading of feedback. The user actually wants the
    // merged slip KEPT — what needed to go was `_oddsFrozen` leaking in as
    // a fake "punter" row, which was a stale-cache issue (the script tag's
    // ?v= query wasn't bumped after the odds-freeze change shipped, so
    // browsers kept serving the old, pre-fix file). Restored.
    // v32 — ONE real code covering every game, however many. Confirmed live
    // (2026-08-03): SportyBet's share API stores/echoes any number of
    // selections without truncating — the "50 selections" wall only exists
    // in their own site's betslip JS when someone tries to load/place it
    // there. SlipPilot's own Optimizer reads a code via that same raw API,
    // not through SportyBet's front-end, so it shows every game with no cap
    // of its own — exactly the "go to SlipPilot to edit" flow that's wanted.
    // v44 — REAL BUG: this bare `catch {}` swallowed EVERY failure mode
    // (network drop, server mid-restart, SportyBet API hiccup, or the
    // server returning success:true with code:null) identically — the
    // "🔗 MERGED" line just silently disappeared with zero indication of
    // why, so a transient blip looked exactly like "the feature is broken".
    // Now every failure path is captured and surfaced in dp-msg so a bad
    // merge is visibly distinct from a normal, complete post.
    let mergedCode = null, mergedGames = 0, mergeError = null;
    try {
      const mergeRes = await fetch('/api/admin/regen-merged', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPw } });
      const mj = await mergeRes.json();
      if (mj.success && mj.code) { mergedCode = mj.code; mergedGames = mj.totalGames; }
      else mergeError = mj.error || mj.message || 'server returned no code';
    } catch (e) { mergeError = `network error (${e.message}) — server may be restarting, try again`; }

    // v27 — "odds shouldn't be in the post, just the picture": the text
    // post is plain again (name + code only) — odds/legs live ONLY in the
    // image card now.
    const today = new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' });
    const lines = [
      `🌅 Good morning! ${today} picks are LIVE 🔥`,
      '',
      "Today's punters 📋",
      ...entries.map(({ name, code }) => `• ${name} — ${code}`),
    ];

    if (mergedCode) {
      lines.push('');
      lines.push(`🔗 MERGED — ${mergedCode} (${mergedGames} games)`);
      lines.push('');
      lines.push(`✏️ Edit/split at slippilot.com.ng/#optimizer?code=${mergedCode}`);
    }

    lines.push('');
    lines.push('🎯 Track all punters live at slippilot.com.ng');

    document.getElementById('dp-text').value = lines.join('\n');
    out.style.display = 'block';
    if (mergeError) {
      msg.textContent = `⚠️ Post text is ready, but the MERGED code failed (${mergeError}) — click Generate Post again to retry it.`;
      msg.style.color = '#ffb300';
    } else {
      msg.style.color = '';
    }
  } catch (e) {
    msg.textContent = 'Error: ' + e.message;
  }

  btn.disabled = false;
  btn.textContent = 'Generate Post';
}

// v25 — "an image can be there that will show the code, folds and slips...
// so i can attach": a shareable PNG card, drawn client-side (canvas, no
// server round-trip/new dependency needed) listing every punter's real
// code with its frozen odds/leg count, ready to download and attach to a post.
// v27 — "folds, odds and everything should be on a line like the result.
// clean": rebuilt as a real column layout (Punter | Folds | Odds | Code),
// one row = one line, same idea as the Report table's own row format —
// no more odds/legs stacked on a second line under the code.
async function generateDailyPostImage() {
  const msg = document.getElementById('dp-msg');
  const btn = document.getElementById('dp-img-btn');
  const wrap = document.getElementById('dp-img-output');
  btn.disabled = true; btn.textContent = 'Building image…'; msg.textContent = '';
  try {
    const entries = await fetchTodaysPunterCodes();
    if (!entries.length) {
      msg.textContent = 'No punter codes saved for today yet.';
      btn.disabled = false; btn.textContent = '🖼 Generate Image'; return;
    }
    const rowH = 36, headH = 108, footH = 38, width = 760;
    const height = headH + entries.length * rowH + footH;
    const canvas = document.getElementById('dp-canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const COL = { name: 24, folds: 320, odds: 420, code: width - 24 };

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#0B1628'); bg.addColorStop(1, '#050a12');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);

    // Header
    ctx.fillStyle = '#F1F5F9'; ctx.font = '700 26px sans-serif';
    ctx.fillText('⚡ SlipPilot — Today\'s Codes', 24, 42);
    const today = new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    ctx.fillStyle = '#64748B'; ctx.font = '13px sans-serif';
    ctx.fillText(today, 24, 64);

    // Column header row — same idea as the Report table's own header
    ctx.font = '700 10px sans-serif'; ctx.fillStyle = '#64748B';
    ctx.fillText('PUNTER', COL.name, 84);
    ctx.fillText('FOLDS', COL.folds, 84);
    ctx.fillText('ODDS', COL.odds, 84);
    ctx.textAlign = 'right'; ctx.fillText('CODE', COL.code, 84); ctx.textAlign = 'left';
    ctx.strokeStyle = 'rgba(37,99,235,0.25)'; ctx.beginPath(); ctx.moveTo(24, 92); ctx.lineTo(width - 24, 92); ctx.stroke();

    // Rows — everything on ONE line per punter
    entries.forEach(({ name, code, odds }, i) => {
      const y = headH + i * rowH;
      if (i % 2 === 1) { ctx.fillStyle = 'rgba(37,99,235,0.05)'; ctx.fillRect(0, y, width, rowH); }
      const midY = y + rowH / 2 + 5;
      ctx.font = '600 14px sans-serif'; ctx.fillStyle = '#F1F5F9';
      ctx.fillText(name, COL.name, midY);
      ctx.font = '13px sans-serif'; ctx.fillStyle = '#94A3B8';
      ctx.fillText(odds ? `${odds.legs}L` : '—', COL.folds, midY);
      ctx.fillStyle = '#00c853';
      ctx.fillText(odds ? `${odds.odds.toLocaleString()}x` : '—', COL.odds, midY);
      ctx.font = '700 14px monospace'; ctx.fillStyle = '#06B6D4';
      ctx.textAlign = 'right';
      ctx.fillText(code, COL.code, midY);
      ctx.textAlign = 'left';
    });

    // Footer
    ctx.strokeStyle = 'rgba(37,99,235,0.25)'; ctx.beginPath();
    ctx.moveTo(24, height - footH + 10); ctx.lineTo(width - 24, height - footH + 10); ctx.stroke();
    ctx.fillStyle = '#64748B'; ctx.font = '12px sans-serif';
    ctx.fillText('🎯 Track all punters live at slippilot.com.ng', 24, height - 14);

    const url = canvas.toDataURL('image/png');
    document.getElementById('dp-img-download').href = url;
    wrap.style.display = 'block';
  } catch (e) {
    msg.textContent = 'Error: ' + e.message;
  }
  btn.disabled = false; btn.textContent = '🖼 Generate Image';
}

function copyDailyPost() {
  const ta = document.getElementById('dp-text');
  navigator.clipboard.writeText(ta.value).then(() => {
    const msg = document.getElementById('dp-msg');
    msg.textContent = 'Copied!';
    setTimeout(() => msg.textContent = '', 2000);
  });
}

// v38 — REAL FEEDBACK: "should save code when running so i can come back
// and meet it. should show history." The whole build (scan → safe-convert →
// quality-rank via master pool → H2H-refine → generate) used to run entirely
// in THIS browser tab's JS — closing the tab mid-build (a real 75s-300s
// process) killed it with nothing to show for it. Moved server-side (see
// runThemedRepostJob in server.js) as a real background job persisted to
// disk: closing the tab, refreshing, or coming back later all land on
// whatever the job actually did. This file now only starts the job and
// polls its status — none of the scan/safe/score/H2H logic lives here
// anymore (see server.js for all of that).
const THEMED_REPOST_LABELS = { overunder: '⚽ Over/Under', fullgameover: '⚽ Full Game Over', handicap: '📐 Handicap', dcdnb: '🔀 Double Chance/DNB', all: '🎯' };
let themedRepostPollTimer = null;

// v44 — "no need of link or stuff": the post text is now just the theme
// header + code lines, ready to copy and post as-is — the
// "Edit/split at slippilot.com.ng/#optimizer?code=..." line is gone.
function themedVariantLines(variants, singleLabel) {
  if (variants.length === 1) return [`🔗 ${singleLabel} — ${variants[0].code} (${variants[0].legs}g)`];
  return variants.map((v, i) => `🔗 ${singleLabel} CODE ${i + 1} — ${v.code} (${v.legs}g)`);
}

function renderThemedRepostJob(current) {
  const msg = document.getElementById('dp-theme-msg');
  const btn = document.getElementById('dp-theme-btn');
  const masterBtn = document.getElementById('dp-theme-master-btn');
  const out = document.getElementById('dp-theme-output');
  if (!current) { out.style.display = 'none'; msg.textContent = ''; return; }

  if (current.status === 'running') {
    btn.disabled = true; if (masterBtn) masterBtn.disabled = true;
    (current.params?.master ? masterBtn || btn : btn).textContent = current.stage || 'Working…';
    msg.textContent = `Started ${new Date(current.startedAt).toLocaleTimeString()} — safe to close this tab, it keeps running.`;
    out.style.display = 'none';
    return;
  }

  btn.disabled = false; btn.textContent = 'Build Themed Repost';
  if (masterBtn) { masterBtn.disabled = false; masterBtn.textContent = '🎯 Master (All Themes)'; }
  if (current.status === 'error') {
    msg.textContent = current.error || 'Build failed.';
    out.style.display = 'none';
    return;
  }
  if (current.status !== 'done' || !current.result) return;
  const { params, result } = current;

  // v44 — "master where we can be like today over, today handicap..":
  // one job, every real theme, delivered together — no per-theme clicking.
  if (result.master) {
    const ok = (result.categories || []).filter(c => !c.error);
    const totalCodes = ok.reduce((s, c) => s + (c.variants || []).length, 0);
    const lines = [
      `🎯 Master Themed Picks — ${ok.length} theme${ok.length === 1 ? '' : 's'}, ${totalCodes} code${totalCodes === 1 ? '' : 's'}${params.safeMode ? ' (Safe)' : ''} 🔥`,
      '',
      ...ok.flatMap(c => [
        THEMED_REPOST_LABELS[c.category] || c.category,
        ...themedVariantLines(c.variants, THEMED_REPOST_LABELS[c.category] || c.category),
        '',
      ]),
      '🎯 Track all punters live at slippilot.com.ng',
    ];
    document.getElementById('dp-theme-text').value = lines.join('\n');
    out.style.display = 'block';
    const failed = (result.categories || []).filter(c => c.error);
    msg.textContent = `${ok.length}/${(result.categories || []).length} themes built, ${totalCodes} code(s) total.` +
      (failed.length ? ` Skipped: ${failed.map(f => `${THEMED_REPOST_LABELS[f.category] || f.category} (${f.error})`).join('; ')}.` : '') +
      ` Built ${new Date(current.finishedAt).toLocaleTimeString()}.`;
    return;
  }

  const variants = result.variants || (result.code ? [{ code: result.code, legs: result.legs }] : []); // back-compat with any pre-v40 single-code history entry
  const label = THEMED_REPOST_LABELS[params.category] || '🎯';
  const lines = [
    `${label} Themed picks — ${result.legs} games across ${variants.length} code${variants.length === 1 ? '' : 's'}${params.safeMode ? ' (Safe)' : ''} 🔥`,
    '',
    ...themedVariantLines(variants, 'MERGED'),
    '',
    '🎯 Track all punters live at slippilot.com.ng',
  ];
  document.getElementById('dp-theme-text').value = lines.join('\n');
  out.style.display = 'block';
  msg.textContent = `Ranked ${result.candidatePool} pooled games by quality (league/market/H2H) → kept the best ${result.legs} across ${variants.length} code(s). ${result.matchedPool}/${result.legs} matched today's intelligence pool directly. Built ${new Date(current.finishedAt).toLocaleTimeString()}.`;
}

function renderThemedRepostHistory(history) {
  const el = document.getElementById('dp-theme-history');
  if (!el) return;
  const past = (history || []).filter(h => h.status === 'done' && h.result);
  if (!past.length) { el.innerHTML = '<p style="font-size:11px;color:#64748B;margin:4px 0 0">No past builds yet.</p>'; return; }
  el.innerHTML = past.map(h => {
    const when = new Date(h.finishedAt).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (h.result.master) {
      const ok = (h.result.categories || []).filter(c => !c.error);
      const totalCodes = ok.reduce((s, c) => s + (c.variants || []).length, 0);
      const codesStr = ok.flatMap(c => (c.variants || []).map(v => v.code)).join(', ');
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(37,99,235,0.08);font-size:11px">
        <span style="color:#94A3B8">🎯 Master · ${ok.length} themes · ${totalCodes} codes${h.params?.safeMode ? ' · Safe' : ''} — ${when}</span>
        <span style="display:flex;align-items:center;gap:8px">
          <span style="font-family:monospace;font-weight:700;color:#06B6D4;letter-spacing:1px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(codesStr)}">${esc(codesStr)}</span>
          <button class="btn-sm" style="padding:2px 8px;font-size:10px" onclick="reuseThemedRepostHistory('${h.jobId}')">Load</button>
        </span>
      </div>`;
    }
    const label = THEMED_REPOST_LABELS[h.params?.category] || '🎯';
    const variants = h.result.variants || (h.result.code ? [{ code: h.result.code, legs: h.result.legs }] : []);
    const codesStr = variants.map(v => v.code).join(', ');
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(37,99,235,0.08);font-size:11px">
      <span style="color:#94A3B8">${label} ${h.result.legs}g · ${variants.length} code${variants.length === 1 ? '' : 's'}${h.params?.safeMode ? ' · Safe' : ''} — ${when}</span>
      <span style="display:flex;align-items:center;gap:8px">
        <span style="font-family:monospace;font-weight:700;color:#06B6D4;letter-spacing:1px">${esc(codesStr)}</span>
        <button class="btn-sm" style="padding:2px 8px;font-size:10px" onclick="reuseThemedRepostHistory('${h.jobId}')">Load</button>
      </span>
    </div>`;
  }).join('');
}

// Pulls a past build back into the main output box (e.g. to re-copy or
// re-share an earlier code) without re-running anything.
function reuseThemedRepostHistory(jobId) {
  fetch('/api/admin/themed-repost/state', { headers: { 'x-admin-password': adminPw } })
    .then(r => r.json())
    .then(j => {
      const entry = (j.history || []).find(h => h.jobId === jobId);
      if (entry) renderThemedRepostJob(entry);
    });
}

async function pollThemedRepostOnce() {
  try {
    const r = await fetch('/api/admin/themed-repost/state', { headers: { 'x-admin-password': adminPw } });
    const j = await r.json();
    renderThemedRepostJob(j.current);
    renderThemedRepostHistory(j.history);
    if (j.current?.status === 'running') {
      themedRepostPollTimer = setTimeout(pollThemedRepostOnce, 2000);
    } else {
      clearTimeout(themedRepostPollTimer);
    }
  } catch {}
}

// Called whenever the Daily Post tab is opened (see loadDailyPost) — "come
// back and meet it": shows whatever the last job did, or keeps polling if
// one is still running, with zero clicks needed.
function checkThemedRepostStatus() {
  clearTimeout(themedRepostPollTimer);
  pollThemedRepostOnce();
}

async function generateThemedRepost() {
  const category = document.getElementById('dp-theme-category').value;
  const minOdds = parseFloat(document.getElementById('dp-theme-minodds').value) || 0;
  const maxOdds = parseFloat(document.getElementById('dp-theme-maxodds').value) || 0;
  const safeMode = document.getElementById('dp-theme-safe').checked;
  const variants = parseInt(document.getElementById('dp-theme-variants').value, 10) || 1;
  const msg = document.getElementById('dp-theme-msg');
  const btn = document.getElementById('dp-theme-btn');

  btn.disabled = true; btn.textContent = 'Starting…'; msg.textContent = '';
  try {
    const r = await fetch('/api/admin/themed-repost/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPw },
      body: JSON.stringify({ category, minOdds, maxOdds, safeMode, variants }),
    });
    const j = await r.json();
    if (!j.success) { msg.textContent = j.error || 'Failed to start.'; btn.disabled = false; btn.textContent = 'Build Themed Repost'; return; }
    clearTimeout(themedRepostPollTimer);
    pollThemedRepostOnce();
  } catch (e) {
    msg.textContent = 'Error: ' + e.message;
    btn.disabled = false; btn.textContent = 'Build Themed Repost';
  }
}

// v44 — "master where we can be like today over, today handicap.. all the
// mode then run h2h and delivered then i can post it": one click builds
// every real theme (Over/Under, Full Game Over, Handicap, DC/DNB) in a
// single background job, same odds/safe/codes settings applied to each.
async function generateThemedRepostMaster() {
  const minOdds = parseFloat(document.getElementById('dp-theme-minodds').value) || 0;
  const maxOdds = parseFloat(document.getElementById('dp-theme-maxodds').value) || 0;
  const safeMode = document.getElementById('dp-theme-safe').checked;
  const variants = parseInt(document.getElementById('dp-theme-variants').value, 10) || 1;
  const msg = document.getElementById('dp-theme-msg');
  const btn = document.getElementById('dp-theme-master-btn');

  btn.disabled = true; btn.textContent = 'Starting…'; msg.textContent = '';
  try {
    const r = await fetch('/api/admin/themed-repost/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPw },
      body: JSON.stringify({ master: true, minOdds, maxOdds, safeMode, variants }),
    });
    const j = await r.json();
    if (!j.success) { msg.textContent = j.error || 'Failed to start.'; btn.disabled = false; btn.textContent = '🎯 Master (All Themes)'; return; }
    clearTimeout(themedRepostPollTimer);
    pollThemedRepostOnce();
  } catch (e) {
    msg.textContent = 'Error: ' + e.message;
    btn.disabled = false; btn.textContent = '🎯 Master (All Themes)';
  }
}

function copyThemedRepost() {
  const ta = document.getElementById('dp-theme-text');
  navigator.clipboard.writeText(ta.value).then(() => {
    const msg = document.getElementById('dp-theme-msg');
    msg.textContent = 'Copied!';
    setTimeout(() => msg.textContent = '', 2000);
  });
}
