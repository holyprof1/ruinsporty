/**
 * strategy-engine.js — SlipPilot Strategy Engine
 *
 * Builds MULTIPLE independent portfolios from the same master pool, each
 * following completely different construction rules (15 named strategies).
 * Every ticket returned carries full audit metadata: confidence, weakest/
 * strongest pick, per-pick reasoning, rejection reasons, conversions applied,
 * and a safer-replacement suggestion — then every generated ticket is ranked
 * safest → riskiest with a top-3 staking recommendation.
 *
 * Reuses the conversion primitives from intelligence-engine.js (the pool is
 * already conversion-passed at analysis time); this module adds a bounded,
 * on-demand conversion pass for picks that only miss a strategy's own odds
 * ceiling, so a good pick isn't thrown away when a safer market for the same
 * game would have kept it eligible.
 */
'use strict';

const intel = require('./intelligence-engine');
const { getLine, findSafeMarket, marketSafety, SAFE_CONVERSIONS, sbGetEvent, isTeamScopedMarket } = intel;

// ─── Market-type detectors ────────────────────────────────────────────────────
function mn(p) { return (p.marketName || '').toLowerCase(); }
function on(p) { return (p.outcomeName || '').toLowerCase(); }

function isDC(p) {
  const m = mn(p);
  return m.includes('double chance') && !m.includes('goal') && !m.includes('over') && !m.includes('under');
}
function dcCombo(p) {
  if (!isDC(p)) return null;
  const o = on(p);
  if (o.includes('1x') || o.includes('home or draw') || o.includes('draw or home')) return '1X';
  if (o.includes('x2') || o.includes('draw or away') || o.includes('away or draw')) return 'X2';
  if (o.includes('home or away') || o.includes('away or home') || o === '12') return '12';
  return 'DC';
}
function isDNB(p) { const m = mn(p); return m.includes('draw no bet') || m.includes('home no draw'); }
function isOverLine(p, line) {
  const m = mn(p);
  if (!m.includes('over/under')) return false;
  if (isTeamScopedMarket(p.marketName, p.homeTeam, p.awayTeam)) return false; // team total, not full-match
  if (!on(p).includes('over')) return false;
  return Math.abs(getLine(p.marketName, p.specifier, p.outcomeName) - line) < 0.1;
}
function isUnderLine(p, line) {
  const m = mn(p);
  if (!m.includes('over/under')) return false;
  if (isTeamScopedMarket(p.marketName, p.homeTeam, p.awayTeam)) return false; // team total, not full-match
  if (!on(p).includes('under')) return false;
  return Math.abs(getLine(p.marketName, p.specifier, p.outcomeName) - line) < 0.1;
}
function is1X2(p) { const m = mn(p); return m === 'match winner' || m === '1x2' || m === 'home/away'; }
function isBTTS(p) { return mn(p).includes('gg/ng'); }
function isBothHalves(p) { return mn(p).includes('both halves'); }
function isFriendly(p) { return /\bfriendly\b|\bfriendlies\b/i.test(p.league || ''); }
function isYouthOrReserve(p) { return /\bu1[6-9]\b|\bu2[0-3]\b|\byouth\b|\breserves?\b/i.test(p.league || ''); }
function isWomen(p) { return /\bwomens?\b|\bfemale\b|\bladies\b|\bgirls\b/i.test(p.league || ''); }
function isSafeMarketPick(p) {
  return isDC(p) || isDNB(p) || isOverLine(p, 1.5) || isOverLine(p, 2.0) || (p.safety || 0) >= 80;
}

// ─── Region / recognition tables (extend as needed) ───────────────────────────
const SCANDINAVIA = new Set(['Sweden', 'Norway', 'Denmark', 'Finland', 'Iceland']);
const SOUTH_AMERICA = new Set(['Brazil', 'Argentina', 'Uruguay', 'Paraguay', 'Chile', 'Colombia', 'Peru', 'Bolivia', 'Ecuador', 'Venezuela']);
const EUROPE_OTHER = new Set([
  'France', 'Netherlands', 'Portugal', 'Belgium', 'Scotland', 'Wales', 'Ireland', 'Northern Ireland',
  'Turkey', 'Poland', 'Austria', 'Switzerland', 'Croatia', 'Serbia', 'Romania', 'Bulgaria', 'Greece',
  'Ukraine', 'Russia', 'Czech Republic', 'Slovakia', 'Hungary', 'Slovenia', 'Bosnia', 'Albania',
  'North Macedonia', 'Montenegro', 'Kosovo', 'Cyprus', 'Malta', 'Luxembourg', 'Georgia', 'Armenia',
  'Azerbaijan', 'Israel', 'Latvia', 'Lithuania', 'Estonia', 'Moldova', 'Belarus',
]);
const UEFA_COMPETITION_RE = /uefa|champions league|europa league|conference league|nations league|euro qualif/i;

function regionOf(p) {
  const cat = p.category || '';
  if (SCANDINAVIA.has(cat)) return 'scandinavia';
  if (cat === 'England') return 'england';
  if (cat === 'Germany') return 'germany';
  if (cat === 'Spain') return 'spain';
  if (cat === 'Italy') return 'italy';
  if (SOUTH_AMERICA.has(cat)) return 'southAmerica';
  if (EUROPE_OTHER.has(cat)) return 'europeOther';
  if (UEFA_COMPETITION_RE.test(p.league || '')) return 'europeOther';
  return null;
}

