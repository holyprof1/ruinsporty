const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const zipName = "slippilot-deploy.zip";
const zipPath = path.join(__dirname, zipName);
const stageDir = path.join(__dirname, "_deploy_stage");

// Clean stage
if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true });
fs.mkdirSync(path.join(stageDir, "public"), { recursive: true });
fs.mkdirSync(path.join(stageDir, "data"), { recursive: true });

// Root files
const rootFiles = ["server.js", "package.json", "package-lock.json", ".htaccess", "DEPLOY.md", "AGENTS.md", "create-deploy-zip.js"];
rootFiles.forEach(f => { if (fs.existsSync(path.join(__dirname, f))) fs.copyFileSync(path.join(__dirname, f), path.join(stageDir, f)); });

// .env.production → .env on server
if (fs.existsSync(path.join(__dirname, ".env.production"))) fs.copyFileSync(path.join(__dirname, ".env.production"), path.join(stageDir, ".env"));

// Public files
const pubDir = path.join(__dirname, "public");
fs.readdirSync(pubDir).forEach(f => {
  const src = path.join(pubDir, f);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(stageDir, "public", f));
});

// Data files (only safe ones)
["stats.json", "support.json", "punters.json", "punter-profiles.json", "punter-codes.json"].forEach(f => {
  const src = path.join(__dirname, "data", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stageDir, "data", f));
});

// Ensure defaults
const defaults = { "stats.json": '{"slipsLoaded":0,"codesGenerated":0,"slipsScanned":0,"puntersTracked":0}', "support.json": "[]" };
for (const [f, content] of Object.entries(defaults)) {
  const fp = path.join(stageDir, "data", f);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
}

// Create zip
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
try {
  execSync(`powershell -Command "Get-ChildItem -Path '${stageDir}' | Compress-Archive -DestinationPath '${zipPath}' -Force"`, { stdio: "inherit" });
  const size = (fs.statSync(zipPath).size / 1024).toFixed(0);
  const fileCount = execSync(`powershell -Command "(Get-ChildItem -Path '${stageDir}' -Recurse -File).Count"`, { encoding: "utf8" }).trim();
  console.log(`\n${zipName} created (${size} KB, ${fileCount} files)`);
  console.log(`\nStructure inside zip:`);
  console.log(`  server.js, package.json, .env, .htaccess`);
  console.log(`  public/  (index.html, app.js, style.css, icons...)`);
  console.log(`  data/    (stats.json, punters.json...)`);
  console.log(`\nUpload to cPanel → Extract → Run NPM Install → Restart`);
} catch (e) {
  console.error("Zip failed:", e.message);
}

// Clean stage
fs.rmSync(stageDir, { recursive: true });
