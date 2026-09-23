// x-assistant-engine.js — SlipPilot X Assistant v2
// Conversational AI assistant for betting slip analysis and generation.
// No LLM — deterministic intent routing with natural language understanding.
// Handles: SCAN | MODIFY | BUILD | COMPARE | INTELLIGENCE | CONTENT | EXPLAIN
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const intentEngine = require('./intent-engine');

const DATA_DIR     = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'x-assistant-history.json');
const PORT         = 3000;
const ADMIN_KEY    = process.env.ADMIN_PASSWORD || '';

// ── Loopback HTTP to the running SlipPilot server ──────────────────────────

function loopback(method, p, body) {
  return new Promise((ok, fail) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: PORT, path: p, method,
      headers: {
        'x-admin-password': ADMIN_KEY,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, r => {
      let d = ''; r.on('data', c => (d += c));
      r.on('end', () => { try { ok(JSON.parse(d)); } catch { fail(new Error('bad json: ' + p + ' — ' + d.slice(0, 80))); } });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}
const get  = p    => loopback('GET',  p, null);
const post = (p, b) => loopback('POST', p, b);

const engineDeps = {
  scoreSelections: (selections) => post('/api/score-selections', { selections }),
  getEventMarkets: (eventId)    => get('/api/markets/' + encodeURIComponent(eventId)),
};

// ── History store ──────────────────────────────────────────────────────────

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch { return []; }
}
function saveHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(-500), null, 2));
}
function appendHistory(entry) {
  const list = loadHistory();
  list.push(entry);
  saveHistory(list);
  return entry;
}

// ── Simple session context store (in-memory, keyed by sessionId) ───────────

const _sessions = new Map(); // sessionId → { lastCode, lastPicks, lastIntent, lastReply }
function getSession(id) { return _sessions.get(id) || {}; }
function setSession(id, data) {
  const previous = getSession(id);
  _sessions.delete(id);
  _sessions.set(id, { ...previous, ...data, _touchedAt: Date.now() });
  while (_sessions.size > 250) _sessions.delete(_sessions.keys().next().value);
}

// ── Tweet text via oEmbed ──────────────────────────────────────────────────

function fetchTweetText(tweetUrl) {
  return new Promise(resolve => {
    const url = 'https://publish.twitter.com/oembed?omit_script=true&url=' + encodeURIComponent(tweetUrl);
    https.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.html) return resolve({ success: false });
          const firstP = json.html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          let text = firstP ? firstP[1] : json.html;
          text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
          resolve({ success: true, text, author: json.author_name || '' });
        } catch { resolve({ success: false }); }
      });
    }).on('error', () => resolve({ success: false }))
      .on('timeout', function() { this.destroy(); resolve({ success: false }); });
  });
}

// ── Booking code detection ─────────────────────────────────────────────────

const CODE_STOPWORDS = new Set(['ABOUT','THANKS','PLEASE','TODAY','GAMES','GOALS','THINK','MAKE',
  'THESE','THOSE','BEFORE','AFTER','LEAGUE','THINGS','REMOVE','THANK','GREAT','REALLY',
  'SAFER','RISKY','THREE','SEVEN','EIGHT','BRAZIL','ARSENAL','TOMORROW','TONIGHT',
  'MATCHES','MARKET','MARKETS','CONFIDENCE','OPTIMIZE','SWEDEN','REBUILD','IMPROVE',
  'REPLACE','BOOKING','SCANNER','VERIFY','STATUS','BUILD','CREATE','GENERATE','AVOID',
  'EXCLUDE','PREFER','COMPARE','EXPLAIN','WHICH','PUNTER','LEAGUE','BETTER','WORSE']);

async function detectBookingCode(text) {
  if (!text) return null;
  const candidates = [...new Set((text.match(/\b[A-Za-z0-9]{5,9}\b/g) || []).map(c => c.toUpperCase()))]
    .filter(c => !CODE_STOPWORDS.has(c));
  for (const code of candidates) {
    try {
      const result = await get('/api/booking/' + encodeURIComponent(code));
      if (result && !result.error && result.selections) return { code, booking: result };
    } catch {}
  }
  return null;
}