// "Recognised" top-flight leagues / competitions for Big Teams Only.
const TOP_LEAGUE_RE = /^(premier league|la liga|serie a|bundesliga|ligue 1|eredivisie|primeira liga|scottish premiership|premiership|super lig|brasileirao|brasileiro serie a|liga profesional|primera division|world cup|european championship|euro|copa america|copa libertadores|copa sudamericana|nations league|fa cup|dfb.?pokal|coppa italia|copa del rey|coupe de france)$/i;
function isTopLeague(p) {
  if (UEFA_COMPETITION_RE.test(p.league || '')) return true;
  return TOP_LEAGUE_RE.test((p.league || '').trim());
}
const BIG_CLUBS = new Set([
  'Real Madrid', 'Barcelona', 'Atletico Madrid', 'Manchester City', 'Manchester United', 'Liverpool',
  'Arsenal', 'Chelsea', 'Tottenham Hotspur', 'Tottenham', 'Bayern Munich', 'Borussia Dortmund',
  'Paris Saint-Germain', 'Paris Saint Germain', 'PSG', 'Juventus', 'Inter Milan', 'Inter', 'AC Milan',
  'Milan', 'Napoli', 'AS Roma', 'Roma', 'Ajax', 'Benfica', 'Porto', 'Sporting CP', 'Celtic', 'Rangers',
]);
function isBigClub(p) { return BIG_CLUBS.has(p.homeTeam) || BIG_CLUBS.has(p.awayTeam); }
function isNationalTeamFixture(p) {
  return /world cup|european championship|nations league|copa america|international|qualif/i.test(p.league || '') ||
    p.category === 'International';
}

// ─── Time-window helpers (WAT, UTC+1 — matches portfolio-builder.js) ──────────
function watHour(kickMs) {
  const WAT_OFFSET_MS = 60 * 60 * 1000;
  return new Date(kickMs + WAT_OFFSET_MS).getUTCHours();
}
function isWithinHours(p, hours) {
  return p.kick > 0 && p.kick <= Date.now() + hours * 3600000 && p.kick > Date.now() - 5 * 60000;
}
function isEvening(p) {
  if (!p.kick) return false;
  const h = watHour(p.kick);
  return h >= 17 && h < 23;
}

// ─── Generic pool utilities ────────────────────────────────────────────────────
function edge(p) {
  // model edge = model-implied win probability minus market-implied probability
  const marketImplied = p.odds > 0 ? 1 / p.odds : 0;
  return (p.confidence || 0) / 100 - marketImplied;
}

function clone(p, patch) { return Object.assign({}, p, patch); }

/**
 * Generic diversity-aware greedy accumulator.
 * Pool must already be sorted in priority order.
 */
function greedyBuild(pool, { maxGames = 20, minGames = 3, maxPerLeague = 6, punterCapAfter = 8, punterCap = 0.42 } = {}) {
  const seenEvent = new Set(), picks = [], leagueCnt = {}, punterCnt = {};
  for (const p of pool) {
    if (picks.length >= maxGames) break;
    if (seenEvent.has(p.eventId)) continue;
    if ((leagueCnt[p.league] || 0) >= maxPerLeague) continue;
    if (picks.length >= punterCapAfter) {
      const proj = ((punterCnt[p.punter] || 0) + 1) / (picks.length + 1);
      if (proj > punterCap) continue;
    }
    seenEvent.add(p.eventId);
    picks.push(p);
    leagueCnt[p.league] = (leagueCnt[p.league] || 0) + 1;
    punterCnt[p.punter] = (punterCnt[p.punter] || 0) + 1;
  }
  return picks;
}

/**
 * Incremental confidence-floor builder — keeps adding candidates (already
 * sorted best-first) only while the running portfolio average stays at or
 * above targetConfidence. Used by CONSERVATIVE BUILDER.
 */
function conservativeBuild(pool, { targetConfidence = 82, maxGames = 25, minGames = 3, maxPerLeague = 5 } = {}) {
  const seenEvent = new Set(), picks = [], leagueCnt = {};
  let sumConf = 0;
  for (const p of pool) {
    if (picks.length >= maxGames) break;
    if (seenEvent.has(p.eventId)) continue;
    if ((leagueCnt[p.league] || 0) >= maxPerLeague) continue;
    const trialAvg = (sumConf + p.confidence) / (picks.length + 1);
    if (picks.length >= 3 && trialAvg < targetConfidence) continue;
    seenEvent.add(p.eventId);
    picks.push(p);
    sumConf += p.confidence;
    leagueCnt[p.league] = (leagueCnt[p.league] || 0) + 1;
  }
  return picks;
}

/**
 * Take the literal top-N by whatever order the pool is already sorted in —
 * no diversity caps. Used by TOP 10 / TOP 20.
 */
function topNBuild(pool, n) {
  const seenEvent = new Set(), picks = [];
  for (const p of pool) {
    if (picks.length >= n) break;
    if (seenEvent.has(p.eventId)) continue;
    seenEvent.add(p.eventId);
    picks.push(p);
  }
  return picks;
}

