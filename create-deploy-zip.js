const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const zipName = "slippilot-deploy.zip";
const zipPath = path.join(__dirname, zipName);

// Build list of files to include (explicit, no junk)
const include = [
  "server.js",
  "package.json",
  "package-lock.json",
  ".htaccess",
  ".env.production",
  ".gitignore",
  "DEPLOY.md",
  "AGENTS.md",
  "create-deploy-zip.js",
];

// Include all public/ files
const pubDir = path.join(__dirname, "public");
const pubFiles = fs.readdirSync(pubDir).map(f => path.join("public", f));

// Include only specific data/ files
const dataInclude = ["stats.json", "support.json", "punters.json", "punter-profiles.json"];
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
// Ensure defaults exist
const defaults = {
  "stats.json": JSON.stringify({ slipsLoaded: 0, codesGenerated: 0, slipsScanned: 0, puntersTracked: 0, slipsMerged: 0, slipsSplit: 0 }, null, 2),
  "support.json": "[]",
  "punters.json": "[]",
};
for (const [file, content] of Object.entries(defaults)) {
  const fp = path.join(dataDir, file);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
}
const dataFiles = dataInclude.filter(f => fs.existsSync(path.join(dataDir, f))).map(f => path.join("data", f));

const allFiles = [...include.filter(f => fs.existsSync(path.join(__dirname, f))), ...pubFiles, ...dataFiles];
const fileList = allFiles.map(f => `'${f}'`).join(",");

try {
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  execSync(
    `powershell -Command "Compress-Archive -Path ${fileList} -DestinationPath '${zipPath}' -Force"`,
    { stdio: "inherit", cwd: __dirname }
  );
  const size = (fs.statSync(zipPath).size / 1024).toFixed(0);
  console.log(`\n${zipName} created (${size} KB)`);
  console.log(`Files: ${allFiles.length}`);
  console.log(`\nReady to upload to slippilot.com.ng`);
} catch (e) {
  console.error("Zip creation failed:", e.message);
}
