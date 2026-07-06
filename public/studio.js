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
    .sort((a, b) => b.hitRate - a.hitRate || b.won - a.won);

  const active = punters.filter(p => p.settled > 0);
  const avgHR  = active.length
    ? Math.round(active.reduce((s, p) => s + p.hitRate, 0) / active.length)
    : 0;

  return { date: targetDate, punters, avgHR };
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
    .filter(p => p.settled > 0)
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
function buildCaption(data, idx, type, analysis) {
  type = type || 'daily';
  const { punters, avgHR, date } = data;
  if (!punters || !punters.length) return 'No data available.';

  const dateStr = type === 'daily' ? fmtLong(date) : (data.rangeLabel || fmtShort(date));
  const tags = type === 'daily'
    ? '#FootballBetting #BettingTips #SlipPilot #SpottyBet'
    : '#FootballBetting #SlipPilot #BettingAnalysis';

  const settled = punters.filter(p => p.settled > 0);
  const best = settled[0] || punters[0];

  let cap = `📊 SLIPPILOT DAILY INTEL — ${dateStr.toUpperCase()}\n`;
  cap += `Top: ${best.name} ${best.hitRate}%  ·  Avg: ${avgHR}%  ·  ${punters.length} analysts\n\n`;

  if (!analysis) {
    cap += `Run a Rescan All to unlock full intelligence.\n\n${tags}`;
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

  // Fallback when no analysis saved yet
  if (!analysis) {
    const settled = punters.filter(p => p.settled > 0);
    if (!settled.length) return '';
    const best  = settled[0];
    const worst = [...settled].sort((a, b) => a.hitRate - b.hitRate)[0];
    let reply = `🧵 SlipPilot breakdown (${period})\n\n`;
    if (best && worst && best.hitRate - worst.hitRate > 15)
      reply += `Gap of the day: ${best.name} hit ${best.hitRate}% while ${worst.name} hit ${worst.hitRate}%.\n\n`;
    reply += `No scan data yet — run a Rescan All to unlock full analysis.\n\nFollow @SlipPilot for tomorrow's codes →`;
    return reply;
  }

  const killers = analysis.ticketKillers || [];
  const wins    = analysis.consensusWins  || [];
  const insights = analysis.insights || [];

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
    const targetDate = getYesterday();
    data       = processLeaderboard(raw, targetDate);
    dateKey    = targetDate;
    rangeLabel = fmtLong(targetDate);
    if (!data.punters.length)
      throw new Error(
        'No completed analysis for ' + targetDate + '. ' +
        'Run Rescan All from the Admin panel first.'
      );
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

  // Only generate content from real analysis — never fabricate
  const noAnalysis = type === 'daily' && (!analysis || analysis.partial);
  const caption = noAnalysis
    ? (analysis?.partial
        ? `Daily Analysis is still collecting. ${analysis.totals?.settled ?? 0} selections settled — need at least 10.`
        : 'No completed Daily Analysis available. Run Rescan All from the Admin panel first.')
    : buildCaption(data, 0, type, analysis);
  const reply = noAnalysis
    ? (analysis?.partial
        ? `Run Rescan All again once more matches have settled (${analysis.totals?.settled ?? 0}/10 ready).`
        : 'Run Rescan All from the Admin panel to generate the daily analysis for this date.')
    : buildReply(data, type, analysis);

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

  csShowReport();
  csStatus('');
}

// ── Generate ──────────────────────────────────────────────────────────────────
async function generateDailyReport(force) {
  const type = _reportType || 'daily';
  let key;
  if (type === 'daily')       key = getYesterday();
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
               : getYesterday();
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
  const key  = type === 'daily'   ? getYesterday()
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

// ── Entry Point ───────────────────────────────────────────────────────────────
async function loadStudio() {
  csHideError();
  csStatus('Loading…', P.blue);
  await _loadLogo();
  try {
    const reports = await safeFetch('/api/studio/reports');
    _reportDates  = reports.map(r => r.date);

    const yesterday = getYesterday();
    const target    = reports.find(r => r.date === yesterday) || reports[0];

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