// ─── Strategy definitions ──────────────────────────────────────────────────────
// Each entry: { key, name, description, minGames, maxGames, oddsCap (per-leg,
// optional), eligible(pick) => {ok, reason}, sortCmp(a,b), build(pool,opts) }

const STRATEGIES = [
  {
    key: 'safe_consensus',
    name: 'Safe Consensus',
    description: 'Only matches backed by 2+ punters, confidence ≥90, odds ≤1.65, DC/DNB/Over1.5/Over2 only. Max 18 games.',
    minGames: 4,
    maxGames: 18,
    oddsCap: 1.65,
    eligible(p) {
      if ((p.count || 0) < 2) return { ok: false, reason: `Only 1 punter backed this (need 2+)` };
      if ((p.confidence || 0) < 90) return { ok: false, reason: `Confidence ${p.confidence} < 90 required` };
      if (p.odds > 1.65) return { ok: false, reason: `Odds ${p.odds} exceed 1.65 cap` };
      if (!(isDC(p) || isDNB(p) || isOverLine(p, 1.5) || isOverLine(p, 2.0))) {
        return { ok: false, reason: `Market "${p.marketName}" not in allowed set (DC/DNB/Over1.5/Over2)` };
      }
      return { ok: true };
    },
    sortCmp: (a, b) => (b.confidence - a.confidence) || (a.odds - b.odds),
    build: (pool) => greedyBuild(pool, { maxGames: 18, minGames: 4, maxPerLeague: 4 }),
  },
  {
    key: 'low_odds_machine',
    name: 'Low Odds Machine',
    description: 'Every pick between 1.15–1.45. Highest confidence only. Built purely for survival, not for jackpot odds.',
    minGames: 5,
    maxGames: 22,
    oddsCap: 1.45,
    eligible(p) {
      if (p.odds < 1.15) return { ok: false, reason: `Odds ${p.odds} below 1.15 floor (too short to be meaningful)` };
      if (p.odds > 1.45) return { ok: false, reason: `Odds ${p.odds} exceed 1.45 ceiling` };
      if ((p.confidence || 0) < 65) return { ok: false, reason: `Confidence ${p.confidence} too low for a survival ticket` };
      return { ok: true };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => greedyBuild(pool, { maxGames: 22, minGames: 5, maxPerLeague: 5 }),
  },
  {
    key: 'big_teams_only',
    name: 'Big Teams Only',
    description: 'Recognised strong clubs/national teams and top-flight leagues only. Friendlies rejected unless confidence >95. Favours favourites.',
    minGames: 3,
    maxGames: 15,
    eligible(p) {
      if (isFriendly(p) && (p.confidence || 0) <= 95) return { ok: false, reason: `Friendly fixture and confidence ${p.confidence} ≤ 95` };
      const recognised = isTopLeague(p) || isNationalTeamFixture(p);
      if (!recognised) return { ok: false, reason: `League "${p.league}" is not a recognised top-flight competition` };
      return { ok: true };
    },
    sortCmp: (a, b) => {
      const wa = (isBigClub(a) ? 10 : 0) + a.confidence * 0.3 - a.odds * 2;
      const wb = (isBigClub(b) ? 10 : 0) + b.confidence * 0.3 - b.odds * 2;
      return wb - wa;
    },
    build: (pool) => greedyBuild(pool, { maxGames: 15, minGames: 3, maxPerLeague: 3 }),
  },
  {
    key: 'league_filter',
    name: 'League Filter',
    description: 'Only Scandinavia, wider Europe, South America, England, Germany, Spain, Italy. Danger/blacklisted leagues never mixed in.',
    minGames: 4,
    maxGames: 20,
    eligible(p) {
      if (['BLACKLIST', 'DANGER', 'VOLATILE'].includes(p.leagueTier)) {
        return { ok: false, reason: `League tier ${p.leagueTier} — excluded regardless of region` };
      }
      const region = regionOf(p);
      if (!region) return { ok: false, reason: `Country "${p.category}" not in the allowed region list` };
      return { ok: true };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 4, maxPerLeague: 5 }),
  },
  {
    key: 'goals_only',
    name: 'Goals Only',
    description: 'Over 1.5 / Over 2 / Over 2.5 (conf >92 only) / Under 4.5. No 1X2, no BTTS, no Both Halves.',
    minGames: 4,
    maxGames: 20,
    eligible(p) {
      if (is1X2(p)) return { ok: false, reason: '1X2 market not allowed in Goals Only' };
      if (isBTTS(p)) return { ok: false, reason: 'BTTS market not allowed in Goals Only' };
      if (isBothHalves(p)) return { ok: false, reason: 'Both Halves market not allowed in Goals Only' };
      if (isOverLine(p, 1.5) || isOverLine(p, 2.0) || isUnderLine(p, 4.5)) return { ok: true };
      if (isOverLine(p, 2.5)) {
        if ((p.confidence || 0) > 92) return { ok: true };
        return { ok: false, reason: `Over 2.5 requires confidence >92 (has ${p.confidence})` };
      }
      return { ok: false, reason: `Market "${p.marketName}" not in the Goals Only allow-list` };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 4, maxPerLeague: 5 }),
  },
  {
    key: 'double_chance_only',
    name: 'Double Chance Only',
    description: 'Only 1X, X2, 12, or DNB. No other market type enters this ticket.',
    minGames: 4,
    maxGames: 20,
    eligible(p) {
      if (isDC(p) || isDNB(p)) return { ok: true };
      return { ok: false, reason: `Market "${p.marketName}" is not DC/DNB` };
    },
    sortCmp: (a, b) => {
      // 12 (no-draw) combos are structurally riskier than 1X/X2 — de-prioritise them
      const pa = dcCombo(a) === '12' ? -3 : 0, pb = dcCombo(b) === '12' ? -3 : 0;
      return (b.confidence + pb) - (a.confidence + pa);
    },
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 4, maxPerLeague: 5 }),
  },
  {
    key: 'conservative_builder',
    name: 'Conservative Builder',
    description: 'Starts from the safest possible pool and only adds another game while overall ticket confidence stays above target (82).',
    minGames: 4,
    maxGames: 25,
    eligible(p) {
      if ((p.confidence || 0) < 70) return { ok: false, reason: `Confidence ${p.confidence} below the 70 quality floor` };
      return { ok: true };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => conservativeBuild(pool, { targetConfidence: 82, maxGames: 25, minGames: 4, maxPerLeague: 5 }),
  },
  {
    key: 'aggressive_builder',
    name: 'Aggressive Builder',
    description: 'Built for high odds — still rejects any individual selection below confidence 75.',
    minGames: 6,
    maxGames: 34,
    eligible(p) {
      if ((p.confidence || 0) < 75) return { ok: false, reason: `Confidence ${p.confidence} below the 75 floor — never relaxed for odds` };
      return { ok: true };
    },
    sortCmp: (a, b) => b.odds - a.odds,
    build: (pool) => greedyBuild(pool, { maxGames: 34, minGames: 6, maxPerLeague: 8, punterCapAfter: 8, punterCap: 0.45 }),
  },
  {
    key: 'early_matches',
    name: 'Early Matches Only',
    description: 'Only matches kicking off within the next 6 hours.',
    minGames: 3,
    maxGames: 20,
    eligible(p) {
      if (!isWithinHours(p, 6)) return { ok: false, reason: 'Kickoff is not within the next 6 hours' };
      return { ok: true };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 3, maxPerLeague: 5 }),
  },
  {
    key: 'evening_matches',
    name: 'Evening Matches Only',
    description: 'Only fixtures kicking off in the evening window (17:00–23:00 WAT).',
    minGames: 3,
    maxGames: 20,
    eligible(p) {
      if (!isEvening(p)) return { ok: false, reason: 'Kickoff is outside the 17:00–23:00 WAT evening window' };
      return { ok: true };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 3, maxPerLeague: 5 }),
  },
  {
    key: 'top10_games',
    name: 'Top 10 Games',
    description: 'The 10 highest-rated matches in today\'s pool, full stop.',
    minGames: 3,
    maxGames: 10,
    eligible() { return { ok: true }; },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => topNBuild(pool, 10),
  },
  {
    key: 'top20_games',
    name: 'Top 20 Games',
    description: 'The 20 best-rated matches in today\'s pool.',
    minGames: 5,
    maxGames: 20,
    eligible() { return { ok: true }; },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => topNBuild(pool, 20),
  },
  {
    key: 'pure_value',
    name: 'Pure Value',
    description: 'Ignores punter popularity entirely — ranks purely by model edge (confidence vs market-implied probability).',
    minGames: 4,
    maxGames: 20,
    eligible(p) {
      if ((p.confidence || 0) < 55) return { ok: false, reason: `Confidence ${p.confidence} below the 55 quality floor` };
      return { ok: true };
    },
    sortCmp: (a, b) => edge(b) - edge(a),
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 4, maxPerLeague: 5 }),
  },
  {
    key: 'pure_consensus',
    name: 'Pure Consensus',
    description: 'Only selections where 3 or more punters independently agree.',
    minGames: 3,
    maxGames: 20,
    eligible(p) {
      if ((p.count || 0) < 3) return { ok: false, reason: `Only ${p.count || 0} punter(s) agree (need 3+)` };
      return { ok: true };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 3, maxPerLeague: 5 }),
  },
  {
    key: 'zero_risk_mode',
    name: 'Zero Risk Mode',
    description: 'Rejects friendlies, youth football, women\'s games, reserve teams, unknown competitions, and any league below configured reliability.',
    minGames: 3,
    maxGames: 20,
    options: { excludeWomen: true },
    eligible(p, opts) {
      if (isFriendly(p)) return { ok: false, reason: 'Friendly fixture' };
      if (isYouthOrReserve(p)) return { ok: false, reason: 'Youth or reserve-team fixture' };
      if ((opts?.excludeWomen ?? true) && isWomen(p)) return { ok: false, reason: 'Women\'s fixture (excluded by config)' };
      if (!['ELITE', 'SAFE'].includes(p.leagueTier)) {
        return { ok: false, reason: `League tier "${p.leagueTier}" below configured reliability (needs ELITE/SAFE)` };
      }
      return { ok: true };
    },
    sortCmp: (a, b) => b.confidence - a.confidence,
    build: (pool) => greedyBuild(pool, { maxGames: 20, minGames: 3, maxPerLeague: 5 }),
  },
  {
    key: 'h2h_favorites',
    name: 'H2H Favorites',
    description: 'Pure moneyline only — Home or Away favourites, no Draw, no DC/Over-Under/BTTS. Prefers Draw No Bet over plain 1X2 on the same fixture when available (removes draw risk for a small odds premium). Odds 1.05–2.05 per leg, no leg cap (wide net across every league in the pool). Mirrors a manual low-odds moneyline slip.',
    minGames: 10,
    maxGames: 50,
    oddsCap: 2.05,
    eligible(p) {
      const dnb = isDNB(p);
      if (!is1X2(p) && !dnb) return { ok: false, reason: `Market "${p.marketName}" is not 1X2 or Draw No Bet — moneyline only` };
      const o = on(p);
      if (o !== 'home' && o !== 'away') return { ok: false, reason: `Outcome "${p.outcomeName}" is not Home/Away — no Draw picks` };
      if (p.odds < 1.05) return { ok: false, reason: `Odds ${p.odds} below 1.05 floor (too short to be meaningful)` };
      if (p.odds > 2.05) return { ok: false, reason: `Odds ${p.odds} exceed 2.05 ceiling — not a favourite anymore` };
      if ((p.confidence || 0) < 55) return { ok: false, reason: `Confidence ${p.confidence} below the 55 quality floor` };
      return { ok: true };
    },
    sortCmp: (a, b) => (b.confidence - a.confidence) || (a.odds - b.odds),
    // punterCap disabled (punterCap:1) — board-scanned favourites all share the
    // same '__MARKET__' source tag (intelligence-engine.js), so the default
    // per-punter diversity cap would collide and choke this down to ~8 legs.
    // Diversity here comes from maxPerLeague instead.
    build: (pool) => {
      // Prefer Draw No Bet over plain 1X2 for the same fixture+side — DNB
      // strictly dominates (identical pick, draw risk removed) for a small
      // odds premium, so drop the 1X2 row when both are eligible for one event.
      const bestPerSide = new Map();
      for (const p of pool) {
        const k = `${p.eventId}|${on(p)}`;
        const existing = bestPerSide.get(k);
        if (!existing || (isDNB(p) && !isDNB(existing))) bestPerSide.set(k, p);
      }
      return greedyBuild([...bestPerSide.values()], { maxGames: 50, minGames: 10, maxPerLeague: 3, punterCap: 1 });
    },
  },
];

