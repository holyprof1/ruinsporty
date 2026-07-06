# Project Map

## Root

```
betting/
│
├── server.js              Main Express server (all API endpoints)
├── app.js                 cPanel auto-restart wrapper — run this, not server.js
├── analyze2.js            Analysis engine — run via POST /api/admin/regen-all
├── session-engine.js      Session intelligence module — required by server.js
│
├── package.json           Dependencies: express, express-session, dotenv
├── .env                   Secrets: ADMIN_PASSWORD, SESSION_SECRET, PORT
├── .env.production        Production env vars
├── .gitignore
├── .htaccess              Apache proxy rules (cPanel deployment)
│
├── README.md              → Getting started
└── docs/
    ├── PROJECT_ARCHITECTURE.md  → System design + data flow
    ├── ANALYSIS_ENGINE.md       → How analyze2.js works
    ├── DATABASE.md              → Every data file explained
    ├── API.md                   → Every endpoint with inputs/outputs
    ├── CONTENT_STUDIO.md        → How the social-media image generator works
    └── PROJECT_MAP.md           → This file
```

## `data/` — JSON Database

```
data/
│
├── leaderboard.json        ★ SOURCE OF TRUTH — punter stats, all-time + per-day
├── punter-codes.json       Today's booking code per punter (auto-clears daily)
├── generated-codes.json    Output of analyze2.js — 60 codes in Groups A–H
├── studio-reports.json     Saved Content Studio reports (one per date)
├── punter-profiles.json    Detailed punter profiles from last analysis run
├── code-history.json       Historical archive of all booking codes
├── codes-today.txt         Human-readable analysis output
│
├── stats.json              Platform counters (slips loaded, codes generated, etc.)
├── api-usage.json          Daily API call counts per IP (rate limiting)
├── visitors.json           Page visit log (last 500 entries)
│
├── session-today.json      Current day's session state
├── session-history.json    Historical session data
├── sessions/               Per-session JSON files (directory)
│
├── social-links.json       Twitter handle, email (editable from admin)
├── page-locks.json         Which public pages are accessible
├── header-code.txt         Optional HTML for public page header
├── blacklist.json          Blacklisted IPs or codes
├── punters.json            Legacy punter data
├── punter-profiles.json    Per-punter analysis profile
├── support.json            User support requests
├── user-submissions.json   User-submitted booking codes
└── weak-matches.json       Matches flagged as risky by analysis
```

## `public/` — Frontend

```
public/
│
├── index.html              Public homepage (leaderboard, codes, stats)
├── admin.html              Admin panel (leaderboard management, Content Studio)
├── studio.js               Content Studio canvas renderer
├── app.js                  Frontend JS for public homepage
├── style.css               Global stylesheet
├── sw.js                   Service worker (PWA offline cache)
│
├── manifest.json           PWA manifest
├── robots.txt
├── sitemap.xml
│
├── logo.png                Display logo
├── logo-nav.png            Navigation logo
├── icon-192.png            PWA icon 192px
├── icon-512.png            PWA icon 512px
├── apple-touch-icon.png
├── favicon-16.png
├── favicon-32.png
│
├── check-sportybet-slip-result.html     SEO landing page
├── optimize-sportybet-slip.html         SEO landing page
├── sportybet-booking-code-converter.html SEO landing page
└── google-site-verification.html        Google Search Console
```

## Data Flow Summary

```
Admin enters codes → punter-codes.json
         ↓
POST /api/admin/regen-all → analyze2.js
         ↓
SpottyBet API (fetch selections) + API-Football (H2H)
         ↓
generated-codes.json + punter-profiles.json + codes-today.txt
         ↓
POST /api/admin/scan-all (as matches settle)
         ↓
leaderboard.json ← SOURCE OF TRUTH
         ↓
GET /api/leaderboard → Content Studio
         ↓
studio-reports.json + PNG images + X caption
```

## Key Relationships

| File | Writes | Reads |
|---|---|---|
| `server.js` | `leaderboard.json`, `visitors.json`, `stats.json`, `page-locks.json`, `header-code.txt`, `social-links.json`, `punter-codes.json`, `studio-reports.json` | All data files |
| `analyze2.js` | `generated-codes.json`, `punter-profiles.json`, `codes-today.txt` | `punter-codes.json` (via server) |
| `session-engine.js` | `session-today.json`, `session-history.json` | `leaderboard.json` |
| `public/studio.js` | Nothing (saves via POST /api/studio/report → server.js) | `leaderboard.json` (via API) |
| `public/admin.html` | Nothing directly | All via API |
| `public/index.html` | Nothing | `leaderboard.json`, `stats.json` via API |
