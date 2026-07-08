/* SlipPilot Content Studio — studio.js
 * Social-media image generator. Reads leaderboard data ONLY.
 * Never calls SpottyBet. Never calculates new statistics. Never estimates.
 */
'use strict';

// ── Colour Palette ────────────────────────────────────────────────────────────
const P = {
  bg:     '#0d1117',
  hdr:    '#010409',
  surf:   '#161b22',
  rowA:   '#0d1117',
  rowB:   '#0f1923',
  border: '#21262d',
  sep:    '#1c2128',
  text:   '#e6edf3',
  muted:  '#848d97',
  dim:    '#3d444d',
  green:  '#3fb950',
  red:    '#f85149',
  yellow: '#d29922',
  blue:   '#58a6ff',
  gold:   '#e3b341',
  silver: '#a5b4c3',
  bronze: '#cd7f32',
};

const F = {
  sans: 'Arial, Helvetica, sans-serif',
  mono: '"Courier New", Courier, monospace',
};

// ── Column Layout (1080px canvas, 20px margins) ───────────────────────────────
// Right edges: RK=68  PUNTER=284  G=342  W=400  L=458  V=512  PD=566
//              WIN%=656  CODE=790  [ODDS/DAYS]=1060  (right margin 20) ✓
const COLS = [
  { key: 'rk',   label: 'RK',          x: 20,  w: 48,  align: 'center' },
  { key: 'name', label: 'PUNTER',       x: 74,  w: 210, align: 'left'   },
  { key: 'g',    label: 'G',            x: 290, w: 52,  align: 'right'  },
  { key: 'w',    label: 'W',            x: 348, w: 52,  align: 'right'  },
  { key: 'l',    label: 'L',            x: 406, w: 52,  align: 'right'  },
  { key: 'v',    label: 'V',            x: 464, w: 48,  align: 'right'  },
  { key: 'pd',   label: 'PD',           x: 518, w: 48,  align: 'right'  },
  { key: 'wp',   label: 'WIN %',        x: 572, w: 84,  align: 'right'  },
  { key: 'code', label: 'CODE',         x: 662, w: 128, align: 'center' },
  { key: 'odds', label: 'TOTAL ODDS',   x: 798, w: 262, align: 'right'  },
];

// ── Alias Map — canonical punter names ───────────────────────────────────────
const ALIAS_MAP = {
  'super mario':     'SuperMario',
  'top boy comrade': 'Top Boy',
  'bayobets':        'Bayobet',
};
function normaliseName(n) {
  const key = (n || '').toLowerCase().trim();
  return ALIAS_MAP[key] || n || 'Unknown';
}

// ── Banned Leagues (for League Watch) ─────────────────────────────────────────
const BANNED_KEYWORDS = [
  'kolmonen', '4. deild', '3. deild', 'besta deild',
  'club friendlies', 'youth', 'women', 'virtual',
  'usl league two', 'serie b ecuador', 'carioca', 'mineiro',
  'azadegan', 'russian 2. liga', 'division 2', 'division 3',
  'division 4', 'division 5', 'brasileiro serie b', 'esiliiga b',
];
function _isBanned(league) {
  const l = (league || '').toLowerCase();
  return BANNED_KEYWORDS.some(b => l.includes(b));
}

// ── State ─────────────────────────────────────────────────────────────────────
let _reportDates = [];
let _currentData = null;
let _captionIdx  = 0;
let _reportType  = 'daily';   // 'daily' | 'weekly' | 'monthly'
let _mode        = 'daily';
let _logoImg     = null;

// ── Column Mode ───────────────────────────────────────────────────────────────
function activeCols() {
  if (_mode !== 'daily') {
    return [...COLS.slice(0, 9), { key: 'days', label: 'DAYS', x: 798, w: 262, align: 'right' }];
  }
  return COLS;
}

// ── Logo Loader (uses site icon — same as index.html) ─────────────────────────
function _loadLogo() {
  if (_logoImg) return Promise.resolve(_logoImg);
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => { _logoImg = img; resolve(img); };
    img.onerror = () => {
      const img2 = new Image();
      img2.onload  = () => { _logoImg = img2; resolve(img2); };
      img2.onerror = () => resolve(null);
      img2.src = '/icon-512.png';
    };
    img.src = '/icon-192.png';
  });
}

// Draw a rounded-rectangle-clipped image (matches index.html border-radius:12px usage)
function _drawRoundedImage(ctx, img, x, y, w, h, r) {
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }
  ctx.closePath();
  ctx.clip();
  const ratio = Math.min(w / img.width, h / img.height);
  ctx.drawImage(img,
    x + (w - img.width * ratio) / 2,
    y + (h - img.height * ratio) / 2,
    img.width * ratio, img.height * ratio
  );
  ctx.restore();
}

// ── Date Helpers ──────────────────────────────────────────────────────────────
function _localDateStr(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function getYesterday() { return _localDateStr(-1); }
function getToday()     { return _localDateStr(0); }
// Returns the date chosen in the picker, falling back to today
// (user can always pick yesterday manually; defaulting to today lets 11pm runs work)
function getTargetDate() {
  const picker = document.getElementById('cs-date-picker');
  return (picker && picker.value) ? picker.value : getToday();
}
function fmtLong(s) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtShort(s) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
}
function getWeekRange() {
  const end   = getYesterday();
  const start = new Date(end + 'T12:00:00');
  start.setDate(start.getDate() - 6);
  const startStr = start.toISOString().slice(0, 10);
  return {
    start: startStr,
    end,
    label: fmtShort(startStr) + ' – ' + fmtShort(end),
  };
}
function getMonthRange() {
  const end = getYesterday();
  const d   = new Date(end + 'T12:00:00');
  const startStr = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  return {
    start: startStr,
    end,
    label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
  };
}
function csTpl() {
  try { return JSON.parse(localStorage.getItem('cs_tpl') || '{}'); } catch { return {}; }
}

// ── Odds Formatter ────────────────────────────────────────────────────────────
// Returns null when odds are missing/invalid so callers can hide the badge entirely.
function _fmtOdds(n) {
  if (!n || n <= 1 || !isFinite(n)) return null;
  if (n >= 1e15) return '>999T×';
  const sig3 = v => { const s = parseFloat(v.toPrecision(3)); return isFinite(s) ? String(s) : v.toFixed(0); };
  if (n < 1000)  return n.toFixed(2) + '×';
  if (n < 1e6)   return sig3(n / 1e3)  + 'K×';
  if (n < 1e9)   return sig3(n / 1e6)  + 'M×';
  if (n < 1e12)  return sig3(n / 1e9)  + 'B×';
  return sig3(n / 1e12) + 'T×';
}

// ── Safe Fetch ────────────────────────────────────────────────────────────────
async function safeFetch(url, opts = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'x-admin-password': window.adminPw || '', ...(opts.headers || {}) },
      ...opts,
    });
  } catch (e) {
    throw new Error('Cannot connect to server. Is the server running?');
  }
  if (resp.status === 401 || resp.status === 403)
    throw new Error('Unauthorized — refresh the page and log in again.');
  if (!resp.ok)
    throw new Error('HTTP ' + resp.status + ' from server (' + url + ').');
  try { return await resp.json(); }
  catch { throw new Error('Invalid JSON response from server (' + url + ').'); }
}

// ── Data Processing ───────────────────────────────────────────────────────────
function processLeaderboard(raw, targetDate) {
  const list = Array.isArray(raw.leaderboard) ? raw.leaderboard : [];

  const punters = list
    .filter(p => Array.isArray(p.codes) && p.codes.some(c => c.date === targetDate))
    .map(p => {
      const c = p.codes.find(c => c.date === targetDate);
      if (!c) return null;

      const won     = c.won     || 0;
      const lost    = c.lost    || 0;
      const void_   = c.void    || 0;
      const pending = c.pending || 0;
      const games   = c.games   || (won + lost + void_ + pending);
      const settled = won + lost;
      const hitRate = (c.hitRate != null)
        ? c.hitRate
        : (settled > 0 ? Math.round(won / settled * 100) : 0);

      const prev  = (p.codes || []).find(cc => cc.date !== targetDate && cc.hitRate != null);
      const trend = prev
        ? (hitRate > prev.hitRate ? '▲' : hitRate < prev.hitRate ? '▼' : '—')
        : '—';

      return {
        name:      normaliseName(p.punter),
        games,
        won,
        lost,
        void:      void_,
        pending,
        hitRate,
        settled,
        trend,
        code:      c.code      || null,
        totalOdds: c.totalOdds || null,
      };
    })
    .filter(Boolean)
    // Require ≥2 settled games — 1 game gives misleading 0% or 100% hit rates
    .filter(p => p.settled >= 2)
    .sort((a, b) => b.hitRate - a.hitRate || b.won - a.won);

  // Keep a separate "pending only" list so we can show them without ranking
  const pendingOnly = (() => {
    return (Array.isArray(raw.leaderboard) ? raw.leaderboard : [])
      .filter(p => Array.isArray(p.codes) && p.codes.some(c => c.date === targetDate))
      .map(p => {
        const c = p.codes.find(c => c.date === targetDate);
        return c && (c.won + c.lost) === 0 ? { name: normaliseName(p.punter), code: c.code, games: c.games || 0, pending: c.pending || 0 } : null;
      })
      .filter(Boolean);
  })();

  const active = punters;
  const avgHR  = active.length
    ? Math.round(active.reduce((s, p) => s + p.hitRate, 0) / active.length)
    : 0;

  return { date: targetDate, punters, pendingOnly, avgHR };
}

function aggregateLeaderboard(raw, startDate, endDate) {
  const list = Array.isArray(raw.leaderboard) ? raw.leaderboard : [];
  const map  = {};

  list.forEach(p => {
    const name    = normaliseName(p.punter);
    const inRange = (p.codes || []).filter(c => c.date >= startDate && c.date <= endDate);
    if (!inRange.length) return;

    if (!map[name]) map[name] = { name, won: 0, lost: 0, void: 0, pending: 0, games: 0, days: 0, codes: [] };
    const agg = map[name];

    inRange.forEach(c => {
      agg.won     += c.won     || 0;
      agg.lost    += c.lost    || 0;
      agg.void    += c.void    || 0;
      agg.pending += c.pending || 0;
      agg.games   += c.games   || ((c.won || 0) + (c.lost || 0) + (c.void || 0) + (c.pending || 0));
      agg.days    += 1;
      if (c.code) agg.codes.push(c.code);
    });
  });

  const punters = Object.values(map)
    .map(p => {
      const settled = p.won + p.lost;
      const hitRate = settled > 0 ? Math.round(p.won / settled * 100) : 0;
      return { ...p, settled, hitRate, totalOdds: null, code: p.codes[0] || null, trend: '—' };
    })
    .filter(p => p.settled >= 2)
    .sort((a, b) => b.hitRate - a.hitRate || b.won - a.won);

  const avgHR = punters.length
    ? Math.round(punters.reduce((s, p) => s + p.hitRate, 0) / punters.length)
    : 0;

  return { punters, avgHR };
}

