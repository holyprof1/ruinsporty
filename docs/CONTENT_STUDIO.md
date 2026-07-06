# Content Studio

Content Studio generates two social-media-ready PNG images from the previous day's analysis, plus an X (Twitter) caption.

It is accessed via **Admin Panel → Content Studio tab**.

---

## Source of Truth

**Content Studio reads only from `data/leaderboard.json` via `GET /api/leaderboard`.**

It never:
- Scans SpottyBet
- Recalculates statistics
- Estimates values not present in the leaderboard
- Generates new booking codes

If a value is not in the leaderboard, it is not shown.

---

## Default Date

Content Studio always defaults to **yesterday's date** (`today - 1 day`). Today's data is never shown because matches are still in progress. Reports for future dates are never generated.

---

## Workflow

1. Open Admin Panel → Content Studio tab
2. Studio auto-loads yesterday's report if one has already been saved
3. If no report exists: click **Generate Yesterday's Report**
4. Studio fetches `GET /api/leaderboard` and builds the report from the returned data
5. Both canvases render automatically
6. Download Card 1 (Punter Scoreboard) and/or Card 2 (Picks + Insights) as PNG
7. Copy the X caption
8. Post to @SlipPilot on X

---

## Image 1 — Punter Scoreboard

Canvas: 1080px wide × auto height

**Header**: SlipPilot logo, "PUNTER SCOREBOARD", date (e.g., "4 July 2026"), total punters analysed.

**Table columns** (per punter row):

| Column | Source field | Notes |
|---|---|---|
| RK | Rank position | 1-based, sorted by hitRate desc |
| PUNTER | `punter` | Name |
| G | `won + lost + void + pending` | Total games today |
| W | `won` | Green |
| L | `lost` | Red |
| V | `void` | Yellow |
| PD | `pending` | Grey |
| WIN% | `hitRate` | `won/(won+lost)×100` |
| ODDS | `avgOdds` | Original ticket total odds |
| ~P/L | Estimated | `won × (avgOdds - 1) - lost`, shown only when avgOdds > 0, prefixed with "~" |
| CODE | First `codes[].code` for target date | Original booking code |
| TREND | Arrow based on delta between today vs all-time HR | ↑ green / ↓ red / → yellow |
| FORM | Last 5 codes: W/L/V dots | |

**Colour palette:**
- Background: `#0f1720`
- Green (wins): `#22c55e`
- Red (losses): `#ef4444`
- Yellow (void/neutral): `#f59e0b`
- Text: `#e8edf4`
- Muted: `#6b7e96`
- Borders: `#1e3248`

---

## Image 2 — Leaderboard Overflow (conditional)

Canvas: 1080px wide × auto height

**Only generated if there are more than 10 punters with data for the target date.**

Shows ranks 11+ with the same table columns as Image 1. Shares the same header design with "Rankings 11–N" subtitle.

---

## X Caption

Generated from real data. Template uses:
- Top punter name and hit rate
- Yesterday's date
- Total punters count
- Best booking code

Three caption templates are rotated. Admin can copy the caption directly from the studio.

---

## Saving Reports

Reports are saved to `data/studio-reports.json` via `POST /api/studio/report`. If a report for yesterday already exists, a modal asks whether to overwrite.

Reports can be browsed in the history section within the Content Studio tab.

---

## Implementation

Renderer: `public/studio.js` (~460 lines)
Canvas API: HTML5 Canvas 2D
No external charting libraries.

Key functions:
- `loadStudio()` — auto-loads on tab open
- `generateDailyReport(force)` — generates and saves
- `csDisplayReport(report)` — renders both canvases from saved data
- `renderCard1(canvas, data)` — scoreboard image
- `renderCard2(canvas, data)` — picks + insights image
- `csDownloadCard(n)` — downloads canvas 1 or 2 as PNG
