/**
 * intelligence-engine.js — SlipPilot Unified Intelligence Engine v6
 *
 * ONE source of truth for confidence scores.
 * Every feature (Smart Slips, Booking Codes, Optimizer, X Assistant,
 * Manual Converter) reads the master pool produced here.
 *
 * Exported functions:
 *   runAnalysis(punterMap, logger, fetchH2H) → builds + caches master pool
 *     fetchH2H(eventId, home, away, pick) is optional — when passed (see
 *     getH2HStats in server.js), masterScore's scoring for every pick now
 *     factors in real head-to-head data, not just league/market/consensus.
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

function marketSafety(marketName, specifier, outcomeName, homeTeam, awayTeam) {
  const mn = (marketName || '').toLowerCase();
  const on = (outcomeName || '').toLowerCase();
  // Per-team total-goals markets ("Arsenal Over/Under total=0.5") are NOT the
  // full-match version of that market — a single team scoring is a different,
  // generally lower-probability event than the match as a whole. The safety
  // table below is calibrated from full-match historical hit-rates, so a
  // team-scoped market must never borrow that calibration. Hard-reject.
  if (isTeamScopedMarket(marketName, homeTeam, awayTeam)) return -1;
  for (const p of HARD_REMOVE_PATTERNS) { if (mn.includes(p) || on.includes(p)) return -1; }

  // Combo/synthetic markets — hard remove
  if (mn.includes('double chance') && (mn.includes('over') || mn.includes('under'))) return -1;
  if (mn.includes(' or over') || mn.includes(' or under')) return -1;  // "Away or Over 2.5" type
  if ((mn.includes(' and ') || mn.includes(' & ')) && (mn.includes('over') || mn.includes('under') || mn.includes('goal'))) return -1;
  // BTTS mislabeled as Over/Under (feed glitch): outcome 'Yes' tagged inside an over/under market
  if (on === 'yes' && mn.includes('over/under')) return -1;
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
  // Basketball O/U is a SportyBet artefact market on football matches — hard remove
  if (mn.includes('basketball') || mn.includes('basketball o/u')) return -1;
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
  // Either-half straight result (1st/2nd Half Home or Away, or "Team to Win Either Half") —
  // no draw-safe equivalent per half, so fold into the full-match Over 1 goals market instead.
  if ((m.includes('1st half') || m.includes('2nd half')) && !m.includes('over/under')) {
    if (o === 'home' || o === '1' || (o.startsWith('home') && !o.includes('or'))) return 'HALF_WIN';
    if (o === 'away' || o === '2' || (o.startsWith('away') && !o.includes('or'))) return 'HALF_WIN';
  }
  if (m.includes('either half')) return 'HALF_WIN';
  if (m.includes('gg/ng') && (o.includes('yes') || o.includes('gg'))) return 'GG_YES';
  // A half only has ~45 minutes to produce goals, so a half-based Over line is
  // calibrated well below its full-match equivalent (see marketSafety) even
  // though it "looks" like the same bet — always prefer the full-match version.
  if ((m.includes('1st half') || m.includes('2nd half')) && m.includes('over/under') && o.includes('over')) {
    return 'HALF_OVER';
  }
  // "Both Halves Under X" implies a low-scoring match overall — a full-match
  // Under line (with a bit of cushion) captures nearly the same probability
  // more reliably than the narrower both-halves condition.
  if (m.includes('both halves') && (o.includes('under') || o.includes('no'))) {
    return 'BOTH_HALVES_UNDER';
  }
  // Over lines — only full-match over/under; 1st half handled just above
  if (m.includes('over/under') && !m.includes('1st half') && !m.includes('2nd half') && o.includes('over')) {
    const line = getLine(mn, sp, on);
    if (line >= 4.5) return 'OVER_4.5';
    if (line >= 3.5) return 'OVER_3.5';
    if (line >= 2.5) return 'OVER_2.5';
    // Over 2 is now an accepted safe target (see SAFE_CONVERSIONS) — no conversion needed below it.
  }
  return 'OK';
}

// Safe conversion chains: risky market → safer alternatives to try in order
// User rules: Over3.5→Over2, Over2.5→Over1, GG→Over1.5, HomeWin/AwayWin→Double Chance,
// either-half Home/Away→Over1 (full match).
const SAFE_CONVERSIONS = {
  'HOME_WIN': ['DC_1X', 'DNB_HOME'],
  'AWAY_WIN': ['DC_X2', 'DNB_AWAY'],
  'DRAW':     ['DC_1X', 'DC_X2'],
  'GG_YES':   ['OVER_1.5', 'GOAL_BOUNDS_RANGE'],
  'HALF_WIN': ['OVER_1'],
  'HALF_OVER': ['OVER_1.5', 'OVER_2'],
  'BOTH_HALVES_UNDER': ['UNDER_3.5', 'UNDER_2.5'],
  'OVER_2.5': ['OVER_2', 'OVER_1.5', 'OVER_1'],
  'OVER_3.5': ['OVER_2'],
  'OVER_4.5': ['OVER_2', 'OVER_1'],
};

// A market whose name is prefixed with one of the two team names (SportyBet's
// per-team total-goals markets, e.g. "Rezeknes Fa/Bjss Over/Under") is NOT
// equivalent to the full-match version of that market — a single team scoring
// 2+ is a different (generally lower-probability) event than the match as a
// whole producing 2+ combined goals. The safety calibration table (marketSafety)
// was built from full-match historical hit-rates, so it must never be applied
// to a team-scoped market. Detected by name containment since SportyBet has no
// separate market-type flag for this.
function isTeamScopedMarket(marketName, homeTeam, awayTeam) {
  const mn = (marketName || '').toLowerCase().trim();
  const h = (homeTeam || '').toLowerCase().trim();
  const a = (awayTeam || '').toLowerCase().trim();
  return (h && mn.startsWith(h)) || (a && mn.startsWith(a));
}

// Find a safe alternative market from event's available markets
function findSafeMarket(avail, type, homeTeam, awayTeam) {
  for (const m of avail) {
    // Hard odds cap: nothing over 2.0 is ever offered as a "safer" alternative
    if (!m.odds || m.odds <= 1.01 || m.odds > 2.0) continue;
    if (isTeamScopedMarket(m.marketName, homeTeam, awayTeam)) continue;
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
      // NOTE: Over_X targets must be FULL-MATCH (90 min) over/under only — a half only
      // has ~45 min to produce goals, so "1st/2nd Half Over 1" is NOT a safe stand-in for
      // a full-match line. Team-scoped totals are filtered out above (isTeamScopedMarket).
      case 'OVER_1.5': {
        if (!mn.includes('over/under') || mn.includes('half')) break;
        if (!on.includes('over')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 1.5) < 0.1 && m.odds >= 1.1 && m.odds <= 2.0) return m;
        break;
      }
      case 'OVER_2.5': {
        if (!mn.includes('over/under') || mn.includes('half') || !on.includes('over')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 2.5) < 0.1 && m.odds >= 1.3 && m.odds <= 2.0) return m;
        break;
      }
      case 'OVER_2': {
        if (!mn.includes('over/under') || mn.includes('half')) break;
        if (!on.includes('over')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 2.0) < 0.1 && m.odds >= 1.1 && m.odds <= 2.0) return m;
        break;
      }
      case 'OVER_1': {
        if (!mn.includes('over/under') || mn.includes('half')) break;
        if (!on.includes('over')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 1.0) < 0.1 && m.odds >= 1.05 && m.odds <= 2.0) return m;
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
      // Under_X targets, same full-match-only rule as Over_X above.
      case 'UNDER_3.5': {
        if (!mn.includes('over/under') || mn.includes('half')) break;
        if (!on.includes('under')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 3.5) < 0.1 && m.odds >= 1.1 && m.odds <= 2.0) return m;
        break;
      }
      case 'UNDER_2.5': {
        if (!mn.includes('over/under') || mn.includes('half')) break;
        if (!on.includes('under')) break;
        const line = getLine(m.marketName, sp, m.outcomeName);
        if (Math.abs(line - 2.5) < 0.1 && m.odds >= 1.1 && m.odds <= 2.0) return m;
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
const VOLATILE_RE = /\b(reserves?|youth|u19|u20|u21|u23|u17|u16|friendl(?:y|ies)|pre-?season|virtual|carioca|mineiro|azadegan)\b/i;
// Women's leagues are filtered at pool-build time (before they reach confidence scoring)
const WOMEN_RE = /\b(women'?s?|female|ladies|girls|dames|frauen|femmes|femenin|femenino|feminino)\b/i;
// A reserve/youth SQUAD can compete in an otherwise normal senior division —
// VOLATILE_RE above only catches it when the whole LEAGUE is youth/reserve.
const TEAM_YOUTH_RE = /\bu1[6-9]\b|\bu2[0-3]\b|\breserves?\b|\byouth\b|\b(ii|2)$/i;
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
  // Reduced tierMult: was 1.12 for ELITE, causing all elite picks to score 99-100 (ceiling kills discriminating power)
  const tierMult = { ELITE: 1.04, RELIABLE: 1.00, SITUATIONAL: 0.96, COLD: 0.88, EXPERIMENTAL: 0.78 }[tier] || 1.0;
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
  // Reduced: was 8/15/20/25 — inflated scores past 100. Now 5/9/12/16.
  let bonus = n === 2 ? 5 : n === 3 ? 9 : n === 4 ? 12 : 16;
  // Extra +2 per ELITE/RELIABLE punter (cap +6, was +9)
  const eliteBonus = Math.min(6, punterNames.filter(p => {
    const t = getPunterData(lbMap, profMap, p).tier;
    return t === 'ELITE' || t === 'RELIABLE';
  }).length * 2);
  return Math.min(22, bonus + eliteBonus);
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
  const { lbMap, profMap, specMap, leagueIntel, marketIntel, teamIntel, selHistory, weakMatches, killerLeagues, h2hMap } = deps;
  const safety = marketSafety(sel.marketName || sel.market, sel.specifier, sel.outcomeName || sel.outcome, sel.homeTeam, sel.awayTeam);
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
  const lgScore = li && (li.won + li.lost) >= 4 ? li.hitRate : 55;

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

  // Odds value — penalize extremes, reward accumulator-viable range (1.45-2.20)
  // Low odds (≤1.35) previously got +8: wrong for accumulators where one loss wipes many wins
  const odds = sel.originalOdds || sel.odds || 0;
  let oddsAdj = 0;
  if (odds > 10)        oddsAdj = -20;
  else if (odds > 5)    oddsAdj = -10;
  else if (odds > 3.0)  oddsAdj = -5;
  else if (odds >= 1.80) oddsAdj = 5;  // sweet spot: good return, realistic probability
  else if (odds >= 1.45) oddsAdj = 2;  // acceptable range
  else if (odds >= 1.25) oddsAdj = 0;  // neutral
  else if (odds >  1.10) oddsAdj = -6; // near-certainty: low value, high accumulator risk
  else if (odds >  0)    oddsAdj = -12; // price implies certainty — reality never is

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

  // v36 — real head-to-head data now feeds the CORE score, not just the
  // Convert tool's Deep Scan side feature. h2hMap is prefetched once per
  // unique event in runAnalysis (pick-independent: avgGoals/bttsPct/
  // homeWinRate from the last ~5 meetings + recent form), via the SAME
  // waterfall /api/h2h already uses — API-Football when a working key is
  // set (currently suspended, see getH2HStats' comment in server.js),
  // SportyBet's own stats endpoints or TheSportsDB otherwise. Same
  // direction as apiFootballH2H's own safety-score heuristic, scaled to
  // this function's other ±5-to-±20 adjustment terms.
  let h2hAdj = 0;
  const h2h = h2hMap && h2hMap[sel.eventId];
  const mkt = (sel.marketName || sel.market || '').toLowerCase();
  if (h2h && h2h.found && h2h.keyStats) {
    const ks = h2h.keyStats;
    if (ks.avgGoals != null) {
      if (ks.avgGoals < 1.5) {
        if (out.includes('over 1.5')) h2hAdj += 10;
        if (out.includes('over 2.5') || out.includes('over 3')) h2hAdj -= 12;
      } else if (ks.avgGoals > 3) {
        if (out.includes('over 2.5') || out.includes('over 3')) h2hAdj += 10;
        if (out.includes('under 1.5') || out.includes('under 2')) h2hAdj -= 10;
      }
    }
    if (ks.bttsPct != null && (mkt.includes('gg') || mkt.includes('both teams'))) {
      if (ks.bttsPct >= 65 && out === 'yes') h2hAdj += 8;
      if (ks.bttsPct <= 25 && out === 'yes') h2hAdj -= 10;
      if (ks.bttsPct <= 25 && out === 'no') h2hAdj += 6;
    }
    if (ks.homeWinRate != null) {
      if (ks.homeWinRate >= 75 && ['home','1','home win'].includes(out)) h2hAdj += 8;
      if (ks.homeWinRate <= 20 && ['home','1','home win'].includes(out)) h2hAdj -= 10;
      if (ks.homeWinRate <= 20 && ['away','2','away win'].includes(out)) h2hAdj += 6;
    }
    h2hAdj = Math.max(-15, Math.min(15, h2hAdj));
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

  return Math.min(97, Math.round((base + lgBonus + consensusBonus + histAdj + weakAdj + oddsAdj + teamAdj + h2hAdj - killerPenalty) * pd.tierMult));
}

// ─── NETWORK HELPERS ──────────────────────────────────────────────────────────
// v46 — REAL BUG: SportyBet's CloudFront WAF started 403-blocking the bare
// "Mozilla/5.0" User-Agent (confirmed live 2026-09-09 in server.js's
// fetchJSON — same endpoint, fuller UA string, 403 vs 200 back to back).
// These three were never updated with that fix, so every Advanced Generator
// run got a CloudFront HTML error page in place of JSON for every punter
// code lookup, every live market-board check, and every code-generation
// POST — the whole pipeline was silently network-dead. Same fuller UA +
// Referer combo fetchJSONWithStatus already uses successfully in server.js.
const SB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.sportybet.com/ng/',
};
function sbGet(code) {
  return new Promise((res, rej) => {
    const req = https.get({
      hostname: 'www.sportybet.com',
      path: '/api/ng/orders/share/' + encodeURIComponent(code),
      headers: { ...SB_HEADERS, 'Accept': 'application/json' },
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
      headers: { ...SB_HEADERS, 'Accept': 'application/json' },
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
      headers: { ...SB_HEADERS, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data) },
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); });
    req.on('error', rej);
    req.setTimeout(15000, () => { req.destroy(); rej(new Error('timeout')); });
    req.write(data); req.end();
  });
}

/**
 * ── THE ONLY CORRECT WAY TO REPORT ODDS FOR A GENERATED CODE ──────────────
 *
 * Every pick carries an `odds` value from whenever it was scored (pool build
 * time, a market scan, a punter's original code) — that number is a snapshot,
 * not a live fact, and can be hours stale by the time a ticket is actually
 * posted. Posting on stale odds and then reporting the STALE product as
 * "the odds" is exactly how a supposedly-safe pick (Over 1.5 @1.3) turns into
 * a settled leg at @7-13 with nobody having caught it.
 *
 * This function posts the ticket, then reads the code straight back and
 * pulls the CURRENT price for every leg from the live `outcomes[]` market
 * data. Do NOT read odds from `ticket.selections` — that field has no odds
 * at all until the match has already settled, so checking it always passes
 * vacuously (this exact bug shipped once already).
 *
 * Any leg whose live price has drifted outside `oddsCap` (or gone inactive)
 * is dropped and the ticket is reposted without it, up to `maxRetries`
 * times. The returned `totalOdds` / per-pick `odds` are the VERIFIED live
 * numbers — always report these, never the pre-post snapshot product.
 *
 * @param {object[]} picks    - pool items with eventId/marketId/specifier/outcomeId/productId/sportId
 * @param {number}   oddsCap  - reject/redo if any leg's live odds fall outside (1.01, oddsCap]
 * @param {number}   maxRetries
 * @param {Function} logger
 * @returns {Promise<{code, url, picks, totalOdds, dropped}|null>} null if it never converges above 4 legs
 */
