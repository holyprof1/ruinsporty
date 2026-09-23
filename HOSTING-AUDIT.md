# SlipPilot constrained-hosting audit

Date: 2026-09-22. Local benchmark host: Windows/Node.js, production mode, direct
`app.js` entrypoint. These figures are repeatable development-host measurements;
cPanel/CloudLinux RSS, virtual memory and thread figures must be captured again
after deployment because the operating systems report them differently.

## Confirmed root causes

1. `app.js` spawned `server.js` even though Passenger already supervises the app.
   This consumed another process plus a full Node/V8 thread set and restarted even
   after clean exits.
2. dotenv used override semantics. A stale `NODE_ENV` in `.env` could override the
   cPanel environment and load admin/automation engines plus three startup child
   test processes in production.
3. express-session used its in-process MemoryStore in development and had no
   persistent bounded store. Production disabled the middleware while routes still
   referenced `req.session`.
4. `oddsStore`, H2H, assistant sessions, generator runs/events, API-usage IPs, and
   table-tennis job registries had missing or delayed bounds.
5. expensive endpoints and background scans had no shared concurrency/queue cap;
   several expensive POST routes lacked a common rate limit.
6. upstream response bodies were concatenated without a byte ceiling. SMTP had no
   explicit connect/greeting/socket deadlines. The Passenger self-ping had no
   timeout.
7. maintenance and scheduler intervals were not centrally stopped, and scheduled
   async jobs had no reusable non-overlap guard.
8. operational memory/handle/event-loop data was unavailable without attaching a
   debugger.

No production file watcher, cluster, or worker-thread startup was found. Nodemon is
confined to the `dev` script. Browser automation and generator self-check child
processes are now excluded from a genuine production boot.

## Implemented controls

- One Passenger-managed Node process (`app.js` directly requires `server.js`).
- Bounded, persistent, hashed file sessions: 500 sessions, one-hour TTL, atomic
  replace, periodic sweep, and shutdown cleanup.
- 1 MiB JSON and 64 KiB form limits; two-MiB upstream response limit.
- Expensive work: concurrency 3, queue 12, 15 expensive POSTs/IP/minute. TT scans
  cap at two simultaneous jobs; bulk ingest caps at one.
- Immediate hard caps: booking 200, odds 2,000, H2H 250, API IPs 5,000,
  assistant sessions 250, generator runs 20/events 1,000, TT scans 20, ingests 10.
- Outbound request and SMTP timeouts; bounded server socket lifetime; no SMTP pool.
- Non-overlapping cleanup, auto-run, self-check and metrics scheduling, all stopped
  on SIGTERM/SIGINT. Debounced data is flushed and the HTTP server is closed.
- Protected `GET /api/diagnostics` using `x-diagnostics-token` and
  `DIAGNOSTICS_TOKEN` (fallback: existing admin password); unauthorized calls are
  returned as 404. No secret values are returned.
- Five-minute lightweight metric line: RSS, heap, active handles and event-loop p95.

## Verification

Commands:

```text
node --test test/hosting-safety.test.js
node test-moonshot-floor.js
node test-conversion-safety.js
node test-global-pool-architecture.js
node test-autobet-guards.js
LOAD_URL=http://127.0.0.1:3189/api/health LOAD_REQUESTS=5000 LOAD_CONCURRENCY=25 DIAGNOSTICS_TOKEN=... node tools/hosting-load-test.js
```

Results: hosting tests 3/3; moonshot 9/9; conversion 10/10; global-pool
architecture 20/20; autobet guards 29/29. Total 71/71, zero failures.

### Load measurements

| Measurement | Before | After |
|---|---:|---:|
| Requests / concurrency | 1,000 / 20 | 1,000 / 20 |
| Failures | 0 | 0 |
| Throughput | 2,040.8 req/s | 1,875.1 req/s |
| Observed idle RSS | 61.4 MiB initially (66 MiB after timers) | 65.28 MiB |
| Peak RSS during sample | not instrumented | 72.17 MiB |
| Local Windows threads | not isolated in baseline | 16 |
| Active handles at idle | not instrumented | 4 (including diagnostic request) |

The before run predated the diagnostics sampler, so inventing a before peak/handle
count would be misleading. The supplied live baseline is 49 MiB RSS and 11 idle
threads. The local after RSS includes the diagnostics histogram and persistent
session store; the material CloudLinux saving is removal of the second Node process
and production-only exclusion of admin/browser/test engines. A longer 5,000-request
after run completed with zero failures at 2,321.0 req/s and 73,568,256-byte peak RSS.

## Deployment notes

Set `NODE_ENV=production`, a strong `SESSION_SECRET`, and a distinct
`DIAGNOSTICS_TOKEN` in cPanel. Keep `app.js` as the Passenger startup file. Do not
run `npm run dev` or nodemon in cPanel. After restart, record `/api/diagnostics` at
idle and during the same load command on the hosting account; that is the valid
CloudLinux after-reading for comparison with 49 MiB/11 threads.
