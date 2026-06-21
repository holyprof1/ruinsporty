# SlipPilot — cPanel Deployment (Harmonweb)

## Your Setup
- Host: Harmonweb (harmonweb.com)
- Domain: slippilot.com.ng
- App root: `/home/myvalcom/slippilot`
- Node.js: v20.20.2 (production)
- Startup file: server.js

## Deploy Steps (Upload New Version)

### 1. Prepare Files
```
npm run deploy:zip
```
This creates `slippilot-deploy.zip` (465 KB) with proper `public/` and `data/` folder structure.

### 2. Upload to cPanel
- Login to cPanel (harmonweb)
- Open **File Manager**
- Navigate to `/home/myvalcom/slippilot/`
- **Delete** everything EXCEPT `node_modules/` folder
- Click **Upload** → select `slippilot-deploy.zip`
- Click on the uploaded zip → click **Extract** → extract to current directory
- Verify: `server.js` and `public/` folder should be at `/home/myvalcom/slippilot/`

### 3. Install Dependencies
- Go to **Setup Node.js App** in cPanel
- Click the **pencil (edit)** icon on slippilot.com.ng
- Click **Run NPM Install** button
- Wait for "Packages installed successfully"

### 4. Restart
- Click **Restart** button (circular arrow)
- Or click **Stop App** then **Start App**

### 5. Verify
- Visit https://slippilot.com.ng — homepage should load
- Visit https://slippilot.com.ng/admin — login with password
- Test: paste a booking code in Optimizer → should load games

## Environment Variables (already set)
In Node.js app settings:
```
ADMIN_PASSWORD = HPfirstpJ
API_FOOTBALL_KEY = f1739cfdacf78915c1b8a7eb2ad726ba
NODE_ENV = production
PORT = 3000
SESSION_SECRET = slippilot-sp-2026-prod
```

## File Structure on Server
```
/home/myvalcom/slippilot/
  server.js          ← main app
  package.json
  .env               ← from .env.production
  .htaccess          ← Apache reverse proxy rules
  node_modules/      ← created by NPM Install
  public/
    index.html       ← main site
    admin.html       ← admin panel
    app.js           ← frontend logic
    style.css        ← styles
    icon-192.png     ← PWA icon
    icon-512.png     ← PWA icon
    manifest.json    ← PWA manifest
    ...
  data/
    stats.json       ← usage counters
    punters.json     ← leaderboard
    support.json     ← support tickets
    punter-profiles.json ← punter analysis
```

## Overwrite vs Skip
- **Always overwrite**: server.js, package.json, public/ folder, .htaccess
- **Skip if live version has user data**: data/support.json (has real tickets), data/stats.json (has real counts)
- **Never upload**: node_modules, .git, analyze.js, debug/

## If App Won't Start
1. Check cPanel **Error Logs** (Metrics → Errors)
2. Confirm all 5 environment variables are set
3. Click **Run NPM Install** again
4. Click **Restart**
5. If still failing — delete `node_modules/`, then Run NPM Install fresh

## SSL
- Already enabled via Let's Encrypt
- Auto-renews every 90 days
- Required for PWA install prompt

## Google Search Console
- Go to search.google.com/search-console
- Add property: slippilot.com.ng
- Verify with DNS or HTML file
- Submit sitemap: https://slippilot.com.ng/sitemap.xml

## Local-Only Files (never upload)
- data/generated-codes.json — analysis output
- data/codes-today.txt — daily codes
- data/api-usage.json — API call tracking
- data/sessions/ — local session files
- analyze.js, analyze2.js — punter analysis scripts
