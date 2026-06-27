// cPanel wrapper — starts server.js and auto-restarts on crash
const { spawn } = require("child_process");
const path = require("path");

function start() {
  console.log("[WRAPPER] Starting server.js...");
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    stdio: "inherit",
    env: { ...process.env, PORT: process.env.PORT || "3000" }
  });

  child.on("exit", (code) => {
    console.log("[WRAPPER] server.js exited with code " + code + " — restarting in 3s...");
    setTimeout(start, 3000);
  });

  child.on("error", (err) => {
    console.error("[WRAPPER] Failed to start:", err.message);
    setTimeout(start, 5000);
  });
}

start();
