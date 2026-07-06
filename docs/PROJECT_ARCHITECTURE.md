# Project Architecture

## System Overview

SlipPilot is a daily punter intelligence platform. It does not discover its own matches — it reads the selections that trusted punters have already placed on SpottyBet, analyses their historical accuracy, and surfaces the best-performing punters each day.

## Data Flow

```
Daily Admin Workflow
════════════════════════════════════════════════════════════

 1. Admin enters today's booking codes
    (Admin Panel → Punter Codes tab)
    └─► data/punter-codes.json

 2. Admin triggers Regenerate
    POST /api/admin/regen-all
    └─► node analyze2.js
         ├── Fetches each code from SpottyBet API
         ├── Scans history codes for W/L/V results
         ├── Runs H2H analysis via API-Football
         ├── Calculates safety scores per selection
         ├── Generates 60 booking codes (Groups A–H)
         └─► data/generated-codes.json
             data/punter-profiles.json
             data/codes-today.txt

 3. As matches settle (throughout the day)
    POST /api/admin/scan-all
    └─► For each punter in leaderboard:
         /api/scan/:code  →  SpottyBet live result
         └─► Updates data/leaderboard.json
              (won, lost, void, pending, hitRate per day)

 4. Next morning: Content Studio
    Admin Panel → Content Studio tab
    └─► Reads data/leaderboard.json (source of truth)
        Renders Punter Scoreboard image (Canvas 1)
        Renders Picks + Insights image (Canvas 2)
        Saves to data/studio-reports.json
        Admin downloads PNGs and posts to X (@SlipPilot)
```

## Key Architectural Constraints

- **Punters are confidence voters, not the match pool source.** The match pool comes from the SpottyBet API (what matches are available). Punters vote on which selections to back.
- **Content Studio is read-only.** It only reads `leaderboard.json`. It never scans SpottyBet, never recalculates statistics, never estimates values it cannot find.
- **`leaderboard.json` is the single source of truth** for all punter statistics displayed to users.
- **One match = one market per booking code.** No duplicate match in any single generated code.
- **Max 6 exposure appearances per match** across all generated codes.
- **Minimum 100× odds** on every generated code. No code under 100×.
- **Football only.** Non-football matches filtered by both sport name and league name.

## Component Responsibilities

| Component | Responsibility |
|---|---|
| `server.js` | Express server, all API endpoints, SpottyBet proxy, session management |
| `app.js` | cPanel-compatible auto-restart wrapper around server.js |
| `analyze2.js` | Full analysis: fetch codes → H2H → score → generate codes |
| `session-engine.js` | Session intelligence module, required by server.js |
| `public/admin.html` | Admin UI: leaderboard, code entry, scan-all, Content Studio |
| `public/studio.js` | Canvas renderer for social-media images |
| `public/index.html` | Public-facing homepage |

## External Dependencies

| Service | Purpose | Auth |
|---|---|---|
| `sportybet.com/api/ng/` | Fetch booking codes, scan results, generate new codes | None (public) |
| `v3.football.api-sports.io` | H2H data, team form, fixtures | `x-apisports-key` in analyze2.js |

## Banned Markets and Leagues

**Banned markets**: player markets, cards, corners, shots, goal kicks, throw-ins, offsides, tennis, basketball, esports, "Draw or Under", "Draw or GG", any "Draw or..." combination.

**Banned leagues**: Kolmonen, 4. deild, 3. deild, Besta deild, Club Friendlies, Youth, Women, Virtual, USL League Two, Serie B Ecuador, Carioca, Mineiro, Azadegan, Russian 2. Liga, Division 2+, Brasileiro Serie B.

**Odds cap**: selections with odds above 2.50 are excluded unless every trusted punter agrees.