// ── Helper: get intelligence data ─────────────────────────────────────────

async function getIntelData() {
  const [leagues, markets, xContext] = await Promise.allSettled([
    get('/api/intelligence/leagues'),
    get('/api/intelligence/markets'),
    get('/api/admin/x-intel'),
  ]);

  // Also try to get yesterday's report
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yd = yesterday.toISOString().slice(0, 10);
  let recentReport = null;
  try { recentReport = await get('/api/analysis/' + yd); } catch {}

  return {
    leagueIntel:  leagues.status  === 'fulfilled' ? leagues.value  : {},
    marketIntel:  markets.status  === 'fulfilled' ? markets.value  : {},
    xContext:     xContext.status === 'fulfilled' ? xContext.value : {},
    todayReport:  recentReport,
  };
}

// ── Helper: build from master pool ────────────────────────────────────────

async function buildFromPool(filters, warnings) {
  // Try cached pool first
  let poolData = null;
  try { poolData = await get('/api/admin/master-pool'); } catch {}

  if (!poolData || !poolData.success || !poolData.masterPool?.length) {
    warnings.push('No master pool cached. Run "Run Master Analysis" in the admin panel first, then try again.');
    return [];
  }

  const rawPool = poolData.masterPool;

  // Apply optimizer filters
  const filteredPool = intentEngine.applyPoolFilters(rawPool, filters);

  if (filteredPool.length < 4) {
    warnings.push(`Only ${filteredPool.length} picks passed your filters (need at least 4). Try loosening the criteria.`);
    return [];
  }

  // Determine how many picks to include based on strategy
  const strategyConfig = {
    safe:      { minGames: 12, maxGames: 22, maxOdds: 1.50 },
    high_odds: { minGames: 20, maxGames: 35, maxOdds: 2.00 },
    consensus: { minGames: 10, maxGames: 20, maxOdds: 1.80 },
    balanced:  { minGames: 14, maxGames: 25, maxOdds: 1.80 },
  };
  const cfg = strategyConfig[filters.strategy] || strategyConfig.balanced;

  // Build N codes
  const codes = [];
  const usedCodes = new Set();

  for (let attempt = 0; attempt < filters.count; attempt++) {
    // Vary pick selection for each code
    const offset = attempt * 3;
    const poolSlice = filteredPool.slice(offset, offset + 60); // take different slices for variety

    // Build the selection set
    let selections = poolSlice
      .filter(p => (p.odds || 0) <= cfg.maxOdds)
      .slice(0, cfg.maxGames);

    if (selections.length < cfg.minGames) {
      // Fallback: use full pool
      selections = filteredPool.filter(p => (p.odds||0) <= cfg.maxOdds).slice(0, cfg.maxGames);
    }

    if (selections.length < 3) {
      warnings.push(`Not enough picks for ticket ${attempt+1} after filters.`);
      continue;
    }

    // Calculate total odds
    const totalOdds = selections.reduce((acc, s) => acc * (s.odds || 1), 1);
    if (totalOdds < 10 && selections.length < cfg.minGames) {
      warnings.push(`Ticket ${attempt+1} odds too low (${Math.round(totalOdds)}x). Adding more picks.`);
    }

    // Format for SportyBet API
    const payload = selections.map(s => ({
      eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
      productId: s.productId || 3, sportId: s.sportId || 'sr:sport:1',
      specifier: s.specifier || '',
    }));

    try {
      const gen = await post('/api/generate', { selections: payload });
      if (gen.success && gen.shareCode && !usedCodes.has(gen.shareCode)) {
        usedCodes.add(gen.shareCode);
        const avgConf = Math.round(selections.reduce((s, p) => s + (p.confidence || 0), 0) / selections.length);
        const totalO = Math.round(totalOdds);
        codes.push({
          code: gen.shareCode,
          gameCount: selections.length,
          totalOdds,
          totalOddsFormatted: totalO >= 1000 ? (totalO/1000).toFixed(1)+'K' : totalO + 'x',
          avgScore: avgConf,
          selections: selections.map(s => ({
            homeTeam: s.homeTeam, awayTeam: s.awayTeam, league: s.league,
            market: s.marketName || s.market, outcome: s.outcomeName || s.outcome,
            odds: s.odds, confidence: s.confidence,
          })),
        });
      } else if (!gen.success) {
        warnings.push(`Could not generate code ${attempt+1}: ${gen.error || 'unknown'}`);
      }
    } catch (e) {
      warnings.push(`Code generation failed: ${e.message}`);
    }

    // Small delay between codes
    if (attempt < filters.count - 1) await new Promise(r => setTimeout(r, 300));
  }

  return codes;
}

