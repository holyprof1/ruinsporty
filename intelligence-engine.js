/**
 * intelligence-engine.js — SlipPilot Unified Intelligence Engine v6
 *
 * ONE source of truth for confidence scores.
 * Every feature (Smart Slips, Booking Codes, Optimizer, X Assistant,
 * Manual Converter) reads the master pool produced here.
 *
 * Exported functions:
 *   runAnalysis(punterMap, logger)     → builds + caches master pool
 *   getMasterPool()                    → returns today's cached pool or null
 *   buildThemedCodes(masterPool, logger) → generates themed booking codes
 *   scoreSelections(selections)        → score any list against master pool logic
 *   getXContext()                      → returns analysis context for X Assistant
 */
'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── DATA FILES ───────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data');
const POOL_FILE    = path.join(DATA, 'master-pool.json');
const LEAGUE_FILE  = path.join(DATA, 'league-intelligence.json');
const MARKET_FILE  = path.join(DATA, 'market-intelligence.json');
const TEAM_FILE    = path.join(DATA, 'team-intelligence.json');
const SPEC_FILE    = path.join(DATA, 'punter-specializations.json');
const PROF_FILE    = path.join(DATA, 'punter-profiles.json');
const LB_FILE      = path.join(DATA, 'leaderboard.json');
const REPORTS_DIR  = path.join(DATA, 'reports');
const WEAK_FILE    = path.join(DATA, 'weak-matches.json');

function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}
function safeJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch { return fallback; }
}

// ─── MARKET SAFETY SCORING (0–100, -1 = hard remove) ─────────────────────────
const HARD_REMOVE_PATTERNS = [
  'corner','card','yellow','red card','foul','offside','throw-in',
  'goalscorer','next goal','last goal','correct score','asian handicap',
  'handicap','1x2 - 2up','1x2 - 1up','half-time/full-time',
  'booking','substitut','first player','player to score','to score','anytime',
  'penalty shootout','winning method','will there be',
];

// Extract numeric line from specifier or outcome name
function getLine(mn, sp, on) {
  const spN = (sp || '').match(/[\d.]+/g) || [];
  if (spN.length) return parseFloat(spN[0]);
  const onN = (on || '').match(/[\d.]+/g) || [];
  if (onN.length) return parseFloat(onN[0]);
  const mnN = (mn || '').match(/[\d.]+/g) || [];
  if (mnN.length) return parseFloat(mnN[mnN.length - 1]);
  return 0;
}

function marketSafety(marketName, specifier, outcomeName) {
  const mn = (marketName || '').toLowerCase();
  const on = (outcomeName || '').toLowerCase();
  for (const p of HARD_REMOVE_PATTERNS) { if (mn.includes(p) || on.includes(p)) return -1; }

  // Combo markets like "Double Chance & Over/Under 2.5" — 0% hit rate in 14-day data, hard remove
  if (mn.includes('double chance') && (mn.includes('over') || mn.includes('under'))) return -1;
  // Standard Double Chance — calibrated to 76% actual (was 85, inflated)
  if (mn.includes('double chance') && !mn.includes('goal')) return 79;
  // Draw No Bet — calibrated to 65 (file: 60%, 14-day: 66%; was 79, overscored by 13-19 pts)
  if (mn === 'draw no bet' || mn.includes('draw no bet')) return 65;
  if (mn.includes('home no draw') || mn === 'home/away') return 75;
  if (mn.includes('goal bounds')) {
    // ONLY safe if outcome is a range like "2-5", "3+", "4+", NOT a bare digit like "2" or "3"
    if (/^\d+$/.test(on.trim())) return -1;
    return 74;
  }
  if (mn.includes('excluded number')) return 76;
  if (mn.includes('both halves')) {
    if (on.includes('under') || on.includes('no')) return 82;
    return -1; // "Both halves over X" is too narrow — remove
  }
  if (mn.includes('gg/ng') || mn === 'gg/ng') {
    // Calibrated to 61% (file: 61%, 14-day: 60%; was 66, overscored)
    return (on.includes('yes') || on.includes('gg')) ? 61 : 55;
  }
  // 1st Half markets — SEPARATE from 2nd half (unreachable bug fixed)
  // Actual HR: 64% overall, 50% in 14-day rolling (was 81/90, dangerously overscored)
  if (mn.includes('1st half')) {
    const line = getLine(mn, specifier, on);
    const isOver = on.includes('over');
    if (isOver && line <= 0.5) return 72;
    if (isOver && line <= 1.5) return 62; // was 81 — actual 50-64% HR
    return 52;
  }
  if (mn.includes('2nd half')) {
    const line = getLine(mn, specifier, on);
    const isOver = on.includes('over');
    if (isOver && line <= 0.5) return 80;
    if (isOver && line <= 1.5) return 75; // file: 79% for 2nd half O/U (better than 1st half)
    return 62;
  }
  if (mn.includes('over/under') || mn === 'over/under') {
    const line = getLine(mn, specifier, on);
    const isOver = on.includes('over');
    const isUnder = on.includes('under') || on.includes('no');
    if (isOver && line <= 0.5) return 93;
    if (isOver && line <= 1.5) return 87;
    if (isOver && line <= 2.0) return 83; // Over 2.0: acceptable but will be converted
    if (isOver && line <= 2.5) return 77;
    if (isUnder && line >= 2.5) return 74;
    if (isOver && line <= 3.5) return 61;
    if (isOver && line <= 4.5) return 52;
    if (line > 4.5) return 44;
    return 70;
  }
  if (mn === 'match winner' || mn === '1x2') return 57;
  if (mn.includes('baseball') || mn === 'baseball o/u') return 71;
  if (mn.includes('basketball') || mn.includes('basketball o/u')) return 68;
  if (mn.includes('winner') || mn.includes('set handicap')) return 63;
  return 57;
}

// ─── RISK CLASSIFICATION (for conversion logic) ───────────────────────────────
function classifyRisk(mn, sp, on) {
  const m = (mn || '').toLowerCase(), o = (on || '').toLowerCase();
  if (HARD_REMOVE_PATTERNS.some(p => m.includes(p) || o.includes(p))) return 'REMOVE';
  if (m.includes('handicap')) return 'REMOVE';
  if (m.includes('goal bounds') && /^\d+$/.test(o.trim())) return 'REMOVE'; // bare digit Goal Bounds
  if (m.includes('both halves') && o.includes('over')) return 'REMOVE';
  if (m === 'match winner' || m === '1x2') {
    if (o === 'home' || o === '1' || (o.startsWith('home') && !o.includes('or'))) return 'HOME_WIN';
    if (o === 'away' || o === '2' || (o.startsWith('away') && !o.includes('or'))) return 'AWAY_WIN';
    if (o === 'draw' || o === 'x') return 'DRAW';
  }
  if (m.includes('gg/ng') && (o.includes('yes') || o.includes('gg'))) return 'GG_YES';
  // Over lines — only full-match over/under; 1st half handled by safety score, not conversion
  if (m.includes('over/under') && !m.includes('1st half') && o.includes('over')) {
    const line = getLine(mn, sp, on);
    if (line >= 4.5) return 'OVER_4.5';
    if (line >= 3.5) return 'OVER_3.5';
    if (line >= 2.5) return 'OVER_2.5';
    if (line >= 2.0) return 'OVER_2.0'; // User rule: "no Over 2" — convert to Over 1.5
  }
  // 2nd Half over — convert high lines
  if (m.includes('2nd half') && o.includes('over')) {
    const line = getLine(mn, sp, on);
    if (line >= 2.5) return 'OVER_2.5';
    if (line >= 2.0) return 'OVER_2.0';
  }
  return 'OK';
}

// Safe conversion chains: risky market → safer alternatives to try in order
const SAFE_CONVERSIONS = {
  'HOME_WIN': ['DC_1X', 'DNB_HOME'],
  'AWAY_WIN': ['DC_X2', 'DNB_AWAY'],
  'DRAW':     ['DC_1X', 'DC_X2'],
  'GG_YES':   ['OVER_1.5', 'GOAL_BOUNDS_RANGE'],
  'OVER_2.0': ['OVER_1.5'],            // User rule: no Over 2 — always convert
  'OVER_2.5': ['OVER_1.5'],
  'OVER_3.5': ['OVER_2.5', 'OVER_1.5'],
  'OVER_4.5': ['OVER_2.5', 'OVER_1.5'],
};

