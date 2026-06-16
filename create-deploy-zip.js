const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Ensure data files exist with defaults
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const defaults = {
  "stats.json": JSON.stringify({ slipsLoaded: 0, codesGenerated: 0, slipsScanned: 0, puntersTracked: 0, slipsMerged: 0, slipsSplit: 0 }, null, 2),
  "support.json": "[]",
  "punters.json": "[]",
  "api-usage.json": JSON.stringify({ date: "", usage: {}, adminCalls: 0 }, null, 2),
};

for (const [file, content] of Object.entries(defaults)) {
  const fp = path.join(dataDir, file);
  if (!fs.existsSync(fp)) { fs.writeFileSync(fp, content); console.log("Created", fp); }
}

// Create zip excluding node_modules, .git, .env
const zipName = "slippilot-deploy.zip";
const zipPath = path.join(__dirname, zipName);

// Clean analysis files from data/ before zipping (local-only files)
const localOnlyFiles = ["punter-profiles.json", "generated-codes.json", "codes-today.txt", "tomorrow-codes.txt", "api-usage.json"];
const sessionsDir = path.join(dataDir, "sessions");

try {
  execSync(
    `powershell -Command "Get-ChildItem -Path '${__dirname}' -Exclude 'node_modules','.git','.env','slippilot-deploy.zip','debug','analyze.js','analyze2.js','logo-source.png','scripts' | Compress-Archive -DestinationPath '${zipPath}' -Force"`,
    { stdio: "inherit" }
  );
  const size = (fs.statSync(zipPath).size / 1024).toFixed(0);
  console.log(`\n${zipName} created (${size} KB)`);
  console.log(`\nNext steps:`);
  console.log(`1. Upload ${zipName} to cPanel File Manager`);
  console.log(`2. Extract it`);
  console.log(`3. Go to Setup Node.js App in cPanel`);
  console.log(`4. Set startup file: server.js`);
  console.log(`5. Add environment variables from .env.production`);
  console.log(`6. Run NPM Install`);
  console.log(`7. Start the app`);
  console.log(`8. Enable SSL via Let's Encrypt`);
  console.log(`\nSee DEPLOY.md for full details.`);
} catch (e) {
  console.error("Zip creation failed:", e.message);
}