// ── League Watch ──────────────────────────────────────────────────────────────
function buildLeagueWatch(raw) {
  const list   = Array.isArray(raw.leaderboard) ? raw.leaderboard : [];
  const counts = {};

  list.forEach(p => {
    (p.topLeagues || []).forEach(entry => {
      const league = Array.isArray(entry) ? entry[0] : entry;
      const count  = Array.isArray(entry) ? (entry[1] || 1) : 1;
      if (league) counts[league] = (counts[league] || 0) + count;
    });
  });

  const sorted = Object.entries(counts)
    .filter(([l]) => l)
    .sort((a, b) => b[1] - a[1]);

  const banned = sorted.filter(([l]) => _isBanned(l)).map(([l]) => l);
  const watch  = sorted.filter(([l]) => !_isBanned(l)).slice(0, 5).map(([l]) => l);

  return { banned, watch };
}

// ── Caption Builder ───────────────────────────────────────────────────────────
// analysis = saved daily analysis object from /api/analysis/:date
// idx 0 = Full intelligence  |  idx 1 = Punter focus  |  idx 2 = Market/League focus
function buildCaption(data, idx, type, analysis) {
  type = type || 'daily';
  idx  = (idx || 0) % 3;
  const { punters, avgHR, date } = data;
  if (!punters || !punters.length) return 'No data available.';

  const dateStr = type === 'daily' ? fmtLong(date) : (data.rangeLabel || fmtShort(date));
  const tags = type === 'daily'
    ? '#FootballBetting #BettingTips #SlipPilot #SpottyBet'
    : '#FootballBetting #SlipPilot #BettingAnalysis';

  const settled = punters.filter(p => p.settled > 0);
  const best = settled[0] || punters[0];

  // ── Variant 1: Punter Performance Focus ─────────────────────────────────────
  if (idx === 1) {
    let cap = `👥 SLIPPILOT PUNTER REPORT — ${dateStr.toUpperCase()}\n\n`;
    if (settled.length >= 1) {
      cap += `🥇 BEST TODAY\n${settled[0].name} — ${settled[0].hitRate}% (${settled[0].won}W / ${settled[0].lost}L)\n\n`;
    }
    if (settled.length >= 2) {
      cap += `🥈 RUNNER UP\n${settled[1].name} — ${settled[1].hitRate}%\n\n`;
    }
    if (settled.length >= 3) {
      cap += `🥉 THIRD PLACE\n${settled[2].name} — ${settled[2].hitRate}%\n\n`;
    }
    const worst = [...settled].sort((a, b) => a.hitRate - b.hitRate)[0];
    if (worst && worst !== settled[0]) {
      cap += `📉 TOUGH DAY\n${worst.name} — only ${worst.hitRate}% today\n\n`;
    }
    cap += `Avg hit rate: ${avgHR}%  ·  ${punters.length} analysts tracked\n\n`;
    if (analysis?.insights?.length) {
      cap += `💡 ${analysis.insights[0]}\n\n`;
    }
    cap += tags;
    return cap;
  }

  // ── Variant 2: Market & League Intel Focus ───────────────────────────────────
  if (idx === 2) {
    let cap = `📈 SLIPPILOT MARKET INTEL — ${dateStr.toUpperCase()}\n`;
    cap += `What won, what lost, what to avoid next time\n\n`;
    if (analysis) {
      const mktWatch = analysis.marketWatch || {};
      const lgWatch  = analysis.leagueWatch  || {};
      const mktEntries = Object.entries(mktWatch).filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 3);
      const lgEntries  = Object.entries(lgWatch).filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 3);
      const bestMkt  = [...mktEntries].sort((a, b) => b[1].hitRate - a[1].hitRate)[0];
      const worstMkt = [...mktEntries].sort((a, b) => a[1].hitRate - b[1].hitRate)[0];
      const bestLg   = [...lgEntries].sort((a, b) => b[1].hitRate - a[1].hitRate)[0];
      const worstLg  = [...lgEntries].sort((a, b) => a[1].hitRate - b[1].hitRate)[0];
      if (bestMkt) {
        cap += `✅ MARKET OF THE DAY\n"${bestMkt[0]}" — ${bestMkt[1].hitRate}% hit rate (${bestMkt[1].won}W/${bestMkt[1].lost}L)\n\n`;
      }
      if (worstMkt && (!bestMkt || worstMkt[0] !== bestMkt[0])) {
        cap += `❌ MARKET TO AVOID\n"${worstMkt[0]}" — only ${worstMkt[1].hitRate}% today\n\n`;
      }
      if (bestLg) {
        cap += `📈 BEST LEAGUE\n${bestLg[0]} — ${bestLg[1].hitRate}% (${bestLg[1].won}W/${bestLg[1].lost}L)\n\n`;
      }
      if (worstLg && (!bestLg || worstLg[0] !== bestLg[0])) {
        cap += `⚠ RISKY LEAGUE\n${worstLg[0]} — ${worstLg[1].hitRate}%${worstLg[1].banned ? ' 🚫 BANNED' : ''}\n\n`;
      }
    } else {
      cap += `Run Rescan All to unlock market intelligence.\n\n`;
    }
    cap += `Overall avg: ${avgHR}%  ·  ${punters.length} analysts\n\n`;
    cap += tags;
    return cap;
  }

  // ── Variant 0 (default): Full Intelligence ────────────────────────────────────
  let cap = `📊 SLIPPILOT DAILY INTEL — ${dateStr.toUpperCase()}\n`;
  cap += `Top: ${best.name} ${best.hitRate}%  ·  Avg: ${avgHR}%  ·  ${punters.length} analysts\n\n`;

  if (!analysis || (analysis.partial && !analysis.ticketKillers?.length && !analysis.consensusWins?.length)) {
    // Partial or no analysis — build from leaderboard data instead
    const settled2 = punters.filter(p => p.settled > 0);
    const pending2 = punters.filter(p => p.pending > 0);
    if (pending2.length && !settled2.length) {
      cap += `${pending2.length} punters have codes live — results still pending. Check back after matches finish.\n\n${tags}`;
    } else if (settled2.length) {
      const wst = [...settled2].sort((a, b) => a.hitRate - b.hitRate)[0];
      cap += `🔍 Best: ${best.name} at ${best.hitRate}% (${best.won}W/${best.lost}L)\n`;
      if (wst && wst.name !== best.name) cap += `Worst: ${wst.name} at ${wst.hitRate}%\n`;
      cap += `\nFull analysis available after Rescan All completes.\n\n${tags}`;
    } else {
      cap += `Codes tracked — run Rescan All after matches finish for full breakdown.\n\n${tags}`;
    }
    return cap;
  }

  try {
    const killers  = analysis.ticketKillers || [];
    const wins     = analysis.consensusWins  || [];
    const insights = analysis.insights || [];
    const mktWatch = analysis.marketWatch || {};
    const lgWatch  = analysis.leagueWatch  || {};

    // 1. 🔥 Biggest Killer Today
    const topKiller = killers[0];
    if (topKiller) {
      const sel = topKiller.selections?.[0];
      const odds = sel?.originalOdds ? ` (${sel.originalOdds}×)` : '';
      const mkt = sel ? (sel.outcome || sel.market || '') : '';
      cap += `🔥 BIGGEST KILLER TODAY\n`;
      cap += `${topKiller.match}${odds}${mkt ? ` — ${mkt}` : ''}\n`;
      cap += `Wrecked ${topKiller.codeCount} slip${topKiller.codeCount !== 1 ? 's' : ''} / ${topKiller.punterCount} punter${topKiller.punterCount !== 1 ? 's' : ''}\n`;
      if (topKiller.reasons?.length) cap += `Why: ${topKiller.reasons.slice(0, 2).join(' / ')}\n`;
      cap += '\n';
    } else {
      cap += `🔥 BIGGEST KILLER TODAY\nNot enough data.\n\n`;
    }

    // 2. 💰 Biggest Gift Today
    const topWin = wins[0];
    if (topWin) {
      const selStr = [...new Set((topWin.selections || []).map(s => s.outcome || s.market))].slice(0, 2).join(', ');
      cap += `💰 BIGGEST GIFT TODAY\n`;
      cap += `${topWin.match}${selStr ? ` — ${selStr}` : ''}\n`;
      if (topWin.punterCount > 1) cap += `${topWin.punterCount} punters called it correctly\n`;
      cap += '\n';
    } else {
      cap += `💰 BIGGEST GIFT TODAY\nNo consensus wins recorded.\n\n`;
    }

    // 3. ⚠ Trap Of The Day — popular pick that lost
    const trap = killers.find(k => k.punterCount >= 2 && k.selections?.some(s => (s.originalOdds || 0) < 2.5))
               || killers.find(k => k.punterCount >= 2)
               || null;
    if (trap) {
      const tSel = trap.selections?.[0];
      const tOdds = tSel?.originalOdds ? ` @ ${tSel.originalOdds}` : '';
      cap += `⚠ TRAP OF THE DAY\n`;
      cap += `${trap.match}${tOdds}${tSel?.market ? ` (${tSel.market})` : ''}\n`;
      cap += `${trap.punterCount} punters chose it — looked safe, wasn't\n\n`;
    } else {
      cap += `⚠ TRAP OF THE DAY\nNo clear trap today (confidence is low).\n\n`;
    }

    // 4 & 5. League performance
    const lgEntries = Object.entries(lgWatch).filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 3);
    const bestLg  = [...lgEntries].sort((a, b) => b[1].hitRate - a[1].hitRate)[0];
    const worstLg = [...lgEntries].sort((a, b) => a[1].hitRate - b[1].hitRate)[0];

    if (bestLg) {
      cap += `📈 BEST LEAGUE TODAY\n`;
      cap += `${bestLg[0]} — ${bestLg[1].hitRate}% (${bestLg[1].won}W/${bestLg[1].lost}L)\n\n`;
    } else {
      cap += `📈 BEST LEAGUE TODAY\nNot enough data.\n\n`;
    }

    if (worstLg && (!bestLg || worstLg[0] !== bestLg[0])) {
      cap += `📉 WORST LEAGUE TODAY\n`;
      cap += `${worstLg[0]} — ${worstLg[1].hitRate}% (${worstLg[1].won}W/${worstLg[1].lost}L)${worstLg[1].banned ? ' 🚫 BANNED' : ''}\n\n`;
    } else {
      cap += `📉 WORST LEAGUE TODAY\nNot enough data.\n\n`;
    }

    // 6 & 7. Market performance
    const mktEntries = Object.entries(mktWatch).filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 3);
    const bestMkt  = [...mktEntries].sort((a, b) => b[1].hitRate - a[1].hitRate)[0];
    const worstMkt = [...mktEntries].sort((a, b) => a[1].hitRate - b[1].hitRate)[0];

    if (bestMkt) {
      cap += `🎯 MARKET OF THE DAY\n`;
      cap += `"${bestMkt[0]}" — ${bestMkt[1].hitRate}% hit rate (${bestMkt[1].won}W/${bestMkt[1].lost}L)\n\n`;
    } else {
      cap += `🎯 MARKET OF THE DAY\nNot enough data.\n\n`;
    }

    if (worstMkt && (!bestMkt || worstMkt[0] !== bestMkt[0])) {
      cap += `❌ MARKET TO AVOID TOMORROW\n`;
      cap += `"${worstMkt[0]}" — only ${worstMkt[1].hitRate}% today (${worstMkt[1].won}W/${worstMkt[1].lost}L)\n\n`;
    } else {
      cap += `❌ MARKET TO AVOID TOMORROW\nNot enough data (confidence is low).\n\n`;
    }

    // 8. 🧠 AI Insight
    const topInsight = insights[0] || analysis.bullets?.[0] || null;
    if (topInsight) {
      cap += `🧠 AI INSIGHT\n${topInsight}\n\n`;
    } else {
      cap += `🧠 AI INSIGHT\nRun Rescan All to generate intelligence.\n\n`;
    }
  } catch(e) {
    cap += `(Analysis error — ${e.message})\n\n`;
  }

  cap += tags;
  return cap;
}