async function verifyAndPostTicket(picks, oddsCap, maxRetries = 3, logger = () => {}) {
  let working = [...picks];
  const allDropped = [];
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (working.length < 4) return null;
    const payload = working.map(s => ({
      eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
      specifier: s.specifier || '', productId: parseInt(s.productId) || 3, sportId: s.sportId || 'sr:sport:1',
    }));
    let posted;
    try { posted = await sbPost(payload); } catch (e) { logger(`  post failed: ${e.message}`); return null; }
    if (posted.bizCode !== 10000 || !posted.data?.shareCode) { logger(`  SportyBet rejected post: ${posted.msg || posted.bizCode}`); return null; }
    const code = posted.data.shareCode, url = posted.data.shareURL || '';

    await new Promise(r => setTimeout(r, 400));
    let j;
    try { j = await sbGet(code); } catch (e) { logger(`  readback failed: ${e.message} — cannot verify, discarding`); return null; }
    if (!j || j.bizCode !== 10000 || !j.data) { logger(`  readback returned no data — cannot verify, discarding`); return null; }

    const ticketSels = j.data.ticket?.selections || [];
    const liveByEvent = new Map((j.data.outcomes || []).map(o => [String(o.eventId), o]));

    const bad = [], verified = [];
    for (const ts of ticketSels) {
      const p = working.find(w => String(w.eventId) === String(ts.eventId) && String(w.marketId) === String(ts.marketId));
      if (!p) continue;
      const ev = liveByEvent.get(String(ts.eventId));
      const mkt = ev?.markets?.find(m => String(m.id) === String(ts.marketId) && (m.specifier || '') === (ts.specifier || ''));
      const out = mkt?.outcomes?.find(o => String(o.id) === String(ts.outcomeId));
      const liveOdds = out ? parseFloat(out.odds) : null;
      if (liveOdds == null || out.isActive !== 1) { bad.push({ p, liveOdds: 'inactive/unknown' }); continue; }
      if (liveOdds <= 1.01 || liveOdds > oddsCap) { bad.push({ p, liveOdds }); continue; }
      verified.push({ ...p, odds: liveOdds, oddsVerified: true, oddsVerifiedAt: new Date().toISOString() });
    }

    if (!bad.length && verified.length === working.length) {
      const totalOdds = Math.round(verified.reduce((a, p) => a * p.odds, 1) * 100) / 100;
      return { code, url, picks: verified, totalOdds, dropped: allDropped };
    }

    for (const b of bad) {
      logger(`  ⚠ ${b.p.homeTeam} vs ${b.p.awayTeam} — expected ~${b.p.odds}, live now ${b.liveOdds} — dropping`);
      allDropped.push({ home: b.p.homeTeam, away: b.p.awayTeam, expectedOdds: b.p.odds, liveOdds: b.liveOdds });
    }
    const badIds = new Set(bad.map(b => b.p.eventId));
    working = working.filter(p => !badIds.has(p.eventId));
  }
  return null;
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
/**
 * Loads every historical intelligence file into the same `deps` shape
 * masterScore() expects. Shared by runAnalysis() and any other caller
 * (e.g. a broad market scanner) that needs to score selections outside
 * the punter-code pipeline.
 */