// Find a safe alternative market from event's available markets
function findSafeMarket(avail, type) {
  for (const m of avail) {
    if (!m.odds || m.odds <= 1.01 || m.odds > 9) continue;
    const mn = (m.marketName || '').toLowerCase();
    const on = (m.outcomeName || '').toLowerCase();
    const sp = m.specifier || '';
    switch (type) {
      case 'DC_X2':
        if (mn.includes('double chance') && !mn.includes('over') &&
            (on.includes('x2') || on.includes('draw or away') || on.includes('away or draw'))) return m;
        break;
      case 'DC_1X':
        if (mn.includes('double chance') && !mn.includes('over') &&
            (on.includes('1x') || on.includes('home or draw') || on.includes('draw or home'))) return m;
        break;
      case 'DNB_AWAY':
        if ((mn.includes('draw no bet') || mn.includes('home no draw')) && (on.includes('away') || on === '2')) return m;
        break;
      case 'DNB_HOME':
        if ((mn.includes('draw no bet') || mn.includes('home no draw')) && (on.includes('home') || on === '1')) return m;
        break;
      case 'OVER_1.5': {
        if (!(mn.includes('over/under') || mn.includes('2nd half'))) break;
        if (!on.includes('over')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 1.5) < 0.1 && m.odds >= 1.1 && m.odds <= 3.5) return m;
        break;
      }
      case 'OVER_2.5': {
        if (!mn.includes('over/under') || !on.includes('over')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 2.5) < 0.1 && m.odds >= 1.3 && m.odds <= 6) return m;
        break;
      }
      case 'GOAL_BOUNDS_RANGE': {
        if (!mn.includes('goal bounds')) break;
        // MUST be a range — "2-5", "3+", "4+", NOT bare "2" or "3"
        if ((on.match(/\d+-\d+/) || on.includes('+')) && !(/^\d+$/.test(on.trim()))) {
          if (m.odds >= 1.5 && m.odds <= 8) return m;
        }
        break;
      }
    }
  }
  return null;
}

// ─── KILLER / PENALISED LEAGUES ───────────────────────────────────────────────
const PENALISED_LEAGUES = new Set([
  'Besta deild','Erovnuli Liga','TOPLYGA','Kolmonen','Besta deild karla',
  '1. deild','Kolmonen, Women',
]);
const VOLATILE_RE = /\b(reserve|youth|u19|u20|u21|u23|u17|u16|friendly|pre-?season|club friendlies|virtual|carioca|mineiro|azadegan)\b/i;
const ELITE_LEAGUES = new Set([
  'Allsvenskan','Tercera Division, Reserves','USL League Two',
  'II Lyga','USL W League','Premier Division','World Cup Qualification, Europe',
  'U19 UEFA European Championship, Women','U19 European Championship',
  'Canadian Premier League','International Clubs',
  'Virsliga',            // 89% HR (17W/2L) — validated elite
  'Premium Liiga',       // 90% HR (9W/1L) — validated elite
  'Ykkosliiga',          // 89% HR (8W/1L) — validated elite
  'Suomen Cup',          // 88% HR (7W/1L) — validated elite
  '1st Division',        // 83% HR (15W/3L) — consistently reliable
]);

function isKillerLeague(league, leagueIntel) {
  if (PENALISED_LEAGUES.has(league)) return true;
  const d = leagueIntel[league];
  if (d && (d.won + d.lost) >= 5 && d.hitRate < 45) return true;
  return false;
}

// ─── PUNTER FORM FROM LEADERBOARD / PROFILES ─────────────────────────────────
function getPunterData(lbMap, profMap, name) {
  const lb  = lbMap.get(name)  || {};
  const prf = profMap[name]    || {};
  const trust = lb.trustScore || prf.trustScore || 55;
  const hrAll = lb.hitRate || prf.hitRate || 55;
  const hr7   = recentForm(lb, 7)  || recentForm(prf, 7)  || hrAll;
  const hr3   = recentForm(lb, 3)  || recentForm(prf, 3)  || hr7;
  const hr14  = recentForm(lb, 14) || recentForm(prf, 14) || hrAll;
  // Rolling weighted form: 3d×45% + 7d×30% + all×25%
  const formScore = Math.round(hr3 * 0.45 + hr7 * 0.30 + hrAll * 0.25);
  const drop = hrAll - hr3;
  let ff = 1.0;
  if (drop >= 25) ff = 0.70;
  else if (drop >= 15) ff = 0.83;
  else if (drop >= 8)  ff = 0.93;
  else if (hr3 > hrAll + 15) ff = 1.12;
  else if (hr3 > hrAll + 8)  ff = 1.07;
  const consistency = lb.consistency || prf.consistency || 70;
  const composite = Math.round(formScore * 0.40 + trust * 0.35 + consistency * 0.25);
  let tier;
  if (composite >= 82 && ff >= 1.0) tier = 'ELITE';
  else if (composite >= 72) tier = 'RELIABLE';
  else if (composite >= 60) tier = 'SITUATIONAL';
  else if (composite >= 48) tier = 'COLD';
  else tier = 'EXPERIMENTAL';
  const tierMult = { ELITE: 1.12, RELIABLE: 1.05, SITUATIONAL: 1.0, COLD: 0.88, EXPERIMENTAL: 0.78 }[tier] || 1.0;
  return { trust, hrAll, hr7, hr3, hr14, formScore, ff, tier, tierMult, composite, effTrust: Math.round(trust * ff) };
}

function recentForm(entry, days) {
  if (!entry?.codes?.length) return null;
  const cutoff = Date.now() - days * 86400000;
  const recent = entry.codes.filter(c =>
    c.date && new Date(c.date).getTime() >= cutoff && (c.won + c.lost) >= 3
  );
  if (!recent.length) return null;
  const w = recent.reduce((s, c) => s + (c.won || 0), 0);
  const l = recent.reduce((s, c) => s + (c.lost || 0), 0);
  return (w + l) ? Math.round(w / (w + l) * 100) : null;
}

// ─── PUNTER SPECIALIZATION SCORES ─────────────────────────────────────────────
function punterLeagueHR(specMap, name, league) {
  const sp = specMap[name]; if (!sp) return null;
  const d = sp.byLeague?.[league];
  if (d && (d.w + d.l) >= 3) return d.hr;
  return sp.global || null;
}
function punterMarketHR(specMap, name, marketName) {
  const sp = specMap[name]; if (!sp) return null;
  const mn = marketName.toLowerCase();
  const key = Object.keys(sp.byMarket || {}).find(k => mn.includes(k.toLowerCase().split(' ')[0]) || k.toLowerCase() === mn);
  if (key) { const d = sp.byMarket[key]; if ((d.w + d.l) >= 3) return d.hr; }
  return sp.global || null;
}

// ─── WEIGHTED CONSENSUS ───────────────────────────────────────────────────────
function weightedConsensus(punterNames, lbMap, profMap) {
  const n = (punterNames || []).length;
  if (n <= 1) return 0;
  // Step bonus per agreement count
  let bonus = n === 2 ? 8 : n === 3 ? 15 : n === 4 ? 20 : 25;
  // Extra +3 per ELITE/RELIABLE punter in the agreement group (cap +9)
  const eliteBonus = Math.min(9, punterNames.filter(p => {
    const t = getPunterData(lbMap, profMap, p).tier;
    return t === 'ELITE' || t === 'RELIABLE';
  }).length * 3);
  return Math.min(30, bonus + eliteBonus);
}

