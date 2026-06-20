# SlipPilot AI Handoff

Read this first before scanning large files.

## What This App Is

SlipPilot is a small Express + static frontend app for SportyBet booking slips. It loads shared booking codes, filters or swaps selections, merges slips, splits slips, scans results, and saves punter leaderboard history.

## Main Files

- `server.js`: all API routes, SportyBet calls, stats, punter storage, H2H probing.
- `public/index.html`: full UI markup for homepage, optimizer, merger, splitter, scanner, leaderboard, modals.
- `public/app.js`: all browser behavior. Start here only when changing UI workflows.
- `public/style.css`: SportyBet-inspired dark green theme.
- `data/*.json`: runtime stats and punter history, ignored by git.
- `debug/*`: raw market/H2H responses, ignored by git.

## Important Routes

- `GET /api/booking/:code`: load SportyBet share code.
- `POST /api/generate`: generate a new SportyBet share code from selections.
- `GET /api/markets/:eventId`: fetch all active markets for one event.
- `POST /api/merge`: merge 2-5 codes and return conflicts.
- `POST /api/split`: split selections into sub-slips.
- `GET /api/scan/:code`: evaluate settled selections.
- `GET /api/h2h`: probes SportyBet factsCenter first, writes raw responses to `debug/h2h`, then falls back if no public SportyBet stats are usable.
- `GET /api/punters`: leaderboard data with public `sharePath`.
- `GET /punter/:name`: public leaderboard view filtered client-side.

## Frontend State To Know

- `allSelections`: current editable optimizer selections.
- `originalSelections`: loaded selections before edits, used to show old -> new changed picks.
- `filtered`: optimizer selections with `removed` flags.
- `changedEventIds`: enables Generate when picks changed but nothing was removed.
- `mergerSelections` and `mergerConflicts`: merge preview and conflict picker.
- `splitData`: generated split preview before SportyBet codes are created.

## Verification Short Path

Run:

```powershell
node --check server.js
node --check public\app.js
npm start
```

Then visit `http://localhost:3000`, check `/api/stats`, and load any valid SportyBet booking code.
