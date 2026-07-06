# Analysis Engine

## Overview

`analyze2.js` is the core intelligence engine. It runs as a child process triggered by `POST /api/admin/regen-all`. It requires `server.js` to be running on port 3000, as it calls local endpoints.

Run time: 3–10 minutes depending on how many punters and how many H2H lookups succeed.

## Steps

### Step 1 — Fetch All Codes

For each punter, two types of codes are fetched:

- **Today codes**: `GET /api/booking/:code` — returns selections (eventId, marketId, outcomeId, odds, teams) for the current booking code. These are the picks the punter is backing today.
- **History codes**: `GET /api/scan/:code` — returns settled results (WON/LOST/VOID per selection) for historical codes. Used for profiling only.

SpottyBet API: `https://www.sportybet.com/api/ng/orders/share/:code`

### Step 2 — Build Punter Profiles

For each punter, using their scanned history:

- `hitRate` = `won / (won + lost) × 100`
- `avgOddsPerGame` = mean of all individual selection odds
- `consistency` = `100 - standardDeviation(codeHitRates)` — low variance = high consistency
- `trustScore` = hitRate ± adjustments:
  - +10 if ≥3 history codes and variance <15%
  - -15 if "correct score" in killer markets
  - -10 if "both halves" in killer markets
  - +5 if avgOdds <1.60
  - +10 if any code hit ≥80%
  - -10 if any code hit <40%
- `strongMarkets` = markets where win rate >70% with ≥2 appearances
- `killerMarkets` = markets where win rate <40% with ≥2 appearances

### Step 3 — Build Master Pool

All `eventId`s from all punters' today codes are merged into a unique pool. Each game in the pool has:

- `picks[]` — all selections from all punters for this event
- `punters[]` — which punters picked this match
- `flag` — `"strong"` (3+ primary tier), `"consensus"` (2+), or `"solo"`
- `bestPick` — selection from the highest trust-score punter

### Step 4 — H2H Analysis

For each game in the pool, API-Football is queried:

- Team IDs looked up via `/teams?search=`
- Last 10 H2H fixtures fetched
- Last 5 home/away fixtures for form

Calculated:
- `avgGoals`, `bttsRate`, `over15Rate`, `over25Rate`, `homeWinRate`
- `homeForm`, `awayForm` (W/L/D strings)

Each game then gets a `safetyScore` (0–100) based on H2H support for the selection, consensus level, and punter trust.

### Step 5 — Smart Conversions

Risky selections are automatically converted to safer equivalents:

| Original | Converted to | Condition |
|---|---|---|
| Over 4.5 / Over 3.0 | Over 2.5 | Always |
| Over 2.5 | Over 1.5 | H2H avg goals <2.0 |
| BTTS Yes | Over 1.5 | H2H BTTS rate <40% |
| Home (1x2) | Double Chance 1X | H2H home win rate <25% |
| Away (1x2) | Double Chance X2 | H2H home win rate >75% |
| Correct Score | Over 1.5 | Always |

Selections are removed if: BTTS No with high BTTS history, Asian Handicap ≤-2.0.

### Step 6 — Code Generation

60 booking codes are generated across 8 groups:

| Group | Strategy | Codes | Games | Target Odds |
|---|---|---|---|---|
| A | Safe picks (safety ≥65) | 10 | 22–30 | 1,000×+ |
| B | Balanced (safety ≥50) | 10 | 28–38 | 10,000×+ |
| C | Value (safety ≥35) | 10 | 35–45 | 100,000×+ |
| D | Consensus bankers | 5 | 20–28 | 1,000×–50,000× |
| E | Moonshot (all pool) | 5 | 45–60 | 1,000,000×+ |
| F | Permutation (bankers + random fill) | 10 | ~25 | Mixed |
| G | Pure merge (best 5 from each primary) | 5 | ~30 | Mixed |
| H | 2-punter merge (specific pairs) | 5 | ~20 | Mixed |

Generated codes posted to `POST /api/generate` → SpottyBet booking API.

## Outputs

| File | Content |
|---|---|
| `data/codes-today.txt` | Human-readable summary of all codes and analysis |
| `data/punter-profiles.json` | Full profile per punter (trust, markets, consistency) |
| `data/generated-codes.json` | All 60 codes by group with odds and game count |

## Punters Tracked

Defined in `analyze2.js` (hardcoded):

| Name | Handle | Tier |
|---|---|---|
| 39 Billion | @39billion | primary |
| 9Z | @9zerobillion | primary |
| Big Strategic | @Big_Strategic | primary |
| Ayo Jordan | @AyoJordan | primary |
| Bayo Bets | @BayoBets | primary |
| OY | @OyAi_dev | secondary |
| Princewill | @90Princewill | secondary |
| Sirtee | @Sirtee | secondary |

Primary punters carry more weight in consensus scoring (3+ primary = "strong consensus").

## Leaderboard Ranking

Punters in `leaderboard.json` are ranked by a composite of:

- Historical hit rate (all-time)
- Yesterday's hit rate (recency weight)
- Trust score
- Consistency

The exact weighting is computed in `server.js` when it reads the leaderboard for the admin panel.