// ─── LEAGUE TIERS ────────────────────────────────────────────────────────────
const BLACKLIST_LEAGUES = new Set([
  'Besta deild','Erovnuli Liga','TOPLYGA','Kolmonen','Besta deild karla',
  '1. deild','Kolmonen, Women','3. deild','4. deild','5. deild','Pervaya Liga',
  'Club Friendly Games','International Friendly Games','Friendlies',
  'LigaPro Primera A',   // 33% hit rate (2W/4L) — validated bad
  'Primera Nacional',    // 20% hit rate (1W/4L) — validated bad
]);
const DANGER_LEAGUES = new Set([
  'Brasileiro Serie C','Mineiro, Modulo II','MLS Next Pro','Ykkonen',
  'Veikkausliiga',       // 38% 14-day HR (3W/5L) — consistently underperforms
  'Kakkonen',            // 58% but erratic, high-variance Finnish second tier
]);
// Override isKillerLeague with tier check
function leagueTier(league, leagueIntel) {
  if (BLACKLIST_LEAGUES.has(league)) return 'BLACKLIST';
  if (PENALISED_LEAGUES.has(league)) return 'DANGER';
  if (VOLATILE_RE.test(league) && !ELITE_LEAGUES.has(league)) return 'VOLATILE';
  if (DANGER_LEAGUES.has(league)) return 'DANGER';
  if (ELITE_LEAGUES.has(league)) return 'ELITE';
  const d = leagueIntel[league];
  if (d && (d.won + d.lost) >= 5) {
    if (d.hitRate >= 75) return 'ELITE';
    if (d.hitRate >= 60) return 'SAFE';
    if (d.hitRate < 45)  return 'DANGER';
  }
  return 'NEUTRAL';
}

// ─── MASTER SCORE (v7) ────────────────────────────────────────────────────────
function masterScore(sel, deps) {
  const { lbMap, profMap, specMap, leagueIntel, marketIntel, teamIntel, selHistory, weakMatches, killerLeagues } = deps;
  const safety = marketSafety(sel.marketName || sel.market, sel.specifier, sel.outcomeName || sel.outcome);
  if (safety < 0) return -1;

  const league = sel.league || '';
  const ltier  = leagueTier(league, leagueIntel || {});
  if (ltier === 'BLACKLIST') return 10;
  if (ltier === 'DANGER')    return 20;
  if (ltier === 'VOLATILE')  return 30;

  const killerPenalty = (killerLeagues && killerLeagues[league]) ? Math.min(20, (killerLeagues[league] || 0) * 3) : 0;
  const lgBonus = ltier === 'ELITE' ? 9 : ltier === 'SAFE' ? 4 : 0;

  const punters  = sel.punters || [sel.punter];
  const primaryP = sel.punter || punters[0] || '';

  // Punter data — use rolling formScore + tier multiplier
  const pd        = getPunterData(lbMap, profMap, primaryP);
  const pLeagueHR = punterLeagueHR(specMap, primaryP, league) || pd.formScore;
  const pMktHR    = punterMarketHR(specMap, primaryP, sel.marketName || sel.market || '') || pd.formScore;

  // League historical
  const li      = leagueIntel[league];
  const lgScore = li && (li.won + li.lost) >= 4 ? li.hitRate : 63;

  // Market historical
  const mi    = marketIntel[sel.marketName || sel.market || ''];
  const mktHR = mi && mi.totalSelections >= 5 ? mi.hitRate : safety;

  // Consensus bonus (weighted by trust)
  const consensusBonus = weightedConsensus(punters, lbMap, profMap);

  // Selection history
  const shKey = `${league}|${sel.homeTeam}|${sel.awayTeam}|${sel.marketName||sel.market}|${sel.outcomeName||sel.outcome}`;
  const sh = selHistory[shKey];
  let histAdj = 0;
  if (sh && sh.appearances >= 2) {
    if (sh.hitRate >= 70)     histAdj = 10;
    else if (sh.hitRate < 40) histAdj = -15;
    else if (sh.hitRate < 55) histAdj = -5;
  }

  // Weak match penalty
  const wm = weakMatches[sel.eventId];
  let weakAdj = 0;
  if (wm && wm.losses > 0) {
    const fr = wm.appearances > 0 ? Math.round(wm.losses / wm.appearances * 100) : 0;
    if (fr >= 60) weakAdj = -15;
    else if (fr >= 40) weakAdj = -8;
  }

  // Odds sanity
  const odds = sel.originalOdds || sel.odds || 0;
  let oddsAdj = 0;
  if (odds > 10) oddsAdj = -20;
  else if (odds > 5) oddsAdj = -10;
  else if (odds <= 1.35 && odds > 0) oddsAdj = 8;
  else if (odds <= 1.7 && odds > 0)  oddsAdj = 4;

  // Team intelligence
  const out = (sel.outcomeName || sel.outcome || '').toLowerCase();
  let teamAdj = 0;
  const ti = teamIntel[sel.homeTeam || ''];
  if (ti && ['home','1','home win'].includes(out) && ti.home?.hitRate != null && ti.home.won + ti.home.lost >= 3) {
    if (ti.home.hitRate >= 70) teamAdj += 6;
    else if (ti.home.hitRate < 40) teamAdj -= 8;
  }
  const tai = teamIntel[sel.awayTeam || ''];
  if (tai && ['away','2','away win'].includes(out) && tai.away?.hitRate != null && tai.away.won + tai.away.lost >= 3) {
    if (tai.away.hitRate >= 70) teamAdj += 6;
    else if (tai.away.hitRate < 40) teamAdj -= 8;
  }

  // v7 weighted base — punter quality boosted to 23% total weight
  const base =
    pLeagueHR       * 0.20 +
    lgScore         * 0.15 +
    safety          * 0.25 +
    pMktHR          * 0.10 +
    mktHR           * 0.07 +
    pd.effTrust     * 0.13 +
    pd.formScore    * 0.10;

  return Math.round((base + lgBonus + consensusBonus + histAdj + weakAdj + oddsAdj + teamAdj - killerPenalty) * pd.tierMult);
}

