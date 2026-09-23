/**
 * market-scanner.js — Broad market scanner
 *
 * The punter-code pipeline (intelligence-engine.js runAnalysis) only ever
 * sees the markets punters happened to pick. This module scans SportyBet's
 * full upcoming-football feed directly — every match, not just the ones in
 * a punter's code — scored with the same calibrated intelligence, so the
 * "surest" pick for a given game can be found even if no punter backed it.
 *
 * Only full-match, well-calibrated market types are requested (1X2, Double
 * Chance, Draw No Bet, Over/Under, GG/NG) — team-scoped totals never enter
 * this pool at all since marketId 19 ("{Team} Over/Under") is never
 * requested in the first place.
 */
'use strict';
const https = require('https');
const intel = require('./intelligence-engine');
const {
  marketSafety, masterScore, classifyRisk, findSafeMarket, SAFE_CONVERSIONS,
  getLine, leagueTier, loadIntelDeps, isTeamScopedMarket,
} = intel;

const FOOTBALL_SPORT_ID = 'sr:sport:1';
// 1=1X2, 10=Double Chance, 11=Draw No Bet, 18=Over/Under (full match, all lines), 29=GG/NG
const SAFE_MARKET_IDS = '1,10,11,18,29';

const WOMEN_RE    = /\b(women|female|ladies|girls|dames|frauen|femmes|femenin|femenino|feminino)\b/i;
const YOUTH_RE    = /\bu1[6-9]\b|\bu2[0-3]\b|\byouth\b|\breserves?\b/i;
const FRIENDLY_RE = /\bfriendly\b|\bfriendlies\b/i;

