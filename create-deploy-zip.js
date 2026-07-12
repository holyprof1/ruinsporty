/**
 * Production ZIP builder — run with: npm run deploy:zip
 * Creates deployment.zip with only production-safe files.
 * Does NOT include data/ — the server creates it on first run.
 * Does NOT include admin.html, studio.js, x-assistant.js, or engine files.
 */

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const ROOT = __dirname;
const OUT = path.join(ROOT, "deployment.zip");

const PUBLIC_FILES = [
  "index.html",
  "app.js",
  "style.css",
  "sw.js",
  "manifest.json",
  "robots.txt",
  "sitemap.xml",
  "optimize-sportybet-slip.html",
  "sportybet-booking-code-converter.html",
  "check-sportybet-slip-result.html",
  "google-site-verification.html",
];

const DEV_ONLY_PUBLIC = new Set(["admin.html", "studio.js", "x-assistant.js"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp", ".gif"]);

async function build() {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

  const output = fs.createWriteStream(OUT);
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("warning", (err) => { if (err.code !== "ENOENT") throw err; });
  archive.on("error", (err) => { throw err; });

  output.on("close", () => {
    const kb = Math.round(archive.pointer() / 1024);
    console.log(`\n✓ deployment.zip — ${kb} KB`);
    console.log(`  Extract to app root, then Restart in cPanel Node.js App Manager.`);
    console.log(`  No npm install needed — server creates data/ on first run.`);
  });

  archive.pipe(output);

  // Root files
  archive.file(path.join(ROOT, "server.js"), { name: "server.js" });
  archive.file(path.join(ROOT, "app.js"), { name: "app.js" });
  archive.file(path.join(ROOT, "package.json"), { name: "package.json" });
  archive.file(path.join(ROOT, ".env.example"), { name: ".env.example" });

  // Public — named files
  const publicDir = path.join(ROOT, "public");
  for (const f of PUBLIC_FILES) {
    const src = path.join(publicDir, f);
    if (fs.existsSync(src)) {
      archive.file(src, { name: `public/${f}` });
    } else {
      console.warn(`  [skip] public/${f} not found`);
    }
  }

  // Public — image/icon assets (exclude dev-only HTML/JS)
  for (const f of fs.readdirSync(publicDir)) {
    if (DEV_ONLY_PUBLIC.has(f)) continue;
    if (PUBLIC_FILES.includes(f)) continue;
    if (IMAGE_EXTS.has(path.extname(f).toLowerCase())) {
      archive.file(path.join(publicDir, f), { name: `public/${f}` });
    }
  }

  await archive.finalize();
}

build().catch((err) => { console.error("Build failed:", err); process.exit(1); });