// ── First Reply Builder ───────────────────────────────────────────────────────
// Reads verbatim from the saved daily analysis — no derived or regenerated content.
function buildReply(data, type, analysis) {
  type = type || 'daily';
  const { punters, date } = data;
  if (!punters || !punters.length) return '';

  const period = type === 'weekly'  ? 'this week'
               : type === 'monthly' ? 'this month'
               : fmtShort(date);

  // Fallback when no analysis saved yet — build from raw leaderboard data
  if (!analysis) {
    const settled = punters.filter(p => p.settled > 0);
    if (!settled.length) return '';
    const best  = settled[0];
    const worst = [...settled].sort((a, b) => a.hitRate - b.hitRate)[0];
    const avg   = Math.round(settled.reduce((s, p) => s + p.hitRate, 0) / settled.length);
    let reply   = `🧵 SlipPilot results (${period})\n\n`;
    reply += `${settled.length} punters tracked. Average hit rate: ${avg}%.\n\n`;
    if (best && worst && best.hitRate - worst.hitRate > 15)
      reply += `Top: ${best.name} ${best.hitRate}% (${best.won}W/${best.lost}L)  ·  Bottom: ${worst.name} ${worst.hitRate}%\n\n`;
    else if (best)
      reply += `Best: ${best.name} — ${best.hitRate}% (${best.won}W/${best.lost}L)\n\n`;
    reply += `Follow @SlipPilot for daily codes →`;
    return reply;
  }

  const killers  = analysis.ticketKillers || [];
  const wins     = analysis.consensusWins  || [];
  const insights = analysis.insights || [];

  // Partial report: analysis was saved but games mostly pending — fall back to leaderboard summary
  if (analysis.partial && !killers.length && !wins.length) {
    const settled = punters.filter(p => p.settled > 0);
    if (!settled.length) {
      const pending = punters.filter(p => p.pending > 0);
      let reply = `🧵 SlipPilot update (${period})\n\n`;
      reply += `${pending.length} punters have codes live — waiting for results to settle.\n\n`;
      if (insights.length) reply += insights[0] + '\n\n';
      reply += `Follow @SlipPilot for codes →`;
      return reply;
    }
    const best  = settled[0];
    const worst = [...settled].sort((a, b) => a.hitRate - b.hitRate)[0];
    const avg   = Math.round(settled.reduce((s, p) => s + p.hitRate, 0) / settled.length);
    let reply   = `🧵 SlipPilot results (${period})\n\n`;
    reply += `${settled.length} punters tracked. Average hit rate: ${avg}%.\n\n`;
    if (best && worst && best.hitRate - worst.hitRate > 15)
      reply += `Top: ${best.name} ${best.hitRate}% (${best.won}W/${best.lost}L)  ·  Bottom: ${worst.name} ${worst.hitRate}%\n\n`;
    else if (best)
      reply += `Best: ${best.name} — ${best.hitRate}% (${best.won}W/${best.lost}L)\n\n`;
    if (insights.length && !insights[0].startsWith('Run Rescan')) reply += insights[0] + '\n\n';
    reply += `Follow @SlipPilot for daily codes →`;
    return reply;
  }

  let reply = `🧵 What really happened today (${period})\n\n`;

  // ── #1 KILLER — lead with the most dramatic game ──────────────────────────
  const topKiller = killers[0];
  if (topKiller) {
    const sel = topKiller.selections?.[0];
    const odds = sel?.originalOdds ? ` @ ${sel.originalOdds}` : '';
    const market = sel ? (sel.outcome ? `${sel.market} — ${sel.outcome}` : sel.market) : '';
    reply += `💀 GAME THAT KILLED THE MOST TODAY\n`;
    reply += `${topKiller.match}${odds}\n`;
    if (market) reply += `Market: ${market}\n`;
    reply += `Killed ${topKiller.codeCount} slip${topKiller.codeCount !== 1 ? 's' : ''} across ${topKiller.punterCount} punter${topKiller.punterCount !== 1 ? 's' : ''}\n`;
    if (topKiller.reasons?.length) {
      reply += `Why it failed: ${topKiller.reasons.join(', ')}\n`;
    }
    if (topKiller.recommendation) {
      reply += `Lesson: ${topKiller.recommendation}\n`;
    }
    reply += '\n';
  }

  // ── Other killers (compact) ───────────────────────────────────────────────
  if (killers.length > 1) {
    reply += `Also killed slips:\n`;
    killers.slice(1, 3).forEach(tk => {
      const s = tk.selections?.[0];
      const odds = s?.originalOdds ? ` (${s.originalOdds})` : '';
      reply += `• ${tk.match}${odds} — ${tk.codeCount} slip${tk.codeCount !== 1 ? 's' : ''}\n`;
    });
    reply += '\n';
  }

  // ── What punters should have done better ─────────────────────────────────
  const worstMkt = Object.entries(analysis.marketWatch || {})
    .filter(([, ms]) => ms.selections >= 3 && ms.hitRate < 50)
    .sort((a, b) => a[1].hitRate - b[1].hitRate)[0];

  const bannedLeagues = Object.entries(analysis.leagueWatch || {})
    .filter(([, ls]) => ls.banned && ls.selections > 0);

  const highOddsErrors = killers.filter(tk => tk.selections?.some(s => s.originalOdds > 3.5));

  if (worstMkt || bannedLeagues.length || highOddsErrors.length) {
    reply += `🔴 WHAT TO DO BETTER\n`;
    if (worstMkt) {
      const alt = worstMkt[0].includes('2.5') ? 'Over 1.5'
                : worstMkt[0] === 'GG' ? 'Double Chance'
                : worstMkt[0] === '1' || worstMkt[0] === '2' ? '1X or X2'
                : null;
      reply += `• Drop "${worstMkt[0]}" — only ${worstMkt[1].hitRate}% today (${worstMkt[1].won}W/${worstMkt[1].lost}L)`;
      if (alt) reply += `. Try ${alt} instead`;
      reply += '\n';
    }
    if (bannedLeagues.length) {
      reply += `• Avoid: ${bannedLeagues.map(([l]) => l).join(', ')} — consistently unreliable\n`;
    }
    if (highOddsErrors.length) {
      reply += `• Stop chasing big odds on shaky matches — it's costing slips\n`;
    }
    reply += '\n';
  }

  // ── Consensus wins ────────────────────────────────────────────────────────
  if (wins.length) {
    reply += `✅ SAFE PICKS THAT CAME THROUGH\n`;
    wins.slice(0, 2).forEach(cw => {
      const selStr = [...new Set(cw.selections.map(s => s.outcome || s.market))].join(', ');
      reply += `• ${cw.match} (${selStr})`;
      if (cw.punterCount > 1) reply += ` — ${cw.punterCount} punters called it`;
      if (cw.leagueHitRate) reply += `, ${cw.leagueHitRate}% league HR`;
      reply += '\n';
    });
    reply += '\n';
  }

  // ── Market intelligence snippet ───────────────────────────────────────────
  const bestMkt = Object.entries(analysis.marketWatch || {})
    .filter(([, ms]) => ms.selections >= 3 && (!worstMkt || ms !== worstMkt[1]))
    .sort((a, b) => b[1].hitRate - a[1].hitRate)[0];
  if (bestMkt) {
    reply += `📈 Best market today: "${bestMkt[0]}" hit ${bestMkt[1].hitRate}% — keep building around it\n\n`;
  }

  // ── Top insight ───────────────────────────────────────────────────────────
  if (insights.length) {
    reply += `💡 ${insights[0]}\n\n`;
  }

  // ── Pending ───────────────────────────────────────────────────────────────
  const stillPending = punters.filter(p => p.pending > 0);
  if (stillPending.length)
    reply += `⏳ Still settling: ${stillPending.map(p => p.name).join(', ')}\n\n`;

  reply += `Follow @SlipPilot for tomorrow's codes →`;
  return reply;
}

// ── Canvas Primitives ─────────────────────────────────────────────────────────
function _t(ctx, text, x, y, {
  size = 14, weight = '400', color = P.text, align = 'left', baseline = 'middle', font
} = {}) {
  ctx.save();
  ctx.font         = font || `${weight} ${size}px ${F.sans}`;
  ctx.fillStyle    = color;
  ctx.textAlign    = align;
  ctx.textBaseline = baseline;
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

function _line(ctx, x1, y1, x2, y2, color = P.border, lw = 1) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}