// ── Main: analyze (backward-compat, for existing routes) ──────────────────

async function analyze({ tweetUrl, tweetText, sessionId }) {
  const sid = sessionId || 'default';
  const warnings = [];
  let text = tweetText || '';
  let author = '';

  if (tweetUrl && !tweetText) {
    const fetched = await fetchTweetText(tweetUrl);
    if (fetched.success) { text = fetched.text; author = fetched.author; }
    else return { needsManualText: true, tweetUrl, warnings: ["Couldn't auto-fetch that tweet — paste the tweet text instead."] };
  }

  if (!text.trim()) return { needsManualText: true, tweetUrl, warnings: ['No text to work with — paste the tweet text.'] };

  return analyzeText({ text, author, tweetUrl: tweetUrl || null, sessionId: sid });
}

// ── Portfolio generator via API loopback ──────────────────────────────────

async function buildViaPortfolio(opts, warnings) {
  try {
    const result = await post('/api/admin/portfolio-generate', opts);
    if (!result.success) {
      warnings.push(result.error || 'Portfolio generation failed');
      return [];
    }
    return result.codes || [];
  } catch (e) {
    warnings.push('Portfolio API error: ' + e.message);
    return [];
  }
}

// ── Main: analyzeText — conversational entry point ─────────────────────────