const STRATEGY_MAP = new Map(STRATEGIES.map(s => [s.key, s]));

// ─── Reasoning / rejection text ────────────────────────────────────────────────
function buildChosenReason(p, strategyDef) {
  const bits = [];
  if ((p.count || 0) >= 2) bits.push(`${p.count} punters agree`);
  if (p.converted) bits.push(`converted from ${(p.conversionNote || '').split('→')[0].trim()}`);
  if (p._strategyConverted) bits.push(`re-priced to fit this ticket's odds cap`);
  bits.push(`${p.confidence}% confidence`);
  bits.push(`${p.marketLabel || p.marketName}`);
  return bits.join(' · ');
}

/**
 * Find a safer/comparable replacement for `target` from the full pool,
 * excluding events already used in this ticket.
 */
function findReplacement(fullPool, usedEventIds, target, strategyDef) {
  const candidates = fullPool
    .filter(p => !usedEventIds.has(p.eventId))
    .filter(p => strategyDef.eligible(p, strategyDef.options).ok)
    .filter(p => p.confidence > target.confidence)
    .sort((a, b) => (Math.abs(a.odds - target.odds) - Math.abs(b.odds - target.odds)) || (b.confidence - a.confidence));
  return candidates[0] || null;
}

// ─── On-demand odds-cap rescue conversion (bounded) ───────────────────────────
/**
 * For a small number of high-confidence picks that are excluded ONLY because
 * they exceed the strategy's own odds ceiling, try live conversion to a safer
 * market on the same event that fits under the cap. Bounded to `maxLookups`
 * live calls so a single strategy run can't hammer the odds API.
 */