function _rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function _trunc(ctx, text, maxW) {
  if (!text) return '—';
  if (ctx.measureText(text).width <= maxW) return text;
  let t = String(text);
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

// ── Table Column Headers ──────────────────────────────────────────────────────
function _drawColHeaders(ctx, y, W, H) {
  const cols = activeCols();
  _rect(ctx, 0, y, W, H, P.surf);
  cols.forEach(col => {
    const cx = col.align === 'right'  ? col.x + col.w
             : col.align === 'center' ? col.x + col.w / 2
             : col.x;
    _t(ctx, col.label, cx, y + H / 2,
      { size: 10, weight: '700', color: P.muted, align: col.align });
  });
  _line(ctx, 0, y + H, W, y + H, P.border);
  return y + H;
}

// ── Data Row ──────────────────────────────────────────────────────────────────
function _drawRow(ctx, p, rank, y, W, H) {
  const cols = activeCols();
  const mid  = y + H / 2;

  _rect(ctx, 0, y, W, H, rank % 2 === 1 ? P.rowA : P.rowB);

  if      (rank === 1) _rect(ctx, 0, y, 3, H, P.gold);
  else if (rank === 2) _rect(ctx, 0, y, 3, H, P.silver);
  else if (rank === 3) _rect(ctx, 0, y, 3, H, P.bronze);

  // RK
  const rkColor = rank === 1 ? P.gold : rank === 2 ? P.silver : rank === 3 ? P.bronze : P.dim;
  _t(ctx, '#' + rank, cols[0].x + cols[0].w / 2, mid,
    { size: 11, weight: '700', color: rkColor, align: 'center' });

  // PUNTER
  ctx.save(); ctx.font = `600 15px ${F.sans}`;
  const nameStr = _trunc(ctx, p.name, cols[1].w - 4); ctx.restore();
  _t(ctx, nameStr, cols[1].x, mid,
    { size: 15, weight: '600', color: rank === 1 ? P.gold : P.text });

  // G W L V PD
  const _num = (i, val, color) =>
    _t(ctx, String(val ?? '—'), cols[i].x + cols[i].w, mid,
      { size: 14, weight: '700', color, align: 'right' });

  _num(2, p.games   ?? '—', P.muted);
  _num(3, p.won     ?? '—', P.green);
  _num(4, p.lost    ?? '—', (p.lost    || 0) > 0 ? P.red    : P.dim);
  _num(5, p.void    ?? '—', (p.void    || 0) > 0 ? P.yellow : P.dim);
  _num(6, p.pending ?? '—', (p.pending || 0) > 0 ? P.muted  : P.dim);

  // WIN %
  const wpColor = p.hitRate >= 75 ? P.green : p.hitRate >= 60 ? P.yellow : P.red;
  const wpText  = p.settled > 0 ? p.hitRate + '%' : '—';
  _t(ctx, wpText, cols[7].x + cols[7].w, mid,
    { size: 18, weight: '900', color: wpColor, align: 'right' });

  // CODE
  const ccx = cols[8].x + cols[8].w / 2;
  if (p.code) {
    ctx.save();
    ctx.font = `600 12px ${F.mono}`;
    const cw  = ctx.measureText(p.code).width;
    const cpx = ccx - cw / 2 - 6;
    const cpy = mid - 10;
    ctx.fillStyle = P.blue + '18';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cpx, cpy, cw + 12, 20, 4);
    else ctx.rect(cpx, cpy, cw + 12, 20);
    ctx.fill();
    ctx.restore();
    _t(ctx, p.code, ccx, mid,
      { font: `600 12px ${F.mono}`, color: P.blue, align: 'center' });
  } else {
    _t(ctx, '—', ccx, mid, { size: 13, color: P.dim, align: 'center' });
  }

  // Last column: TOTAL ODDS (daily) or DAYS (weekly/monthly)
  const lastCol = cols[9];
  if (lastCol.key === 'days') {
    _t(ctx, p.days != null ? String(p.days) : '—', lastCol.x + lastCol.w, mid,
      { size: 14, weight: '600', color: P.muted, align: 'right' });
  } else {
    const oddsStr = _fmtOdds(p.totalOdds);
    if (oddsStr) {
      if (p.games) {
        // Show "Ng" above odds
        _t(ctx, p.games + 'g', lastCol.x + lastCol.w, mid - 9,
          { size: 9, color: P.dim, align: 'right' });
        _t(ctx, oddsStr, lastCol.x + lastCol.w, mid + 7,
          { size: 13, weight: '600', color: P.muted, align: 'right' });
      } else {
        _t(ctx, oddsStr, lastCol.x + lastCol.w, mid,
          { size: 14, weight: '600', color: P.muted, align: 'right' });
      }
    } else {
      _t(ctx, 'Pending Scan', lastCol.x + lastCol.w, mid,
        { size: 10, color: P.dim, align: 'right' });
    }
  }

  _line(ctx, 20, y + H, W - 20, y + H, P.sep);
}

// ── Card 1: Leaderboard (top 10) ──────────────────────────────────────────────
function renderCard1(canvas, data) {
  const W     = 1080;
  const HDR_H = 112;
  const TH_H  = 38;
  const ROW_H = 50;
  const FTR_H = 52;

  const rows = data.punters.slice(0, 10);
  const N    = rows.length;
  if (N === 0) throw new Error('No punter rows to render.');

  canvas.width  = W;
  canvas.height = HDR_H + TH_H + N * ROW_H + FTR_H;

  const ctx = canvas.getContext('2d');
  _rect(ctx, 0, 0, W, canvas.height, P.bg);

  // ── Header band
  _rect(ctx, 0, 0, W, HDR_H, P.hdr);
  _rect(ctx, 0, 0, W, 3, P.blue);

  const tpl      = csTpl();
  const site     = tpl.site || 'SlipPilot';
  const modeTag  = _mode === 'weekly'  ? 'WEEKLY PUNTER REPORT'
                 : _mode === 'monthly' ? 'MONTHLY PUNTER REPORT'
                 : 'DAILY PUNTER REPORT';
  const dateLine = (data.rangeLabel || fmtLong(data.date)).toUpperCase();

  // Logo — site icon (icon-192.png) with rounded corners, matching index.html 48×48 usage
  if (_logoImg) {
    _drawRoundedImage(ctx, _logoImg, 22, 24, 40, 40, 8);
  } else {
    // Fallback: green rect with site name initial
    _rect(ctx, 22, 24, 40, 40, '#00c853' + '22');
    _t(ctx, 'S', 42, 44, { size: 18, weight: '900', color: '#00c853', align: 'center' });
  }

  _t(ctx, site.toUpperCase(), 74, 37, { size: 20, weight: '900', color: P.text });
  _t(ctx, modeTag,            74, 59, { size: 11, weight: '600', color: P.muted });
  _t(ctx, dateLine,           74, 84, { size: 11, color: P.dim });

  const total    = data.punters.length;
  const avgColor = data.avgHR >= 70 ? P.green : data.avgHR >= 60 ? P.yellow : P.red;

  _t(ctx, String(total),           820,    40, { size: 28, weight: '900', color: P.text,  align: 'right' });
  _t(ctx, 'PUNTERS ANALYSED',      820,    68, { size: 9,  weight: '700', color: P.muted, align: 'right' });
  _t(ctx, data.avgHR + '%',        W - 22, 40, { size: 28, weight: '900', color: avgColor, align: 'right' });
  _t(ctx, 'PLATFORM AVG WIN %',    W - 22, 68, { size: 9,  weight: '700', color: P.muted, align: 'right' });

  if (data.punters.length > 10) {
    _t(ctx, 'TOP 10 SHOWN  ·  SEE IMAGE 2 FOR MORE', W - 22, 88,
      { size: 9, color: P.dim, align: 'right' });
  } else if (data.punters[0]) {
    _t(ctx, '🏆 ' + data.punters[0].name.toUpperCase(), W - 22, 88,
      { size: 9, weight: '600', color: P.gold, align: 'right' });
  }

  _line(ctx, 0, HDR_H, W, HDR_H, P.border);

  let y = _drawColHeaders(ctx, HDR_H, W, TH_H);
  rows.forEach((p, i) => _drawRow(ctx, p, i + 1, y + i * ROW_H, W, ROW_H));
  y += N * ROW_H;

  _line(ctx, 0, y, W, y, P.border);
  _rect(ctx, 0, y, W, FTR_H, P.hdr);
  _t(ctx, site.toLowerCase() + '.com.ng', 22, y + FTR_H / 2,
    { size: 11, weight: '600', color: P.blue });
  _t(ctx, 'Win% = won ÷ settled  ·  Data sourced from leaderboard analysis only',
    230, y + FTR_H / 2, { size: 10, color: P.dim });
  _t(ctx, data.date, W - 22, y + FTR_H / 2,
    { size: 11, color: P.muted, align: 'right' });
}

// ── Card 2: Overflow — punters 11+ only ──────────────────────────────────────
function renderCard2(canvas, data) {
  const W     = 1080;
  const HDR_H = 72;
  const TH_H  = 38;
  const ROW_H = 50;
  const FTR_H = 52;

  const rows = data.punters.slice(10);
  if (!rows.length) { canvas.width = 10; canvas.height = 10; return; }

  const N = rows.length;
  canvas.width  = W;
  canvas.height = HDR_H + TH_H + N * ROW_H + FTR_H;

  const ctx  = canvas.getContext('2d');
  const tpl  = csTpl();
  const site = tpl.site || 'SlipPilot';

  _rect(ctx, 0, 0, W, canvas.height, P.bg);
  _rect(ctx, 0, 0, W, HDR_H, P.hdr);
  _rect(ctx, 0, 0, W, 3, P.blue);

  const modeWord = _mode === 'weekly' ? 'WEEKLY' : _mode === 'monthly' ? 'MONTHLY' : 'DAILY';
  _t(ctx, site.toUpperCase() + '  ·  ' + modeWord + ' PUNTER REPORT',
    22, 26, { size: 14, weight: '900', color: P.text });
  _t(ctx, (data.rangeLabel || fmtShort(data.date)) + '  ·  Rankings 11 – ' + (10 + N),
    22, 52, { size: 11, color: P.muted });

  _line(ctx, 0, HDR_H, W, HDR_H, P.border);

  let y = _drawColHeaders(ctx, HDR_H, W, TH_H);
  rows.forEach((p, i) => _drawRow(ctx, p, 10 + i + 1, y + i * ROW_H, W, ROW_H));
  y += N * ROW_H;

  _line(ctx, 0, y, W, y, P.border);
  _rect(ctx, 0, y, W, FTR_H, P.hdr);
  _t(ctx, site.toLowerCase() + '.com.ng', 22, y + FTR_H / 2,
    { size: 11, weight: '600', color: P.blue });
  _t(ctx, data.date, W - 22, y + FTR_H / 2,
    { size: 11, color: P.muted, align: 'right' });
}

// ── Report Generation ─────────────────────────────────────────────────────────
async function _buildReportPayload(type) {
  type = type || 'daily';

  csStatus('Loading leaderboard…', P.blue);
  const raw = await safeFetch('/api/leaderboard');

  let data, dateKey, rangeLabel;

  if (type === 'daily') {
    const targetDate = getTargetDate();
    data       = processLeaderboard(raw, targetDate);
    dateKey    = targetDate;
    rangeLabel = fmtLong(targetDate);
    // No settled punters at all — could be all pending or no codes saved
    if (!data.punters.length) {
      const pOnly = data.pendingOnly || [];
      if (pOnly.length > 0)
        throw new Error(
          pOnly.length + ' punter(s) have codes for ' + targetDate + ' but 0 games settled yet. ' +
          'Run Rescan All after matches finish.'
        );
      throw new Error(
        'No punter data found for ' + targetDate + '. Ensure codes are saved and run Rescan All.'
      );
    }
  } else if (type === 'weekly') {
    const range = getWeekRange();
    const agg   = aggregateLeaderboard(raw, range.start, range.end);
    data        = { ...agg, date: range.end, rangeLabel: range.label };
    dateKey     = 'week-' + range.end;
    rangeLabel  = range.label;
    if (!data.punters.length)
      throw new Error('No data found for the last 7 days (' + range.label + ').');
  } else {
    const range = getMonthRange();
    const agg   = aggregateLeaderboard(raw, range.start, range.end);
    data        = { ...agg, date: range.end, rangeLabel: range.label };
    dateKey     = range.end.slice(0, 7);
    rangeLabel  = range.label;
    if (!data.punters.length)
      throw new Error('No data found for ' + range.label + '.');
  }

  const broken = data.punters.filter(p => p.hitRate == null || isNaN(p.hitRate));
  if (broken.length)
    throw new Error('Data error: hitRate missing for ' + broken.map(p => p.name).join(', '));

  // Fetch saved analysis (Analysis Engine is the only writer)
  let analysis = null;
  if (type === 'daily') {
    try {
      const ar = await safeFetch('/api/analysis/' + dateKey);
      analysis = ar?.analysis || null;
    } catch { /* no analysis saved yet — will show fallback text */ }
  }

  const lw = buildLeagueWatch(raw);

  const caption = buildCaption(data, 0, type, analysis);
  const reply   = buildReply(data, type, analysis);

  return {
    date:        dateKey,
    timestamp:   new Date().toISOString(),
    type,
    rangeLabel,
    punterCount: data.punters.length,
    avgHR:       data.avgHR,
    best:        data.punters[0]?.name   || null,
    bestHR:      data.punters[0]?.hitRate ?? null,
    rankings:    data.punters,
    caption,
    reply,
    leagueWatch: lw,
    analysis,
  };
}

