// intent-engine.js — SlipPilot Conversational Intent Engine v2
// Understands natural language: no LLM, regex + structured classification.
// Handles booking-code modification AND pool-based generation, intelligence queries, content.
// Channel-agnostic: inject network deps via engineDeps object.
'use strict';

const norm = (s) => (s || '').toLowerCase().replace(/[''']/g, "'").trim();
const includes = (h, n) => norm(h).includes(norm(n));

const NUM_WORDS = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,twelve:12,fifteen:15,twenty:20 };
function parseNumber(raw) {
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/,/g,''));
  if (!isNaN(n)) return n;
  return NUM_WORDS[String(raw).toLowerCase()] ?? null;
}

const MARKET_KEYWORDS = ['under','over','btts','both teams to score','draw no bet','handicap','double chance','1x2','gg/ng','correct score','clean sheet'];
function looksLikeMarket(phrase) { return MARKET_KEYWORDS.some(k => norm(phrase).includes(k)); }

function splitClauses(text) {
  return norm(text).split(/,|;|(?:\band\b)/).map(s => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP-LEVEL INTENT CLASSIFICATION
// Returns one of: SCAN | MODIFY | BUILD | COMPARE | INTELLIGENCE | CONTENT | EXPLAIN | UNKNOWN
// ─────────────────────────────────────────────────────────────────────────────
function classifyIntent(text) {
  const t = norm(text);

  // SCAN — verify/check result of a specific code
  if (/\b(scan|verify|check.{0,10}code|status|did.{0,5}(win|lose)|is.{0,10}(correct|true|real|won)|won\?|correct\?)\b/.test(t))
    return 'SCAN';

  // COMPARE — comparing two codes or vs historical data
  if (/\b(compar|versus|vs\b|against|compare.{0,15}yesterday|yesterday.{0,15}compare|better.{0,10}(this|that|option)|which.{0,10}(better|stronger|safer))\b/.test(t))
    return 'COMPARE';

  // CONTENT — generate X/social post content (checked before BUILD to prevent "generate a post" → BUILD)
  if (/\b(tweet|draft.{0,15}post|write.{0,10}(post|caption|tweet)|create.{0,10}post|share.{0,10}(this|today)|announcement|poll|thread)\b/.test(t) ||
      /\b(would you take|which leg ruins|biggest win|biggest miss|daily post|morning post|picks are live|leaderboard post|spotlight)\b/.test(t) ||
      /\bgenerate.{0,20}(post|tweet|caption|content|announcement)\b/.test(t) ||
      /\b(post|content)\s+(for|about|on)\b/.test(t))
    return 'CONTENT';

  // BUILD — generating a new ticket (no code needed)
  if (/\b(build|create|generate|make me|give me|get me|i want|i need|put together|show me|new (slip|ticket|code)|fresh (slip|code))\b/.test(t) ||
      /\b(balanced.{0,10}ticket|safe.{0,10}(ticket|options?|picks?|slip)|safer options?|alternative|different strat)\b/.test(t) ||
      /\b(from.{0,10}pool|use only|only football|avoid|exclude.{0,15}(league|market|live)|exclude live|prefer double chance|prefer dc|prefer over 1\.5|prefer dnb|first half|first half only|show only|only (first|second|double|dnb|btts|over|under)|high.?odds|highest odds|most confident|no (brazil|argentin|nordic|africa|asian|live)|without (brazil|live))\b/.test(t) ||
      /\b(three (different|strategies|tickets?|codes?|slips?)|two (different|strategies|tickets?)|three strategies)\b/.test(t))
    return 'BUILD';

  // INTELLIGENCE — statistics / data queries (no code needed)
  if (/\b(which (market|league|punter|tipster|competition)|who.{0,10}(perform|best|worst)|what.{0,10}(best|worst|performing|hit rate)|how.{0,10}(is|has|been).{0,15}(perform|doing))\b/.test(t) ||
      /\b(statistics|stats|performance|hit rate|win rate|analysis|trend|best market|worst market|best league|worst league|best punter)\b/.test(t))
    return 'INTELLIGENCE';

  // EXPLAIN — breakdown of picks or reasoning
  if (/\b(explain|why.{0,10}(these|this|select|chosen?|picked?)|breakdown|break.{0,5}down|reason|tell me about|what is this|summarize|summarise|how.{0,10}pick)\b/.test(t))
    return 'EXPLAIN';

  // MODIFY — changing an existing slip (needs code)
  if (/\b(remove|delete|add|replace|swap|change|convert|filter|trim|reduce|safer|risky|lower|higher|rebuild|improve|optimiz|replace risky|drop|edit|update|fix|only today|today only|today.{0,5}games only|keep only|clean up|clear up)\b/.test(t))
    return 'MODIFY';

  return 'UNKNOWN';
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTER PARSER — for BUILD intent
// ─────────────────────────────────────────────────────────────────────────────
function parseFilters(text) {
  const t = norm(text);
  const filters = {
    strategy: 'balanced',   // balanced | safe | high_odds | consensus | custom
    excludeLeagues: [],     // keyword strings to exclude
    includeLeagues: [],     // keyword strings to require
    preferMarkets: [],      // market keywords to prefer
    excludeMarkets: [],     // market keywords to block
    kickoffAfter: null,     // ISO string — exclude picks kicking off after this time
    kickoffBefore: null,    // ISO string — exclude picks kicking off before this time
    minConfidence: 60,
    maxOddsPerPick: 2.0,
    targetTotalOdds: null,
    count: 1,
    excludeLive: true,
    footballOnly: true,
  };

  // Strategy
  if (/\b(safe|safer|conservative|low.?risk|secure|cautious)\b/.test(t)) filters.strategy = 'safe';
  else if (/\b(high.?odds|bigger odds|higher odds|risky|aggressive|maximum odds)\b/.test(t)) filters.strategy = 'high_odds';
  else if (/\b(consensus|agreed|agreement|multiple punters?|popular picks?)\b/.test(t)) filters.strategy = 'consensus';
  else if (/\b(balanced)\b/.test(t)) filters.strategy = 'balanced';

  // League exclusions — "avoid X", "exclude X", "no X", "without X", "remove X"
  const EXCLUDE_TRIGGERS = /\b(avoid|exclude|no\b|without|remove|skip|drop|dont? (use|include))\b.{0,20}/;
  if (/brazil|brazilian|serie a.*brazil|serie b.*brazil|copa do brasil/i.test(t) && EXCLUDE_TRIGGERS.test(t.replace(/brazil.{0,20}/g, m => EXCLUDE_TRIGGERS.test(t.slice(0, t.indexOf(m))) ? m : '')))
    filters.excludeLeagues.push('brazil');
  // Simpler: check proximity
  const leagueMap = [
    { kw: /brazil|brasileiro/i, name: 'brazil' },
    { kw: /argentin/i, name: 'argentina' },
    { kw: /nordic|scandinav/i, name: 'nordic' },
    { kw: /africa|african/i, name: 'africa' },
    { kw: /asia|asian/i, name: 'asia' },
    { kw: /amateur|semi.?pro/i, name: 'amateur' },
    { kw: /youth|u\d{2}|under.?\d{2}/i, name: 'youth' },
    { kw: /friendly/i, name: 'friendly' },
  ];
  for (const { kw, name } of leagueMap) {
    if (kw.test(t) && /\b(avoid|exclude|no |without|skip|remove|don.?t (use|want|include))\b.{0,30}/.test(t.replace(kw, '§')))
      filters.excludeLeagues.push(name);
  }

  // Market preferences
  if (/\b(double chance|dc\b)\b/.test(t)) filters.preferMarkets.push('double chance');
  if (/\b(over 1\.5|o1\.5|1\.5 goals?)\b/.test(t)) filters.preferMarkets.push('over 1.5');
  if (/\b(draw no bet|dnb\b)\b/.test(t)) filters.preferMarkets.push('draw no bet');
  if (/\b(first.?half|1st.?half|first half)\b/.test(t)) filters.preferMarkets.push('1st half');
  if (/\b(goal bounds?)\b/.test(t)) filters.preferMarkets.push('goal bounds');
  if (/\b(asian handicap|handicap)\b/.test(t)) filters.preferMarkets.push('handicap');

  // Market exclusions
  if (/\b(no btts|no both teams|exclude btts|no gg)\b/.test(t)) filters.excludeMarkets.push('btts');
  if (/\b(no over 2\.5|no high over|exclude high over)\b/.test(t)) filters.excludeMarkets.push('over 2.5');
  if (/\b(no (correct score|score|scoreline))\b/.test(t)) filters.excludeMarkets.push('correct score');

  // Confidence
  const confMatch = t.match(/(\d{2,3})\s*%?\s*confidence/);
  if (confMatch) filters.minConfidence = parseInt(confMatch[1]);
  if (/\b(most confident|highest confidence|max confidence|only confident)\b/.test(t)) filters.minConfidence = 75;

  // Live exclusion
  if (/\b(exclude live|no live|only future|future only|upcoming only)\b/.test(t)) filters.excludeLive = true;

  // Target total odds
  const oddsMatch = t.match(/(\d{2,6}(?:\.\d+)?)\s*(total\s+)?odds/);
  if (oddsMatch) filters.targetTotalOdds = parseFloat(oddsMatch[1]);

  // Number of codes
  const numMatch = t.match(/\b(three|3|two|2|four|4)\b.{0,20}(different\s+)?(strategies|codes?|tickets?|slips?|options?)/);
  if (numMatch) {
    const n = parseNumber(numMatch[1]);
    if (n) filters.count = Math.min(n, 5);
  }

  // Kickoff time window — "after 6pm", "before 8pm", "only early games" etc.
  // Times are interpreted as Africa/Lagos (UTC+1, no DST) — that's our users' timezone.
  const _parseHour = (hStr, minStr, ampmStr) => {
    let h = parseInt(hStr); const m = parseInt(minStr || '0'); const ap = (ampmStr || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
    // Convert Lagos time → UTC by subtracting 1 hour
    const utcH = h - 1;
    const today = new Date().toISOString().slice(0, 10);
    const utcMins = String(m).padStart(2, '0');
    if (utcH < 0) {
      // wraps to previous day — use yesterday's date
      const prev = new Date(today + 'T00:00:00Z');
      prev.setUTCDate(prev.getUTCDate() - 1);
      return new Date(prev.toISOString().slice(0,10) + 'T' + String(24 + utcH).padStart(2,'0') + ':' + utcMins + ':00Z').toISOString();
    }
    return new Date(today + 'T' + String(utcH).padStart(2,'0') + ':' + utcMins + ':00Z').toISOString();
  };
  const afterM = text.match(/\b(?:after|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const beforeM = text.match(/\b(?:before|until|up\s+to|only.*before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (afterM) filters.kickoffAfter = _parseHour(afterM[1], afterM[2], afterM[3]);
  if (beforeM) filters.kickoffBefore = _parseHour(beforeM[1], beforeM[2], beforeM[3]);
  // Shorthands: "no late games", "early only", "morning games"
  if (/\b(no late|avoid late|without late|skip late)\b/.test(t)) filters.kickoffAfter = _parseHour('20', '00', '');
  if (/\b(early only|morning only|daytime only|no evening|no night)\b/.test(t)) filters.kickoffAfter = _parseHour('18', '00', '');

  return filters;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENCE QUERY PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseIntelQuery(text) {
  const t = norm(text);
  if (/\b(punter|tipster|picker|who|performer)\b/.test(t)) {
    if (/\b(best|top|leading|performing|consistent)\b/.test(t)) return { type: 'top_punters' };
    if (/\b(worst|cold|form|struggle|losing)\b/.test(t)) return { type: 'struggling_punters' };
    return { type: 'punter_stats' };
  }
  if (/\b(market)\b/.test(t)) {
    if (/\b(best|top|winning|safest|performing|highest)\b/.test(t)) return { type: 'top_markets' };
    if (/\b(worst|risky|failing|lowest|avoid)\b/.test(t)) return { type: 'worst_markets' };
    return { type: 'market_stats' };
  }
  if (/\b(league|competition|division)\b/.test(t)) {
    if (/\b(best|safe|reliable|top|trusted)\b/.test(t)) return { type: 'top_leagues' };
    if (/\b(worst|avoid|risky|banned|problematic)\b/.test(t)) return { type: 'worst_leagues' };
    return { type: 'league_stats' };
  }
  if (/\b(today|today.?s|current|live now)\b/.test(t)) return { type: 'today_summary' };
  if (/\b(yesterday|recent|last.{0,5}(week|few days|month)|this week)\b/.test(t)) return { type: 'recent_summary' };
  return { type: 'general_stats' };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT TYPE PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseContentRequest(text) {
  const t = norm(text);
  if (/\bpoll\b/.test(t)) return { type: 'poll' };
  if (/\b(would you take|would you bet|should I take)\b/.test(t)) return { type: 'would_you_take' };
  if (/\b(breakdown|break.?down|explain.{0,10}ticket|ticket breakdown)\b/.test(t)) return { type: 'breakdown' };
  if (/\b(biggest win|biggest miss|biggest (win|loss)|best pick|top win)\b/.test(t)) return { type: 'highlights' };
  if (/\b(thread)\b/.test(t)) return { type: 'thread' };
  if (/\b(daily|morning|picks are live|today.?s picks)\b/.test(t)) return { type: 'daily_post' };
  if (/\b(leaderboard|standings|rankings?|top punters?)\b/.test(t)) return { type: 'leaderboard_post' };
  if (/\b(challenge|community|everyone.{0,10}pick|your picks?|who.{0,10}right)\b/.test(t)) return { type: 'community' };
  if (/\b(which leg ruins|killer|leg that fails|ruins.{0,10}ticket)\b/.test(t)) return { type: 'killer_leg' };
  if (/\b(market.{0,10}trend|market watch|trending market)\b/.test(t)) return { type: 'market_trend' };
  return { type: 'general' };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODIFY ACTION PARSER (original logic, kept intact)
// ─────────────────────────────────────────────────────────────────────────────
function parseActions(text) {
  const actions = [];
  for (const clause of splitClauses(text)) {
    let m;
    if ((m = clause.match(/remove (?:the )?last (\d+|\w+)\s*(?:games?|selections?|picks?|matches?|legs?)?/))) {
      const n = parseNumber(m[1]); if (n) actions.push({ type: 'remove_last_n', n }); continue;
    }
    if (/remove tomorrow'?s?\s*(?:games?|matches?)?/.test(clause)) { actions.push({ type: 'remove_tomorrow' }); continue; }
    if (/(?:keep|edit|update|change|fix|make).{0,15}(?:only )?today'?s?\s*(?:games?|matches?)?(?:\s*only)?/.test(clause) ||
        /\bonly today'?s?\s*(?:games?|matches?)?\b/.test(clause) ||
        /\btoday'?s?\s*(?:games?|matches?)?\s*only\b/.test(clause) ||
        /\bto\s+only\s+today\b/.test(clause)) { actions.push({ type: 'keep_today_only' }); continue; }
    if ((m = clause.match(/keep only (?:the )?([a-z0-9][a-z0-9 .'-]{1,30})/))) { actions.push({ type: 'keep_only_league', league: m[1].trim() }); continue; }
    if ((m = clause.match(/convert (?:all )?over\s*(\d+(?:\.\d+)?)\s*(?:to|->)\s*over\s*(\d+(?:\.\d+)?)/))) { actions.push({ type: 'convert_market', family: 'over_under', to: `Over ${m[2]}` }); continue; }
    if ((m = clause.match(/convert (?:all )?under\s*(\d+(?:\.\d+)?)\s*(?:to|->)\s*under\s*(\d+(?:\.\d+)?)/))) { actions.push({ type: 'convert_market', family: 'over_under', to: `Under ${m[2]}` }); continue; }
    if ((m = clause.match(/convert (?:all )?over\s*(\d+(?:\.\d+)?)/))) { actions.push({ type: 'convert_market', family: 'over_under', to: `Over ${m[1]}` }); continue; }
    if ((m = clause.match(/convert (?:all )?under\s*(\d+(?:\.\d+)?)/))) { actions.push({ type: 'convert_market', family: 'over_under', to: `Under ${m[1]}` }); continue; }
    if (/convert (?:all )?(btts|both teams to score)/.test(clause)) { const toNo = /\bno\b/.test(clause); actions.push({ type: 'convert_market', family: 'btts', to: toNo ? 'No' : 'Yes' }); continue; }
    if ((m = clause.match(/(reduce|lower|bring.*down|cut).{0,20}?(\d+(?:\.\d+)?)/))) { actions.push({ type: 'reduce_to_target_odds', target: parseFloat(m[2]) }); continue; }
    if ((m = clause.match(/(increase|raise|boost|push.*up).{0,20}?(\d+(?:\.\d+)?)/))) { actions.push({ type: 'increase_to_target_odds', target: parseFloat(m[2]) }); continue; }
    if (/\b(increase odds|higher odds|highest odds possible|maximi[sz]e odds)\b/.test(clause)) { actions.push({ type: 'increase_to_target_odds', target: null }); continue; }
    if ((m = clause.match(/\b(?:to|around|at)\s*(\d+(?:\.\d+)?)\s*odds\b/))) { actions.push({ type: 'reduce_to_target_odds', target: parseFloat(m[1]) }); continue; }
    if (/\b(make (?:it )?safer|reduce risk|less risky|safer)\b/.test(clause)) { actions.push({ type: 'reduce_risk' }); continue; }
    if (/\b(maximi[sz]e confidence|highest confidence|max confidence|safest possible)\b/.test(clause)) { actions.push({ type: 'maximize_confidence' }); continue; }
    if ((m = clause.match(/\b(lock)\s+([a-z][a-z .'-]{1,25})/))) { actions.push({ type: 'lock', team: m[2].trim() }); continue; }
    if ((m = clause.match(/\b(unlock)\s+([a-z][a-z .'-]{1,25})/))) { actions.push({ type: 'unlock', team: m[2].trim() }); continue; }
    if (/\b(rebuild slip|improve ticket|replace risky games|rebuild|improve|optimi[sz]e)\b/.test(clause)) { actions.push({ type: 'reduce_risk' }); actions.push({ type: 'rebuild' }); continue; }
    if ((m = clause.match(/remove (?:all )?([a-z0-9][a-z0-9 .'-]{1,30})/))) {
      const target = m[1].trim();
      if (looksLikeMarket(target)) actions.push({ type: 'remove_market_type', keyword: target });
      else actions.push({ type: 'remove_any', term: target });
    }
  }
  return actions;
}

function describeAction(a) {
  switch (a.type) {
    case 'remove_league': return 'remove league ' + a.league;
    case 'remove_team': return 'remove team ' + a.team;
    case 'remove_any': return 'remove ' + a.term;
    case 'remove_market_type': return 'remove ' + a.keyword + ' markets';
    case 'keep_only_league': return 'keep only ' + a.league;
    case 'remove_last_n': return 'remove last ' + a.n + ' selections';
    case 'keep_today_only': return "keep today's games only";
    case 'remove_tomorrow': return "remove tomorrow's games";
    case 'reduce_risk': return 'reduce risk';
    case 'maximize_confidence': return 'maximize confidence';
    case 'reduce_to_target_odds': return 'reduce odds toward ' + a.target;
    case 'increase_to_target_odds': return a.target ? 'increase odds toward ' + a.target : 'increase odds';
    case 'convert_market': return 'convert to ' + a.to;
    case 'lock': return 'lock ' + a.team;
    case 'unlock': return 'unlock ' + a.team;
    case 'rebuild': return 'rebuild slip';
    default: return a.type;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PARSE INTENT — routes to the right handler
// ─────────────────────────────────────────────────────────────────────────────
function parseIntent(rawText) {
  const text = norm(rawText);
  const topLevel = classifyIntent(text);

  if (topLevel === 'SCAN') {
    return { summary: 'Scan/verify this ticket', topLevel, isScanRequest: true, isExplainRequest: false, actions: [] };
  }
  if (topLevel === 'EXPLAIN') {
    return { summary: 'Explain this ticket', topLevel, isScanRequest: false, isExplainRequest: true, actions: [] };
  }
  if (topLevel === 'BUILD') {
    const filters = parseFilters(text);
    return { summary: `Build ${filters.count > 1 ? filters.count + ' ' : ''}${filters.strategy} ticket${filters.count > 1 ? 's' : ''}`, topLevel, filters, isScanRequest: false, isExplainRequest: false, actions: [] };
  }
  if (topLevel === 'INTELLIGENCE') {
    const query = parseIntelQuery(text);
    return { summary: `Intelligence: ${query.type.replace(/_/g,' ')}`, topLevel, query, isScanRequest: false, isExplainRequest: false, actions: [] };
  }
  if (topLevel === 'CONTENT') {
    const contentType = parseContentRequest(text);
    return { summary: `Generate ${contentType.type.replace(/_/g,' ')} post`, topLevel, contentType, isScanRequest: false, isExplainRequest: false, actions: [] };
  }
  if (topLevel === 'COMPARE') {
    return { summary: 'Compare codes or historical data', topLevel, isScanRequest: false, isExplainRequest: false, actions: [] };
  }

  // MODIFY or UNKNOWN — use action parser
  const actions = parseActions(text);
  const effectiveLevel = actions.length ? 'MODIFY' : 'UNKNOWN';
  const summary = actions.length
    ? actions.map(describeAction).join('; ')
    : 'No actionable request detected. Try: "build me a safe ticket", "which market performs best?", "scan [CODE]", or "give me safer options".';
  return { summary, topLevel: effectiveLevel, isScanRequest: false, isExplainRequest: false, actions };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ENGINE — applies MODIFY actions to a selections array
// ─────────────────────────────────────────────────────────────────────────────
async function applyActions(selections, actions, warnings, deps) {
  let sels = selections.map(s => ({ ...s }));
  const locked = new Set();

  for (const a of actions) {
    if (a.type === 'lock' && a.team) sels.forEach(s => { if (includes(s.homeTeam, a.team) || includes(s.awayTeam, a.team)) locked.add(s.eventId); });
    if (a.type === 'unlock' && a.team) sels.forEach(s => { if (includes(s.homeTeam, a.team) || includes(s.awayTeam, a.team)) locked.delete(s.eventId); });
  }

  for (const a of actions) {
    const before = sels.length;
    switch (a.type) {
      case 'remove_league': sels = sels.filter(s => !includes(s.league, a.league)); break;
      case 'remove_team': sels = sels.filter(s => !includes(s.homeTeam, a.team) && !includes(s.awayTeam, a.team)); break;
      case 'remove_any': sels = sels.filter(s => !(includes(s.league, a.term) || includes(s.homeTeam, a.term) || includes(s.awayTeam, a.term) || includes(s.market, a.term) || includes(s.outcome, a.term))); break;
      case 'remove_market_type': sels = sels.filter(s => !includes(s.market, a.keyword) && !includes(s.outcome, a.keyword)); break;
      case 'keep_only_league': sels = sels.filter(s => includes(s.league, a.league)); break;
      case 'remove_last_n': { const n = Math.max(1, parseInt(a.n)||1); sels = sels.slice(0, Math.max(0, sels.length - n)); break; }
      case 'keep_today_only': sels = sels.filter(s => isToday(s.kickoff)); break;
      case 'remove_tomorrow': sels = sels.filter(s => !isTomorrow(s.kickoff)); break;
      case 'reduce_risk':
      case 'maximize_confidence': {
        try {
          const scored = await deps.scoreSelections(sels);
          if (scored?.success) {
            const scoreMap = new Map(scored.selections.map(s => [s.eventId, s.score]));
            const threshold = a.type === 'maximize_confidence' ? 65 : 42;
            const kept = sels.filter(s => locked.has(s.eventId) || (scoreMap.get(s.eventId) ?? 50) >= threshold);
            if (kept.length >= Math.min(3, sels.length)) sels = kept;
            else warnings.push(`${a.type}: not enough high-confidence picks left, kept original set`);
          }
        } catch { warnings.push('Could not reach scoring engine for ' + a.type); }
        break;
      }
      case 'reduce_to_target_odds': {
        const target = parseFloat(a.target);
        if (target > 0) {
          try {
            const scored = await deps.scoreSelections(sels);
            const scoreMap = scored?.success ? new Map(scored.selections.map(s => [s.eventId, s.score])) : new Map();
            const removable = sels.filter(s => !locked.has(s.eventId)).sort((a2, b2) => (scoreMap.get(a2.eventId)??50) - (scoreMap.get(b2.eventId)??50));
            let idx = 0;
            while (removable.length && sels.reduce((acc, s) => acc * (s.originalOdds || s.odds || 1), 1) > target && idx < removable.length && sels.length > 1) {
              sels = sels.filter(s => s.eventId !== removable[idx].eventId);
              idx++;
            }
          } catch { warnings.push('Could not reduce to target odds precisely'); }
        }
        break;
      }
      case 'increase_to_target_odds':
        warnings.push("Increasing total odds means adding more selections. Try: 'build me a high-odds ticket' instead.");
        break;
      case 'convert_market': {
        for (const s of sels) {
          const isOU = /over\/under/i.test(s.market) || /^(over|under)\s/i.test(s.outcome||'');
          const isBTTS = /gg\/ng|both teams to score/i.test(s.market);
          const matchesFamily = (a.family === 'over_under' && isOU) || (a.family === 'btts' && isBTTS);
          if (!matchesFamily) continue;
          try {
            const marketData = await deps.getEventMarkets(s.eventId);
            if (!marketData?.markets) continue;
            const match = marketData.markets.find(mk => includes(mk.outcomeName, a.to));
            if (match) { s.market = match.marketName; s.outcome = match.outcomeName; s.marketId = match.marketId; s.outcomeId = match.outcomeId; s.specifier = match.specifier; s.odds = match.odds; s.originalOdds = match.odds; }
            else warnings.push(`Couldn't find "${a.to}" for ${s.homeTeam} vs ${s.awayTeam} — left as-is`);
          } catch { warnings.push(`Market lookup failed for ${s.homeTeam} vs ${s.awayTeam}`); }
        }
        break;
      }
      case 'rebuild':
      default: break;
    }
    if (sels.length === 0 && before > 0) { warnings.push(`Action "${a.type}" would have removed everything — reverted that step`); sels = selections.map(s => ({ ...s })); }
  }
  return sels;
}

// ─────────────────────────────────────────────────────────────────────────────
// POOL FILTER — applies BUILD filters to a master pool array
// ─────────────────────────────────────────────────────────────────────────────
function applyPoolFilters(pool, filters) {
  let picks = [...pool];
  const now = Date.now();

  // Exclude live games
  if (filters.excludeLive) {
    picks = picks.filter(p => !p.kickoff || new Date(p.kickoff).getTime() > now);
  }

  // Kickoff time window
  if (filters.kickoffAfter) {
    const cutoff = new Date(filters.kickoffAfter).getTime();
    picks = picks.filter(p => !p.kickoff || new Date(p.kickoff).getTime() <= cutoff);
  }
  if (filters.kickoffBefore) {
    const floor = new Date(filters.kickoffBefore).getTime();
    picks = picks.filter(p => !p.kickoff || new Date(p.kickoff).getTime() >= floor);
  }

  // League exclusions
  for (const leagueTerm of filters.excludeLeagues) {
    picks = picks.filter(p => !norm(p.league || '').includes(leagueTerm));
  }

  // League inclusions
  for (const leagueTerm of filters.includeLeagues) {
    picks = picks.filter(p => norm(p.league || '').includes(leagueTerm));
  }

  // Market preferences — reorder, not filter
  if (filters.preferMarkets.length > 0) {
    const preferred = picks.filter(p => filters.preferMarkets.some(m => norm(p.marketName || p.market || '').includes(m)));
    const rest = picks.filter(p => !filters.preferMarkets.some(m => norm(p.marketName || p.market || '').includes(m)));
    picks = [...preferred, ...rest];
  }

  // Market exclusions
  for (const mkt of filters.excludeMarkets) {
    picks = picks.filter(p => !norm(p.marketName || p.market || '').includes(mkt));
  }

  // Confidence threshold
  picks = picks.filter(p => (p.confidence || p.score || 0) >= filters.minConfidence);

  // Per-pick odds ceiling
  picks = picks.filter(p => (p.odds || 0) <= filters.maxOddsPerPick);

  // Strategy-based sorting
  switch (filters.strategy) {
    case 'safe':
      picks.sort((a, b) => (b.confidence||b.score||0) - (a.confidence||a.score||0) || (a.odds||0) - (b.odds||0));
      break;
    case 'high_odds':
      picks.sort((a, b) => (b.odds||0) - (a.odds||0));
      break;
    case 'consensus':
      picks.sort((a, b) => (b.punters?.length||0) - (a.punters?.length||0) || (b.confidence||b.score||0) - (a.confidence||a.score||0));
      break;
    default: // balanced
      picks.sort((a, b) => {
        const scoreA = (a.confidence||a.score||0) * 0.6 + Math.log(a.odds+0.01) * 20 * 0.4;
        const scoreB = (b.confidence||b.score||0) * 0.6 + Math.log(b.odds+0.01) * 20 * 0.4;
        return scoreB - scoreA;
      });
  }

  return picks;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT GENERATOR — generates X post copy from context
// ─────────────────────────────────────────────────────────────────────────────
function generateContent(contentType, context) {
  const { picks, report, punters, code, totalOdds, date } = context || {};
  const today = date || new Date().toLocaleDateString('en-NG', { weekday:'long', day:'numeric', month:'long' });

  const templates = {
    daily_post: () => {
      const codes = (punters || []).slice(0, 6).map(p => `• ${p.name} — ${p.code}`).join('\n');
      return [
        `🌅 ${today} predictions are LIVE 🔥`,
        '',
        `Today's featured picks from ${(punters||[]).length} analysts 📋`,
        codes,
        '',
        code ? `🔗 Merged slip → ${code}` : '',
        `🎯 Track all punters live → slippilot.com.ng`,
        '#BettingAnalysis #SportyBet',
      ].filter(l => l !== null).join('\n');
    },

    poll: () => {
      const pick = (picks || [])[0];
      if (pick) {
        return [
          `🗳️ Quick poll — ${pick.homeTeam} vs ${pick.awayTeam}`,
          '',
          `Market: ${pick.marketName || pick.market}`,
          `Current odds: @${pick.odds}`,
          '',
          '🔵 Safe — Take it',
          '🔴 Skip — Too risky',
          '',
          'What would you do? 👇 #BettingCommunity',
        ].join('\n');
      }
      return [
        `🗳️ Betting strategy poll — ${today}`,
        '',
        'What\'s your approach when odds drop overnight?',
        '',
        '🔵 Take it — value is still there',
        '🟡 Wait and see',
        '🔴 Skip — moved too much',
        '',
        '#BettingStrategy #Predictions',
      ].join('\n');
    },

    would_you_take: () => {
      const pick = (picks || [])[0];
      if (!pick) return '🤔 Would you take this pick? Drop your answer below 👇';
      return [
        `🤔 Would YOU take this?`,
        '',
        `${pick.homeTeam} vs ${pick.awayTeam}`,
        `Market: ${pick.marketName || pick.market}`,
        `Odds: @${pick.odds}`,
        `Our confidence: ${pick.confidence || pick.score}%`,
        '',
        'Take it or skip it? 👇',
        '#BettingTips #SlipPilot',
      ].join('\n');
    },

    killer_leg: () => {
      const killers = (picks || []).filter(p => (p.confidence || p.score || 0) < 65).slice(0, 3);
      if (!killers.length) return '✅ No obvious killer legs today — looking clean!';
      const worst = killers[0];
      return [
        `🚨 Ticket killer alert`,
        '',
        `The riskiest leg on today's slip:`,
        `${worst.homeTeam} vs ${worst.awayTeam}`,
        `Market: ${worst.marketName || worst.market} @${worst.odds}`,
        `Confidence: ${worst.confidence || worst.score}% ⚠️`,
        '',
        'Would you remove it? 👇 #BettingRisk',
      ].join('\n');
    },

    highlights: () => {
      const rpt = report || {};
      const winner = (rpt.punterStats || []).sort((a,b) => (b.hitRate||0)-(a.hitRate||0))[0];
      const loser  = (rpt.punterStats || []).sort((a,b) => (a.hitRate||0)-(b.hitRate||0))[0];
      return [
        `📊 Yesterday's results are in:`,
        '',
        winner ? `🏆 Best performer: ${winner.punter} — ${winner.hitRate}% hit rate (${winner.won}/${winner.won+(winner.lost||0)})` : '',
        loser  ? `💔 Tough day: ${loser.punter} — ${loser.hitRate}% (${loser.lost} misses)` : '',
        '',
        `Overall HR: ${rpt.totals?.hitRate || '?'}%`,
        '',
        'Full analysis → slippilot.com.ng #BettingResults',
      ].filter(Boolean).join('\n');
    },

    leaderboard_post: () => {
      const top3 = (punters || []).slice(0, 3);
      const medals = ['🥇','🥈','🥉'];
      const lines = top3.map((p, i) => `${medals[i]} ${p.name} — ${p.hitRate}% (${p.won || 0} wins)`);
      return [
        `🏆 SlipPilot Leaderboard — ${today}`,
        '',
        ...lines,
        '',
        `Updated daily → slippilot.com.ng #Leaderboard #BettingStats`,
      ].join('\n');
    },

    market_trend: () => {
      const rpt = report || {};
      const markets = Object.entries(rpt.marketWatch || {})
        .map(([name, d]) => ({ name, ...d }))
        .sort((a,b) => (b.hitRate||0)-(a.hitRate||0));
      const best = markets[0];
      const worst = markets[markets.length-1];
      return [
        `📈 Market performance — last 7 days`,
        '',
        best  ? `✅ Best: ${best.name}  ${best.hitRate}% HR (${best.won}/${best.selections})` : '',
        worst ? `❌ Worst: ${worst.name}  ${worst.hitRate}% HR (${worst.lost} misses)` : '',
        '',
        `Based on ${rpt.totals?.selections || '?'} tracked selections`,
        'Full breakdown → slippilot.com.ng #MarketAnalysis',
      ].filter(Boolean).join('\n');
    },

    community: () => [
      `🎯 SlipPilot Community Challenge — ${today}`,
      '',
      `Drop your best pick below 👇`,
      `Format: Match | Market | Odds`,
      '',
      `Top pick gets featured in tomorrow's daily post!`,
      '#BettingCommunity #SlipPilot',
    ].join('\n'),

    breakdown: () => {
      if (!picks || !picks.length) return 'Paste a booking code first so I can break it down for you.';
      const topPicks = picks.slice(0, 3);
      const lines = topPicks.map(p =>
        `• ${p.homeTeam} vs ${p.awayTeam}\n  ${p.marketName || p.market} @${p.odds} — ${p.confidence || p.score}% confidence`
      );
      return [
        `📋 Ticket Breakdown${code ? ` — Code: ${code}` : ''}`,
        '',
        ...lines,
        picks.length > 3 ? `...and ${picks.length - 3} more` : '',
        '',
        `Total odds: @${totalOdds || '?'}`,
        '#BettingAnalysis',
      ].filter(l => l !== '').join('\n');
    },

    thread: () => [
      `🧵 Thread: How SlipPilot picks today's selections`,
      '',
      `1/ We track ${(punters||[]).length} punters daily and merge their picks into one optimised slip.`,
      '',
      `2/ Each pick goes through our intelligence engine:\n• Market safety check\n• Historical hit rate\n• Punter consistency score\n• League reliability`,
      '',
      `3/ Only picks that pass ALL filters make the final slip.`,
      '',
      `4/ Today's merged code: ${code || 'see bio link'}`,
      '',
      `5/ Track every punter live → slippilot.com.ng`,
      '\n#BettingEducation #SlipPilot',
    ].join('\n\n'),

    general: () => [
      `🔥 Today's picks are ready — ${today}`,
      '',
      code ? `Merged booking code: ${code}` : 'Check slippilot.com.ng for today\'s full analysis',
      '',
      `${(picks||[]).length ? `${picks.length} selections` : ''} tracked across ${(punters||[]).length || '?'} punters`,
      '#BettingTips #SlipPilot',
    ].filter(Boolean).join('\n'),
  };

  const fn = templates[contentType] || templates.general;
  return fn();
}

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENCE RESPONSE FORMATTER
// ─────────────────────────────────────────────────────────────────────────────
function formatIntelResponse(queryType, data) {
  const { leagueIntel, marketIntel, punterStats, xContext, todayReport } = data || {};

  switch (queryType) {
    case 'top_markets': {
      const markets = Object.entries(marketIntel || {})
        .map(([name, d]) => ({ name, ...d }))
        .filter(m => (m.selections || m.total || 0) >= 5)
        .sort((a,b) => (b.hitRate||0)-(a.hitRate||0))
        .slice(0, 5);
      if (!markets.length) return 'No market performance data available yet. Run a rescan to populate intelligence.';
      const lines = markets.map((m, i) => `${i+1}. ${m.name}: ${m.hitRate}% hit rate (${m.won || m.selections}/${m.total || m.selections} games)`);
      return `Best performing markets recently:\n${lines.join('\n')}`;
    }
    case 'worst_markets': {
      const markets = Object.entries(marketIntel || {})
        .map(([name, d]) => ({ name, ...d }))
        .filter(m => (m.selections || m.total || 0) >= 5)
        .sort((a,b) => (a.hitRate||0)-(b.hitRate||0))
        .slice(0, 5);
      if (!markets.length) return 'No market data available. Run a rescan first.';
      const lines = markets.map((m, i) => `${i+1}. ${m.name}: ${m.hitRate}% hit rate (${m.lost || '?'} losses)`);
      return `Worst performing markets to avoid:\n${lines.join('\n')}\nConsider sticking to DC, DNB, or Over 1.5.`;
    }
    case 'market_stats': {
      const markets = Object.entries(marketIntel || {}).map(([name, d]) => ({ name, ...d })).filter(m => (m.selections||0) >= 3);
      if (!markets.length) return 'No market history data yet.';
      const sorted = [...markets].sort((a,b) => (b.hitRate||0)-(a.hitRate||0));
      return `Market performance overview (${markets.length} markets tracked):\n` +
        sorted.slice(0, 8).map(m => `${m.name}: ${m.hitRate}% (${m.selections} games)`).join('\n');
    }
    case 'top_leagues': {
      const leagues = Object.entries(leagueIntel || {})
        .map(([name, d]) => ({ name, ...d }))
        .filter(l => (l.selections || l.totalSelections || 0) >= 5)
        .sort((a,b) => (b.hitRate||0)-(a.hitRate||0))
        .slice(0, 5);
      if (!leagues.length) return 'No league data available yet.';
      return `Most reliable leagues:\n` + leagues.map((l,i) => `${i+1}. ${l.name}: ${l.hitRate}% hit rate`).join('\n');
    }
    case 'worst_leagues': {
      const leagues = Object.entries(leagueIntel || {})
        .map(([name, d]) => ({ name, ...d }))
        .filter(l => (l.selections || l.totalSelections || 0) >= 5)
        .sort((a,b) => (a.hitRate||0)-(b.hitRate||0))
        .slice(0, 5);
      if (!leagues.length) return 'No league data available yet.';
      return `Leagues to avoid:\n` + leagues.map((l,i) => `${i+1}. ${l.name}: ${l.hitRate}% hit rate`).join('\n') + '\nThese have the highest loss rates in our history.';
    }
    case 'league_stats': {
      const leagues = Object.entries(leagueIntel || {}).map(([name, d]) => ({ name, ...d })).filter(l => (l.totalSelections||0) >= 3);
      if (!leagues.length) return 'No league intelligence data yet.';
      return `League intelligence (${leagues.length} leagues tracked):\n` +
        leagues.sort((a,b) => (b.hitRate||0)-(a.hitRate||0)).slice(0, 10).map(l => `${l.name}: ${l.hitRate}%`).join('\n');
    }
    case 'top_punters': {
      const sorted = (punterStats || []).sort((a,b) => (b.hitRate||0)-(a.hitRate||0)).slice(0, 5);
      if (!sorted.length) return 'No punter stats available yet.';
      return `Top performing punters:\n` + sorted.map((p,i) => `${i+1}. ${p.punter || p.name}: ${p.hitRate}% (${p.won || 0} wins / ${p.codes || p.selections || 0} codes)`).join('\n');
    }
    case 'struggling_punters': {
      const sorted = (punterStats || []).sort((a,b) => (a.hitRate||0)-(b.hitRate||0)).slice(0, 5);
      if (!sorted.length) return 'No punter stats available.';
      return `Punters in poor form lately:\n` + sorted.map((p,i) => `${i+1}. ${p.punter || p.name}: ${p.hitRate}% (${p.lost || 0} losses)`).join('\n');
    }
    case 'today_summary': {
      const ctx = xContext || {};
      if (!ctx.topPicks) return 'No data for today yet. Run a master analysis first to see today\'s picks.';
      const parts = [`Today's pool summary:`];
      if (ctx.topPicks?.length) parts.push(`Top picks: ${ctx.topPicks.slice(0,3).map(p => `${p.home||''} vs ${p.away||''} (${p.confidence||0}%)`).join(', ')}`);
      if (ctx.bestLeague) parts.push(`Best league today: ${ctx.bestLeague}`);
      if (ctx.topPunter) parts.push(`Most active punter: ${ctx.topPunter}`);
      if (ctx.biggestKiller) parts.push(`Watch out for: ${ctx.biggestKiller}`);
      return parts.join('\n');
    }
    case 'recent_summary': {
      const rpt = todayReport || {};
      const totals = rpt.totals || rpt.analysis?.totals || {};
      return `Recent performance summary:\n` +
        `Hit Rate: ${totals.hitRate || '?'}%\n` +
        `Won: ${totals.won || 0} | Lost: ${totals.lost || 0} | Void: ${totals.void || 0}\n` +
        `Total selections: ${totals.selections || 0}`;
    }
    default:
      return 'Available queries: best market, worst market, top leagues, worst leagues, top punters, today\'s summary.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REPLY BUILDER (for SCAN/MODIFY results)
// ─────────────────────────────────────────────────────────────────────────────
const RISK_ACTION_TYPES = new Set(['reduce_risk','maximize_confidence','reduce_to_target_odds','increase_to_target_odds']);

function buildReply(ctx) {
  const { detectedCode, actionsPerformed=[], scan, oldOdds, newOdds, newBookingCode, removedCount=0, warnings=[] } = ctx;

  if (!detectedCode && !newBookingCode) {
    return { reply: "Couldn't find a booking code in that — paste the code directly or the full slip text.", firstReply: null };
  }

  if (scan && !newBookingCode) {
    const settled = scan.won + scan.lost + scan.void;
    const lines = [
      `✅ Ticket scanned.`,
      `${settled}/${scan.total} selections settled${scan.pending ? `, ${scan.pending} pending` : ''}.`,
      `Status: ${scan.won}W / ${scan.lost}L${scan.void ? ` / ${scan.void} void` : ''}.`,
    ];
    if (scan.pending === 0) lines.push(`Hit rate: ${scan.hitRate}%.`);
    const firstReply = scan.pending > 0 ? "I'll keep an eye on the pending ones — want an update when they settle?" : null;
    return { reply: lines.join('\n'), firstReply };
  }

  if (newBookingCode) {
    const usedRiskEngine = actionsPerformed.some(a => RISK_ACTION_TYPES.has(a.type));
    const skipInBody = usedRiskEngine ? new Set(['rebuild','reduce_risk','maximize_confidence']) : new Set(['rebuild']);
    const actionLines = actionsPerformed.filter(a => !skipInBody.has(a.type)).map(describeAction);
    const capitalized = s => s.charAt(0).toUpperCase() + s.slice(1);
    const header = usedRiskEngine ? (removedCount > 0 ? `Found ${removedCount} risky selection${removedCount===1?'':'s'}.` : `Rebuilt with safer picks.`) : 'Done.';
    const body = actionLines.length ? actionLines.map(capitalized).join('.\n') + '.' : '';
    const lines = [header];
    if (body) lines.push(body);
    lines.push(`New odds: ${newOdds}`);
    lines.push(`Booking code: ${newBookingCode}`);
    const firstReply = usedRiskEngine ? 'Want me to trim it further, or lock in a couple of picks?' : 'Need another tweak?';
    return { reply: lines.join('\n'), firstReply };
  }

  if (warnings.length) return { reply: `Couldn't finish that:\n${warnings[0]}`, firstReply: null };

  return { reply: "Got the ticket, but couldn't tell what change you wanted. Try: 'remove Brazil', 'reduce to 500 odds', or 'make it safer'.", firstReply: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD REPLY BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildCodeReply(ctx) {
  const { filters, codes=[], warnings=[], poolSize } = ctx;
  if (!codes.length) {
    return {
      reply: warnings.length
        ? `Couldn't build a ticket: ${warnings[0]}\n\nTry running a fresh analysis in the Intelligence Engine tab first.`
        : "The pool is empty or too small to build a ticket right now. Run 'Run Master Analysis' in the admin panel first.",
      firstReply: 'Want me to try with looser filters instead?',
    };
  }

  const strategy = filters?.strategy || 'balanced';
  const strat_desc = { safe:'safe, low-risk', high_odds:'high-odds', consensus:'consensus-backed', balanced:'balanced' }[strategy] || strategy;

  const lines = codes.length === 1
    ? [
        `✅ Here's your ${strat_desc} ticket:`,
        '',
        `Booking code: ${codes[0].code}`,
        `Games: ${codes[0].gameCount}  |  Odds: ~${codes[0].totalOddsFormatted || Math.round(codes[0].totalOdds)+'x'}  |  Avg confidence: ${codes[0].avgScore || '?'}%`,
        '',
        'Load it at sportybet.com or slippilot.com.ng',
      ]
    : [
        `✅ Built ${codes.length} ${strat_desc} tickets:`,
        '',
        ...codes.map((c, i) => `${i+1}. ${c.code}  (${c.gameCount}g, ~${c.totalOddsFormatted || Math.round(c.totalOdds)+'x'}, ${c.avgScore || '?'}% avg conf)`),
        '',
        'Load any of these at sportybet.com',
      ];

  if (warnings.length) lines.push(`\n⚠️ Note: ${warnings[0]}`);

  const firstReply = strategy === 'safe'
    ? 'Want the picks broken down? Or a higher-odds version?'
    : strategy === 'high_odds'
    ? 'Want me to trim the riskiest legs and rebuild safer?'
    : 'Want a safer version, or higher odds?';

  return { reply: lines.join('\n'), firstReply };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function isToday(kickoffISO) {
  if (!kickoffISO) return false;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  return today === new Date(kickoffISO).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}
function isTomorrow(kickoffISO) {
  if (!kickoffISO) return false;
  const t = new Date(); t.setDate(t.getDate()+1);
  return t.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }) === new Date(kickoffISO).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATOR OPTIONS PARSER (Phase 3)
// Converts a natural language BUILD request into a structured options object
// compatible with portfolio-builder.js buildPortfolio(pool, opts, ...)
// ─────────────────────────────────────────────────────────────────────────────
function parseGeneratorOptions(text) {
  const t = norm(text);
  const opts = {
    count:            1,
    minGames:         12,
    maxGames:         20,
    todayOnly:        false,
    kickoffStart:     null,
    kickoffEnd:       null,
    sortBy:           'confidence',
    maxOddsPerPick:   2.0,
    minConfidence:    55,
    convertRisky:     false,
    footballOnly:     true,
    removeFriendlies: true,
    removeBanned:     true,
    preferConsensus:  false,
    topPuntersOnly:   false,
    maxRepeat:        1,
    strategy:         'balanced',
  };

  // Count of codes
  const countM = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s*(?:booking\s*)?codes?\b/);
  if (countM) opts.count = Math.min(20, parseNumber(countM[1]) || 1);
  // "generate 5" without "codes"
  const genN = t.match(/\b(?:generate|create|build|make)\s+(\d+)\b/);
  if (genN && !countM) opts.count = Math.min(20, parseInt(genN[1]) || 1);
  // "3 different strategies" / "3 strategies"
  if (/\b(\d+|three|two|five)\s+(?:different\s+)?strate/i.test(text)) {
    const sm = text.match(/\b(\d+|three|two|five)\s+/i);
    if (sm) opts.count = Math.min(5, parseNumber(sm[1]) || 1);
  }

  // Min/max games
  const maxGamesM = t.match(/\b(?:max(?:imum)?|no more than|at most)\s+(\d+)\s*(?:games?|selections?|picks?|legs?)\b/);
  if (maxGamesM) opts.maxGames = Math.min(50, parseInt(maxGamesM[1]) || opts.maxGames);
  const minGamesM = t.match(/\b(?:min(?:imum)?|at least|no less than)\s+(\d+)\s*(?:games?|selections?|picks?|legs?)\b/);
  if (minGamesM) opts.minGames = Math.max(1, parseInt(minGamesM[1]) || opts.minGames);
  // "18 games" / "10 picks"
  const gamesN = t.match(/\b(\d+)\s*(?:games?|selections?|picks?|legs?)\b/);
  if (gamesN && !maxGamesM && !minGamesM) {
    const n = parseInt(gamesN[1]);
    opts.maxGames = n; opts.minGames = Math.max(1, n - 4);
  }

  // Today only
  if (/\btoday('?s?)?\s*(matches?|games?|only|picks?|fixtures?)\b|\bonly\s+today\b|\btoday\s+only\b/.test(t)) opts.todayOnly = true;

  // Sort by
  if (/\bsort\s+(?:by\s+)?kickoff\b|\bby\s+kickoff\b|\bkickoff\s*(time|order|sort|sorted)?\b.*\bsort|\bsort.*\bkickoff/.test(t)) opts.sortBy = 'kickoff';
  else if (/\bsort\s+(?:by\s+)?(?:confidence|score)\b|\bby\s+confidence\b/.test(t)) opts.sortBy = 'confidence';
  else if (/\bsort\s+(?:by\s+)?odds\b|\bby\s+odds\b/.test(t)) opts.sortBy = 'odds';

  // Max single odds
  const maxOddsM = t.match(/\bmax(?:imum)?\s+(?:single\s+)?(?:odd|odds?)\s+(?:of\s+)?(\d+\.?\d*)\b/);
  if (maxOddsM) opts.maxOddsPerPick = parseFloat(maxOddsM[1]);
  const noAboveM = t.match(/\b(?:no|not)\s+(?:more\s+than|above|over)\s+(\d+\.?\d*)\s*(?:odds?|x)\b/);
  if (noAboveM) opts.maxOddsPerPick = parseFloat(noAboveM[1]);
  // "1.80 odds per pick" / "maximum 1.80"
  const oddsValM = t.match(/\b(\d\.\d{1,2})\s*(?:odds?|x)?\s*(?:per\s+pick|each|max|maximum)?\b/);
  if (oddsValM && !maxOddsM && !noAboveM) {
    const v = parseFloat(oddsValM[1]);
    if (v >= 1.01 && v <= 5.0) opts.maxOddsPerPick = v;
  }

  // Strategy
  if (/\b(safe|safer|conservative|low.?risk)\b/.test(t)) opts.strategy = 'safe';
  else if (/\b(jackpot|big|huge|high.?odds?|value|aggressive)\b/.test(t)) opts.strategy = 'high_odds';
  else if (/\bconsensus\b/.test(t)) opts.strategy = 'consensus';
  else if (/\bbalanced\b/.test(t)) opts.strategy = 'balanced';

  // Consensus picks
  if (/\bprefer\s+consensus\b|\bconsensus\s+picks?\b/.test(t)) opts.preferConsensus = true;

  // Top punters only
  if (/\btop\s+punters?\b|\bbest\s+punters?\b|\belite\s+punters?\b/.test(t)) opts.topPuntersOnly = true;

  // Convert risky
  if (/\bconvert\s+risky\b|\bauto.?convert\b|\boptimi[sz]e\s+risky\b/.test(t)) opts.convertRisky = true;

  // Football only
  if (/\bfootball\s+only\b|\bonly\s+football\b/.test(t)) opts.footballOnly = true;

  // Remove friendlies
  if (/\bremove\s+friendl|no\s+friendl|exclude\s+friendl/.test(t)) opts.removeFriendlies = true;

  // Remove banned
  if (/\bremove\s+(?:banned|blacklist)\b|no\s+banned\b/.test(t)) opts.removeBanned = true;

  // Min confidence
  const confM = t.match(/\bmin(?:imum)?\s+confidence\s+(?:of\s+)?(\d+)\b/);
  if (confM) opts.minConfidence = Math.max(0, Math.min(100, parseInt(confM[1])));

  // Max repeat
  const repM = t.match(/\bmax(?:imum)?\s+(?:repeated?|repeat)\s+(?:match(?:es?)?\s+)?(?:per\s+portfolio\s+)?(\d+)\b/);
  if (repM) opts.maxRepeat = Math.max(1, Math.min(10, parseInt(repM[1])));

  // Kickoff window
  const afterM = t.match(/\b(?:after|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const beforeM = t.match(/\b(?:before|until|up to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (afterM || beforeM) {
    const today = new Date().toISOString().slice(0, 10);
    if (afterM) {
      let h = parseInt(afterM[1]); const mins = afterM[2] || '00'; const ampm = (afterM[3]||'').toLowerCase();
      if (ampm === 'pm' && h < 12) h += 12; if (ampm === 'am' && h === 12) h = 0;
      opts.kickoffStart = today + 'T' + String(h).padStart(2,'0') + ':' + mins + ':00.000Z';
    }
    if (beforeM) {
      let h = parseInt(beforeM[1]); const mins = beforeM[2] || '00'; const ampm = (beforeM[3]||'').toLowerCase();
      if (ampm === 'pm' && h < 12) h += 12; if (ampm === 'am' && h === 12) h = 0;
      opts.kickoffEnd = today + 'T' + String(h).padStart(2,'0') + ':' + mins + ':00.000Z';
    }
  }

  return opts;
}

module.exports = {
  classifyIntent,
  parseIntent,
  parseFilters,
  parseGeneratorOptions,
  parseIntelQuery,
  parseContentRequest,
  parseActions,
  describeAction,
  applyActions,
  applyPoolFilters,
  generateContent,
  formatIntelResponse,
  buildReply,
  buildCodeReply,
  includesFuzzy: includes,
};
