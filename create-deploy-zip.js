/**
 * Production ZIP builder — run with: npm run deploy:zip
 * Creates deployment.zip containing only the files needed for the production server.
 * Dev-only files (admin.html, studio.js, x-assistant.js, engine files, debug data) are excluded.
 */

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const ROOT = __dirname;
const OUT = path.join(ROOT, "deployment.zip");

// Public files included in production
const PUBLIC_FILES = [
  "index.html",
  "app.js",
  "style.css",
  "sw.js",
  "manifest.json",
  "robots.txt",
  "sitemap.xml",
  // SEO landing pages
  "optimize-sportybet-slip.html",
  "sportybet-booking-code-converter.html",
  "check-sportybet-slip-result.html",
  "google-site-verification.html",
];

// Data files included as empty stubs or safe defaults
const DATA_STUBS = {
  "stats.json": JSON.stringify({ slipsLoaded: 0, codesGenerated: 0, slipsScanned: 0, puntersTracked: 0 }, null, 2),
  "support.json": "[]",
  "odds-history.json": "{}",
};

// Data files copied as-is from the dev repo (safe public config)
const DATA_COPY = [
  "social-links.json",
  "header-code.txt",
  "page-locks.json",
];

async function build() {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

  const output = fs.createWriteStream(OUT);
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("warning", (err) => { if (err.code !== "ENOENT") throw err; });
  archive.on("error", (err) => { throw err; });

  output.on("close", () => {
    const kb = Math.round(archive.pointer() / 1024);
    console.log(`\n✓ deployment.zip created — ${kb} KB`);
    console.log(`  Upload this to your cPanel/hosting root and run: npm install --omit=dev`);
  });

  archive.pipe(output);

  // Root files
  archive.file(path.join(ROOT, "server.js"), { name: "server.js" });
  archive.file(path.join(ROOT, "package.json"), { name: "package.json" });
  archive.file(path.join(ROOT, ".env.example"), { name: ".env.example" });
  if (fs.existsSync(path.join(ROOT, "app.js"))) {
    archive.file(path.join(ROOT, "app.js"), { name: "app.js" });
  }

  // Public directory — allowed files only
  for (const f of PUBLIC_FILES) {
    const src = path.join(ROOT, "public", f);
    if (fs.existsSync(src)) {
      archive.file(src, { name: `public/${f}` });
    } else {
      console.warn(`  [skip] public/${f} not found`);
    }
  }

  // Public image/icon assets (all files that are not dev-only HTML/JS)
  const publicDir = path.join(ROOT, "public");
  const devOnlyPublic = new Set(["admin.html", "studio.js", "x-assistant.js"]);
  for (const f of fs.readdirSync(publicDir)) {
    if (devOnlyPublic.has(f)) continue;
    if (PUBLIC_FILES.includes(f)) continue; // already added
    const ext = path.extname(f).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp", ".gif"].includes(ext)) {
      archive.file(path.join(publicDir, f), { name: `public/${f}` });
    }
  }

  // Data directory — stubs for runtime-written files, copies for config files
  for (const [name, content] of Object.entries(DATA_STUBS)) {
    archive.append(content, { name: `data/${name}` });
  }
  for (const f of DATA_COPY) {
    const src = path.join(ROOT, "data", f);
    if (fs.existsSync(src)) {
      archive.file(src, { name: `data/${f}` });
    } else {
      console.warn(`  [skip] data/${f} not found`);
    }
  }

  await archive.finalize();
}

build().catch((err) => { console.error("Build failed:", err); process.exit(1); });