// ── Display Saved Report ──────────────────────────────────────────────────────
function csDisplayReport(report) {
  csHideError();

  const type = report.type || 'daily';
  _mode       = type;
  _reportType = type;

  // Sync type buttons
  document.querySelectorAll('.cs-rtype-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type));
  const hint = document.getElementById('cs-rtype-hint');
  if (hint) {
    hint.textContent = type === 'daily'   ? 'Yesterday\'s completed session'
                     : type === 'weekly'  ? 'Last 7 completed days aggregated'
                     : 'Current month aggregated';
  }

  const data = {
    date:       report.date,
    punters:    report.rankings || [],
    avgHR:      report.avgHR   || 0,
    rangeLabel: report.rangeLabel || null,
  };
  _currentData = {
    ...data,
    caption:     report.caption,
    reply:       report.reply,
    type,
    leagueWatch: report.leagueWatch || null,
    analysis:    report.analysis    || null,
  };

  const dateEl = document.getElementById('cs-report-date');
  if (dateEl) dateEl.textContent = report.rangeLabel || fmtLong(report.date);
  const metaEl = document.getElementById('cs-report-meta');
  if (metaEl) {
    const ts = report.timestamp
      ? new Date(report.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '';
    metaEl.textContent =
      `Generated ${ts}  ·  ${report.punterCount || data.punters.length} analysts  ·  ${report.avgHR}% avg hit rate`;
  }

  const c1 = document.getElementById('cs-canvas-1');
  if (c1) {
    try { renderCard1(c1, data); }
    catch (e) { csShowError('Render error: ' + e.message); return; }
  }

  const capEl = document.getElementById('cs-caption-text');
  if (capEl) capEl.textContent = report.caption || 'No completed Daily Analysis available.';

  const repEl = document.getElementById('cs-reply-text');
  if (repEl) repEl.textContent = report.reply || '';

  // ── Render additional category cards (from real analysis only) ────────────
  const an = report.analysis || null;
  const c2 = document.getElementById('cs-canvas-killer');
  if (c2) { try { renderKillerCard(c2, an); } catch {} }
  const c3 = document.getElementById('cs-canvas-consensus');
  if (c3) { try { renderConsensusCard(c3, an); } catch {} }
  const c4 = document.getElementById('cs-canvas-league');
  if (c4) { try { renderLeagueWatchCard(c4, an); } catch {} }
  const c5 = document.getElementById('cs-canvas-market');
  if (c5) { try { renderMarketWatchCard(c5, an); } catch {} }
  const c6 = document.getElementById('cs-canvas-performer');
  if (c6) { try { renderPerformerCard(c6, data, an); } catch {} }

  // Category-specific captions
  const killerCap = document.getElementById('cs-killer-caption');
  if (killerCap) killerCap.textContent = buildKillerCaption(an);
  const consensusCap = document.getElementById('cs-consensus-caption');
  if (consensusCap) consensusCap.textContent = buildConsensusCaption(an);
  const performerCap = document.getElementById('cs-performer-caption');
  if (performerCap) performerCap.textContent = buildBestPerformerCaption(data, an);
  const leagueCap = document.getElementById('cs-league-caption');
  if (leagueCap) leagueCap.textContent = buildLeagueWatchCaption(an);
  const marketCap = document.getElementById('cs-market-caption');
  if (marketCap) marketCap.textContent = buildMarketWatchCaption(an);

  // Special posts
  csRenderSpecialPosts(data, an);

  csShowReport();
  csStatus('');
}

// ── Generate ──────────────────────────────────────────────────────────────────
async function generateDailyReport(force) {
  const type = _reportType || 'daily';
  let key;
  if (type === 'daily')       key = getTargetDate();
  else if (type === 'weekly') key = 'week-' + getWeekRange().end;
  else                        key = getMonthRange().end.slice(0, 7);

  if (!force && _reportDates.includes(key)) {
    try {
      const existing = await safeFetch('/api/studio/report/' + key);
      csShowModal(existing.timestamp);
    } catch { await _doGenerate(); }
    return;
  }
  csHideModal();
  await _doGenerate();
}

async function _doGenerate() {
  const btn = document.getElementById('cs-gen-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  csHideError();
  if (!_logoImg) await _loadLogo();
  try {
    const report = await _buildReportPayload(_reportType || 'daily');
    csStatus('Saving report…', P.blue);
    await safeFetch('/api/studio/report', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(report),
    });
    if (!_reportDates.includes(report.date)) _reportDates.unshift(report.date);
    csDisplayReport(report);
    csStatus('Report saved.', P.green);
    setTimeout(() => csStatus(''), 3000);
  } catch (e) {
    console.error('[Studio]', e);
    csShowError(e.message);
    csStatus('');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✦ Generate Report'; }
  }
}

// ── Caption Actions ───────────────────────────────────────────────────────────
function csCP() {
  const text = document.getElementById('cs-caption-text')?.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('cs-cp-btn');
    if (btn) { const o = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = o, 1600); }
  });
}

function csNewCaption() {
  if (!_currentData) return;
  _captionIdx = (_captionIdx + 1) % 3;
  const el = document.getElementById('cs-caption-text');
  if (el) el.textContent = buildCaption(
    _currentData, _captionIdx,
    _currentData.type     || 'daily',
    _currentData.analysis || null
  );
}

// ── Reply Actions ─────────────────────────────────────────────────────────────
function csCPReply() {
  const text = document.getElementById('cs-reply-text')?.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('cs-reply-cp-btn');
    if (btn) { const o = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = o, 1600); }
  });
}

