# Database

All data is stored as JSON files in `data/`. No database server required.

---

## Core Data Files

### `data/leaderboard.json` — MASTER SOURCE OF TRUTH

Written by: `POST /api/admin/scan-all` (server endpoint)
Read by: `GET /api/leaderboard`, Content Studio, admin panel

Structure:
```json
[
  {
    "punter": "SuperMario",
    "handle": "@supermario",
    "tier": "primary",
    "daysActive": 14,
    "lastActive": "2026-07-04",
    "won": 25,
    "lost": 3,
    "void": 0,
    "pending": 17,
    "hitRate": 89,
    "avgOdds": 2.06,
    "consistency": 85,
    "trustScore": 91,
    "codes": [
      {
        "code": "J90E8Q",
        "date": "2026-07-04",
        "games": 45,
        "won": 25,
        "lost": 3,
        "void": 0,
        "pending": 17,
        "hitRate": 89
      }
    ]
  }
]
```

**Never estimate values from this file.** All fields are real, populated from SpottyBet scan results.

---

### `data/punter-codes.json` — Today's Booking Codes

Written by: `POST /api/admin/punter-codes`
Read by: `analyze2.js`, admin panel
Auto-cleared: daily (when `_date` field differs from today)

Structure:
```json
{
  "_date": "2026-07-05",
  "39 Billion": "HPS13S",
  "9Z": "LU84JS",
  "Big Strategic": "QU303D",
  "Ayo Jordan": "MDTXU3",
  "Bayo Bets": "RE9N9N",
  "OY": "M9J9KV",
  "Princewill": "V3XV6K",
  "Sirtee": "HXQH8Q"
}
```

---

### `data/generated-codes.json` — Generated Booking Codes

Written by: `analyze2.js` (Step 6)
Read by: admin panel, `data/codes-today.txt`

Structure:
```json
{
  "A": [{ "code": "XXXX", "games": 26, "odds": 1842.5, "topPicks": ["..."] }],
  "B": [...],
  "C": [...], "D": [...], "E": [...], "F": [...], "G": [...], "H": [...]
}
```

---

### `data/studio-reports.json` — Content Studio Reports

Written by: `POST /api/studio/report`
Read by: `GET /api/studio/reports`, `GET /api/studio/report/:date`

Structure (array of reports, one per date):
```json
[
  {
    "date": "2026-07-04",
    "generatedAt": "2026-07-05T08:30:00Z",
    "leaderboard": [ /* full punter rows as displayed */ ],
    "caption": "...",
    "meta": { "totalPunters": 11, "topPunter": "SuperMario", "topHR": 89 }
  }
]
```

---

### `data/punter-profiles.json` — Punter Analysis Profiles

Written by: `analyze2.js` (Step 2)
Read by: admin panel analysis view

Contains trust scores, strong/weak/killer markets, best/worst codes, consistency per punter.

---

### `data/session-today.json` and `data/session-history.json`

Written by: `session-engine.js`
Read by: `session-engine.js`, server.js

Track the current day's analysis session state and historical session data.

---

## Supporting Data Files

| File | Purpose | Updated by |
|---|---|---|
| `data/stats.json` | Cumulative platform stats (slips loaded, codes generated, etc.) | `incrementStat()` in server.js on each API call |
| `data/api-usage.json` | Daily API call counts per IP for rate limiting | server.js middleware |
| `data/visitors.json` | Page visit log (last 500 visits) | server.js `trackVisitor()` |
| `data/code-history.json` | Historical booking code archive | server.js |
| `data/punters.json` | Legacy punter list | server.js (may overlap with leaderboard) |
| `data/page-locks.json` | Which pages are locked/unlocked | Admin panel |
| `data/blacklist.json` | Blacklisted IPs or codes | server.js |
| `data/social-links.json` | Twitter handle, email, etc. for public pages | Admin panel |
| `data/support.json` | Support request submissions | Public form |
| `data/user-submissions.json` | User-submitted codes | Public form |
| `data/header-code.txt` | Optional HTML injected into public page header | Admin panel |
| `data/weak-matches.json` | Matches flagged as weak by analysis | analyze2.js |
| `data/codes-today.txt` | Human-readable output of today's analysis | analyze2.js |
| `data/sessions/` | Per-session JSON files | session-engine.js |

---

## Important Rules

- **Never delete `leaderboard.json`** — it is the accumulation of weeks of scan data.
- **Never delete `punter-codes.json`** — it clears itself daily but must exist for the auto-clear logic to run.
- **Never delete `studio-reports.json`** — it holds the history of all past social media reports.
- `data/` is blocked from direct HTTP access by server.js middleware.