// ─── NETWORK HELPERS ──────────────────────────────────────────────────────────
function sbGet(code) {
  return new Promise((res, rej) => {
    const req = https.get({
      hostname: 'www.sportybet.com',
      path: '/api/ng/orders/share/' + encodeURIComponent(code),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, r => { let d=''; r.on('data', c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); });
    req.on('error', rej);
    req.setTimeout(12000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}
// Fetch all available markets for a specific event
function sbGetEvent(eventId) {
  return new Promise((res, rej) => {
    const req = https.get({
      hostname: 'www.sportybet.com',
      path: `/api/ng/factsCenter/event?eventId=${encodeURIComponent(eventId)}`,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, r => { let d=''; r.on('data', c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); });
    req.on('error', rej);
    req.setTimeout(10000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}
function sbPost(selections) {
  return new Promise((res, rej) => {
    const data = JSON.stringify({ selections });
    const req = https.request({
      hostname: 'www.sportybet.com', path: '/api/ng/orders/share', method: 'POST',
      headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data), 'User-Agent':'Mozilla/5.0' },
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); });
    req.on('error', rej);
    req.setTimeout(15000, () => { req.destroy(); rej(new Error('timeout')); });
    req.write(data); req.end();
  });
}

// Market name normaliser (SportyBet IDs → friendly names)
const MKT_NAMES = {
  '1':'Match Winner','2':'Asian Handicap','10':'Home/Away','11':'Double Chance',
  '12':'Draw No Bet','14':'Over/Under','16':'Asian Handicap','18':'Over/Under',
  '19':'Over/Under','29':'GG/NG','37':'1st Half - Over/Under','59':'2nd Half - Over/Under',
  '60':'Double Chance','83':'Home No Draw','85':'Asian Handicap','188':'Asian Handicap',
  '204':'Double Chance','258':'Baseball O/U','450001':'Goal Bounds',
  '450002':'Both Halves O/U','450003':'Both Halves O/U','68':'Basketball O/U',
  '854':'Over/Under','856':'GG/NG','900300':'Over/Under','900303':'Over/Under',
  '60200':'Match Winner',
};
const OUT_NAMES = {
  '12':'Over','13':'Under','74':'GG','76':'NG','10':'Home','6':'Away',
  '4':'X','5':'1 or X','1':'1','2':'X2','3':'2','23':'Under','30':'Over',
};

// ─── RUN ANALYSIS ─────────────────────────────────────────────────────────────
/**
 * Fetches all punter codes, scores every pick, returns master pool.
 * Caches result to data/master-pool.json.
 * @param {Object} punterMap — { punterName: 'CODE' }
 * @param {Function} logger  — optional (msg) => void for progress updates
 */
async function runAnalysis(punterMap, logger = ()=>{}) {
  const today  = localToday();
  const now    = Date.now();

  // Load all intelligence
  logger('Loading historical intelligence…');
  const leagueIntel = safeJSON(LEAGUE_FILE, {});
  const marketIntel = safeJSON(MARKET_FILE, {});
  const teamIntel   = safeJSON(TEAM_FILE,   {});
  const specMap     = safeJSON(SPEC_FILE,   {});
  const profMap     = safeJSON(PROF_FILE,   {});
  const weakMatches = safeJSON(WEAK_FILE,   {});

  // Build leaderboard map from file (rich source of trust + form)
  let lb = [];
  try { lb = safeJSON(LB_FILE, []); } catch {}
  const lbMap = new Map(lb.map(p => [p.punter, p]));

  // Selection history for exact pick tracking
  const selHistoryFile = path.join(DATA, 'selection-history.json');
  const selHistory = safeJSON(selHistoryFile, {});

  // ── Load ALL historical reports (3 weeks), weight recent more heavily ─────────
  const killerEvents  = new Set();
  const killerLeagues = {}; // league → weighted killer count
  try {
    const now3w = Date.now();
    const reportFiles = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort(); // ALL reports, oldest first
    for (const f of reportFiles) {
      const rDate = f.replace('.json', '');
      const ageDays = (now3w - new Date(rDate).getTime()) / 86400000;
      // Weight: recent 3d = 1.5, 3-7d = 1.2, 7-14d = 0.8, older = 0.4
      const wt = ageDays <= 3 ? 1.5 : ageDays <= 7 ? 1.2 : ageDays <= 14 ? 0.8 : 0.4;
      const rpt = safeJSON(path.join(REPORTS_DIR, f), {});
      for (const tk of (rpt.analysis?.ticketKillers || [])) {
        if (tk.homeTeam && tk.awayTeam) killerEvents.add(`${tk.homeTeam}|${tk.awayTeam}`);
        if (tk.league) killerLeagues[tk.league] = (killerLeagues[tk.league] || 0) + Math.round((tk.punterCount || 1) * wt);
      }
    }
    logger(`  Loaded ${reportFiles.length} historical reports for killer/pattern intelligence`);
  } catch {}

  const deps = { lbMap, profMap, specMap, leagueIntel, marketIntel, teamIntel, selHistory, weakMatches, killerLeagues };

  // Fetch punter data
  logger(`Fetching picks from ${Object.keys(punterMap).length} punters…`);
  const allRaw = [];
  const fetchLog = {};

  for (const [punter, code] of Object.entries(punterMap)) {
    if (!code || typeof code !== 'string') continue;
    const codeStr = code.trim().toUpperCase();
    if (!codeStr) continue;
    try {
      const j = await sbGet(codeStr);
      if (!j || j.bizCode !== 10000 || !j.data) {
        fetchLog[punter] = { code: codeStr, status: 'fail', error: j?.message || 'no data' };
        continue;
      }
      const outcomes = j.data.outcomes || [];
      const ticketSels = j.data.ticket?.selections || [];
      const ticketMap = new Map((ticketSels || []).map(ts => [ts.eventId, ts]));
      let cnt = 0;

      for (const o of outcomes) {
        const ms = (o.matchStatus || '').toLowerCase();
        if (['ended','h1','h2','ht','p1','p2','inprogress'].includes(ms)) continue;
        const kick = o.estimateStartTime || 0;
        if (kick && kick <= now) continue;

        const mkt  = (o.markets || [])[0] || {};
        const pick = (mkt.outcomes || [])[0] || {};
        const ts   = ticketMap.get(o.eventId) || {};

        const marketId   = String(ts.marketId || mkt.id || '');
        const marketName = MKT_NAMES[marketId] || mkt.desc || ('Mkt' + marketId);
        const specifier  = ts.specifier || mkt.specifier || '';
        const outcomeId  = String(ts.outcomeId || pick.id || '');
        const outcomeName = pick.desc || OUT_NAMES[outcomeId] || outcomeId;
        const odds = parseFloat(ts.odds || pick.odds || 1);
        if (odds <= 1.0) continue;

        const league   = o.sport?.category?.tournament?.name || o.sport?.category?.name || '';
        const category = o.sport?.category?.name || '';

        allRaw.push({
          punter, code: codeStr,
          eventId:    String(o.eventId),
          homeTeam:   o.homeTeamName || '',
          awayTeam:   o.awayTeamName || '',
          league, category,
          kickoff:    kick ? new Date(kick).toISOString() : '',
          kick,
          marketId, marketName, specifier,
          outcomeId, outcomeName, odds,
          productId:  ts.productId || mkt.product || 3,
          sportId:    String(o.sport?.id || 'sr:sport:1'),
          matchKey:   `${o.eventId}|${marketId}|${specifier}|${outcomeId}`,
        });
        cnt++;
      }
      fetchLog[punter] = { code: codeStr, status: 'ok', picks: cnt };
      logger(`  ${punter} (${codeStr}): ${cnt} upcoming picks`);
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      fetchLog[punter] = { code: codeStr, status: 'error', error: e.message };
      logger(`  ${punter}: ERROR — ${e.message}`);
    }
  }

  if (allRaw.length < 3) {
    return { success: false, error: 'Not enough picks fetched. Check punter codes.', masterPool: [], fetchLog };
  }

  // ── Merge consensus picks (same matchKey from multiple punters) ─────────────
  const selMap = {};
  for (const s of allRaw) {
    if (!selMap[s.matchKey]) {
      selMap[s.matchKey] = { ...s, punters: [s.punter], codes: [s.code], count: 1 };
    } else {
      const e = selMap[s.matchKey];
      if (!e.punters.includes(s.punter)) { e.punters.push(s.punter); e.count++; }
      if (!e.codes.includes(s.code)) e.codes.push(s.code);
      // Keep highest-trust punter as primary
      const newEff = getPunterData(lbMap, profMap, s.punter).effTrust;
      const curEff = getPunterData(lbMap, profMap, e.punter).effTrust;
      if (newEff > curEff) { const saved = { punters: e.punters, codes: e.codes, count: e.count }; Object.assign(e, s, saved); }
    }
  }

  // ── Per-game deduplication: best market per event ──────────────────────────
  const gameMap = {}; // eventId → best pick for this game
  for (const s of Object.values(selMap)) {
    const safety = marketSafety(s.marketName, s.specifier, s.outcomeName);
    s._safety = safety;
    s._score  = safety < 0 ? -1 : masterScore(s, deps);
    if (!gameMap[s.eventId] || s._score > gameMap[s.eventId]._score) {
      gameMap[s.eventId] = s;
    }
  }

  // ── MARKET CONVERSION (v7): convert risky markets to safer alternatives ─────
  // Never invent conversions. Only: Over3.5→Over2.5/1.5, Over2.5→Over1.5,
  // GG→Over1.5, HomeWin→DC/DNB, AwayWin→DC/DNB. If no safe alt → REMOVE.
  const conversionCandidates = Object.values(gameMap).filter(s => {
    if (s._score < 0) return false;
    const risk = classifyRisk(s.marketName, s.specifier, s.outcomeName);
    return risk !== 'OK' && risk !== 'REMOVE';
  });

  if (conversionCandidates.length > 0) {
    logger(`Market conversion: checking ${conversionCandidates.length} picks for safer alternatives…`);
    for (const s of conversionCandidates) {
      try {
        const j = await sbGetEvent(s.eventId);
        if (!j || j.bizCode !== 10000 || !j.data) { s._score = -1; continue; }
        const avail = (j.data.markets || []).flatMap(m =>
          (m.outcomes || []).filter(o => o.isActive === 1).map(o => ({
            marketId: m.id, marketName: m.desc || '', specifier: m.specifier || '',
            outcomeId: o.id, outcomeName: o.desc || '', odds: parseFloat(o.odds) || 0,
            productId: m.product || 3,
          }))
        );
        const risk = classifyRisk(s.marketName, s.specifier, s.outcomeName);
        const convTypes = SAFE_CONVERSIONS[risk] || [];
        let converted = false;
        for (const cType of convTypes) {
          const alt = findSafeMarket(avail, cType);
          if (!alt) continue;
          const newSafety = marketSafety(alt.marketName, alt.specifier, alt.outcomeName);
          // Validation gate:
          if (newSafety < 0) continue;                    // alt is itself unsafe
          if (newSafety <= s._safety) continue;           // no safety improvement
          if (alt.odds <= 1.01 || alt.odds > 9) continue; // odds out of range
          if (/^\d+$/.test((alt.outcomeName || '').trim()) && (alt.marketName || '').toLowerCase().includes('goal bounds')) continue; // bare digit Goal Bounds
          const oldNote = `${s.marketName}: ${s.outcomeName} @${s.odds}`;
          s.marketId   = String(alt.marketId);
          s.marketName = alt.marketName;
          s.specifier  = alt.specifier || '';
          s.outcomeId  = String(alt.outcomeId);
          s.outcomeName = alt.outcomeName;
          s.odds       = alt.odds;
          s.productId  = alt.productId || 3;
          s.matchKey   = `${s.eventId}|${s.marketId}|${s.specifier}|${s.outcomeId}`;
          s._safety    = newSafety;
          s._score     = masterScore(s, deps);
          s._converted = true;
          s._conversionNote = `${oldNote} → ${alt.marketName}: ${alt.outcomeName}`;
          logger(`  ✓ Converted: ${s.homeTeam} vs ${s.awayTeam} — ${s._conversionNote}`);
          converted = true;
          break;
        }
        if (!converted) {
          s._score = -1;
          logger(`  ✗ Removed: ${s.homeTeam} vs ${s.awayTeam} — ${s.marketName}: ${s.outcomeName} (no safe conversion)`);
        }
        await new Promise(r => setTimeout(r, 100));
      } catch(e) {
        s._score = -1;
      }
    }
  }

  // ── Build master pool ───────────────────────────────────────────────────────
  const masterPool = [];
  const excluded   = [];

  for (const s of Object.values(gameMap)) {
    if (s._score < 0) {
      excluded.push({ game: `${s.homeTeam} vs ${s.awayTeam}`, league: s.league, reason: `Hard-removed market: ${s.marketName}`, score: s._score });
      continue;
    }
    if (s._score < 42) {
      excluded.push({ game: `${s.homeTeam} vs ${s.awayTeam}`, league: s.league, reason: `Confidence too low (${s._score})`, market: `${s.marketName} @${s.odds}` });
      continue;
    }

    // Killer event warning (appeared in any historical report)
    const killerKey = `${s.homeTeam}|${s.awayTeam}`;
    const killerWarning = killerEvents.has(killerKey)
      ? `⚠️ This game caused losses in historical data`
      : null;

    const pd = getPunterData(lbMap, profMap, s.punter);
    masterPool.push({
      eventId: s.eventId, homeTeam: s.homeTeam, awayTeam: s.awayTeam,
      league: s.league, category: s.category,
      kickoff: s.kickoff, kick: s.kick,
      marketId: s.marketId, marketName: s.marketName,
      specifier: s.specifier, outcomeId: s.outcomeId, outcomeName: s.outcomeName,
      odds: s.odds, productId: s.productId, sportId: s.sportId,
      punter: s.punter, punters: s.punters, codes: s.codes,
      count: s.count, matchKey: s.matchKey,
      confidence: Math.min(100, Math.max(0, s._score)),
      safety: s._safety,
      originalOdds: s.odds,
      killerWarning,
      converted: s._converted || false,
      conversionNote: s._conversionNote || null,
      punterTier: pd.tier,
      punterFormScore: pd.formScore,
      leagueTier: leagueTier(s.league, leagueIntel),
      // Labels for UI
      punterLabel:  s.punters.join(', '),
      countLabel:   s.count >= 3 ? `★${s.count}` : s.count >= 2 ? `·${s.count}` : '',
      marketLabel:  `${s.marketName}${s.specifier ? ' ' + s.specifier : ''} → ${s.outcomeName}`,
    });
  }

  masterPool.sort((a, b) => b.confidence - a.confidence);

  // ── Punter performance summary ─────────────────────────────────────────────
  const punterSummary = {};
  for (const [name] of Object.entries(punterMap)) {
    if (!name || name.startsWith('_')) continue;
    const pd = getPunterData(lbMap, profMap, name);
    punterSummary[name] = {
      effTrust: pd.effTrust,
      hrAll: pd.hrAll,
      hr7: pd.hr7,
      hr3: pd.hr3,
      formScore: pd.formScore,
      ff: pd.ff,
      tier: pd.tier,
      composite: pd.composite,
      code: punterMap[name],
      pickCount: masterPool.filter(s => s.punters.includes(name)).length,
      tag: pd.tier === 'ELITE' ? '★ ELITE' : pd.tier === 'RELIABLE' ? '✓ RELIABLE' : pd.tier === 'COLD' ? '▼ COLD' : pd.tier === 'EXPERIMENTAL' ? '? EXP' : '◆ SIT',
    };
  }

  // ── Cache to disk ──────────────────────────────────────────────────────────
  const analysis = {
    date: today,
    generatedAt: new Date().toISOString(),
    version: 6,
    poolSize: masterPool.length,
    excludedCount: excluded.length,
    fetchLog, punterSummary,
    masterPool,
    excluded: excluded.slice(0, 30),
    stats: {
      uniqueGames: new Set(allRaw.map(s => s.eventId)).size,
      totalPicks: allRaw.length,
      topLeagues: (() => {
        const lc = {};
        masterPool.forEach(s => { lc[s.league] = (lc[s.league] || 0) + 1; });
        return Object.entries(lc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([l,n])=>({league:l,count:n}));
      })(),
      avgConfidence: masterPool.length ? Math.round(masterPool.reduce((s,p)=>s+p.confidence,0)/masterPool.length) : 0,
      consensusCount: masterPool.filter(s => s.count >= 2).length,
      topConsensus:   masterPool.filter(s => s.count >= 3).length,
    },
  };

  try { fs.writeFileSync(POOL_FILE, JSON.stringify(analysis, null, 2)); }
  catch(e) { logger(`Warning: Could not save master pool: ${e.message}`); }

  logger(`✓ Master pool: ${masterPool.length} games eligible, ${excluded.length} excluded`);
  return { success: true, ...analysis };
}

// ─── GET MASTER POOL ──────────────────────────────────────────────────────────
/**
 * Returns today's cached master pool, or null if stale.
 * maxAgeMinutes: how old the cache is allowed to be (default 120 min)
 */
function getMasterPool(maxAgeMinutes = 120) {
  try {
    const raw = safeJSON(POOL_FILE, null);
    if (!raw) return null;
    if (raw.date !== localToday()) return null;
    const ageMs = Date.now() - new Date(raw.generatedAt).getTime();
    if (ageMs > maxAgeMinutes * 60000) return null;
    return raw;
  } catch { return null; }
}

// ─── THEMED CODE BUILDER ──────────────────────────────────────────────────────
function blendSort(w) {
  return (a, b) =>
    (b.confidence * w + Math.log(b.odds + 0.01) * 20 * (1 - w)) -
    (a.confidence * w + Math.log(a.odds + 0.01) * 20 * (1 - w));
}

// ─── BOOKING CODE BUILDER v8 — 30-code portfolio engine ──────────────────────
//
// Each match appears at most DIVERSITY_CAP times across all generated codes.
// Themes are ordered so high-quality themes run first (they get first pick).
// Dynamic punter special themes are appended at runtime from the pool's top punters.
const DIVERSITY_CAP = 3;

// ── Market category testers ───────────────────────────────────────────────────
function _isDC(p)    { const mn=(p.marketName||'').toLowerCase(); return mn.includes('double chance')&&!mn.includes('goal')&&!mn.includes('over')&&!mn.includes('under'); }
function _isDNB(p)   { const mn=(p.marketName||'').toLowerCase(); return mn.includes('draw no bet')||mn.includes('home no draw'); }
function _isGB(p)    { const mn=(p.marketName||'').toLowerCase(),on=(p.outcomeName||'').toLowerCase(); return mn.includes('goal bounds')&&!(/^\d+$/.test(on.trim())); }
function _isO15(p)   { const mn=(p.marketName||'').toLowerCase(),on=(p.outcomeName||'').toLowerCase(),sp=p.specifier||''; if(!mn.includes('over/under')&&!mn.includes('2nd half'))return false; if(!on.includes('over'))return false; const line=getLine(p.marketName,sp,p.outcomeName); return Math.abs(line-1.5)<0.1; }
function _isSafe(p)  { return _isDC(p)||_isDNB(p)||_isGB(p)||_isO15(p)||(p.safety>=80); }
function _isScand(p) { return /allsvenskan|superettan|ykkosliiga|premium liiga|ii lyga|esiliiga|eliteserien|virsliga|ykkonen|kakkonen|suomen cup/i.test(p.league||''); }
function _isNordic(p){ return _isScand(p)||/premier division.*ire|premier division.*nir|icelandic/i.test(p.league||''); }
function _isEur(p)   { return /premier league|bundesliga|serie a|ligue 1|eredivisie|champions league|europa league|conference league|la liga/i.test(p.league||''); }
function _isAmer(p)  { return /brasileiro|serie [abc]|argentino|mls|usl|primera division|apertura|clausura|superliga argentina|colombiano|peruano|venezolano/i.test(p.league||'')||/brazil|argentina|colombia|chile|peru|mexico|usa|canada/i.test(p.category||''); }

// ── Time bucket helpers (evaluated at call time — always uses current moment) ──
function _isEarly(p)  { return p.kick > 0 && p.kick < Date.now() + 12 * 3600000; }
function _isLate(p)   { const n=Date.now(); return p.kick > n+12*3600000 && p.kick <= n+32*3600000; }
function _isLater(p)  { return p.kick > 0 && p.kick > Date.now() + 32 * 3600000; }

// ── Slip builder ──────────────────────────────────────────────────────────────
function buildOneSlip(candidates, { minOdds=1000, maxGames=25, punterCap=0.38, maxPerLeague=6, leagueCapPct=0.22, globalPickCount={} } = {}) {
  const seenEvent = new Set(), picks = [], punterCnt = {}, leagueCnt = {};
  let total = 1;
  for (const s of candidates) {
    if (seenEvent.has(s.eventId)) continue;
    if (picks.length >= maxGames) break;
    if ((globalPickCount[s.matchKey] || 0) >= DIVERSITY_CAP) continue;
    const leagueLim = Math.min(maxPerLeague, Math.max(4, Math.floor((maxGames || 25) * leagueCapPct)));
    if ((leagueCnt[s.league] || 0) >= leagueLim) continue;
    const pp = s.punter;
    if (punterCap < 1.0 && picks.length >= 8) {
      const proj = ((punterCnt[pp] || 0) + 1) / (picks.length + 1);
      if (proj > punterCap) continue;
    }
    seenEvent.add(s.eventId);
    picks.push(s);
    total *= s.odds;
    punterCnt[pp] = (punterCnt[pp] || 0) + 1;
    leagueCnt[s.league] = (leagueCnt[s.league] || 0) + 1;
    if (total >= minOdds) break;
  }
  return { picks, odds: Math.round(total * 100) / 100 };
}

function blendSort(w) {
  return (a, b) =>
    (b.confidence * w + Math.log(b.odds + 0.01) * 20 * (1 - w)) -
    (a.confidence * w + Math.log(a.odds + 0.01) * 20 * (1 - w));
}

async function generateCode(picks, logger) {
  if (picks.length < 3) return null;
  const payload = picks.map(s => ({
    eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
    specifier: s.specifier || '', productId: parseInt(s.productId) || 3, sportId: s.sportId || '',
  }));
  try {
    const r = await sbPost(payload);
    if (r.bizCode === 10000 && r.data?.shareCode) return r.data.shareCode;
    return null;
  } catch(e) { logger && logger(`Code gen error: ${e.message}`); return null; }
}

// ── Static theme definitions (28 themes) ─────────────────────────────────────
// Ordered by priority: safest/highest-confidence themes run first.
// Dynamic punter specials (up to 4) are appended at runtime → total ~32, target 30.
const STATIC_THEMES = [
  // ── ULTRA SAFE (6) — DC / DNB / O1.5 / GB only ──────────────────────────
  { name:'Safe Platinum',    label:'S★', sortW:0.88, minOdds:500,   maxGames:22, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isSafe(p)&&p.confidence>=80 },
  { name:'Safe Gold',        label:'S+', sortW:0.82, minOdds:1000,  maxGames:25, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isSafe(p)&&p.confidence>=72 },
  { name:'Safe Today',       label:'S+', sortW:0.80, minOdds:500,   maxGames:22, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isSafe(p)&&_isEarly(p)&&p.confidence>=68 },
  { name:'Safe Late',        label:'S',  sortW:0.78, minOdds:300,   maxGames:20, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isSafe(p)&&(_isLate(p)||_isLater(p))&&p.confidence>=68 },
  { name:'Safe Consensus',   label:'S+', sortW:0.82, minOdds:800,   maxGames:22, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isSafe(p)&&p.count>=2&&p.confidence>=65 },
  { name:'Pure DC',          label:'S',  sortW:0.84, minOdds:20,    maxGames:18, maxPerLeague:5, punterCap:0.40, filterFn: p=>(_isDC(p)||_isDNB(p))&&p.confidence>=62 },

  // ── CONSENSUS (4) — multi-punter agreement ────────────────────────────────
  { name:'Consensus 3+',     label:'A★', sortW:0.76, minOdds:1000,  maxGames:20, maxPerLeague:5, punterCap:0.38, filterFn: p=>p.count>=3 },
  { name:'Consensus Alpha',  label:'A+', sortW:0.72, minOdds:1000,  maxGames:24, maxPerLeague:6, punterCap:0.38, filterFn: p=>p.count>=2&&p.confidence>=68 },
  { name:'Consensus Beta',   label:'A+', sortW:0.66, minOdds:2000,  maxGames:28, maxPerLeague:6, punterCap:0.38, filterFn: p=>p.count>=2 },
  { name:'Consensus Safe',   label:'A+', sortW:0.80, minOdds:800,   maxGames:22, maxPerLeague:5, punterCap:0.38, filterFn: p=>p.count>=2&&_isSafe(p) },

  // ── MARKET PURITY (4) — single-market theme codes ────────────────────────
  { name:'Pure Over 1.5',    label:'B+', sortW:0.74, minOdds:500,   maxGames:22, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isO15(p)&&p.confidence>=70 },
  { name:'Over 1.5 Wide',    label:'B+', sortW:0.66, minOdds:2000,  maxGames:28, maxPerLeague:6, punterCap:0.40, filterFn: p=>_isO15(p) },
  { name:'Goal Bounds+',     label:'B+', sortW:0.70, minOdds:1000,  maxGames:26, maxPerLeague:6, punterCap:0.40, filterFn: p=>_isGB(p)||(_isO15(p)&&p.confidence>=75) },
  { name:'Short Odds Safe',  label:'S',  sortW:0.90, minOdds:20,    maxGames:16, maxPerLeague:4, punterCap:0.38, filterFn: p=>p.odds>=1.1&&p.odds<=1.65&&p.confidence>=75 },

  // ── TIME-BASED (3) — different kickoff windows ────────────────────────────
  { name:'Early Kickoffs',   label:'B+', sortW:0.72, minOdds:1000,  maxGames:24, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isEarly(p)&&p.confidence>=70 },
  { name:'Late Kickoffs',    label:'B+', sortW:0.70, minOdds:1000,  maxGames:22, maxPerLeague:5, punterCap:0.38, filterFn: p=>(_isLate(p)||_isLater(p))&&p.confidence>=70 },
  { name:'Full Day',         label:'A',  sortW:0.68, minOdds:2000,  maxGames:28, maxPerLeague:6, punterCap:0.38, filterFn: p=>p.confidence>=70 },

  // ── LEAGUE CLUSTERS (4) ───────────────────────────────────────────────────
  { name:'Nordic Alpha',     label:'A',  sortW:0.70, minOdds:1000,  maxGames:26, maxPerLeague:7, punterCap:0.42, filterFn: p=>_isNordic(p)&&p.confidence>=65 },
  { name:'Nordic Safe',      label:'A+', sortW:0.76, minOdds:500,   maxGames:22, maxPerLeague:6, punterCap:0.40, filterFn: p=>_isNordic(p)&&_isSafe(p) },
  { name:'European Elite',   label:'A',  sortW:0.74, minOdds:1000,  maxGames:22, maxPerLeague:5, punterCap:0.38, filterFn: p=>_isEur(p)&&p.confidence>=68 },
  { name:'Global Mix',       label:'B',  sortW:0.65, minOdds:2000,  maxGames:28, maxPerLeague:6, punterCap:0.40, filterFn: p=>(_isAmer(p)||_isNordic(p)||_isEur(p))&&p.confidence>=65 },

  // ── PORTFOLIO / RISK LEVELS (4) ───────────────────────────────────────────
  { name:'Portfolio Conservative', label:'S+', sortW:0.84, minOdds:200,   maxGames:18, maxPerLeague:4, punterCap:0.36, filterFn: p=>p.confidence>=80&&p.odds<=2.0 },
  { name:'Portfolio Balanced',     label:'A',  sortW:0.58, minOdds:5000,  maxGames:28, maxPerLeague:6, punterCap:0.38, filterFn: p=>p.confidence>=65 },
  { name:'AI Portfolio Alpha',     label:'A+', sortW:0.62, minOdds:3000,  maxGames:26, maxPerLeague:6, punterCap:0.38,
    filterFn: p=>p.confidence>=68,
    sortFnOverride: (a,b) => {
      const wa=(_isSafe(a)?6:0)+(_isNordic(a)?4:0)+(a.count>=2?8:0)+(a.confidence>=80?5:0);
      const wb=(_isSafe(b)?6:0)+(_isNordic(b)?4:0)+(b.count>=2?8:0)+(b.confidence>=80?5:0);
      return(b.confidence*0.56+(wb)*2.5+Math.log(b.odds+.01)*14)-(a.confidence*0.56+(wa)*2.5+Math.log(a.odds+.01)*14);
    }
  },
  { name:'AI Portfolio Beta',      label:'A+', sortW:0.54, minOdds:5000,  maxGames:30, maxPerLeague:7, punterCap:0.40,
    filterFn: p=>p.confidence>=62,
    sortFnOverride: (a,b) => {
      const wa=(_isSafe(a)?5:0)+(_isNordic(a)?3:0)+(a.count>=2?6:0);
      const wb=(_isSafe(b)?5:0)+(_isNordic(b)?3:0)+(b.count>=2?6:0);
      return(b.confidence*0.50+(wb)*2+Math.log(b.odds+.01)*18)-(a.confidence*0.50+(wa)*2+Math.log(a.odds+.01)*18);
    }
  },

  // ── BOOMSHOTS (3) — high-game-count, high-odds targets ───────────────────
  // ownDiversityPool:true means boomshots get their own counter so they aren't
  // blocked by the global diversity cap from earlier themes.
  { name:'Balanced Boomshot', label:'B',  sortW:0.42, minOdds:50000,  maxGames:34, minGames:14, maxPerLeague:8, punterCap:0.42, ownDiversityPool:true, filterFn: p=>p.confidence>=60 },
  { name:'Boomshot Alpha',    label:'C+', sortW:0.32, minOdds:100000, maxGames:40, minGames:18, maxPerLeague:9, punterCap:0.44, ownDiversityPool:true, filterFn: p=>p.confidence>=55 },
  { name:'Mega Boomshot',     label:'C',  sortW:0.22, minOdds:500000, maxGames:48, minGames:22, maxPerLeague:11,punterCap:0.46, ownDiversityPool:true, filterFn: p=>p.confidence>=48 },
];

/**
 * Build up to 30 themed codes from masterPool.
 * Dynamic per-punter specials are appended to the static theme list at runtime.
 * Global diversity cap (DIVERSITY_CAP) prevents any match appearing in too many codes.
 */
async function buildThemedCodes(masterPool, logger = ()=>{}) {
  // ── Rank punters by average confidence of their contributions to today's pool
  const punterScores = {};
  for (const s of masterPool) {
    for (const p of (s.punters || [s.punter])) {
      if (!p) continue;
      if (!punterScores[p]) punterScores[p] = { total: 0, count: 0 };
      punterScores[p].total += s.confidence;
      punterScores[p].count++;
    }
  }
  const topPunters = Object.entries(punterScores)
    .filter(([, d]) => d.count >= 5)
    .sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count))
    .slice(0, 4)
    .map(([p]) => p);

  // Dynamic punter special themes — unique pick profile per top punter
  const punterThemes = topPunters.map((pName, i) => ({
    name: `${pName} Special`,
    label: 'A+',
    sortW: 0.86,
    minOdds: 1000,
    maxGames: 20,
    maxPerLeague: 5,
    punterCap: 1.0, // single-punter slip — diversity via league cap instead
    filterFn: p => (p.punters || [p.punter]).includes(pName) && p.confidence >= 65,
  }));

  const ALL_THEMES = [...STATIC_THEMES, ...punterThemes];
  logger(`Building ${ALL_THEMES.length} themes → targeting 30 codes from ${masterPool.length}-game pool (diversity cap: ${DIVERSITY_CAP}×)…`);

  const results = [];
  const globalPickCount = {};
  const generatedCodes = new Set(); // dedup — SportyBet returns same code for identical selections

  for (const theme of ALL_THEMES) {
    if (results.length >= 30) {
      logger(`  [${theme.name}] SKIPPED — 30 codes reached`);
      continue;
    }

    const sortFn = theme.sortFnOverride || blendSort(theme.sortW);
    const core = masterPool.filter(theme.filterFn).sort(sortFn);

    // Boomshots use their own fresh diversity pool so they aren't blocked by earlier themes
    const pickCountForTheme = theme.ownDiversityPool ? {} : globalPickCount;
    const slipOpts = {
      minOdds: theme.minOdds,
      maxGames: theme.maxGames,
      punterCap: theme.punterCap,
      maxPerLeague: theme.maxPerLeague,
      leagueCapPct: 0.22,
      globalPickCount: pickCountForTheme,
    };

    let { picks, odds } = buildOneSlip(core, slipOpts);
    let borrowed = 0;

    // Fallback: blend with lower-confidence pool when core is thin after diversity cap
    if (picks.length < 4) {
      const usedIds = new Set(picks.map(p => p.eventId));
      const fill = masterPool
        .filter(s => !theme.filterFn(s) && s.confidence >= 55 && !usedIds.has(s.eventId))
        .sort(blendSort(Math.max(0.28, (theme.sortW || 0.50) - 0.12)));
      const merged = [...core, ...fill];
      const r2 = buildOneSlip(merged, slipOpts);
      if (r2.picks.length > picks.length) {
        borrowed = r2.picks.filter(p => !picks.some(c => c.eventId === p.eventId)).length;
        picks = r2.picks; odds = r2.odds;
      }
    }

    const minGames = theme.minGames || 3;
    if (picks.length < minGames) {
      logger(`  [${theme.name}] SKIPPED — only ${picks.length} eligible picks (need ${minGames})`);
      continue;
    }

    // Register picks in diversity counter before posting (blocks later themes from overusing same games)
    for (const p of picks) {
      globalPickCount[p.matchKey] = (globalPickCount[p.matchKey] || 0) + 1;
    }

    const oddsStr = odds>=1e6?(odds/1e6).toFixed(2)+'M':odds>=1e3?(odds/1e3).toFixed(2)+'K':Math.round(odds)+'x';
    logger(`  [${theme.name}] ${picks.length}g ${oddsStr} — posting…`);
    const code = await generateCode(picks, logger);
    await new Promise(r => setTimeout(r, 400));

    if (!code) { logger(`  [${theme.name}] Code generation failed`); continue; }
    if (generatedCodes.has(code)) { logger(`  [${theme.name}] SKIPPED — duplicate code ${code}`); continue; }
    generatedCodes.add(code);

    // Build breakdown metrics
    const leagueBreakdown = {}, punterBreakdown = {};
    picks.forEach(p => { leagueBreakdown[p.league]=(leagueBreakdown[p.league]||0)+1; });
    picks.forEach(p => { (p.punters||[p.punter]).forEach(pt => { if(pt) punterBreakdown[pt]=(punterBreakdown[pt]||0)+1; }); });
    const mkts = new Set(picks.map(p => {
      const mn=(p.marketName||'').toLowerCase();
      if(mn.includes('double chance')) return 'DC';
      if(mn.includes('draw no bet')||mn.includes('home no draw')) return 'DNB';
      if(mn.includes('goal bounds')) return 'GBounds';
      if(mn.includes('both halves')) return 'BHalves';
      if(mn.includes('over/under')||mn.includes('2nd half')) return 'O/U';
      if(mn.includes('gg')) return 'BTTS';
      return 'Other';
    }));
    const timeGroups = { early:0, late:0, later:0 };
    picks.forEach(p => { if(_isEarly(p))timeGroups.early++; else if(_isLate(p))timeGroups.late++; else timeGroups.later++; });

    results.push({
      theme: theme.name, label: theme.label, code,
      count: picks.length, games: picks.length, odds, borrowed,
      targetOdds: theme.minOdds,
      hitTarget: odds >= theme.minOdds,
      avgConfidence: Math.round(picks.reduce((s,p)=>s+p.confidence,0)/picks.length),
      minConfidence: Math.min(...picks.map(p=>p.confidence)),
      markets: [...mkts].join(' | '),
      timeSpread: `E:${timeGroups.early} L:${timeGroups.late} D+:${timeGroups.later}`,
      topLeagues: Object.entries(leagueBreakdown).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([l,n])=>`${l}(${n})`).join(', '),
      topPunters: Object.entries(punterBreakdown).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([p,n])=>`${p}(${n})`).join(', '),
      topPicks: picks.slice(0,4).map(p=>`${p.homeTeam} vs ${p.awayTeam} — ${p.marketLabel} @${p.odds}`),
      diversity: Object.keys(leagueBreakdown).length*3 + mkts.size*5 + Object.keys(punterBreakdown).length*2,
      picks,
    });

    logger(`  ✓ ${theme.name}: ${code} | ${picks.length}g | ${oddsStr}${borrowed>0?` (+${borrowed} borrowed)`:''}`);
  }

  logger(`\n✓ Generated ${results.length}/${ALL_THEMES.length} codes.`);
  return results;
}

// ─── SCORE MANUAL SELECTIONS ──────────────────────────────────────────────────
/**
 * Score a list of manually provided selections using full intelligence.
 * Returns each selection enriched with confidence + suggestions.
 */
function scoreSelections(selections) {
  const leagueIntel = safeJSON(LEAGUE_FILE, {});
  const marketIntel = safeJSON(MARKET_FILE, {});
  const teamIntel   = safeJSON(TEAM_FILE, {});
  const specMap     = safeJSON(SPEC_FILE, {});
  const profMap     = safeJSON(PROF_FILE, {});
  const weakMatches = safeJSON(WEAK_FILE, {});
  const lb          = safeJSON(LB_FILE, []);
  const lbMap       = new Map(lb.map(p => [p.punter, p]));
  const selHistory  = safeJSON(path.join(DATA, 'selection-history.json'), {});
  const deps        = { lbMap, profMap, specMap, leagueIntel, marketIntel, teamIntel, selHistory, weakMatches };

  const pool = getMasterPool(240); // allow up to 4h stale for manual scoring

  return selections.map(s => {
    // First check if event is in today's master pool (use pre-computed confidence)
    const poolEntry = pool?.masterPool?.find(p => p.eventId === s.eventId);
    if (poolEntry && poolEntry.marketName === (s.market || s.marketName)) {
      return { ...s, confidence: poolEntry.confidence, safety: poolEntry.safety, fromMasterPool: true };
    }

    // Otherwise score fresh
    const norm = { ...s, marketName: s.market || s.marketName, outcomeName: s.outcome || s.outcomeName };
    const safety = marketSafety(norm.marketName, norm.specifier, norm.outcomeName);
    if (safety < 0) return { ...s, confidence: 0, safety: -1, warning: 'Market removed — too risky' };
    const conf = masterScore(norm, deps);

    // Market suggestions
    const suggestions = [];
    if (safety < 65) {
      const mn = (norm.marketName || '').toLowerCase();
      if (mn === 'match winner' || mn === '1x2') suggestions.push({ market:'Double Chance', reason:'DC is 30% safer than 1X2 historically' });
      if (mn.includes('over/under')) {
        const line = parseFloat((norm.specifier||'').replace('total=','').replace(/[^0-9.]/g,'') || '2.5');
        if (line >= 3.5) suggestions.push({ market:`Over/Under (2.5)`, reason:`Over ${line} is risky — Over 2.5 has 77% hit rate` });
        if (line >= 2.5) suggestions.push({ market:`Over/Under (1.5)`, reason:`Over 1.5 has 87% hit rate vs ${line} line` });
      }
    }

    return { ...s, confidence: Math.max(0, conf), safety, suggestions };
  });
}

// ─── X ASSISTANT CONTEXT ──────────────────────────────────────────────────────
/**
 * Returns rich context for X Assistant captions and analysis posts.
 * Combines today's master pool + yesterday's match report.
 */
function getXContext() {
  const pool = getMasterPool(480); // allow up to 8h stale
  const today = localToday();
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  let report = null;
  try { report = safeJSON(path.join(REPORTS_DIR, `${yesterday}.json`), null); } catch {}
  if (!report) {
    try { report = safeJSON(path.join(REPORTS_DIR, `${today}.json`), null); } catch {}
  }

  const ctx = {
    today, yesterday,
    hasPool: !!pool,
    hasReport: !!report,

    // Today's top picks
    topPicks: (pool?.masterPool || []).slice(0, 5).map(p => ({
      game: `${p.homeTeam} vs ${p.awayTeam}`,
      league: p.league,
      market: p.marketLabel,
      odds: p.odds,
      confidence: p.confidence,
      consensus: p.count,
    })),

    // Yesterday's analysis
    biggestKiller: null,
    biggestWin: null,
    topPunterYday: null,
    worstPunterYday: null,
    bestLeagueYday: null,
    worstLeagueYday: null,
    bestMarketYday: null,
    hitRateYday: null,
  };

  if (report?.analysis) {
    const a = report.analysis;
    if (a.ticketKillers?.length) {
      const tk = a.ticketKillers[0];
      ctx.biggestKiller = {
        game: tk.match,
        league: tk.league,
        punterCount: tk.punterCount,
        market: tk.selections?.[0]?.market,
        outcome: tk.selections?.[0]?.outcome,
      };
    }
    if (a.consensusWins?.length) {
      const cw = a.consensusWins[0];
      ctx.biggestWin = { game: cw.match, punterCount: cw.punterCount, market: cw.selections?.[0]?.market };
    }
    const pStats = Object.values(a.punterStats || {}).filter(p => p.won + p.lost >= 3).sort((x,y) => y.hitRate - x.hitRate);
    if (pStats.length) { ctx.topPunterYday = pStats[0]; ctx.worstPunterYday = pStats[pStats.length-1]; }
    const lgs = Object.values(a.leagueWatch || {}).filter(l => l.won + l.lost >= 3);
    lgs.sort((x,y)=>y.hitRate-x.hitRate);
    if (lgs.length) { ctx.bestLeagueYday = lgs[0]; ctx.worstLeagueYday = lgs[lgs.length-1]; }
    const mkts = Object.values(a.marketWatch || {}).filter(m => m.won + m.lost >= 3);
    mkts.sort((x,y)=>y.hitRate-x.hitRate);
    if (mkts.length) ctx.bestMarketYday = mkts[0];
    ctx.hitRateYday = a.totals?.hitRate || null;
    ctx.totalsYday  = a.totals;
  }

  return ctx;
}

module.exports = { runAnalysis, getMasterPool, buildThemedCodes, scoreSelections, getXContext, marketSafety, masterScore, classifyRisk, findSafeMarket, getLine, leagueTier, getPunterData };