// ── Download ──────────────────────────────────────────────────────────────────
function csDownloadCard(n) {
  const canvas = document.getElementById('cs-canvas-' + n);
  if (!canvas || canvas.width < 100) { alert('Card ' + n + ' is not rendered yet.'); return; }
  const suffix = _mode === 'weekly'  ? 'week-' + getWeekRange().end
               : _mode === 'monthly' ? getMonthRange().end.slice(0, 7)
               : getTargetDate();
  canvas.toBlob(blob => {
    const a   = document.createElement('a');
    a.href    = URL.createObjectURL(blob);
    a.download = `slippilot-${suffix}-card${n}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, 'image/png');
}

// ── Conflict Modal ─────────────────────────────────────────────────────────────
function csShowModal(ts) {
  const m = document.getElementById('cs-modal');
  const t = document.getElementById('cs-modal-time');
  if (t && ts) t.textContent = new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (m) m.style.display = 'flex';
}
function csHideModal() {
  const m = document.getElementById('cs-modal'); if (m) m.style.display = 'none';
}
async function csViewToday() {
  csHideModal();
  const type = _reportType || 'daily';
  const key  = type === 'daily'   ? getTargetDate()
             : type === 'weekly'  ? 'week-' + getWeekRange().end
             : getMonthRange().end.slice(0, 7);
  try { csDisplayReport(await safeFetch('/api/studio/report/' + key)); }
  catch (e) { csShowError(e.message); }
}

// ── UI Helpers ─────────────────────────────────────────────────────────────────
function csStatus(msg, color) {
  const el = document.getElementById('cs-status');
  if (!el) return;
  el.textContent   = msg;
  el.style.color   = typeof color === 'string' ? color : '#64748b';
  el.style.display = msg ? 'block' : 'none';
}
function csShowError(msg) {
  const el = document.getElementById('cs-error-box');
  if (el) { el.textContent = '⚠  ' + msg; el.style.display = 'block'; }
}
function csHideError() {
  const el = document.getElementById('cs-error-box'); if (el) el.style.display = 'none';
}
function csShowReport() {
  const ob = document.getElementById('cs-onboarding');
  const rp = document.getElementById('cs-report');
  if (ob) ob.style.display = 'none';
  if (rp) rp.style.display = 'block';
}
function csShowOnboarding() {
  const ob = document.getElementById('cs-onboarding');
  const rp = document.getElementById('cs-report');
  if (ob) ob.style.display = 'flex';
  if (rp) rp.style.display = 'none';
}

// ── Report Type Selector ──────────────────────────────────────────────────────
function setReportType(type) {
  _reportType = type;
  _mode       = type;
  document.querySelectorAll('.cs-rtype-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type));
  const hint = document.getElementById('cs-rtype-hint');
  if (hint) {
    hint.textContent = type === 'daily'   ? 'Yesterday\'s completed session'
                     : type === 'weekly'  ? 'Last 7 completed days aggregated'
                     : 'Current month aggregated';
  }
}

// ── History ───────────────────────────────────────────────────────────────────
async function csRenderHistory() {
  const el = document.getElementById('cs-history-list');
  if (!el) return;
  try {
    const reports = await safeFetch('/api/studio/reports');
    _reportDates  = reports.map(r => r.date);
    if (!reports.length) {
      el.innerHTML = '<p style="color:#848d97;font-size:13px;padding:20px">No saved reports yet.</p>';
      return;
    }
    const today     = _localDateStr(0);
    const yesterday = _localDateStr(-1);
    const weekAgo   = _localDateStr(-7);
    const groups    = { today: [], yesterday: [], week: [], older: [] };
    for (const h of reports) {
      if (h.date === today)          groups.today.push(h);
      else if (h.date === yesterday) groups.yesterday.push(h);
      else if (h.date >= weekAgo)    groups.week.push(h);
      else                           groups.older.push(h);
    }
    const rowHtml = h => `
      <div style="display:flex;justify-content:space-between;align-items:center;
                  padding:10px 16px;border-bottom:1px solid #1c2128;font-size:13px">
        <div>
          <strong style="color:#e6edf3">${h.date}</strong>
          ${h.type ? `<span style="font-size:10px;color:#58a6ff;margin-left:6px;text-transform:uppercase">${h.type}</span>` : ''}
          <span style="color:#848d97;margin-left:10px">${h.punterCount || '?'} analysts  ·  ${h.avgHR || '?'}% avg</span>
          ${h.best ? `<span style="color:#e3b341;margin-left:8px">${h.best} (${h.bestHR ?? '—'}%)</span>` : ''}
        </div>
        <button class="cs-dl-btn" onclick="csLoadAndView('${h.date}')">View →</button>
      </div>`;
    const sectionHtml = (label, items) => items.length
      ? `<div style="padding:5px 16px 2px;font-size:10px;font-weight:700;letter-spacing:.08em;color:#58a6ff;text-transform:uppercase;background:#0d1117">${label}</div>`
        + items.map(rowHtml).join('')
      : '';
    el.innerHTML = sectionHtml('Today', groups.today)
      + sectionHtml('Yesterday', groups.yesterday)
      + sectionHtml('Last 7 Days', groups.week)
      + sectionHtml('Older', groups.older);
  } catch (e) {
    el.innerHTML = `<p style="color:#f85149;font-size:13px;padding:16px">⚠  ${e.message}</p>`;
  }
}

async function csLoadAndView(date) {
  switchStudioTab('daily');
  csStatus('Loading ' + date + '…', P.blue);
  try { csDisplayReport(await safeFetch('/api/studio/report/' + date)); }
  catch (e) { csShowError(e.message); csStatus(''); }
}

// ── Templates ─────────────────────────────────────────────────────────────────
function csRenderTemplates() {
  const t   = csTpl();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('tpl-site', t.site || 'SlipPilot');
  set('tpl-logo', t.logo || 'SP');
  set('tpl-blue', t.blue || '#58a6ff');
  set('tpl-cyan', t.cyan || '#3fb950');
}
function csSaveTemplate() {
  const g = id => document.getElementById(id)?.value?.trim() || '';
  localStorage.setItem('cs_tpl', JSON.stringify({
    site: g('tpl-site') || 'SlipPilot',
    logo: g('tpl-logo') || 'SP',
    blue: g('tpl-blue') || '#58a6ff',
    cyan: g('tpl-cyan') || '#3fb950',
  }));
  const btn = document.getElementById('cs-tpl-save-btn');
  if (btn) { btn.textContent = 'Saved!'; setTimeout(() => btn.textContent = 'Save', 1500); }
}
function csResetTemplate() {
  if (!confirm('Reset to defaults?')) return;
  localStorage.removeItem('cs_tpl');
  csRenderTemplates();
}

// ── Tab Switching ─────────────────────────────────────────────────────────────
function switchStudioTab(tab) {
  document.querySelectorAll('.cs-stab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.cs-content').forEach(c =>
    c.classList.toggle('active', c.dataset.tab === tab));
  if (tab === 'history')   csRenderHistory();
  if (tab === 'templates') csRenderTemplates();
  // 'slips' tab is self-contained — user clicks Generate manually
}

// ── Content Category Captions ─────────────────────────────────────────────────

function buildKillerCaption(analysis) {
  if (!analysis) return 'Run Rescan All to generate the Ticket Killer report.';
  const killers = analysis.ticketKillers || [];
  const date = analysis.date || '';
  const dateStr = date ? fmtShort(date) : 'Today';
  if (!killers.length) return `No ticket killers recorded for ${dateStr}. Clean day!`;
  const top = killers[0];
  const sel = top.selections?.[0];
  const mkt = sel ? (sel.outcome ? `${sel.market} — ${sel.outcome}` : sel.market) : '';
  const odds = sel?.originalOdds ? ` @ ${sel.originalOdds}` : '';
  let cap = `☠️ TICKET KILLER — ${dateStr.toUpperCase()}\n\n`;
  cap += `${top.match}${odds}\n`;
  if (mkt) cap += `${mkt}\n`;
  cap += `Killed ${top.codeCount} slip${top.codeCount !== 1 ? 's' : ''} across ${top.punterCount} punter${top.punterCount !== 1 ? 's' : ''}\n\n`;
  if (top.reasons?.length) cap += `Why it failed:\n${top.reasons.map(r => '• ' + r).join('\n')}\n\n`;
  if (killers.length > 1) {
    cap += `Also killed slips today:\n`;
    killers.slice(1, 4).forEach(k => {
      const ks = k.selections?.[0];
      cap += `• ${k.match} — ${k.codeCount} slip${k.codeCount !== 1 ? 's' : ''}\n`;
    });
    cap += '\n';
  }
  cap += `#FootballBetting #TicketKiller #SlipPilot #BettingAnalysis`;
  return cap;
}

function buildConsensusCaption(analysis) {
  if (!analysis) return 'Run Rescan All to generate the Consensus Picks report.';
  const wins  = analysis.consensusWins  || [];
  const all   = analysis.allSelections  || [];
  const date  = analysis.date || '';
  const dateStr = date ? fmtShort(date) : 'Today';
  const multiPunter = all.filter
    ? [...new Set(all.map(s => `${s.homeTeam}|${s.awayTeam}`))]
        .map(key => {
          const sels = all.filter(s => `${s.homeTeam}|${s.awayTeam}` === key);
          return { match: key.replace('|', ' vs '), punters: [...new Set(sels.map(s => s.punter))].length };
        }).filter(m => m.punters >= 3).sort((a, b) => b.punters - a.punters)
    : [];
  if (!wins.length && !multiPunter.length) return `No strong consensus picks recorded for ${dateStr}.`;
  let cap = `🤝 CONSENSUS PICKS — ${dateStr.toUpperCase()}\n`;
  cap += `Matches where multiple punters agreed\n\n`;
  if (wins.length) {
    cap += `✅ PICKS THAT CAME THROUGH\n`;
    wins.slice(0, 3).forEach(w => {
      const selStr = [...new Set((w.selections || []).map(s => s.outcome || s.market))].slice(0, 2).join(', ');
      cap += `${w.match}${selStr ? ` (${selStr})` : ''} — ${w.punterCount} punters agreed ✓\n`;
    });
    cap += '\n';
  }
  if (multiPunter.length) {
    cap += `📌 Most backed matches:\n`;
    multiPunter.slice(0, 3).forEach(m => cap += `• ${m.match} — ${m.punters} punters\n`);
    cap += '\n';
  }
  cap += `#FootballBetting #ConsensusPicks #SlipPilot #BettingTips`;
  return cap;
}

function buildBestPerformerCaption(data, analysis) {
  const { punters, date } = data;
  const settled = (punters || []).filter(p => p.settled > 0);
  if (!settled.length) return 'No settled results yet for this date.';
  const dateStr = date ? fmtShort(date) : 'Today';
  const best  = settled[0];
  const worst = [...settled].sort((a, b) => a.hitRate - b.hitRate)[0];
  let cap = `🏆 PERFORMER SPOTLIGHT — ${dateStr.toUpperCase()}\n\n`;
  cap += `🥇 BEST TODAY\n${best.name}\n${best.hitRate}% hit rate — ${best.won}W / ${best.lost}L`;
  if (best.totalOdds) cap += ` — ${typeof best.totalOdds === 'number' ? best.totalOdds.toFixed(0) + 'x odds' : best.totalOdds}`;
  cap += '\n\n';
  if (worst && worst.name !== best.name) {
    cap += `📉 TOUGHEST DAY\n${worst.name}\n${worst.hitRate}% — ${worst.won}W / ${worst.lost}L\n\n`;
  }
  if (settled.length >= 3) {
    const mid = settled[Math.floor(settled.length / 2)];
    cap += `Field avg: ${Math.round(settled.reduce((a, p) => a + p.hitRate, 0) / settled.length)}%  ·  ${settled.length} analysts\n\n`;
  }
  if (analysis?.insights?.length) cap += `💡 ${analysis.insights[0]}\n\n`;
  cap += `#FootballBetting #BettingPerformance #SlipPilot #BettingTips`;
  return cap;
}

function buildLeagueWatchCaption(analysis) {
  if (!analysis) return 'Run Rescan All to generate League Watch data.';
  const lgWatch = analysis.leagueWatch || {};
  const lgEntries = Object.entries(lgWatch).filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 3);
  const date = analysis.date || '';
  const dateStr = date ? fmtShort(date) : 'Today';
  if (!lgEntries.length) return `Not enough league data for ${dateStr} — need 3+ selections per league.`;
  const sorted  = [...lgEntries].sort((a, b) => b[1].hitRate - a[1].hitRate);
  const best    = sorted[0];
  const worst   = sorted[sorted.length - 1];
  const banned  = lgEntries.filter(([, v]) => v.banned);
  let cap = `🏟️ LEAGUE WATCH — ${dateStr.toUpperCase()}\n`;
  cap += `Hit rate breakdown by competition\n\n`;
  cap += `📈 BEST LEAGUES TODAY\n`;
  sorted.slice(0, 4).forEach(([league, stats]) =>
    cap += `${league} — ${stats.hitRate}% (${stats.won}W/${stats.lost}L)${stats.banned ? ' 🚫' : ''}\n`
  );
  cap += '\n';
  if (banned.length) {
    cap += `🚫 BLACKLISTED LEAGUES STILL ACTIVE\n`;
    banned.forEach(([l]) => cap += `• ${l}\n`);
    cap += `Remove these from slips immediately\n\n`;
  }
  cap += `#FootballBetting #LeagueWatch #SlipPilot #BettingAnalysis`;
  return cap;
}

function buildMarketWatchCaption(analysis) {
  if (!analysis) return 'Run Rescan All to generate Market Watch data.';
  const mktWatch = analysis.marketWatch || {};
  const mktEntries = Object.entries(mktWatch).filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 3);
  const date = analysis.date || '';
  const dateStr = date ? fmtShort(date) : 'Today';
  if (!mktEntries.length) return `Not enough market data for ${dateStr}.`;
  const sorted  = [...mktEntries].sort((a, b) => b[1].hitRate - a[1].hitRate);
  const best    = sorted[0];
  const worst   = sorted[sorted.length - 1];
  let cap = `📊 MARKET WATCH — ${dateStr.toUpperCase()}\n`;
  cap += `Which bet types performed — and which didn't\n\n`;
  if (best) cap += `✅ HOT MARKET\n"${best[0]}" — ${best[1].hitRate}% (${best[1].won}W/${best[1].lost}L)\n\n`;
  if (worst && worst[0] !== best?.[0]) cap += `❌ COLD MARKET\n"${worst[0]}" — only ${worst[1].hitRate}% today\n\n`;
  if (sorted.length > 2) {
    cap += `Full breakdown:\n`;
    sorted.slice(0, 5).forEach(([mkt, stats]) =>
      cap += `${mkt}: ${stats.hitRate}% (${stats.won}W/${stats.lost}L)\n`
    );
    cap += '\n';
  }
  cap += `#FootballBetting #MarketWatch #SlipPilot #BettingAnalysis`;
  return cap;
}

