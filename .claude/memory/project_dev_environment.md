---
name: Dev Environment Setup
description: How to run GEO Rise locally, known issues, and workarounds
type: project
---

**How to start dev server:**
```bash
cd /Users/lukas/Desktop/geo-rise
npm run dev -- --tunnel-url https://YOUR-NGROK-URL:443
```

**Cloudflare tunnel is blocked** — Lukas's router DNS (192.168.1.1) cannot resolve trycloudflare.com. The workaround is ngrok.

**ngrok setup (already installed and authenticated):**
1. Start ngrok in a separate terminal: `ngrok http 3457` (or whatever port Remix uses)
2. Copy the ngrok HTTPS URL (e.g. https://abc123.ngrok-free.app)
3. Pass it to Shopify CLI: `npm run dev -- --tunnel-url https://abc123.ngrok-free.app:443`

**Neon DB free tier auto-suspends** — if Prisma throws P1001 (can't reach DB), the Neon database has gone to sleep. Wake it up by visiting the Neon dashboard or by running:
```bash
nc -zv ep-XXXX.us-east-2.aws.neon.tech 5432
```
Then retry — it usually comes back in a few seconds.

**Environment variables** are in `/Users/lukas/Desktop/geo-rise/.env` (gitignored). Contains:
- DATABASE_URL (Neon PostgreSQL)
- ANTHROPIC_API_KEY
- SHOPIFY_API_KEY
- SHOPIFY_API_SECRET
- SHOPIFY_APP_URL (set automatically by CLI during dev)
- SCOPES=write_products

**Why:** Cloudflare tunnel DNS resolution fails on Lukas's home network. ngrok works reliably.
**How to apply:** Always remind Lukas to use ngrok if the dev server fails to start with the default tunnel.
