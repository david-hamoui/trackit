# trackit

A lightweight, personal food and macro tracking PWA built for daily use.

## Overview
Built to replace bloated, subscription-based macro tracking apps:
- **Fast logging**: OpenFoodFacts database search, custom food library, barcode lookup, and Gemini vision plate estimates.
- **Metric-first targets**: Dynamic calorie and macronutrient targets tailored for lean bulking or cutting based on weight trends.
- **Apple Health sync**: Webhook endpoint to sync weight and body fat automatically from iOS Shortcuts and smart scale readings.
- **Offline / PWA**: Installable on iPhone/desktop, fast local caching.

## Tech Stack
- **Frontend**: Vanilla HTML, CSS, JavaScript (PWA, zero UI frameworks)
- **Backend / Hosting**:
  - **Cloudflare Pages + D1**: Primary production setup (serverless edge functions with D1 SQLite)
  - **Node.js + Express + better-sqlite3**: Local alternative server

## Getting Started

### Local Development
```bash
npm install

# Run Cloudflare Pages + local D1
npm run pages:dev

# Or run Node.js + local SQLite
npm start
```

### Deploying to Cloudflare Pages
1. Create a D1 database:
   ```bash
   npx wrangler d1 create trackit-db
   ```
2. Put your database ID into `wrangler.toml`, then run migrations:
   ```bash
   npm run db:init-remote
   ```
3. Deploy:
   ```bash
   npm run pages:deploy
   ```
4. Set environment variables in Cloudflare Dashboard (Settings → Variables and Secrets):
   - `GEMINI_API_KEY`: Google Gemini API key (optional, for photo/meal recognition)
   - `WEBHOOK_TOKEN`: Bearer token for the Apple Health shortcut webhook

## Apple Health Sync (iOS Shortcut)
Send a POST request to `https://<your-domain>/api/health/sync`:
```json
{
  "token": "YOUR_WEBHOOK_TOKEN",
  "weight_kg": 78.0,
  "body_fat_pct": 15.0
}
```
