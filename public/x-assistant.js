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

async function loadDailyPost() {
  const el = document.getElementById('dp-punters');
  try {
    const r = await fetch('/api/admin/punter-codes', { headers: { 'x-admin-password': adminPw } });
    const codes = await r.json();
    const entries = Object.entries(codes).filter(([, v]) => v);
    if (!entries.length) {
      el.innerHTML = '<p style="color:#8a9e8a;font-size:12px;margin:0">No punter codes saved yet for today.</p>';
    } else {
      el.innerHTML = entries.map(([name, code]) =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1e2e1e">
          <span style="font-size:12px;font-weight:600">${esc(name)}</span>
          <span style="font-family:monospace;font-size:13px;font-weight:800;color:#69f0ae;letter-spacing:1px">${esc(code)}</span>
        </div>`
      ).join('');
    }
  } catch (e) {
    el.innerHTML = `<p style="color:#e53935;font-size:12px;margin:0">${e.message}</p>`;
  }
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
    // 1. Get today's punter codes
    const codesRes = await fetch('/api/admin/punter-codes', { headers: { 'x-admin-password': adminPw } });
    const codes = await codesRes.json();
    const entries = Object.entries(codes).filter(([, v]) => v);

    if (!entries.length) {
      msg.textContent = 'No punter codes saved for today yet.';
      btn.disabled = false; btn.textContent = 'Generate Post';
      return;
    }

    // 2. Auto-merge all today's codes into one slip
    let merged = '';
    try {
      const mergeRes = await fetch('/api/admin/regen-merged', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPw } });
      const mj = await mergeRes.json();
      if (mj.success && mj.codes && mj.codes.length) {
        merged = mj.codes[0].code;
      }
    } catch {}

    // 3. Build the post
    const today = new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' });
    const lines = [
      `🌅 Good morning! ${today} picks are LIVE 🔥`,
      '',
      "Today's punters 📋",
      ...entries.map(([name, code]) => `• ${name} — ${code}`),
    ];

    if (merged) {
      lines.push('');
      lines.push(`🔗 MERGED — ${merged}`);
      lines.push('');
      lines.push('✏️ Edit merged slip: slippilot.com.ng/#convert');
    }

    lines.push('');
    lines.push('🎯 Track all punters live at slippilot.com.ng');

    document.getElementById('dp-text').value = lines.join('\n');
    out.style.display = 'block';
  } catch (e) {
    msg.textContent = 'Error: ' + e.message;
  }

  btn.disabled = false;
  btn.textContent = 'Generate Post';
}

function copyDailyPost() {
  const ta = document.getElementById('dp-text');
  navigator.clipboard.writeText(ta.value).then(() => {
    const msg = document.getElementById('dp-msg');
    msg.textContent = 'Copied!';
    setTimeout(() => msg.textContent = '', 2000);
  });
}
