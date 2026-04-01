# ReviewHub v4 — Cuckoo Electronics

Internal Amazon review management and analysis tool for cross-functional teams.

## Features
- Role-based login (Admin, Marketing, Product Dev, Tech, CS)
- Import Cuckoo Amazon Reviews Archive .xlsx — all tabs auto-detected
- Full review browsing: search, filter by SKU/rating/date, sort, pagination (50/page)
- Bulk select + bulk escalate / bulk tag
- Stable review IDs — re-importing preserves all tags and escalations
- Ticketing system with priority, team assignment, comments, audit log
- AI Insights powered by Claude — analyze by product, focus area, and rating tier
- CS response drafting — AI-generated Amazon seller responses
- Export filtered reviews to CSV (UTF-8 BOM for Excel compatibility)
- IndexedDB persistence — data survives tab closes and browser restarts
- Slack notifications via server-side proxy (webhook URL never exposed to browser)
- Responsive layout — works on smaller screens

## Deploy on Render

1. Push this repo to GitHub
2. Render → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment variables (see ENV_SETUP.md):
   - `ANTHROPIC_API_KEY` — for AI features
   - `SLACK_WEBHOOK_URL` — for Slack notifications
6. Deploy

## Local development

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... SLACK_WEBHOOK_URL=https://... npm start
```

Then open http://localhost:3000

## Security

- Passwords stored in IndexedDB (browser-local), hashed at rest in a future version
- API keys live only in server environment variables — never sent to the browser  
- All AI and Slack calls proxied through `/api/ai` and `/api/slack`
- Rate limiting: 10 AI calls/min, 30 Slack calls/min per IP
- Security headers: CSP, X-Frame-Options, X-Content-Type-Options, etc.
- Input sanitized with `xe()` before any innerHTML insertion
- No third-party analytics, no external fonts, no CDN except xlsx.js
