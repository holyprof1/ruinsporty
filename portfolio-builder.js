'use strict';

// ─── Portfolio Builder — SlipPilot Phase 3 ───────────────────────────────────
// Accepts a master pool of picks and generates N validated SportyBet booking
// codes with full per-pick analysis.

const DEFAULT_OPTS = {
  count: 1,
  minGames: 12,
  maxGames: 20,
  todayOnly: false,
  kickoffStart: null,
  kickoffEnd: null,
  sortBy: 'confidence',
  maxOddsPerPick: 2.0,
  minConfidence: 55,
  convertRisky: false,
  footballOnly: true,
  removeFriendlies: true,
  removeBanned: true,
  preferConsensus: false,
  topPuntersOnly: false,
  maxRepeat: 1,
  strategy: 'balanced',
};

// Markets that are always banned regardless of options
const BANNED_MARKET_FRAGMENTS = [
  'correct score',
  'exact goals',
  'both halves under',
  'half time/full time',
];

// League-name patterns that are always banned (when removeBanned is true)
const BANNED_LEAGUE_PATTERNS = [
  /\bu17\b/i,
  /\bu19\b/i,
  /\bu20\b/i,
  /\bu21\b/i,
  /\bu23\b/i,
  /\byouth\b/i,
  /\bwomens?\b/i,
  /\bfemale\b/i,
  /\breserves?\b/i,
  /\bnwsl\b/i,
  /national\s+womens?\s+soccer/i,
];

const FRIENDLY_PATTERN = /\bfriendly\b/i;

const BANNED_LEAGUE_TIERS = new Set(['BLACKLIST', 'DANGER', 'VOLATILE']);

// SportId for football on SportyBet / Sportradar
const FOOTBALL_SPORT_ID = 'sr:sport:1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return today's date in WAT (UTC+1) as { start, end } — both Date objects.
 * start = today 00:00 WAT, end = tomorrow 00:00 WAT.
 */
function todayRangeWAT() {
  const now = new Date();
  // WAT offset in ms
  const WAT_OFFSET_MS = 60 * 60 * 1000; // UTC+1
  // Convert "now" to WAT civil time
  const nowWAT = new Date(now.getTime() + WAT_OFFSET_MS);

  // Build WAT midnight as a UTC timestamp
  const startWAT = Date.UTC(
    nowWAT.getUTCFullYear(),
    nowWAT.getUTCMonth(),
    nowWAT.getUTCDate(),
    0, 0, 0, 0
  ) - WAT_OFFSET_MS;

  const endWAT = startWAT + 24 * 60 * 60 * 1000;

  return { start: new Date(startWAT), end: new Date(endWAT) };
}

function normalise(str) {
  return (str || '').toLowerCase().trim();
}

function isBannedMarket(pick) {
  const mkt = normalise(pick.marketName);
  for (const frag of BANNED_MARKET_FRAGMENTS) {
    if (mkt.includes(frag)) return true;
  }
  // BTTS mislabeled: outcomeName 'Yes' inside an Over/Under market
  if (
    normalise(pick.outcomeName) === 'yes' &&
    mkt.includes('over/under')
  ) {
    return true;
  }
  return false;
}

function isBannedLeague(pick, opts) {
  if (!opts.removeBanned) return false;

  // Tier-based ban
  if (BANNED_LEAGUE_TIERS.has(pick.leagueTier)) return true;

  const league = normalise(pick.league);

  // Age group / gender / reserve
  for (const pat of BANNED_LEAGUE_PATTERNS) {
    if (pat.test(league)) return true;
  }

  // Friendly
  if (opts.removeFriendlies && FRIENDLY_PATTERN.test(league)) return true;

  return false;
}

/**
 * Build the reason string for a pick.
 */
function buildReason(pick) {
  if (pick.converted) {
    return pick.conversionNote || 'Converted to safer market';
  }
  if (pick.killerWarning) {
    return 'Kept despite warning: ' + pick.killerWarning;
  }
  if ((pick.count || 0) >= 3) {
    return 'Consensus pick (' + pick.count + ' punters)';
  }
  if ((pick.confidence || 0) >= 80) {
    return 'High confidence (' + pick.confidence + '%)';
  }
  return 'Selected by optimizer';
}