async function rescueOddsCapMisses(nearMisses, oddsCap, maxLookups, deps, logger) {
  const rescued = [];
  let lookups = 0;
  for (const p of nearMisses) {
    if (lookups >= maxLookups) break;
    lookups++;
    try {
      const j = await sbGetEvent(p.eventId);
      if (!j || j.bizCode !== 10000 || !j.data) continue;
      const avail = (j.data.markets || []).flatMap(m =>
        (m.outcomes || []).filter(o => o.isActive === 1).map(o => ({
          marketId: m.id, marketName: m.desc || '', specifier: m.specifier || '',
          outcomeId: o.id, outcomeName: o.desc || '', odds: parseFloat(o.odds) || 0,
          productId: m.product || 3,
        }))
      );
      // Try the same safe-conversion families used pool-wide, but only accept
      // an alternative that also satisfies this strategy's odds cap.
      for (const cType of ['DC_1X', 'DC_X2', 'DNB_HOME', 'DNB_AWAY', 'OVER_1.5', 'OVER_2']) {
        const alt = findSafeMarket(avail, cType, p.homeTeam, p.awayTeam);
        if (!alt || alt.odds > oddsCap || alt.odds <= 1.01) continue;
        const newSafety = marketSafety(alt.marketName, alt.specifier, alt.outcomeName, p.homeTeam, p.awayTeam);
        if (newSafety < 0 || newSafety < (p.safety || 0)) continue;
        const oldNote = `${p.marketName}: ${p.outcomeName} @${p.odds}`;
        const rescuedPick = clone(p, {
          marketId: String(alt.marketId), marketName: alt.marketName, specifier: alt.specifier || '',
          outcomeId: String(alt.outcomeId), outcomeName: alt.outcomeName, odds: alt.odds,
          productId: alt.productId || 3, safety: newSafety,
          _strategyConverted: true,
          conversionNote: `${oldNote} → ${alt.marketName}: ${alt.outcomeName} (fitted to ticket odds cap)`,
          marketLabel: `${alt.marketName}${alt.specifier ? ' ' + alt.specifier : ''} → ${alt.outcomeName}`,
        });
        rescued.push(rescuedPick);
        logger && logger(`  ↻ Rescued: ${p.homeTeam} vs ${p.awayTeam} — ${rescuedPick.conversionNote}`);
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    } catch { /* skip on network error */ }
  }
  return rescued;
}

// ─── Ticket assembly ────────────────────────────────────────────────────────────
async function buildTicket(strategyDef, masterPool, generateCodeFn, logger = () => {}) {
  const opts = strategyDef.options || {};

  const evaluated = masterPool.map(p => ({ pick: p, verdict: strategyDef.eligible(p, opts) }));
  let eligiblePool = evaluated.filter(e => e.verdict.ok).map(e => e.pick);
  const rejected = evaluated.filter(e => !e.verdict.ok).map(e => ({ pick: e.pick, reason: e.verdict.reason }));

  eligiblePool = [...eligiblePool].sort(strategyDef.sortCmp);

  let picks = strategyDef.build(eligiblePool, opts);

  // Odds-cap rescue: if we're short of minGames and the strategy has a hard
  // per-leg odds ceiling, try to reclaim a few close misses via live conversion.
  if (strategyDef.oddsCap && picks.length < strategyDef.minGames) {
    const usedIds = new Set(picks.map(p => p.eventId));
    const nearMisses = rejected
      .map(r => r.pick)
      .filter(p => !usedIds.has(p.eventId) && p.odds > strategyDef.oddsCap && p.odds <= strategyDef.oddsCap * 1.6 && (p.confidence || 0) >= 70)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);
    if (nearMisses.length) {
      const rescued = await rescueOddsCapMisses(nearMisses, strategyDef.oddsCap, 5, {}, logger);
      if (rescued.length) {
        const merged = [...picks, ...rescued].sort(strategyDef.sortCmp);
        picks = strategyDef.build(merged, opts);
      }
    }
  }

  // Picks that PASSED eligibility but still didn't make the final ticket —
  // cut by the game cap, league/punter diversity limits, or rank cutoff
  // (e.g. Top 10/20). These are just as much a "why was this rejected" answer
  // as the picks that failed eligible() outright.
  const finalIds = new Set(picks.map(p => p.eventId));
  const buildCut = eligiblePool
    .filter(p => !finalIds.has(p.eventId))
    .map(p => ({ pick: p, reason: `Eligible, but not selected — outranked or capped by this strategy's game/league/punter limits` }));
  const allRejected = [...rejected, ...buildCut];

  const rejectionSummary = {};
  for (const r of allRejected) {
    const cat = (r.reason || '').split(' ').slice(0, 3).join(' ');
    rejectionSummary[cat] = (rejectionSummary[cat] || 0) + 1;
  }
  const rejectionSample = allRejected
    .sort((a, b) => (b.pick.confidence || 0) - (a.pick.confidence || 0))
    .slice(0, 10)
    .map(r => ({ home: r.pick.homeTeam, away: r.pick.awayTeam, league: r.pick.league, confidence: r.pick.confidence, reason: r.reason }));

  if (picks.length < strategyDef.minGames) {
    return {
      key: strategyDef.key, name: strategyDef.name, description: strategyDef.description,
      skipped: true,
      reason: `Only ${picks.length} qualifying game(s) today — need at least ${strategyDef.minGames} for this strategy.`,
      gameCount: picks.length,
      rejections: { summary: rejectionSummary, sample: rejectionSample },
    };
  }

  // Post, then read the code straight back and verify every leg's odds
  // against the LIVE outcomes[] market data — never trust the pre-post
  // snapshot. This is the only place a code actually gets created, so this
  // is the only place odds can be reported as real. See intel.verifyAndPostTicket
  // for why `ticket.selections` must never be used for this.
  const oddsCap = strategyDef.oddsCap || 2.2;
  let verifiedResult = null, genError = null;
  try {
    verifiedResult = await intel.verifyAndPostTicket(picks, oddsCap, 3, logger);
  } catch (e) {
    genError = e.message;
  }
  if (!verifiedResult) {
    return {
      key: strategyDef.key, name: strategyDef.name, description: strategyDef.description,
      skipped: true,
      reason: genError
        ? `Code generation failed: ${genError}`
        : `Live odds verification failed — too many legs drifted outside the odds cap after posting; no clean code could be produced.`,
      gameCount: picks.length,
      rejections: { summary: rejectionSummary, sample: rejectionSample },
    };
  }

  const finalPicks = verifiedResult.picks;
  const usedEventIds = new Set(finalPicks.map(p => p.eventId));
  const sorted = [...finalPicks].sort((a, b) => a.confidence - b.confidence);
  const weakest = sorted[0];
  const strongest = sorted[sorted.length - 1];
  const avgConfidence = Math.round(finalPicks.reduce((s, p) => s + (p.confidence || 0), 0) / finalPicks.length);
  const totalOdds = verifiedResult.totalOdds; // verified live product, not the stale snapshot product
  const survivalPct = Math.round(finalPicks.reduce((acc, p) => acc * (p.confidence / 100), 1) * 10000) / 100;

  const conversions = finalPicks.filter(p => p.converted || p._strategyConverted).map(p => ({
    home: p.homeTeam, away: p.awayTeam, note: p.conversionNote,
    source: p._strategyConverted ? 'strategy-time (odds-cap fit)' : 'pool-time (risk reduction)',
  }));

  const replacement = findReplacement(masterPool, usedEventIds, weakest, strategyDef);

  return {
    key: strategyDef.key, name: strategyDef.name, description: strategyDef.description,
    skipped: false,
    code: verifiedResult.code, url: verifiedResult.url,
    genError: null,
    oddsVerifiedAt: new Date().toISOString(),
    oddsDroppedForDrift: verifiedResult.dropped,
    gameCount: finalPicks.length, totalOdds, avgConfidence, minConfidence: weakest.confidence,
    survivalPct,
    weakestPick: { home: weakest.homeTeam, away: weakest.awayTeam, league: weakest.league, market: weakest.marketLabel, odds: weakest.odds, confidence: weakest.confidence },
    strongestPick: { home: strongest.homeTeam, away: strongest.awayTeam, league: strongest.league, market: strongest.marketLabel, odds: strongest.odds, confidence: strongest.confidence },
    picks: finalPicks.map(p => ({
      home: p.homeTeam, away: p.awayTeam, league: p.league, market: p.marketLabel || p.marketName,
      odds: p.odds, confidence: p.confidence, punter: p.punter, punters: p.punters, consensus: p.count,
      converted: !!(p.converted || p._strategyConverted), conversionNote: p.conversionNote || null,
      kickoff: p.kickoff, reason: buildChosenReason(p, strategyDef),
      oddsVerifiedAt: p.oddsVerifiedAt,
    })),
    conversions,
    rejections: { summary: rejectionSummary, sample: rejectionSample },
    replacement: replacement ? {
      forWeakest: `${weakest.homeTeam} vs ${weakest.awayTeam}`,
      suggestion: `${replacement.homeTeam} vs ${replacement.awayTeam} — ${replacement.marketLabel} @${replacement.odds} (conf ${replacement.confidence})`,
    } : null,
  };
}

