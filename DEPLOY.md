# SlipPilot — cPanel Deployment Guide (Harmonweb)

## Step 1 — Upload Files
- Login to cPanel
- Go to File Manager
- Navigate to public_html
- Upload slippilot-deploy.zip
- Extract it

## Step 2 — Setup Node.js App
- In cPanel, find "Setup Node.js App"
- Click "Create Application"
- Node.js version: 18 or higher
- Application mode: Production
- Application root: public_html (or public_html/slippilot)
- Application URL: slippilot.com.ng
- Application startup file: server.js
- Click Create

## Step 3 — Environment Variables
In the Node.js app panel, add these environment variables:
- ADMIN_PASSWORD=HPfirstpJ
- API_FOOTBALL_KEY=967dcdc512484c631bf76f7493f5c9b5
- SESSION_SECRET=slippilot-secret-2024-change-this
- PORT=3000
- NODE_ENV=production

## Step 4 — Install Dependencies
- In Node.js app panel, click "Run NPM Install"
- Wait for completion

## Step 5 — Start App
- Click "Start App" or "Restart"
- Visit slippilot.com.ng to confirm it loads

## Step 6 — Enable SSL
- In cPanel, go to "Let's Encrypt SSL"
- Select slippilot.com.ng
- Click Install (free SSL, auto-renews)
- HTTPS is required for PWA install prompt to work

## Step 7 — Submit to Google
- Go to search.google.com/search-console
- Add property: slippilot.com.ng
- Submit sitemap: slippilot.com.ng/sitemap.xml

## Updating the Site
- Make changes locally
- Run: npm run deploy:zip
- Upload the zip to cPanel and extract (overwrite)
- In Node.js app panel, click Restart

## If App Crashes
- Check cPanel Error Logs
- Confirm all environment variables are set
- Run NPM Install again
- Restart app
