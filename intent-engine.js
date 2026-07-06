// intent-engine.js — SlipPilot deterministic Intent Engine
// NO LLM. Regex + keyword + alias rules only.
// Channel-agnostic: knows nothing about X/Twitter/Telegram/etc. Callers inject
// the network primitives it needs (scoreSelections, getEventMarkets) so this
// exact module can later back a Telegram bot, WhatsApp bot, Discord bot, or
// website chat widget without any change here.
'use strict';

// ── Normalisation helpers ──
const norm = (s) => (s || '').toLowerCase().replace(/[’]/g, "'").trim();
const includesFuzzy = (haystack, needle) => norm(haystack).includes(norm(needle));

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
function parseNumber(raw) {
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  if (!isNaN(n)) return n;
  return NUM_WORDS[String(raw).toLowerCase()] ?? null;
}

const MARKET_KEYWORDS = ['under', 'over', 'btts', 'both teams to score', 'draw no bet', 'handicap', 'double chance', '1x2', 'gg/ng', 'correct score', 'clean sheet'];
function looksLikeMarket(phrase) {
  const p = norm(phrase);
  return MARKET_KEYWORDS.some((k) => p.includes(k));
}

function splitClauses(text) {
  return norm(text).split(/,|;|(?:\band\b)/).map((s) => s.trim()).filter(Boolean);
}