// ─── Risk ranking ───────────────────────────────────────────────────────────────
function computeRiskScore(ticket) {
  if (ticket.skipped) return Infinity;
  const legPenalty = Math.min(30, ticket.gameCount * 0.6);
  const oddsPenalty = Math.min(25, Math.log(Math.max(1, ticket.totalOdds)) * 3);
  return (100 - ticket.avgConfidence) * 0.45 + (100 - ticket.minConfidence) * 0.35 + legPenalty * 0.12 + oddsPenalty * 0.08;
}

function rankTickets(tickets) {
  const withScore = tickets.map(t => ({ ...t, riskScore: t.skipped ? null : Math.round(computeRiskScore(t) * 100) / 100 }));
  const ranked = withScore.filter(t => !t.skipped).sort((a, b) => a.riskScore - b.riskScore);
  ranked.forEach((t, i) => { t.riskRank = i + 1; });
  const skipped = withScore.filter(t => t.skipped);
  const top3 = ranked.slice(0, 3).map(t => ({
    key: t.key, name: t.name, riskRank: t.riskRank, avgConfidence: t.avgConfidence,
    minConfidence: t.minConfidence, gameCount: t.gameCount, totalOdds: t.totalOdds,
    rationale: `#${t.riskRank} safest — ${t.avgConfidence}% avg / ${t.minConfidence}% floor across ${t.gameCount} legs (${t.totalOdds}x).`,
  }));
  return { ranked: [...ranked, ...skipped], top3 };
}