function loadIntelDeps(logger = () => {}) {
  const leagueIntel = safeJSON(LEAGUE_FILE, {});
  const marketIntel = safeJSON(MARKET_FILE, {});
  const teamIntel   = safeJSON(TEAM_FILE,   {});
  const specMap     = safeJSON(SPEC_FILE,   {});
  const profMap     = safeJSON(PROF_FILE,   {});
  const weakMatches = safeJSON(WEAK_FILE,   {});

  let lb = [];
  try { lb = safeJSON(LB_FILE, []); } catch {}
  const lbMap = new Map(lb.map(p => [p.punter, p]));

  const selHistoryFile = path.join(DATA, 'selection-history.json');
  const selHistory = safeJSON(selHistoryFile, {});

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

  // Neutral synthetic "punter" — used when scoring a pick that has no real
  // punter behind it (e.g. the broad market scanner). Seeded at RELIABLE-tier
  // averages so masterScore's punter-dependent terms land at a neutral
  // multiplier (1.00) instead of being dragged into COLD/EXPERIMENTAL territory
  // purely for lacking punter history.
  lbMap.set('__MARKET__', { punter: '__MARKET__', trustScore: 75, hitRate: 75, consistency: 70, codes: [] });

  return { lbMap, profMap, specMap, leagueIntel, marketIntel, teamIntel, selHistory, weakMatches, killerLeagues, killerEvents };
}