function sbGetUpcoming(pageNum, pageSize) {
  return new Promise((resolve, reject) => {
    const p = `/api/ng/factsCenter/pcUpcomingEvents?sportId=${FOOTBALL_SPORT_ID}&marketId=${SAFE_MARKET_IDS}&pageSize=${pageSize}&pageNum=${pageNum}`;
    const req = https.get({
      hostname: 'www.sportybet.com', path: p,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Pages through the full upcoming-football feed and returns every event
 * kicking off within `maxHoursAhead` hours, deduplicated.
 */
async function fetchAllUpcoming(maxHoursAhead = 30, logger = () => {}) {
  const now = Date.now();
  const cutoff = now + maxHoursAhead * 3600000;
  const events = [];
  const seen = new Set();
  let page = 1, totalNum = Infinity;
  while ((page - 1) * 100 < totalNum && page <= 15) {
    let j;
    try { j = await sbGetUpcoming(page, 100); } catch (e) { logger(`  page ${page}: fetch error — ${e.message}`); break; }
    if (!j || j.bizCode !== 10000 || !j.data) break;
    totalNum = j.data.totalNum || 0;
    for (const t of (j.data.tournaments || [])) {
      for (const ev of (t.events || [])) {
        if (seen.has(ev.eventId)) continue;
        seen.add(ev.eventId);
        events.push(ev);
      }
    }
    logger(`  page ${page}/${Math.ceil(totalNum / 100)}: ${events.length}/${totalNum} events collected so far`);
    page++;
    await new Promise(r => setTimeout(r, 150));
  }
  return events.filter(ev =>
    ev.estimateStartTime > now && ev.estimateStartTime <= cutoff &&
    (ev.matchStatus || '').toLowerCase() === 'not start'
  );
}

function isBannedLeague(league) {
  if (WOMEN_RE.test(league || '')) return true;
  if (YOUTH_RE.test(league || '')) return true;
  if (FRIENDLY_RE.test(league || '')) return true;
  return false;
}

// League-level checks miss a youth/reserve squad competing in an otherwise
// normal senior division (common in Baltic/Nordic lower tiers, e.g. a club's
// "U21" or "II" side playing in the regular league pyramid) — check the
// team names themselves too.
const TEAM_YOUTH_RE = /\bu1[6-9]\b|\bu2[0-3]\b|\breserves?\b|\byouth\b|\b(ii|2)$/i;
function isBannedTeam(homeTeam, awayTeam) {
  return TEAM_YOUTH_RE.test((homeTeam || '').trim()) || TEAM_YOUTH_RE.test((awayTeam || '').trim());
}

/**
 * Flattens one event's `markets` array (as returned by pcUpcomingEvents)
 * into individual candidate selections, in the same shape the rest of the
 * intelligence engine expects.
 */
function extractCandidates(ev) {
  const league = ev.sport?.category?.tournament?.name || '';
  const category = ev.sport?.category?.name || '';
  const out = [];
  for (const m of (ev.markets || [])) {
    if (isTeamScopedMarket(m.desc, ev.homeTeamName, ev.awayTeamName)) continue; // defense in depth
    for (const o of (m.outcomes || [])) {
      if (o.isActive !== 1) continue;
      const odds = parseFloat(o.odds) || 0;
      if (odds <= 1.01 || odds > 2.0) continue; // odds cap, same rule as the punter-code pool
      out.push({
        eventId: String(ev.eventId), homeTeam: ev.homeTeamName || '', awayTeam: ev.awayTeamName || '',
        league, category, kickoff: new Date(ev.estimateStartTime).toISOString(), kick: ev.estimateStartTime,
        marketId: String(m.id), marketName: m.desc || '', specifier: m.specifier || '',
        outcomeId: String(o.id), outcomeName: o.desc || '', odds,
        productId: m.product || 3, sportId: FOOTBALL_SPORT_ID,
        matchKey: `${ev.eventId}|${m.id}|${m.specifier || ''}|${o.id}`,
      });
    }
  }
  return out;
}

/**
 * Scans the full live market feed and returns the single best (highest-
 * confidence, safety-converted) pick per event, scored with the exact same
 * intelligence used for punter-code picks — just without punter-specific
 * bonuses, since no punter is attached to these.
 */
async function scanMarkets(opts = {}, logger = () => {}) {
  const maxHoursAhead = opts.maxHoursAhead || 30;
  logger(`Fetching live market feed (next ${maxHoursAhead}h)…`);
  const events = await fetchAllUpcoming(maxHoursAhead, logger);
  logger(`✓ ${events.length} matches in window`);

  const deps = loadIntelDeps(logger);

  const results = [];
  const excluded = [];
  for (const ev of events) {
    const league = ev.sport?.category?.tournament?.name || '';
    if (isBannedLeague(league)) { excluded.push({ game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, reason: 'banned league (women/youth/reserve/friendly)' }); continue; }
    if (isBannedTeam(ev.homeTeamName, ev.awayTeamName)) { excluded.push({ game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, reason: 'youth/reserve squad' }); continue; }
    const tier = leagueTier(league, deps.leagueIntel);
    if (['BLACKLIST', 'DANGER', 'VOLATILE'].includes(tier)) { excluded.push({ game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, reason: `league tier ${tier}` }); continue; }

    const candidates = extractCandidates(ev);
    if (!candidates.length) continue;

    // Score every candidate market for this event with the neutral synthetic punter.
    let best = null, bestScore = -1;
    for (const c of candidates) {
      const sel = { ...c, punter: '__MARKET__', punters: ['__MARKET__'], count: 1 };
      const safety = marketSafety(sel.marketName, sel.specifier, sel.outcomeName, sel.homeTeam, sel.awayTeam);
      if (safety < 0) continue;
      const score = masterScore(sel, deps);
      if (score > bestScore) { bestScore = score; best = { ...sel, _safety: safety, _score: score }; }
    }
    if (!best || best._score < 42) { excluded.push({ game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, reason: `confidence too low (${best ? best._score : 'n/a'})` }); continue; }

    // Try to convert to something safer if the best pick is still a risky type
    // (e.g. straight 1X2 win, or a GG/high goal-line) using this event's OWN
    // already-fetched markets — no extra network call needed.
    const risk = classifyRisk(best.marketName, best.specifier, best.outcomeName);
    if (risk === 'REMOVE') { excluded.push({ game: `${ev.homeTeamName} vs ${ev.awayTeamName}`, reason: 'hard-removed market' }); continue; }
    if (risk !== 'OK') {
      const avail = candidates.map(c => ({
        marketId: c.marketId, marketName: c.marketName, specifier: c.specifier,
        outcomeId: c.outcomeId, outcomeName: c.outcomeName, odds: c.odds, productId: c.productId,
      }));
      const convTypes = SAFE_CONVERSIONS[risk] || [];
      for (const cType of convTypes) {
        const alt = findSafeMarket(avail, cType, ev.homeTeamName, ev.awayTeamName);
        if (!alt) continue;
        const newSafety = marketSafety(alt.marketName, alt.specifier, alt.outcomeName, ev.homeTeamName, ev.awayTeamName);
        if (newSafety < 0 || newSafety <= best._safety) continue;
        if (alt.odds <= 1.01 || alt.odds > 2.0) continue;
        const trial = { ...best, marketId: String(alt.marketId), marketName: alt.marketName, specifier: alt.specifier || '',
          outcomeId: String(alt.outcomeId), outcomeName: alt.outcomeName, odds: alt.odds, productId: alt.productId || 3 };
        const trialScore = masterScore(trial, deps);
        if (trialScore < best._score) continue;
        best = { ...trial, _safety: newSafety, _score: trialScore, _converted: true,
          _conversionNote: `${best.marketName}: ${best.outcomeName} @${best.odds} → ${alt.marketName}: ${alt.outcomeName}` };
        break;
      }
    }
    results.push({
      eventId: best.eventId, homeTeam: best.homeTeam, awayTeam: best.awayTeam,
      league, category: best.category, kickoff: best.kickoff, kick: best.kick,
      marketId: best.marketId, marketName: best.marketName, specifier: best.specifier,
      outcomeId: best.outcomeId, outcomeName: best.outcomeName, odds: best.odds,
      productId: best.productId, sportId: best.sportId, matchKey: best.matchKey,
      confidence: Math.min(100, Math.max(0, best._score)),
      safety: best._safety, originalOdds: best.odds,
      punter: null, punters: [], count: 0,
      converted: best._converted || false, conversionNote: best._conversionNote || null,
      leagueTier: tier,
      marketLabel: `${best.marketName}${best.specifier ? ' ' + best.specifier : ''} → ${best.outcomeName}`,
      source: 'market-scan',
      // Snapshot, not gospel — see verifyOddsBeforePosting() in intelligence-engine.js.
      oddsSnapshotAt: new Date().toISOString(),
      oddsVerified: false,
    });
  }

  results.sort((a, b) => b.confidence - a.confidence);
  logger(`✓ Market scan: ${results.length} games eligible, ${excluded.length} excluded`);
  return { pool: results, excluded, stats: { scanned: events.length, eligible: results.length, excludedCount: excluded.length } };
}

module.exports = { scanMarkets, fetchAllUpcoming };