// ─── H2H Favorites: refine a pasted booking code leg-by-leg ───────────────────
// Unlike the pool-based strategy above, a pasted code's legs have no model
// confidence score — so this checks only the structural rules (market type,
// side, odds band) and, for legs that fail, looks up the event's LIVE markets
// to see if a Home/Away 1X2 or DNB pick within the same odds band exists.
// Legs that already fit are left alone — this never touches a leg that's
// already a clean Home/Away favourite.
const H2H_ODDS_FLOOR = 1.05, H2H_ODDS_CEIL = 2.05;

function h2hLegVerdict(sel) {
  const m = (sel.market || '').toLowerCase().trim();
  const o = (sel.outcome || '').toLowerCase().trim();
  const rightMarket = m === 'match winner' || m === '1x2' || m === 'home/away' ||
    m.includes('draw no bet') || m.includes('home no draw');
  const rightSide = o === 'home' || o === 'away';
  const inRange = sel.odds >= H2H_ODDS_FLOOR && sel.odds <= H2H_ODDS_CEIL;
  if (rightMarket && rightSide && inRange) return { ok: true };
  const reasons = [];
  if (!rightMarket) reasons.push(`market "${sel.market}" isn't 1X2/DNB`);
  else if (!rightSide) reasons.push(`outcome "${sel.outcome}" is a Draw pick`);
  if (rightMarket && rightSide && !inRange) reasons.push(`odds ${sel.odds} outside ${H2H_ODDS_FLOOR}-${H2H_ODDS_CEIL}`);
  return { ok: false, reason: reasons.join('; ') };
}

