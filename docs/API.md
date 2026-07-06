# API Reference

Base URL: `http://localhost:3000`

Admin authentication: either a valid session cookie (`POST /api/admin/login`) or header `x-admin-password: <ADMIN_PASSWORD>`.

---

## Public Endpoints

### `GET /api/stats`
Platform counters (slips loaded, codes generated, etc.).
```json
{ "slipsLoaded": 48291, "codesGenerated": 31847, "slipsScanned": 12903, "puntersTracked": 4721, "slipsMerged": 8834, "slipsSplit": 3201 }
```

### `GET /api/leaderboard`
Returns all punters with full stats, sorted by rank.
```json
{ "leaderboard": [ { "punter": "SuperMario", "hitRate": 89, "won": 25, "lost": 3, ... } ], "total": 11 }
```

### `GET /api/social-links`
Twitter handle, email, etc. for public display.

### `GET /api/page-locks`
Which pages are currently locked/accessible to public.

### `GET /api/header-inject`
Returns raw HTML text injected into the public homepage header (used for announcement banners).

### `GET /api/booking/:code`
Fetches a SpottyBet booking code and returns its selections.

**Response:**
```json
{
  "totalOdds": 1842.5,
  "selections": [
    { "eventId": "...", "homeTeam": "Arsenal", "awayTeam": "Chelsea", "market": "Over/Under", "outcome": "Over 1.5", "odds": 1.28, "marketId": "...", "outcomeId": "...", "specifier": "total=1.5" }
  ]
}
```

### `GET /api/scan/:code`
Scans a SpottyBet booking code for live/settled results.

**Response:**
```json
{
  "shareCode": "J90E8Q",
  "hitRate": 89,
  "results": [
    { "homeTeam": "Arsenal", "awayTeam": "Chelsea", "market": "Over/Under", "outcome": "Over 1.5", "odds": 1.28, "verdict": "WON" }
  ]
}
```
Verdict values: `"WON"`, `"LOST"`, `"VOID"`, `"PENDING"`

---

## Admin-Only Endpoints

All require admin session or `x-admin-password` header.

### `POST /api/admin/login`
Body: `{ "password": "..." }`
Sets session cookie on success.

### `GET /api/admin/visitors`
Today's visitor count, unique IPs, referrers, recent visits.

### `GET /api/admin/punter-codes`
Today's booking code per punter. Auto-returns empty strings if date has changed.

### `POST /api/admin/punter-codes`
Body: `{ "39 Billion": "XXXXX", "9Z": "YYYYY", ... }`
Updates today's codes. Persists to `data/punter-codes.json`.

### `POST /api/admin/regen-all`
Triggers full analysis: runs `node analyze2.js` as a child process (up to 10 minutes).
```json
{ "success": true, "message": "Analysis complete. Codes regenerated.", "output": "..." }
```

### `POST /api/admin/scan-all`
Scans all punters' today codes and updates `leaderboard.json` with real results.
```json
{ "success": true, "updated": 11 }
```

### `GET /api/admin/header-code` / `POST /api/admin/header-code`
Get/set the HTML injected into the public homepage header.

### `GET /api/admin/social-links` / `POST /api/admin/social-links`
Get/set Twitter handle, email, and other social links.

### `GET /api/admin/page-locks` / `POST /api/admin/page-locks`
Get/set which pages are locked.

---

## Content Studio Endpoints

All require admin auth.

### `GET /api/studio/reports`
Returns summary list of all saved reports (date, meta, generatedAt).
```json
[{ "date": "2026-07-04", "generatedAt": "2026-07-05T08:30:00Z", "meta": { "totalPunters": 11, "topPunter": "SuperMario", "topHR": 89 } }]
```

### `GET /api/studio/report/:date`
Returns full report for a specific date (date format: `YYYY-MM-DD`).
```json
{ "date": "2026-07-04", "leaderboard": [...], "caption": "...", "meta": {...} }
```

### `POST /api/studio/report`
Saves or overwrites a report for a date.
Body: `{ "date": "...", "leaderboard": [...], "caption": "...", "meta": {...} }`

---

## Debug / Utility Endpoints

### `GET /api/debug/outbound`
Tests whether the server can reach SpottyBet's API. Returns latency and `bizCode`.