/**
 * Shape a raw pool item into the output pick format.
 */
function shapePick(item) {
  return {
    homeTeam: item.homeTeam,
    awayTeam: item.awayTeam,
    league: item.league,
    kickoff: item.kickoff,
    originalMarket: item.marketName,
    originalOdds: item.originalOdds != null ? item.originalOdds : item.odds,
    originalOutcome: item.outcomeName,
    finalMarket: item.marketName,
    finalOdds: item.odds,
    finalOutcome: item.outcomeName,
    converted: item.converted || false,
    conversionNote: item.conversionNote || null,
    confidence: item.confidence || 0,
    reason: buildReason(item),
    killerWarning: item.killerWarning || null,
    consensus: item.count || 0,
  };
}

/**
 * Build the selections array expected by generateCodeFn from pool items.
 */
function buildSelections(items) {
  return items.map((item) => ({
    eventId: item.eventId,
    marketId: item.marketId,
    specifier: item.specifier || '',
    outcomeId: item.outcomeId,
    odds: item.odds,
    productId: item.productId || 1,
    sportId: item.sportId,
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build a portfolio of N SportyBet booking codes from the master pool.
 *
 * @param {object[]} masterPool   - Array of pool items (see spec)
 * @param {object}   opts         - Options (see DEFAULT_OPTS)
 * @param {Function} generateCodeFn - async (selections) => { code, url }
 * @param {Function|null} log     - progress callback(msg), may be null
 * @returns {Promise<{ success: boolean, codes: object[], warnings: string[], stats: object }>}
 */
async function buildPortfolio(masterPool, opts, generateCodeFn, log) {
  // ── Merge options with defaults ────────────────────────────────────────────
  const options = Object.assign({}, DEFAULT_OPTS, opts || {});

  const emit = typeof log === 'function' ? log : () => {};
  const warnings = [];

  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
  options.count = clamp(options.count, 1, 20);
  options.minGames = Math.max(1, options.minGames);
  options.maxGames = Math.max(options.minGames, options.maxGames);

  const poolSize = Array.isArray(masterPool) ? masterPool.length : 0;

  // ── Guard: empty pool ──────────────────────────────────────────────────────
  if (poolSize === 0) {
    warnings.push('Master pool is empty — no codes generated.');
    return {
      success: false,
      codes: [],
      warnings,
      stats: {
        poolSize: 0,
        filteredSize: 0,
        codesRequested: options.count,
        codesGenerated: 0,
        warnings,
      },
    };
  }

  // ── Step 1: Apply filters ──────────────────────────────────────────────────
  emit('Applying filters...');

  const { start: todayStart, end: todayEnd } = todayRangeWAT();

  let pool = masterPool.filter((item) => {
    // Football only
    if (options.footballOnly && item.sportId !== FOOTBALL_SPORT_ID) {
      return false;
    }

    // Today only (WAT)
    if (options.todayOnly) {
      const ko = new Date(item.kickoff);
      if (ko < todayStart || ko >= todayEnd) return false;
    }

    // Kickoff window
    if (options.kickoffStart) {
      const koStart = new Date(options.kickoffStart);
      if (new Date(item.kickoff) < koStart) return false;
    }
    if (options.kickoffEnd) {
      const koEnd = new Date(options.kickoffEnd);
      if (new Date(item.kickoff) >= koEnd) return false;
    }

    // Banned leagues / tiers
    if (isBannedLeague(item, options)) return false;

    // Banned markets (always applied)
    if (isBannedMarket(item)) return false;

    // Max odds
    if (item.odds > options.maxOddsPerPick) return false;

    // Min confidence
    if ((item.confidence || 0) < options.minConfidence) return false;

    // Top punters only
    if (options.topPuntersOnly) {
      const tier = (item.punterTier || '').toUpperCase();
      if (tier !== 'ELITE' && tier !== 'RELIABLE') return false;
    }

    return true;
  });

  const filteredSize = pool.length;

  if (filteredSize === 0) {
    warnings.push('All picks were filtered out — no codes generated.');
    return {
      success: false,
      codes: [],
      warnings,
      stats: {
        poolSize,
        filteredSize: 0,
        codesRequested: options.count,
        codesGenerated: 0,
        warnings,
      },
    };
  }

  // ── Step 2: Sort pool ──────────────────────────────────────────────────────

  // preferConsensus / strategy === 'consensus' pre-sort by count desc
  const useConsensusSort =
    options.preferConsensus || options.strategy === 'consensus';

  if (useConsensusSort) {
    pool.sort((a, b) => (b.count || 0) - (a.count || 0));
  } else {
    switch (options.sortBy) {
      case 'kickoff':
        pool.sort(
          (a, b) => new Date(a.kickoff) - new Date(b.kickoff)
        );
        break;
      case 'odds':
        pool.sort((a, b) => a.odds - b.odds);
        break;
      case 'confidence':
      default:
        pool.sort(
          (a, b) => (b.confidence || 0) - (a.confidence || 0)
        );
        break;
    }
  }

  // strategy overrides for ordering
  if (options.strategy === 'safe') {
    pool.sort((a, b) => a.odds - b.odds);
  } else if (options.strategy === 'high_odds') {
    pool.sort((a, b) => b.odds - a.odds);
  }
  // 'balanced' leaves the primary sort intact

  // ── Step 3: Build codes ────────────────────────────────────────────────────

  // Track match diversity across all codes
  const usedMatchKeys = new Map(); // matchKey -> times used

  const codes = [];

  for (let i = 0; i < options.count; i++) {
    const codeIndex = i + 1;
    emit(`Building code ${codeIndex}/${options.count}...`);

    // Pick items for this code (diversity-aware + rotation)
    const selected = [];
    for (const item of pool) {
      if (selected.length >= options.maxGames) break;

      const key = item.matchKey || `${item.eventId}`;
      const timesUsed = usedMatchKeys.get(key) || 0;
      if (timesUsed >= options.maxRepeat) continue;

      selected.push(item);
    }

    // Validate minimum games
    if (selected.length < options.minGames) {
      const msg = `Code ${codeIndex}: only ${selected.length} picks available (minGames=${options.minGames}) — skipped.`;
      warnings.push(msg);
      emit('Warning: ' + msg);
      continue;
    }

    // Update diversity map
    for (const item of selected) {
      const key = item.matchKey || `${item.eventId}`;
      usedMatchKeys.set(key, (usedMatchKeys.get(key) || 0) + 1);
    }

    // Rotate selected picks to end of pool — forces next code to start with fresh picks
    const usedKeys = new Set(selected.map(item => item.matchKey || `${item.eventId}`));
    pool = [
      ...pool.filter(item => !usedKeys.has(item.matchKey || `${item.eventId}`)),
      ...pool.filter(item => usedKeys.has(item.matchKey || `${item.eventId}`)),
    ];

    // Call SportyBet code generator
    emit(`Validating...`);
    const selections = buildSelections(selected);
    let codeResult;
    try {
      codeResult = await generateCodeFn(selections);
    } catch (err) {
      const msg = `Code ${codeIndex}: generateCodeFn failed — ${err && err.message ? err.message : String(err)}`;
      warnings.push(msg);
      emit('Warning: ' + msg);
      continue;
    }

    if (!codeResult || !codeResult.code) {
      const msg = `Code ${codeIndex}: generateCodeFn returned no code — skipped.`;
      warnings.push(msg);
      emit('Warning: ' + msg);
      continue;
    }

    // Compute aggregate stats
    const totalOdds = selected.reduce((acc, item) => acc * item.odds, 1);
    const avgConfidence =
      selected.reduce((acc, item) => acc + (item.confidence || 0), 0) /
      selected.length;

    codes.push({
      code: codeResult.code,
      url: codeResult.url || null,
      gameCount: selected.length,
      totalOdds: Math.round(totalOdds * 100) / 100,
      avgConfidence: Math.round(avgConfidence),
      picks: selected.map(shapePick),
    });
  }

  emit('Done.');

  const success = codes.length > 0;

  if (!success && warnings.length === 0) {
    warnings.push('No codes were generated.');
  }

  return {
    success,
    codes,
    warnings,
    stats: {
      poolSize,
      filteredSize,
      codesRequested: options.count,
      codesGenerated: codes.length,
      warnings,
    },
  };
}

module.exports = { buildPortfolio };