// Among an event's live markets, find the best Home/Away 1X2/DNB pick in band
// — DNB preferred over plain 1X2 for the same side, then lowest odds wins.
function pickBestFavorite(avail, homeTeam, awayTeam) {
  let best = null, bestIsDnb = false;
  for (const m of (avail || [])) {
    if (isTeamScopedMarket(m.marketName, homeTeam, awayTeam)) continue;
    const mn = (m.marketName || '').toLowerCase();
    const on_ = (m.outcomeName || '').toLowerCase();
    const isDnbMkt = mn.includes('draw no bet') || mn.includes('home no draw');
    const isPlain1X2 = mn === 'match winner' || mn === '1x2' || mn === 'home/away';
    if (!(isPlain1X2 || isDnbMkt)) continue;
    if (on_ !== 'home' && on_ !== 'away') continue;
    if (!m.odds || m.odds < H2H_ODDS_FLOOR || m.odds > H2H_ODDS_CEIL) continue;
    if (!best || (isDnbMkt && !bestIsDnb) || (isDnbMkt === bestIsDnb && m.odds < best.odds)) {
      best = m; bestIsDnb = isDnbMkt;
    }
  }
  return best;
}

/**
 * fetchEventMarkets(eventId) => Promise<[{marketName, outcomeName, odds, specifier, marketId, outcomeId}]>
 * is injected by the caller (server.js) so this module stays free of HTTP concerns.
 */
async function refineTicketForH2HFavorites(selections, fetchEventMarkets) {
  const results = [];
  for (const sel of selections) {
    const verdict = h2hLegVerdict(sel);
    if (verdict.ok) {
      results.push({ ...sel, verdict: 'KEEP', reason: 'Already fits H2H Favorites — 1X2/DNB, Home or Away, odds in range' });
      continue;
    }
    try {
      const avail = await fetchEventMarkets(sel.eventId);
      const alt = pickBestFavorite(avail, sel.homeTeam, sel.awayTeam);
      if (alt) {
        results.push({
          ...sel, verdict: 'EDIT', reason: verdict.reason,
          suggestion: { marketName: alt.marketName, outcomeName: alt.outcomeName, odds: alt.odds, marketId: alt.marketId, outcomeId: alt.outcomeId, specifier: alt.specifier || '' },
        });
      } else {
        results.push({ ...sel, verdict: 'DROP', reason: `${verdict.reason} — no safe Home/Away favourite available on this fixture` });
      }
    } catch (e) {
      results.push({ ...sel, verdict: 'DROP', reason: `${verdict.reason} — couldn't check live markets (${e.message})` });
    }
    await new Promise(r => setTimeout(r, 200)); // stagger — don't hammer SportyBet
  }
  const summary = {
    keep: results.filter(r => r.verdict === 'KEEP').length,
    edit: results.filter(r => r.verdict === 'EDIT').length,
    drop: results.filter(r => r.verdict === 'DROP').length,
  };
  return { legs: results, summary };
}

// ─── Public API ─────────────────────────────────────────────────────────────────

async function runStrategy(key, masterPool, generateCodeFn, logger) {
  const def = STRATEGY_MAP.get(key);
  if (!def) throw new Error(`Unknown strategy: ${key}`);
  return buildTicket(def, masterPool, generateCodeFn, logger);
}

async function runAllStrategies(masterPool, generateCodeFn, logger = () => {}) {
  const tickets = [];
  for (const def of STRATEGIES) {
    logger(`Building ${def.name}...`);
    try {
      const ticket = await buildTicket(def, masterPool, generateCodeFn, logger);
      tickets.push(ticket);
      logger(ticket.skipped ? `  ⚠ ${def.name}: ${ticket.reason}` : `  ✓ ${def.name}: ${ticket.code} — ${ticket.gameCount}g @${ticket.totalOdds}x (${ticket.avgConfidence}% avg)`);
    } catch (e) {
      tickets.push({ key: def.key, name: def.name, description: def.description, skipped: true, reason: `Error: ${e.message}` });
      logger(`  ✗ ${def.name}: ERROR — ${e.message}`);
    }
  }
  const { ranked, top3 } = rankTickets(tickets);
  return { strategies: ranked, top3 };
}

function listStrategies() {
  return STRATEGIES.map(s => ({ key: s.key, name: s.name, description: s.description }));
}

module.exports = { runStrategy, runAllStrategies, listStrategies, STRATEGIES, refineTicketForH2HFavorites };