async function analyzeText({ text, author, tweetUrl, sessionId }) {
  const sid = sessionId || 'default';
  const session = getSession(sid);
  const warnings = [];

  const intent = intentEngine.parseIntent(text);
  const topLevel = intent.topLevel || 'UNKNOWN';

  const result = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    tweetUrl: tweetUrl || null,
    tweetText: text,
    author: author || '',
    intent: topLevel,
    intentSummary: intent.summary,
    detectedCode: null,
    actionsRequested: intent.actions || [],
    actionsPerformed: [],
    warnings,
    // output fields
    oldOdds: null,
    newOdds: null,
    newBookingCode: null,
    newCodes: null,          // multiple codes (BUILD with count > 1)
    confidence: null,
    scan: null,
    reply: null,
    firstReply: null,
    intelResponse: null,    // INTELLIGENCE intent
    contentPost: null,      // CONTENT intent
    codeBreakdown: null,    // EXPLAIN intent
  };

  // ── INTELLIGENCE INTENT ────────────────────────────────────────────────────
  if (topLevel === 'INTELLIGENCE') {
    try {
      const intelData = await getIntelData();
      const punterStats = intelData.xContext?.punterStats || [];
      const response = intentEngine.formatIntelResponse(intent.query?.type || 'general_stats', {
        leagueIntel: intelData.leagueIntel,
        marketIntel: intelData.marketIntel,
        punterStats,
        xContext: intelData.xContext,
        todayReport: intelData.todayReport,
      });
      result.intelResponse = response;
      result.reply = response;
      result.firstReply = 'Want more details on any of these? Try: "show me worst markets" or "who is the top punter?"';
    } catch (e) {
      result.warnings.push('Could not load intelligence data: ' + e.message);
      result.reply = 'Intelligence data is unavailable right now. Make sure the intelligence engine has run today.';
    }
    appendHistory(result);
    return result;
  }

  // ── CONTENT INTENT ─────────────────────────────────────────────────────────
  if (topLevel === 'CONTENT') {
    try {
      const [intelData, poolData, punterCodesRes] = await Promise.allSettled([
        getIntelData(),
        get('/api/admin/master-pool'),
        get('/api/admin/punter-codes'),
      ]);
      const intel   = intelData.status === 'fulfilled' ? intelData.value : {};
      const pool    = poolData.status  === 'fulfilled' && poolData.value?.success ? poolData.value.masterPool || [] : [];
      const punters = punterCodesRes.status === 'fulfilled'
        ? Object.entries(punterCodesRes.value || {}).filter(([k,v]) => v && !k.startsWith('_')).map(([name, code]) => ({ name, code }))
        : [];

      const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
      const reportDate = yesterday.toISOString().slice(0,10);
      let report = null;
      try { report = await get('/api/analysis/' + reportDate); } catch {}

      const ctx = {
        picks: pool.slice(0, 10),
        punters,
        report: report || {},
        code: session.lastCode || null,
        totalOdds: session.lastOdds || null,
        date: new Date().toLocaleDateString('en-NG', { weekday:'long', day:'numeric', month:'long' }),
      };

      const contentPost = intentEngine.generateContent(intent.contentType?.type || 'general', ctx);
      result.contentPost = contentPost;
      result.reply = `📝 Here's your draft post:\n\n${contentPost}`;
      result.firstReply = 'Copy it above, or ask me to make it shorter, add a poll, or change the tone.';
    } catch (e) {
      result.warnings.push('Content generation failed: ' + e.message);
      result.reply = 'Could not generate content right now. Try again in a moment.';
    }
    appendHistory(result);
    return result;
  }

  // ── BUILD INTENT ───────────────────────────────────────────────────────────
  if (topLevel === 'BUILD') {
    // Phase 3: use portfolio builder with rich options extracted from natural language
    const genOpts = intentEngine.parseGeneratorOptions(text);

    // Try portfolio builder first (via /api/admin/portfolio-generate loopback)
    let codes = await buildViaPortfolio(genOpts, warnings);

    // If portfolio builder fails (e.g. no master pool), fall back to legacy buildFromPool
    if (!codes.length) {
      const filters = intent.filters || intentEngine.parseFilters(text);
      codes = await buildFromPool(filters, warnings);
    }

    result.newCodes = codes;
    if (codes.length === 1) {
      result.newBookingCode = codes[0].code;
      result.newOdds = codes[0].totalOdds;
      setSession(sid, { lastCode: codes[0].code, lastOdds: codes[0].totalOdds, lastPicks: codes[0].picks || codes[0].selections || [] });
    } else if (codes.length > 1) {
      setSession(sid, { lastCode: codes[0].code, lastOdds: codes[0].totalOdds, lastPicks: codes[0].picks || codes[0].selections || [] });
    }

    // Build reply summary
    if (codes.length) {
      const lines = [];
      if (codes.length === 1) {
        const c = codes[0];
        lines.push(`✅ Here's your ${genOpts.strategy} ticket:`);
        lines.push('');
        lines.push(`Booking code: **${c.code}**`);
        lines.push(`Games: ${c.gameCount}  |  Odds: ~${c.totalOddsFormatted || Math.round(c.totalOdds)+'x'}`);
        if (c.avgConfidence) lines.push(`Avg confidence: ${c.avgConfidence}/100`);
        if (warnings.length) lines.push('\n⚠️ ' + warnings.join('\n⚠️ '));
      } else {
        lines.push(`✅ Generated ${codes.length} tickets:`);
        codes.forEach((c, i) => {
          lines.push(`\n${i+1}. **${c.code}** — ${c.gameCount} games, ~${c.totalOddsFormatted || Math.round(c.totalOdds)+'x'}`);
        });
        if (warnings.length) lines.push('\n⚠️ ' + warnings.join('\n⚠️ '));
      }
      result.reply = lines.join('\n');
      result.firstReply = codes.length > 1 ? 'Tap any code to copy it, or ask me to explain the picks in any of them.' : 'Want me to explain the picks, or build a different strategy?';
    } else {
      result.reply = warnings.length
        ? 'Could not build a ticket:\n' + warnings.map(w => '• ' + w).join('\n')
        : 'No suitable picks found. Try running Master Analysis first, or relax the filters.';
    }

    appendHistory(result);
    return result;
  }

  // ── COMPARE INTENT ─────────────────────────────────────────────────────────
  if (topLevel === 'COMPARE') {
    const detected = await detectBookingCode(text);
    const detected2 = null; // Second code — would need two codes in input

    // Check if comparing to yesterday
    if (/yesterday/i.test(text)) {
      try {
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
        const reportDate = yesterday.toISOString().slice(0,10);
        const report = await get('/api/analysis/' + reportDate);
        const totals = report?.analysis?.totals || report?.totals || {};
        const ctx = detected ? await get('/api/scan/' + detected.code) : null;
        const parts = ['📊 Comparison with yesterday:'];
        if (ctx) parts.push(`Current ticket: ${ctx.won || 0}W/${ctx.lost || 0}L — ${ctx.hitRate || '?'}% HR`);
        parts.push(`Yesterday overall: ${totals.hitRate || '?'}% HR (${totals.won||0}W/${totals.lost||0}L, ${totals.selections||0} selections)`);
        if (report?.analysis?.punterStats?.length) {
          const top = report.analysis.punterStats.sort((a,b) => (b.hitRate||0)-(a.hitRate||0))[0];
          parts.push(`Best punter yesterday: ${top.punter} — ${top.hitRate}%`);
        }
        result.reply = parts.join('\n');
        result.firstReply = 'Want the full breakdown? Ask me "which market performed best yesterday?"';
      } catch(e) {
        result.reply = 'Could not load yesterday\'s data. Make sure a rescan was run yesterday.';
      }
    } else if (detected) {
      // Scan the detected code and compare with session context
      const scan = await get('/api/scan/' + detected.code).catch(() => null);
      result.detectedCode = detected.code;
      result.scan = scan;
      const prev = session.lastCode;
      if (prev && prev !== detected.code) {
        const prevScan = await get('/api/scan/' + prev).catch(() => null);
        const parts = [`Comparing ${prev} vs ${detected.code}:`];
        if (prevScan) parts.push(`${prev}: ${prevScan.won||0}W/${prevScan.lost||0}L`);
        if (scan) parts.push(`${detected.code}: ${scan.won||0}W/${scan.lost||0}L`);
        result.reply = parts.join('\n');
      } else {
        result.reply = scan
          ? `${detected.code}: ${scan.won||0}W/${scan.lost||0}L/${scan.void||0}V — ${scan.hitRate||'?'}% HR`
          : 'Could not scan that code right now.';
      }
      result.firstReply = 'Paste another code to compare side by side.';
    } else {
      result.reply = 'For a comparison, paste a booking code or ask "compare this with yesterday".';
    }
    appendHistory(result);
    return result;
  }

  // ── All remaining intents need a booking code ──────────────────────────────
  const detected = await detectBookingCode(text);
  result.detectedCode = detected?.code || null;

  // ── SCAN INTENT ────────────────────────────────────────────────────────────
  if (topLevel === 'SCAN' || (intent.isScanRequest && !intent.actions?.length)) {
    if (!detected) {
      result.reply = "Paste a valid SportyBet booking code and I'll scan it for results.";
      appendHistory(result);
      return result;
    }
    result.intentSummary = 'Scan/verify this ticket';
    try {
      const scan = await get('/api/scan/' + encodeURIComponent(detected.code));
      result.scan = scan;
      result.oldOdds = detected.booking.totalOdds;
      setSession(sid, { lastCode: detected.code });
    } catch(e) { result.warnings.push('Scan failed: ' + e.message); }
    const { reply, firstReply } = intentEngine.buildReply({ detectedCode: result.detectedCode, scan: result.scan, oldOdds: result.oldOdds, newBookingCode: null, actionsPerformed: [], removedCount: 0, warnings: result.warnings });
    result.reply = reply; result.firstReply = firstReply;
    appendHistory(result);
    return result;
  }

  // ── EXPLAIN INTENT ─────────────────────────────────────────────────────────
  if (topLevel === 'EXPLAIN' || intent.isExplainRequest) {
    if (!detected) {
      result.reply = "Paste a booking code and I'll explain every pick in it.";
      appendHistory(result);
      return result;
    }
    result.oldOdds = detected.booking.totalOdds;
    const sels = detected.booking.selections || [];
    try {
      const scored = await post('/api/score-selections', { selections: sels });
      const scoreMap = scored?.success ? new Map(scored.selections.map(s => [s.eventId, s.score])) : new Map();
      const breakdown = sels.slice(0, 8).map(s => {
        const score = scoreMap.get(s.eventId);
        const conf = score !== undefined ? ` — ${score}% confidence` : '';
        return `• ${s.homeTeam || ''} vs ${s.awayTeam || ''}: ${s.market || ''} @${s.odds}${conf}`;
      });
      result.codeBreakdown = breakdown;
      result.reply = [
        `📋 Breakdown of ${detected.code} (${sels.length} picks, ~${Math.round(detected.booking.totalOdds)}x):`,
        '',
        ...breakdown,
        sels.length > 8 ? `...and ${sels.length - 8} more picks` : '',
      ].filter(Boolean).join('\n');
      result.firstReply = 'Want me to rebuild it with only the high-confidence picks? Or remove the risky legs?';
    } catch(e) {
      result.reply = `${detected.code} has ${sels.length} picks totalling ~${Math.round(detected.booking.totalOdds)}x odds.`;
    }
    appendHistory(result);
    return result;
  }

  // ── MODIFY INTENT ─────────────────────────────────────────────────────────
  if (!detected && (topLevel === 'MODIFY' || intent.actions?.length)) {
    result.reply = "I'll need a booking code to modify. Paste the code along with your request.";
    appendHistory(result);
    return result;
  }

  if (detected && intent.actions?.length) {
    result.oldOdds = detected.booking.totalOdds;
    const originalCount = detected.booking.selections.length;
    try {
      const newSels = await intentEngine.applyActions(detected.booking.selections, intent.actions, warnings, engineDeps);
      result.actionsPerformed = intent.actions;
      if (newSels.length > 0) {
        const gen = await post('/api/generate', { selections: newSels });
        if (gen.success) {
          result.newBookingCode = gen.shareCode;
          result.newOdds = Math.round(newSels.reduce((acc, s) => acc * (s.originalOdds || s.odds || 1), 1) * 100) / 100;
          result.removedCount = Math.max(0, originalCount - newSels.length);
          setSession(sid, { lastCode: gen.shareCode, lastOdds: result.newOdds, lastPicks: newSels });
        } else {
          result.warnings.push('Could not generate new code: ' + (gen.error || 'unknown'));
        }
        try {
          const scored = await post('/api/score-selections', { selections: newSels });
          if (scored?.success) result.confidence = Math.round(scored.selections.reduce((a,s) => a + s.score, 0) / scored.selections.length);
        } catch {}
      } else {
        result.warnings.push('All selections were removed — nothing to rebuild.');
      }
    } catch(e) { result.warnings.push('Optimization failed: ' + e.message); }
  } else if (detected) {
    // No actions — default to scan
    result.intentSummary = 'Scan/verify this ticket';
    try {
      const scan = await get('/api/scan/' + encodeURIComponent(detected.code));
      result.scan = scan;
      result.oldOdds = detected.booking.totalOdds;
    } catch(e) { result.warnings.push('Scan failed: ' + e.message); }
  } else {
    // No code, no clear intent
    result.reply = 'I can:\n• Scan a ticket: paste any SportyBet booking code\n• Build a new ticket: "build me a safe ticket"\n• Answer stats: "which market performs best?"\n• Generate posts: "write me a daily post"\n• Modify a slip: paste a code + tell me what to change';
  }

  const { reply, firstReply } = intentEngine.buildReply({
    detectedCode: result.detectedCode,
    actionsPerformed: result.actionsPerformed,
    scan: result.scan,
    oldOdds: result.oldOdds,
    newOdds: result.newOdds,
    newBookingCode: result.newBookingCode,
    removedCount: result.removedCount || 0,
    warnings: result.warnings,
  });
  if (!result.reply) { result.reply = reply; result.firstReply = firstReply; }

  appendHistory(result);
  return result;
}

module.exports = { analyze, analyzeText, loadHistory };
