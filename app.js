// cPanel wrapper — starts server.js and auto-restarts on crash
// Includes crash-loop protection: backs off exponentially after rapid restarts
'use strict';
const { spawn } = require("child_process");
const path  = require("path");
const fs    = require("fs");

const SERVER  = path.join(__dirname, "server.js");
const LOGFILE = path.join(__dirname, "data", "wrapper.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + "\n"); } catch {}
}

// Crash-loop protection: track restart times
const restartTimes = [];
const MAX_RESTARTS_PER_MINUTE = 5;
let consecutiveFastCrashes = 0;
let child = null;

function start() {
  // Detect crash loop: if > MAX_RESTARTS_PER_MINUTE in 60s, back off
  const now = Date.now();
  restartTimes.push(now);
  while (restartTimes.length && now - restartTimes[0] > 60000) restartTimes.shift();

  if (restartTimes.length > MAX_RESTARTS_PER_MINUTE) {
    consecutiveFastCrashes++;
    const backoff = Math.min(60000, 5000 * consecutiveFastCrashes);
    log(`[WRAPPER] CRASH LOOP detected (${restartTimes.length} restarts/min) — backing off ${backoff}ms`);
    setTimeout(start, backoff);
    return;
  }

  consecutiveFastCrashes = 0;
  log("[WRAPPER] Starting server.js...");

  child = spawn(process.execPath, [SERVER], {
    stdio: "inherit",
    env: { ...process.env, PORT: process.env.PORT || "3000" },
    detached: false,
  });

  child.on("exit", (code, signal) => {
    log(`[WRAPPER] server.js exited (code=${code} signal=${signal}) — restarting in 3s...`);
    child = null;
    // Grace period on clean exits (code=0) — still restart but add small delay
    const delay = (code === 0) ? 1000 : 3000;
    setTimeout(start, delay);
  });

  child.on("error", (err) => {
    log(`[WRAPPER] Failed to start server.js: ${err.message}`);
    child = null;
    setTimeout(start, 5000);
  });
}

// Forward SIGTERM/SIGINT to child so it can flush and close gracefully
process.on("SIGTERM", () => {
  log("[WRAPPER] SIGTERM received — forwarding to child");
  if (child) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 12000);
});
process.on("SIGINT", () => {
  log("[WRAPPER] SIGINT received — forwarding to child");
  if (child) child.kill("SIGINT");
  setTimeout(() => process.exit(0), 12000);
});

// Keep wrapper itself alive — Passenger should keep app.js running
process.on("uncaughtException", err => {
  log(`[WRAPPER] UncaughtException: ${err.message} — continuing`);
});
process.on("unhandledRejection", reason => {
  log(`[WRAPPER] UnhandledRejection: ${reason}`);
});

start();