// ── Special Post Builder (auto-generates from real analysis) ──────────────────
function buildSpecialPosts(data, analysis) {
  const posts = [];
  if (!analysis) return posts;
  const killers     = analysis.ticketKillers || [];
  const wins        = analysis.consensusWins  || [];
  const allSels     = analysis.allSelections  || [];
  const punterStats = analysis.punterStats    || {};
  const lgWatch     = analysis.leagueWatch    || {};
  const mktWatch    = analysis.marketWatch    || {};
  const date        = analysis.date || data.date || '';
  const dateStr     = date ? fmtShort(date) : 'Today';
  const tags = '#SlipPilot #FootballBetting #BettingTips';

  // 1. Team that destroyed the most punters
  const topKiller = killers[0];
  if (topKiller && topKiller.punterCount >= 2) {
    const teamName = topKiller.match.split(' vs ')[0] || topKiller.match;
    posts.push({
      type: 'Special: Ticket Killer',
      caption: `${topKiller.punterCount} punters all had ${teamName} — and all lost.\n\n`
        + `${topKiller.match}\n`
        + (topKiller.selections?.[0]?.originalOdds ? `Odds: ${topKiller.selections[0].originalOdds}\n` : '')
        + `Killed ${topKiller.codeCount} slip${topKiller.codeCount !== 1 ? 's' : ''} on ${dateStr}.\n\n${tags}`,
      reply: topKiller.reasons?.length
        ? `Why it failed: ${topKiller.reasons.join(' / ')}.\n${topKiller.recommendation || ''}`
        : `Another day, another reminder — no pick is ever guaranteed.`,
    });
  }

  // 2. Most agreed-upon match
  const matchCount = {};
  for (const s of allSels) {
    const key = `${s.homeTeam} vs ${s.awayTeam}`;
    if (!matchCount[key]) matchCount[key] = new Set();
    matchCount[key].add(s.punter);
  }
  const topConsensus = Object.entries(matchCount).sort((a, b) => b[1].size - a[1].size)[0];
  if (topConsensus && topConsensus[1].size >= 4) {
    const selsForMatch = allSels.filter(s => `${s.homeTeam} vs ${s.awayTeam}` === topConsensus[0]);
    const verdicts = [...new Set(selsForMatch.map(s => s.verdict))];
    const won = selsForMatch.every(s => s.verdict === 'WON' || s.verdict === 'PENDING');
    posts.push({
      type: 'Special: Mass Consensus',
      caption: `${topConsensus[1].size} punters all backed the same match on ${dateStr}.\n\n`
        + `${topConsensus[0]}\n`
        + (verdicts.includes('WON') ? '✅ It came through.\n' : verdicts.includes('LOST') ? '❌ It let everyone down.\n' : '⏳ Still pending.\n')
        + `\n${tags}`,
      reply: `When ${topConsensus[1].size} analysts agree on something — pay attention.\n`
        + `Punters: ${[...topConsensus[1]].join(', ')}`,
    });
  }

  // 3. Biggest blacklisted league offender
  const bannedActive = Object.entries(lgWatch).filter(([, v]) => v.banned && v.selections > 0);
  if (bannedActive.length) {
    const worst = bannedActive.sort((a, b) => a[1].hitRate - b[1].hitRate)[0];
    posts.push({
      type: 'Special: Blacklisted League Warning',
      caption: `⚠️ BLACKLISTED LEAGUE STILL COSTING PUNTERS — ${dateStr}\n\n`
        + `${worst[0]} has a ${worst[1].hitRate}% hit rate (${worst[1].won}W/${worst[1].lost}L).\n`
        + `This league is on our banned list for exactly this reason.\n\n`
        + `Remove it from your slip builder.\n\n${tags}`,
      reply: bannedActive.length > 1
        ? `Other active banned leagues today: ${bannedActive.slice(1, 3).map(([l]) => l).join(', ')}`
        : `One bad league can wreck an entire slip.`,
    });
  }

  // 4. Best market vs worst market contrast post
  const mktEntries = Object.entries(mktWatch).filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 3);
  if (mktEntries.length >= 2) {
    const bestMkt  = [...mktEntries].sort((a, b) => b[1].hitRate - a[1].hitRate)[0];
    const worstMkt = [...mktEntries].sort((a, b) => a[1].hitRate - b[1].hitRate)[0];
    if (bestMkt[0] !== worstMkt[0]) {
      posts.push({
        type: 'Special: Market Contrast',
        caption: `📊 SAME DAY, VERY DIFFERENT RESULTS — ${dateStr}\n\n`
          + `✅ "${bestMkt[0]}" hit ${bestMkt[1].hitRate}% today (${bestMkt[1].won}W/${bestMkt[1].lost}L)\n`
          + `❌ "${worstMkt[0]}" only managed ${worstMkt[1].hitRate}% (${worstMkt[1].won}W/${worstMkt[1].lost}L)\n\n`
          + `The market you pick matters as much as the match.\n\n${tags}`,
        reply: `SlipPilot tracks every market type daily to help you bet smarter, not harder.`,
      });
    }
  }

  // 5. Punter contrast — best vs worst day
  const punterArr = Object.values(punterStats).filter(p => (p.won + p.lost) >= 3);
  if (punterArr.length >= 2) {
    const bestP  = [...punterArr].sort((a, b) => b.hitRate - a.hitRate)[0];
    const worstP = [...punterArr].sort((a, b) => a.hitRate - b.hitRate)[0];
    if (bestP.punter !== worstP.punter) {
      posts.push({
        type: 'Special: Punter Contrast',
        caption: `⚡ THE GAP WAS MASSIVE TODAY — ${dateStr}\n\n`
          + `${bestP.punter}: ${bestP.hitRate}% (${bestP.won}W/${bestP.lost}L)\n`
          + `${worstP.punter}: ${worstP.hitRate}% (${worstP.won}W/${worstP.lost}L)\n\n`
          + `Same day. Same leagues. Very different decisions.\n\n${tags}`,
        reply: `Follow the data — not the hype. Track all punters at slippilot.com.ng`,
      });
    }
  }

  return posts;
}

// ── New Category Canvas Renderers ─────────────────────────────────────────────

function renderKillerCard(canvas, analysis) {
  const W = 1080, CARD_H = 520;
  canvas.width  = W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  _rect(ctx, 0, 0, W, CARD_H, P.bg);
  _rect(ctx, 0, 0, W, 3, P.red);
  _rect(ctx, 0, 0, W, 64, P.hdr);
  _t(ctx, 'SLIPPILOT  ·  TICKET KILLER REPORT', 22, 22, { size: 13, weight: '900', color: P.text });
  if (analysis?.date) _t(ctx, fmtShort(analysis.date).toUpperCase(), W - 22, 22, { size: 12, color: P.muted, align: 'right' });
  _line(ctx, 0, 64, W, 64, P.border);

  const killers = (analysis?.ticketKillers || []).slice(0, 4);
  if (!killers.length) {
    _t(ctx, 'No ticket killers recorded today', W / 2, CARD_H / 2, { size: 18, color: P.muted, align: 'center' });
    return;
  }

  let y = 90;
  killers.forEach((k, i) => {
    const bh = i === 0 ? 130 : 70;
    _rect(ctx, 20, y, W - 40, bh, i === 0 ? '#1a0505' : P.surf);
    if (i === 0) _rect(ctx, 20, y, 4, bh, P.red);
    const sel = k.selections?.[0];
    const odds = sel?.originalOdds ? ` @ ${sel.originalOdds}` : '';
    const mktStr = sel ? (sel.outcome ? `${sel.market} — ${sel.outcome}` : sel.market) : '';
    if (i === 0) {
      _t(ctx, '☠ #1 KILLER', 34, y + 20, { size: 10, weight: '700', color: P.red });
      _t(ctx, k.match + odds, 34, y + 46, { size: 17, weight: '700', color: '#fff' });
      if (mktStr) _t(ctx, mktStr, 34, y + 72, { size: 13, color: P.muted });
      _t(ctx, `${k.punterCount} punters  ·  ${k.codeCount} slips destroyed`, 34, y + 100, { size: 12, color: P.red });
    } else {
      _t(ctx, `#${i + 1}  ${k.match}${odds}`, 34, y + 24, { size: 14, weight: '600', color: P.text });
      _t(ctx, `${k.punterCount} punters  ·  ${k.codeCount} slips`, 34, y + 48, { size: 12, color: P.muted });
    }
    y += bh + 10;
  });

  _rect(ctx, 0, CARD_H - 38, W, 38, P.hdr);
  _t(ctx, 'slippilot.com.ng', 22, CARD_H - 19, { size: 11, weight: '600', color: P.blue });
  _t(ctx, 'Know your killers. Avoid them tomorrow.', W - 22, CARD_H - 19, { size: 11, color: P.muted, align: 'right' });
}

function renderConsensusCard(canvas, analysis) {
  const W = 1080, CARD_H = 520;
  canvas.width  = W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  _rect(ctx, 0, 0, W, CARD_H, P.bg);
  _rect(ctx, 0, 0, W, 3, P.green);
  _rect(ctx, 0, 0, W, 64, P.hdr);
  _t(ctx, 'SLIPPILOT  ·  CONSENSUS PICKS', 22, 22, { size: 13, weight: '900', color: P.text });
  if (analysis?.date) _t(ctx, fmtShort(analysis.date).toUpperCase(), W - 22, 22, { size: 12, color: P.muted, align: 'right' });
  _line(ctx, 0, 64, W, 64, P.border);

  const wins = (analysis?.consensusWins || []).slice(0, 5);
  if (!wins.length) {
    _t(ctx, 'No consensus wins recorded today', W / 2, CARD_H / 2, { size: 18, color: P.muted, align: 'center' });
    return;
  }

  let y = 88;
  wins.forEach((w, i) => {
    const selStr = [...new Set((w.selections || []).map(s => s.outcome || s.market))].slice(0, 2).join(', ');
    _rect(ctx, 20, y, W - 40, 78, P.surf);
    _rect(ctx, 20, y, 4, 78, P.green);
    _t(ctx, `✅ ${w.match}`, 34, y + 22, { size: 15, weight: '700', color: '#fff' });
    _t(ctx, selStr ? selStr : 'See slip for details', 34, y + 46, { size: 12, color: P.muted });
    _t(ctx, `${w.punterCount} punters agreed`, W - 30, y + 34, { size: 12, color: P.green, align: 'right' });
    y += 90;
  });

  _rect(ctx, 0, CARD_H - 38, W, 38, P.hdr);
  _t(ctx, 'slippilot.com.ng', 22, CARD_H - 19, { size: 11, weight: '600', color: P.blue });
  _t(ctx, 'Agreement = confidence. Consensus = signal.', W - 22, CARD_H - 19, { size: 11, color: P.muted, align: 'right' });
}

function renderLeagueWatchCard(canvas, analysis) {
  const W = 1080, CARD_H = 520;
  canvas.width  = W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  _rect(ctx, 0, 0, W, CARD_H, P.bg);
  _rect(ctx, 0, 0, W, 3, P.blue);
  _rect(ctx, 0, 0, W, 64, P.hdr);
  _t(ctx, 'SLIPPILOT  ·  LEAGUE INTELLIGENCE', 22, 22, { size: 13, weight: '900', color: P.text });
  if (analysis?.date) _t(ctx, fmtShort(analysis.date).toUpperCase(), W - 22, 22, { size: 12, color: P.muted, align: 'right' });
  _line(ctx, 0, 64, W, 64, P.border);

  const lgWatch = analysis?.leagueWatch || {};
  const entries = Object.entries(lgWatch)
    .filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 2)
    .sort((a, b) => b[1].hitRate - a[1].hitRate)
    .slice(0, 6);

  if (!entries.length) {
    _t(ctx, 'Not enough league data yet', W / 2, CARD_H / 2, { size: 18, color: P.muted, align: 'center' });
    return;
  }

  _t(ctx, 'LEAGUE', 22, 80, { size: 10, weight: '700', color: P.muted });
  _t(ctx, 'W', 720, 80, { size: 10, weight: '700', color: P.muted, align: 'right' });
  _t(ctx, 'L', 790, 80, { size: 10, weight: '700', color: P.muted, align: 'right' });
  _t(ctx, 'HIT RATE', W - 22, 80, { size: 10, weight: '700', color: P.muted, align: 'right' });
  _line(ctx, 20, 94, W - 20, 94, P.border);

  let y = 110;
  entries.forEach(([league, stats], i) => {
    _rect(ctx, 0, y - 8, W, 50, i % 2 === 0 ? P.rowA : P.rowB);
    if (stats.banned) _rect(ctx, 0, y - 8, 4, 50, P.red);
    const hrColor = stats.hitRate >= 70 ? P.green : stats.hitRate >= 50 ? P.yellow : P.red;
    ctx.save(); ctx.font = `600 14px ${F.sans}`;
    _t(ctx, _trunc(ctx, league + (stats.banned ? ' 🚫' : ''), 650), 22, y + 17, { size: 14, weight: '600', color: stats.banned ? P.red : P.text });
    ctx.restore();
    _t(ctx, String(stats.won ?? 0), 720, y + 17, { size: 14, weight: '700', color: P.green, align: 'right' });
    _t(ctx, String(stats.lost ?? 0), 790, y + 17, { size: 14, weight: '700', color: P.red, align: 'right' });
    _t(ctx, `${stats.hitRate}%`, W - 22, y + 17, { size: 15, weight: '700', color: hrColor, align: 'right' });
    y += 56;
  });

  _rect(ctx, 0, CARD_H - 38, W, 38, P.hdr);
  _t(ctx, 'slippilot.com.ng', 22, CARD_H - 19, { size: 11, weight: '600', color: P.blue });
  _t(ctx, 'League intelligence updated daily', W - 22, CARD_H - 19, { size: 11, color: P.muted, align: 'right' });
}