// Same simple bounded-concurrency worker pool pattern already used by
// advanced-generator-engine.js's mapWithConcurrency — duplicated here rather
// than cross-required since the two engine files don't otherwise depend on
// each other and this is a handful of lines.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await worker(items[my], my);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

async function runAnalysis(punterMap, logger = ()=>{}, fetchH2H = null) {
  const today  = localToday();
  const now    = Date.now();

  // Load all intelligence
  logger('Loading historical intelligence…');
  const deps = loadIntelDeps(logger);
  const { lbMap, profMap, specMap, leagueIntel, marketIntel, teamIntel, selHistory, weakMatches, killerLeagues, killerEvents } = deps;

  // Fetch punter data
  logger(`Fetching picks from ${Object.keys(punterMap).length} punters…`);
  const allRaw = [];
  const fetchLog = {};

  for (const [punter, code] of Object.entries(punterMap)) {
    // Normalise to an array of code strings — handles single, comma-separated, or array
    let codeList = [];
    if (Array.isArray(code)) {
      codeList = code.map(c => String(c).trim().toUpperCase()).filter(Boolean);
    } else if (typeof code === 'string' && code.includes(',')) {
      codeList = code.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    } else if (typeof code === 'string' && code.trim()) {
      codeList = [code.trim().toUpperCase()];
    }
    if (!codeList.length) continue;

    let totalCnt = 0;
    const seenEvents = new Set(); // dedupe across multiple codes for same punter

    for (const codeStr of codeList) {
      try {
        const j = await sbGet(codeStr);
        if (!j || j.bizCode !== 10000 || !j.data) {
          fetchLog[`${punter}[${codeStr}]`] = { code: codeStr, status: 'fail', error: j?.message || 'no data' };
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
          const specifier  = ts.specifier || mkt.specifier || '';
          const outcomeId  = String(ts.outcomeId || pick.id || '');
          const dedupeKey  = `${o.eventId}|${marketId}|${specifier}|${outcomeId}`;
          if (seenEvents.has(dedupeKey)) continue;
          seenEvents.add(dedupeKey);

          // Live desc MUST win over the static fallback table — MKT_NAMES flattens
          // distinct markets sharing an id (e.g. 18 "Over/Under" full-match vs 19
          // "{Team} Over/Under" team-scoped) into the same generic label, which
          // silently defeats isTeamScopedMarket() downstream. Only fall back to
          // the static table when the feed genuinely omits a description.
          const marketName = mkt.desc || MKT_NAMES[marketId] || ('Mkt' + marketId);
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
        totalCnt += cnt;
        logger(`  ${punter} (${codeStr}): ${cnt} upcoming picks`);
        await new Promise(r => setTimeout(r, 200));
      } catch(e) {
        fetchLog[`${punter}[${codeStr}]`] = { code: codeStr, status: 'error', error: e.message };
        logger(`  ${punter} (${codeStr}): ERROR — ${e.message}`);
      }
    }
    fetchLog[punter] = { codes: codeList, status: 'ok', picks: totalCnt };
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

  // v36 — prefetch real head-to-head data ONCE per unique event (not once
  // per raw pick — many picks across different punters/markets share the
  // same event) before scoring, so masterScore can consult it synchronously
  // via deps.h2hMap. Bounded concurrency keeps this from turning a ~40s
  // analysis into several minutes on a real day's ~150-200 unique games.
  deps.h2hMap = {};
  if (typeof fetchH2H === 'function') {
    const uniqueEvents = new Map();
    for (const s of Object.values(selMap)) {
      if (!uniqueEvents.has(s.eventId)) uniqueEvents.set(s.eventId, s);
    }
    const eventList = [...uniqueEvents.values()];
    logger(`Fetching real head-to-head data for ${eventList.length} unique games…`);
    let h2hFound = 0;
    await mapWithConcurrency(eventList, 6, async (s) => {
      try {
        const h2h = await fetchH2H(s.eventId, s.homeTeam, s.awayTeam, '');
        if (h2h) { deps.h2hMap[s.eventId] = h2h; if (h2h.found) h2hFound++; }
      } catch {}
    });
    logger(`  H2H data found for ${h2hFound}/${eventList.length} games`);
  }

  // ── Per-game deduplication: best market per event ──────────────────────────
  const gameMap = {}; // eventId → best pick for this game
  for (const s of Object.values(selMap)) {
    // Filter women's leagues at pool level (not just portfolio time)
    if (WOMEN_RE.test(s.league || '')) { s._score = -1; s._safety = -1; continue; }
    // A youth/reserve squad (e.g. "... U21", "... II") competing in an otherwise
    // normal senior division isn't caught by the league-name check above.
    if (TEAM_YOUTH_RE.test((s.homeTeam || '').trim()) || TEAM_YOUTH_RE.test((s.awayTeam || '').trim())) { s._score = -1; s._safety = -1; continue; }
    // Football only — punter codes sometimes mix in darts/table-tennis picks
    if (s.sportId && s.sportId !== 'sr:sport:1') { s._score = -1; s._safety = -1; continue; }
    // Team-scoped totals (e.g. "Rezeknes Fa/Bjss Over/Under") are not the full-match
    // market — never score them against full-match safety calibration.
    if (isTeamScopedMarket(s.marketName, s.homeTeam, s.awayTeam)) { s._score = -1; s._safety = -1; continue; }
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
        const preScore = s._score;
        let converted = false;
        for (const cType of convTypes) {
          const alt = findSafeMarket(avail, cType, s.homeTeam, s.awayTeam);
          if (!alt) continue;
          const newSafety = marketSafety(alt.marketName, alt.specifier, alt.outcomeName, s.homeTeam, s.awayTeam);
          // Validation gate:
          if (newSafety < 0) continue;                    // alt is itself unsafe
          if (newSafety <= s._safety) continue;           // no safety improvement
          if (alt.odds <= 1.01 || alt.odds > 9) continue; // odds out of range
          if (/^\d+$/.test((alt.outcomeName || '').trim()) && (alt.marketName || '').toLowerCase().includes('goal bounds')) continue; // bare digit Goal Bounds
          // Confidence-improvement gate: simulate the swap and reject if it would
          // actually lower the final score — a safer market on paper that the punter/league/
          // form data doesn't support is not worth taking over the original pick.
          const trial = { ...s, marketId: String(alt.marketId), marketName: alt.marketName,
            specifier: alt.specifier || '', outcomeId: String(alt.outcomeId),
            outcomeName: alt.outcomeName, odds: alt.odds, productId: alt.productId || 3 };
          const trialScore = masterScore(trial, deps);
          if (trialScore < preScore) continue;            // no confidence improvement — try next candidate
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
          s._score     = trialScore;
          s._converted = true;
          s._conversionNote = `${oldNote} → ${alt.marketName}: ${alt.outcomeName}`;
          logger(`  ✓ Converted: ${s.homeTeam} vs ${s.awayTeam} — ${s._conversionNote}`);
          converted = true;
          break;
        }
        if (!converted) {
          s._score = -1;
          s._noSafeConversion = true;
          logger(`  ✗ Removed: ${s.homeTeam} vs ${s.awayTeam} — ${s.marketName}: ${s.outcomeName} (no safe conversion)`);
        }
        await new Promise(r => setTimeout(r, 100));
      } catch(e) {
        s._score = -1;
        s._noSafeConversion = true;
      }
    }
  }

  // ── Build master pool ───────────────────────────────────────────────────────
  const masterPool = [];
  const excluded   = [];

  for (const s of Object.values(gameMap)) {
    if (s._score < 0) {
      const reason = s._noSafeConversion
        ? `No safe conversion found: ${s.marketName}: ${s.outcomeName}`
        : `Hard-removed market: ${s.marketName}`;
      excluded.push({ game: `${s.homeTeam} vs ${s.awayTeam}`, league: s.league, reason, score: s._score });
      continue;
    }
    if (s._score < 42) {
      excluded.push({ game: `${s.homeTeam} vs ${s.awayTeam}`, league: s.league, reason: `Confidence too low (${s._score})`, market: `${s.marketName} @${s.odds}` });
      continue;
    }
    // User rule: odds over 2.0 are removed outright, no matter the market
    if (s.odds > 2.0) {
      excluded.push({ game: `${s.homeTeam} vs ${s.awayTeam}`, league: s.league, reason: `Odds too high (${s.odds} > 2.0 cap)`, market: `${s.marketName} @${s.odds}` });
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
      // Odds are a snapshot, not a fact that holds until kickoff — every pick
      // must carry when it was read so nothing downstream mistakes a stale
      // number for a live one. Never report an odds figure without this.
      oddsSnapshotAt: new Date(now).toISOString(),
      oddsVerified: false,
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
    logger(`  [${theme.name}] ${picks.length}g ${oddsStr} — posting & verifying live odds…`);
    // Post, then verify every leg's odds against the LIVE market data before
    // reporting anything — the pre-post `odds` above is only a snapshot and
    // can be hours stale (picks came from the master pool built earlier).
    const verified = await verifyAndPostTicket(picks, 2.2, 3, logger);
    await new Promise(r => setTimeout(r, 400));

    if (!verified) { logger(`  [${theme.name}] Code generation/verification failed`); continue; }
    const code = verified.code;
    if (generatedCodes.has(code)) { logger(`  [${theme.name}] SKIPPED — duplicate code ${code}`); continue; }
    generatedCodes.add(code);
    picks = verified.picks;   // verified live odds, possibly fewer legs than requested
    odds = verified.totalOdds; // verified live product — never report the stale snapshot product

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
    const safety = marketSafety(norm.marketName, norm.specifier, norm.outcomeName, norm.homeTeam, norm.awayTeam);
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

module.exports = { runAnalysis, getMasterPool, buildThemedCodes, scoreSelections, getXContext, marketSafety, masterScore, classifyRisk, findSafeMarket, getLine, leagueTier, getPunterData, sbGetEvent, sbGet, sbPost, SAFE_CONVERSIONS, isTeamScopedMarket, loadIntelDeps, verifyAndPostTicket };
