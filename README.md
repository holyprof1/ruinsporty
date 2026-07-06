# SlipPilot

SpottyBet punter network tracker and betting intelligence platform. Tracks real punter booking codes daily, scores them against historical hit rate, and generates a ranked leaderboard and Content Studio report.

## Quick Start

```bash
npm install
node app.js          # starts server.js with auto-restart wrapper
# server runs on http://localhost:3000
```

## Environment Variables (`.env`)

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Admin panel password and `x-admin-password` header secret |
| `SESSION_SECRET` | Express session signing key |
| `PORT` | Server port (defaults to 3000) |

## Daily Workflow

1. Admin enters today's booking codes for each punter via Admin → Punter Codes
2. Admin triggers **Regenerate** (`POST /api/admin/regen-all`) — runs `analyze2.js`
3. `analyze2.js` fetches each code from SpottyBet, scores picks vs H2H data, and generates ~60 booking codes in Groups A–H saved to `data/generated-codes.json`
4. Leaderboard is updated automatically as the day progresses via `/api/admin/scan-all`
5. Admin opens Content Studio → Generate Yesterday's Report → Download PNGs → post to X

## Tech Stack

- **Backend**: Node.js + Express (`server.js`)
- **Auto-restart wrapper**: `app.js` (cPanel-compatible)
- **Analysis engine**: `analyze2.js` (run via admin trigger)
- **Session intelligence**: `session-engine.js` (required by server.js)
- **Frontend**: Vanilla HTML/CSS/JS in `public/`
- **Data store**: JSON files in `data/`
- **External APIs**: SpottyBet (`sportybet.com/api/ng/`), API-Football v3

## Project Structure

```
betting/
├── server.js              # Express API + all endpoints
├── app.js                 # cPanel auto-restart wrapper
├── analyze2.js            # Full analysis engine (admin-triggered)
├── session-engine.js      # Session intelligence (required by server.js)
├── package.json
├── .env                   # secrets (never commit)
├── data/                  # JSON database
│   ├── leaderboard.json   # MASTER punter stats — source of truth
│   ├── punter-codes.json  # Today's codes (auto-cleared daily)
│   ├── generated-codes.json # Output of analyze2.js
│   ├── studio-reports.json  # Content Studio saved reports
│   └── ...                # other data files
├── public/                # Static frontend
│   ├── index.html         # Public homepage
│   ├── admin.html         # Admin panel
│   ├── studio.js          # Content Studio renderer
│   └── ...
└── docs/                  # Architecture documentation
```

## Admin Access

Navigate to `/admin.html`. Password prompt on first visit. Password is `ADMIN_PASSWORD` from `.env`.

Admin session persists for 1 hour. API calls may also use header `x-admin-password: <password>`.
