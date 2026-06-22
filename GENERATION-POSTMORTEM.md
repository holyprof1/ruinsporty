# SlipPilot Generation Post-Mortem — June 22, 2026

## Results Summary

Sampled 30 of 150 generated codes. **0 clean slips. Every single slip had at least 2 cuts.**

| Metric | Value |
|--------|-------|
| Total games scanned | 430 |
| Won | 178 (74%) |
| Lost | 61 |
| Pending | 191 |
| Clean slips (0 loss) | 0 |
| 1 cut | 2 |
| 2 cuts | 6 |
| 3 cuts | 7 |
| 5+ cuts | 2 |

74% individual hit rate is decent — but when you stack 20-40 picks in one accumulator, even 74% per pick means the probability of a clean sweep is nearly zero.

**Math**: 0.74^20 = 0.3% chance of clean sweep on a 20-game slip. 0.74^40 = 0.0001%.

## Root Causes

### 1. OVER-2.0 ODDS PICKS HAD 0% WIN RATE

| Odds Range | Won | Lost | Win Rate |
|-----------|-----|------|----------|
| Under 1.30 | 125 | 23 | **84%** |
| 1.30-1.50 | 35 | 9 | **80%** |
| 1.50-2.00 | 18 | 18 | **50%** |
| Over 2.00 | 0 | 11 | **0%** |

**Lesson**: Anything above 1.50 odds is essentially a coin flip. Above 2.00 is worse than a coin flip. The "under 2.0 only" rule from the later generation run was correct but came too late.

### 2. SPECIFIC MARKETS THAT KILLED SLIPS

| Market | Losses | Notes |
|--------|--------|-------|
| Excluded Number of Goals - Away | 17 | Exotic market, unreliable |
| 2nd Half - Argentina Over/Under | 11 | World Cup specials, volatile |
| Excluded Number of Goals - Home | 10 | Same exotic market problem |
| Both Halves Over 1.5 | 8 | Requires goals in BOTH halves — too specific |
| Double Chance | 8 | Usually safe, but failed in lower leagues |
| Over/Under - Early Goals | 7 | Time-bound, unpredictable |

**Lesson**: "Exotic" markets (Excluded Goals, 2nd Half team-specific, Both Halves Over) should be BLACKLISTED entirely. They look safe on paper but have poor hit rates.

### 3. LEAGUES THAT FAILED MOST

| League | Losses |
|--------|--------|
| Erovnuli Liga (Georgia) | 17 |
| World Cup | 11 |
| Premier League (Ethiopia) | 10 |
| Copa de la Liga (Peru) | 8 |
| U21 leagues | 8 |
| Superettan (Sweden 2nd tier) | 7 |

**Lesson**: Georgian, Ethiopian, and youth leagues are fundamentally unpredictable. Even "safe" markets in these leagues fail. The World Cup losses came from aggressive specials (team-specific Over/Under, halftime markets).

### 4. STRUCTURAL FLAW: TOO MANY GAMES PER SLIP

Group A had 8-15 games — those were the "safest" but even they had 2.5 cuts average. Groups C-E with 20-50 games never stood a chance mathematically.

**The math is brutal**: even with 80% per-pick accuracy:
- 8 games: 17% clean sweep chance
- 15 games: 3.5% clean sweep chance  
- 25 games: 0.4% clean sweep chance
- 40 games: 0.01% clean sweep chance

## What Must Change for Next Time

### HARD RULES (non-negotiable)

1. **MAX 15 games per slip** — anything above kills the probability
2. **MAX 1.45 odds per pick** — the 1.50+ range is a coin flip
3. **BLACKLIST these markets entirely**:
   - Excluded Number of Goals (home/away)
   - Both Halves Over 1.5
   - 2nd Half team-specific Over/Under
   - Any "Both Halves" market
   - Correct Score
   - Any team-specific market (France Over/Under, Argentina Over/Under)
4. **BLACKLIST these leagues**:
   - Erovnuli Liga / Liga 2 (Georgia)
   - Ethiopian Premier League
   - U21 / Youth leagues
   - Reserve leagues (Tercera Division Reserves)
   - II Lyga (Lithuania)
5. **MINIMUM 3 punter consensus** for any pick to be included
6. **Do NOT use "market optimization" to convert picks to markets nobody picked** — the punters know what they're selecting. Convert within the same category only (Over 3.5 → Over 2.5 is fine. 1X2 → Double Chance is fine. But don't invent new market types).

### GENERATION STRATEGY

1. **Group A (3-5 slips, 8-10 games each)**: Only picks with 3+ punter consensus AND odds under 1.35. These are the real candidates to win.
2. **Group B (5-10 slips, 10-15 games each)**: 2+ consensus, odds under 1.45, top-tier leagues only.
3. **No Groups C/D/E**: 25+ game accumulators are mathematically dead. Don't generate them. They waste SportyBet API calls and give false hope.
4. **Flex is mandatory**: Every slip should be played with flex. A 10-game slip with 2 flex is better than a clean 15-game slip.

### SAFETY SCORE RECALIBRATION

The current safety score gave 100 to many picks that failed. The scoring was too generous:
- Consensus bonus too high (+14 per extra punter)
- Market safety scores unreliable (Double Chance got +18 but failed 8 times)
- League tier not weighted enough (Georgian league got neutral score but failed 17 times)

**New weights for next run**:
- League blacklist is hard — score = 0 for blacklisted leagues (automatic exclusion)
- Market blacklist is hard — score = 0 for blacklisted markets
- Odds > 1.45 gets a -20 penalty
- Consensus of 1 gets -15 (only single-punter picks that are very safe should be included)
- Base score from implied probability should be: (1/odds) * 80 (not 55)

### DATA QUALITY

- H2H data was unavailable (API-Football suspended). This means safety scores had zero historical backing. Fix: get a working H2H API before next generation.
- TheSportsDB coverage was only 15% — useless for lower leagues.
- Without H2H, the "safety score" was essentially: consensus count + odds + market type. That's not enough.

## Summary

The generation system works mechanically — all 150 codes were created, all valid, all loadable. But the **pick selection strategy** was fundamentally flawed:

1. Too many games per slip (20-50 is suicide)
2. Exotic markets included that nobody should bet on
3. Lower leagues included that are unpredictable
4. No H2H data to validate picks
5. Safety scores too optimistic

For next time: **fewer games, lower odds, top leagues only, consensus picks only, flex always**. The target should be 5-10 slips of 8-12 games each, not 50 slips of 20-50 games.