// ── Deterministic intent parser ──
// Returns { summary, isScanRequest, isExplainRequest, actions[] }
function parseIntent(rawText) {
  const text = norm(rawText);
  const actions = [];
  let isScanRequest = false;
  let isExplainRequest = false;

  if (/\b(scan|verify|is (this|it) (true|real|correct)|did (this|it) win|check (this|the)?\s*(code|ticket|slip)|status of|is this)\b/.test(text)) {
    isScanRequest = true;
  }
  if (/\b(explain|summarize|summarise|what is this|break (this|it) down)\b/.test(text)) {
    isExplainRequest = true;
  }

  for (const clause of splitClauses(text)) {
    let m;

    if ((m = clause.match(/remove (?:the )?last (\d+|\w+)\s*(?:games|selections|picks|matches|legs)?/))) {
      const n = parseNumber(m[1]);
      if (n) actions.push({ type: 'remove_last_n', n });
      continue;
    }
    if (/remove tomorrow'?s?\s*(?:games|matches)?/.test(clause)) {
      actions.push({ type: 'remove_tomorrow' });
      continue;
    }
    if (/keep (?:only )?today'?s?\s*(?:games|matches)?(?:\s*only)?/.test(clause)) {
      actions.push({ type: 'keep_today_only' });
      continue;
    }
    if ((m = clause.match(/keep only (?:the )?([a-z0-9][a-z0-9 .'-]{1,30})/))) {
      actions.push({ type: 'keep_only_league', league: m[1].trim() });
      continue;
    }

    // convert market — explicit from/to first, then bare target
    if ((m = clause.match(/convert (?:all )?over\s*(\d+(?:\.\d+)?)\s*(?:to|->)\s*over\s*(\d+(?:\.\d+)?)/))) {
      actions.push({ type: 'convert_market', family: 'over_under', to: `Over ${m[2]}` });
      continue;
    }
    if ((m = clause.match(/convert (?:all )?under\s*(\d+(?:\.\d+)?)\s*(?:to|->)\s*under\s*(\d+(?:\.\d+)?)/))) {
      actions.push({ type: 'convert_market', family: 'over_under', to: `Under ${m[2]}` });
      continue;
    }
    if ((m = clause.match(/convert (?:all )?over\s*(\d+(?:\.\d+)?)/))) {
      actions.push({ type: 'convert_market', family: 'over_under', to: `Over ${m[1]}` });
      continue;
    }
    if ((m = clause.match(/convert (?:all )?under\s*(\d+(?:\.\d+)?)/))) {
      actions.push({ type: 'convert_market', family: 'over_under', to: `Under ${m[1]}` });
      continue;
    }
    if (/convert (?:all )?(btts|both teams to score)/.test(clause)) {
      const toNo = /\bno\b/.test(clause);
      actions.push({ type: 'convert_market', family: 'btts', to: toNo ? 'No' : 'Yes' });
      continue;
    }

    // odds targeting — check direction word near a number
    if ((m = clause.match(/(reduce|lower|bring.*down|cut).{0,20}?(\d+(?:\.\d+)?)/))) {
      actions.push({ type: 'reduce_to_target_odds', target: parseFloat(m[2]) });
      continue;
    }
    if ((m = clause.match(/(increase|raise|boost|push.*up).{0,20}?(\d+(?:\.\d+)?)/))) {
      actions.push({ type: 'increase_to_target_odds', target: parseFloat(m[2]) });
      continue;
    }
    if (/\b(increase odds|higher odds|highest odds possible|maximi[sz]e odds)\b/.test(clause)) {
      actions.push({ type: 'increase_to_target_odds', target: null });
      continue;
    }
    if ((m = clause.match(/\b(?:to|around|at)\s*(\d+(?:\.\d+)?)\s*odds\b/))) {
      actions.push({ type: 'reduce_to_target_odds', target: parseFloat(m[1]) });
      continue;
    }

    if (/\b(make (?:it )?safer|reduce risk|less risky|safer)\b/.test(clause)) {
      actions.push({ type: 'reduce_risk' });
      continue;
    }
    if (/\b(maximi[sz]e confidence|highest confidence|max confidence|safest possible)\b/.test(clause)) {
      actions.push({ type: 'maximize_confidence' });
      continue;
    }

    if ((m = clause.match(/\b(lock)\s+([a-z][a-z .'-]{1,25})/))) {
      actions.push({ type: 'lock', team: m[2].trim() });
      continue;
    }
    if ((m = clause.match(/\b(unlock)\s+([a-z][a-z .'-]{1,25})/))) {
      actions.push({ type: 'unlock', team: m[2].trim() });
      continue;
    }

    if (/\b(rebuild slip|improve ticket|replace risky games|rebuild|improve|optimi[sz]e)\b/.test(clause)) {
      actions.push({ type: 'reduce_risk' });
      actions.push({ type: 'rebuild' });
      continue;
    }

    // generic "remove X" fallback — could be league, team, or market keyword
    if ((m = clause.match(/remove (?:all )?([a-z0-9][a-z0-9 .'-]{1,30})/))) {
      const target = m[1].trim();
      if (looksLikeMarket(target)) actions.push({ type: 'remove_market_type', keyword: target });
      else actions.push({ type: 'remove_any', term: target });
      continue;
    }
  }

  const summary = actions.length
    ? actions.map(describeAction).join('; ')
    : (isScanRequest ? 'Scan/verify this ticket' : isExplainRequest ? 'Explain this ticket' : 'No actionable request detected');

  return { summary, isScanRequest, isExplainRequest, actions };
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

// ── Action engine — applies parsed actions to a selections array ──
// deps: { scoreSelections(selections) -> Promise<{success, selections:[{eventId, score}]}>,
//         getEventMarkets(eventId) -> Promise<{markets:[{marketName,outcomeName,marketId,outcomeId,specifier,odds}]}> }
async function applyActions(selections, actions, warnings, deps) {
  let sels = selections.map((s) => ({ ...s }));
  const locked = new Set();

  for (const a of actions) {
    if (a.type === 'lock' && a.team) sels.forEach((s) => { if (includesFuzzy(s.homeTeam, a.team) || includesFuzzy(s.awayTeam, a.team)) locked.add(s.eventId); });
    if (a.type === 'unlock' && a.team) sels.forEach((s) => { if (includesFuzzy(s.homeTeam, a.team) || includesFuzzy(s.awayTeam, a.team)) locked.delete(s.eventId); });
  }

  for (const a of actions) {
    const before = sels.length;
    switch (a.type) {
      case 'remove_league':
        sels = sels.filter((s) => !includesFuzzy(s.league, a.league));
        break;
      case 'remove_team':
        sels = sels.filter((s) => !includesFuzzy(s.homeTeam, a.team) && !includesFuzzy(s.awayTeam, a.team));
        break;
      case 'remove_any':
        sels = sels.filter((s) => !(includesFuzzy(s.league, a.term) || includesFuzzy(s.homeTeam, a.term) || includesFuzzy(s.awayTeam, a.term) || includesFuzzy(s.market, a.term) || includesFuzzy(s.outcome, a.term)));
        break;
      case 'remove_market_type':
        sels = sels.filter((s) => !includesFuzzy(s.market, a.keyword) && !includesFuzzy(s.outcome, a.keyword));
        break;
      case 'keep_only_league':
        sels = sels.filter((s) => includesFuzzy(s.league, a.league));
        break;
      case 'remove_last_n': {
        const n = Math.max(1, parseInt(a.n) || 1);
        sels = sels.slice(0, Math.max(0, sels.length - n));
        break;
      }
      case 'keep_today_only':
        sels = sels.filter((s) => isToday(s.kickoff));
        break;
      case 'remove_tomorrow':
        sels = sels.filter((s) => !isTomorrow(s.kickoff));
        break;
      case 'reduce_risk':
      case 'maximize_confidence': {
        try {
          const scored = await deps.scoreSelections(sels);
          if (scored?.success) {
            const scoreMap = new Map(scored.selections.map((s) => [s.eventId, s.score]));
            const threshold = a.type === 'maximize_confidence' ? 60 : 40;
            const kept = sels.filter((s) => locked.has(s.eventId) || (scoreMap.get(s.eventId) ?? 50) >= threshold);
            if (kept.length >= Math.min(3, sels.length)) sels = kept;
            else warnings.push(`${a.type}: not enough high-confidence selections left, kept original set`);
          }
        } catch { warnings.push('Could not reach scoring engine for ' + a.type); }
        break;
      }
      case 'reduce_to_target_odds': {
        const target = parseFloat(a.target);
        if (target > 0) {
          try {
            const scored = await deps.scoreSelections(sels);
            const scoreMap = scored?.success ? new Map(scored.selections.map((s) => [s.eventId, s.score])) : new Map();
            const removable = sels.filter((s) => !locked.has(s.eventId)).sort((a2, b2) => (scoreMap.get(a2.eventId) ?? 50) - (scoreMap.get(b2.eventId) ?? 50));
            let idx = 0;
            while (removable.length && sels.reduce((acc, s) => acc * (s.originalOdds || s.odds || 1), 1) > target && idx < removable.length && sels.length > 1) {
              sels = sels.filter((s) => s.eventId !== removable[idx].eventId);
              idx++;
            }
          } catch { warnings.push('Could not reduce to target odds precisely'); }
        }
        break;
      }
      case 'increase_to_target_odds':
        warnings.push("Increasing odds isn't fully automatic — removing selections only lowers odds. Try asking to convert markets to higher-odds equivalents instead.");
        break;
      case 'convert_market': {
        for (const s of sels) {
          const isOU = /over\/under/i.test(s.market) || /^(over|under)\s/i.test(s.outcome || '');
          const isBTTS = /gg\/ng|both teams to score/i.test(s.market);
          const matchesFamily = (a.family === 'over_under' && isOU) || (a.family === 'btts' && isBTTS);
          if (!matchesFamily) continue;
          try {
            const marketData = await deps.getEventMarkets(s.eventId);
            if (!marketData?.markets) continue;
            const match = marketData.markets.find((mk) => includesFuzzy(mk.outcomeName, a.to));
            if (match) {
              s.market = match.marketName; s.outcome = match.outcomeName; s.marketId = match.marketId;
              s.outcomeId = match.outcomeId; s.specifier = match.specifier; s.odds = match.odds; s.originalOdds = match.odds;
            } else {
              warnings.push(`Couldn't find "${a.to}" for ${s.homeTeam} vs ${s.awayTeam} — left as-is`);
            }
          } catch { warnings.push(`Market lookup failed for ${s.homeTeam} vs ${s.awayTeam}`); }
        }
        break;
      }
      case 'rebuild':
      default:
        break;
    }
    if (sels.length === 0 && before > 0) {
      warnings.push(`Action "${a.type}" would have removed everything — reverted that step`);
      sels = selections.map((s) => ({ ...s }));
    }
  }
  return sels;
}

function isToday(kickoffISO) {
  if (!kickoffISO) return false;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  return today === new Date(kickoffISO).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}
function isTomorrow(kickoffISO) {
  if (!kickoffISO) return false;
  const t = new Date(); t.setDate(t.getDate() + 1);
  const tomorrow = t.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  return tomorrow === new Date(kickoffISO).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

// ── Template-based reply generator — NO LLM ──
const RISK_ACTION_TYPES = new Set(['reduce_risk', 'maximize_confidence', 'reduce_to_target_odds', 'increase_to_target_odds']);

function buildReply(ctx) {
  const { detectedCode, actionsPerformed = [], scan, oldOdds, newOdds, newBookingCode, removedCount = 0, warnings = [] } = ctx;

  if (!detectedCode) {
    return { reply: "Couldn't find a booking code in that — mind sending the code or the full slip?", firstReply: null };
  }

  if (scan && !newBookingCode) {
    const settled = scan.won + scan.lost + scan.void;
    const lines = [
      `✅ Ticket scanned.`,
      `${settled}/${scan.total} selections settled${scan.pending ? `, ${scan.pending} pending` : ''}.`,
      `Current status: ${scan.won}/${scan.won + scan.lost}${scan.void ? ` (+${scan.void} void)` : ''}.`,
    ];
    if (scan.pending === 0) lines.push(`Hit rate: ${scan.hitRate}%.`);
    const firstReply = scan.pending > 0 ? "I'll keep an eye on the pending ones — want an update when it settles?" : null;
    return { reply: lines.join('\n'), firstReply };
  }

  if (newBookingCode) {
    const usedRiskEngine = actionsPerformed.some((a) => RISK_ACTION_TYPES.has(a.type));
    const skipInBody = usedRiskEngine ? new Set(['rebuild', 'reduce_risk', 'maximize_confidence']) : new Set(['rebuild']);
    const actionLines = actionsPerformed.filter((a) => !skipInBody.has(a.type)).map(describeAction);
    const capitalized = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    let header;
    if (usedRiskEngine) header = removedCount > 0 ? `Found ${removedCount} risky selection${removedCount === 1 ? '' : 's'}.` : `Rebuilt with the safer picks.`;
    else header = 'Done.';

    const body = actionLines.length ? actionLines.map(capitalized).join('.\n') + '.' : '';
    const lines = [header];
    if (body) lines.push(body);
    lines.push(`New odds: ${newOdds}`);
    lines.push(`Booking code: ${newBookingCode}`);

    const firstReply = usedRiskEngine ? 'Want me to trim it even further, or lock in a couple of picks?' : 'Need another tweak — different league, lower odds, anything?';
    return { reply: lines.join('\n'), firstReply };
  }

  if (warnings.length) {
    return { reply: `Couldn't quite finish that one:\n${warnings[0]}`, firstReply: null };
  }

  return { reply: "Got the ticket, but couldn't tell what change you wanted — try something like 'remove Brazil' or 'reduce to 500 odds'.", firstReply: null };
}

module.exports = { parseIntent, applyActions, buildReply, describeAction, includesFuzzy };