function renderMarketWatchCard(canvas, analysis) {
  const W = 1080, CARD_H = 520;
  canvas.width  = W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  _rect(ctx, 0, 0, W, CARD_H, P.bg);
  _rect(ctx, 0, 0, W, 3, P.yellow);
  _rect(ctx, 0, 0, W, 64, P.hdr);
  _t(ctx, 'SLIPPILOT  ·  MARKET WATCH', 22, 22, { size: 13, weight: '900', color: P.text });
  if (analysis?.date) _t(ctx, fmtShort(analysis.date).toUpperCase(), W - 22, 22, { size: 12, color: P.muted, align: 'right' });
  _line(ctx, 0, 64, W, 64, P.border);

  const mktWatch = analysis?.marketWatch || {};
  const entries = Object.entries(mktWatch)
    .filter(([, v]) => (v.won || 0) + (v.lost || 0) >= 2)
    .sort((a, b) => b[1].hitRate - a[1].hitRate)
    .slice(0, 7);

  if (!entries.length) {
    _t(ctx, 'Not enough market data yet', W / 2, CARD_H / 2, { size: 18, color: P.muted, align: 'center' });
    return;
  }

  _t(ctx, 'MARKET TYPE', 22, 80, { size: 10, weight: '700', color: P.muted });
  _t(ctx, 'W', 680, 80, { size: 10, weight: '700', color: P.muted, align: 'right' });
  _t(ctx, 'L', 760, 80, { size: 10, weight: '700', color: P.muted, align: 'right' });
  _t(ctx, 'HIT RATE', W - 22, 80, { size: 10, weight: '700', color: P.muted, align: 'right' });
  _line(ctx, 20, 94, W - 20, 94, P.border);

  let y = 110;
  entries.forEach(([mkt, stats], i) => {
    _rect(ctx, 0, y - 8, W, 48, i % 2 === 0 ? P.rowA : P.rowB);
    const hrColor = stats.hitRate >= 70 ? P.green : stats.hitRate >= 50 ? P.yellow : P.red;
    const barW = Math.round((stats.hitRate / 100) * 200);
    _rect(ctx, 840, y + 8, barW, 14, hrColor + '33');
    _rect(ctx, 840, y + 8, barW, 14, hrColor + '22');
    ctx.save(); ctx.font = `600 14px ${F.sans}`;
    _t(ctx, _trunc(ctx, mkt, 630), 22, y + 16, { size: 14, weight: '600', color: P.text });
    ctx.restore();
    _t(ctx, String(stats.won ?? 0), 680, y + 16, { size: 14, weight: '700', color: P.green, align: 'right' });
    _t(ctx, String(stats.lost ?? 0), 760, y + 16, { size: 14, weight: '700', color: P.red, align: 'right' });
    _t(ctx, `${stats.hitRate}%`, W - 22, y + 16, { size: 15, weight: '700', color: hrColor, align: 'right' });
    y += 54;
  });

  _rect(ctx, 0, CARD_H - 38, W, 38, P.hdr);
  _t(ctx, 'slippilot.com.ng', 22, CARD_H - 19, { size: 11, weight: '600', color: P.blue });
  _t(ctx, 'Market selection shapes your results', W - 22, CARD_H - 19, { size: 11, color: P.muted, align: 'right' });
}

function renderPerformerCard(canvas, data, analysis) {
  const W = 1080, CARD_H = 520;
  canvas.width  = W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  _rect(ctx, 0, 0, W, CARD_H, P.bg);
  _rect(ctx, 0, 0, W, 3, P.gold);
  _rect(ctx, 0, 0, W, 64, P.hdr);
  _t(ctx, 'SLIPPILOT  ·  PERFORMER SPOTLIGHT', 22, 22, { size: 13, weight: '900', color: P.text });
  const dateLabel = data.rangeLabel || (data.date ? fmtShort(data.date).toUpperCase() : '');
  if (dateLabel) _t(ctx, dateLabel, W - 22, 22, { size: 12, color: P.muted, align: 'right' });
  _line(ctx, 0, 64, W, 64, P.border);

  const settled = (data.punters || []).filter(p => p.settled > 0);
  if (!settled.length) {
    _t(ctx, 'No settled results yet', W / 2, CARD_H / 2, { size: 18, color: P.muted, align: 'center' });
    return;
  }

  const best  = settled[0];
  const worst = [...settled].sort((a, b) => a.hitRate - b.hitRate)[0];
  const avg   = Math.round(settled.reduce((a, p) => a + p.hitRate, 0) / settled.length);

  // Best performer card
  _rect(ctx, 20, 86, 500, 180, '#0f1a0f');
  _rect(ctx, 20, 86, 4, 180, P.gold);
  _t(ctx, '🥇 BEST TODAY', 36, 110, { size: 11, weight: '700', color: P.gold });
  _t(ctx, best.name, 36, 148, { size: 22, weight: '800', color: '#fff' });
  _t(ctx, `${best.hitRate}% HIT RATE`, 36, 182, { size: 16, weight: '700', color: P.green });
  _t(ctx, `${best.won}W  /  ${best.lost}L`, 36, 212, { size: 13, color: P.muted });
  if (best.totalOdds) _t(ctx, `${typeof best.totalOdds === 'number' ? best.totalOdds.toFixed(0) + 'x' : best.totalOdds} odds`, 36, 238, { size: 12, color: P.muted });

  // Worst performer card
  if (worst && worst.name !== best.name) {
    _rect(ctx, 560, 86, 500, 180, '#1a0505');
    _rect(ctx, 560, 86, 4, 180, P.red);
    _t(ctx, '📉 TOUGHEST DAY', 576, 110, { size: 11, weight: '700', color: P.red });
    _t(ctx, worst.name, 576, 148, { size: 22, weight: '800', color: '#fff' });
    _t(ctx, `${worst.hitRate}% HIT RATE`, 576, 182, { size: 16, weight: '700', color: P.red });
    _t(ctx, `${worst.won}W  /  ${worst.lost}L`, 576, 212, { size: 13, color: P.muted });
  }

  // Field stats
  _rect(ctx, 20, 286, W - 40, 60, P.surf);
  _t(ctx, `${settled.length} analysts tracked  ·  Field avg: ${avg}%  ·  ${data.date ? fmtShort(data.date) : ''}`, 36, 316, { size: 13, color: P.muted });

  // Runner-up row
  if (settled.length >= 2) {
    _t(ctx, 'FULL RANKINGS', 22, 374, { size: 10, weight: '700', color: P.muted });
    _line(ctx, 20, 386, W - 20, 386, P.border);
    settled.slice(0, Math.min(4, settled.length)).forEach((p, i) => {
      const rx = 22 + i * 260;
      const hrC = p.hitRate >= 70 ? P.green : p.hitRate >= 50 ? P.yellow : P.red;
      _t(ctx, `#${i + 1} ${p.name}`, rx, 412, { size: 13, weight: '600', color: P.text });
      _t(ctx, `${p.hitRate}%`, rx, 436, { size: 14, weight: '700', color: hrC });
    });
  }

  _rect(ctx, 0, CARD_H - 38, W, 38, P.hdr);
  _t(ctx, 'slippilot.com.ng', 22, CARD_H - 19, { size: 11, weight: '600', color: P.blue });
  _t(ctx, 'Track punter performance daily', W - 22, CARD_H - 19, { size: 11, color: P.muted, align: 'right' });
}

// ── Download helper (all numbered canvases) ───────────────────────────────────
function csDownloadCanvas(id, filename) {
  const canvas = document.getElementById(id);
  if (!canvas || canvas.width < 100) { alert('Card not rendered yet.'); return; }
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || id + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, 'image/png');
}

// ── Special Posts UI ──────────────────────────────────────────────────────────
function csRenderSpecialPosts(data, analysis) {
  const container = document.getElementById('cs-special-posts');
  if (!container) return;
  const posts = buildSpecialPosts(data, analysis);
  if (!posts.length) {
    container.innerHTML = '<p style="color:#64748B;font-size:13px;padding:16px">No special posts generated for this date — need more settled data.</p>';
    return;
  }
  container.innerHTML = posts.map((p, i) => `
    <div class="cs-social-section" style="margin-bottom:12px">
      <div style="padding:12px 18px;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:700;color:#F1F5F9">${p.type}</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="cs-copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('sp-cap-${i}').textContent)">Copy Caption</button>
          <button class="cs-copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('sp-rep-${i}').textContent)">Copy Reply</button>
        </div>
      </div>
      <div style="padding:14px 18px">
        <pre id="sp-cap-${i}" style="white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;font-size:13px;color:#CBD5E1;line-height:1.65;background:#040810;border-radius:8px;padding:14px;margin:0 0 10px">${p.caption}</pre>
        <div style="font-size:11px;color:#64748B;margin-bottom:6px;font-weight:600">FIRST REPLY</div>
        <pre id="sp-rep-${i}" style="white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;font-size:12px;color:#94A3B8;line-height:1.6;background:#040810;border-radius:8px;padding:12px;margin:0">${p.reply}</pre>
      </div>
    </div>
  `).join('');
}

// ── Entry Point ───────────────────────────────────────────────────────────────
async function loadStudio() {
  csHideError();
  csStatus('Loading…', P.blue);
  // Default to yesterday — today's data is never complete yet
  const picker = document.getElementById('cs-date-picker');
  if (picker && !picker.value) picker.value = getYesterday();
  await _loadLogo();
  try {
    const reports = await safeFetch('/api/studio/reports');
    _reportDates  = reports.map(r => r.date);

    const target    = reports.find(r => r.date === getTargetDate()) || reports[0];

    if (!target) {
      csShowOnboarding();
      csStatus('');
      return;
    }

    const full = await safeFetch('/api/studio/report/' + target.date);
    csDisplayReport(full);
    csStatus('');
  } catch (e) {
    console.error('[Studio] loadStudio:', e);
    csShowError(e.message);
    csStatus('');
    csShowOnboarding();
  }
}
