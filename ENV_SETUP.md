# ReviewHub v4 — Environment Variables

Set these in Render → Your Service → Environment:

## Required for AI features
ANTHROPIC_API_KEY=sk-ant-...

## Required for Slack notifications  
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

## Auto-set by Render
PORT=10000

---

## How to get these values

### Anthropic API Key
1. Go to console.anthropic.com
2. API Keys → Create Key
3. Copy and paste into Render

### Slack Webhook URL
1. Go to api.slack.com/apps
2. Create New App → From Scratch
3. Incoming Webhooks → Activate
4. Add New Webhook to Workspace → choose channel
5. Copy Webhook URL and paste into Render

---

## Security notes
- NEVER commit these values to git
- NEVER hardcode them in the HTML or JS
- They are only readable server-side — the browser never sees them
- The /api/ai and /api/slack endpoints proxy all calls through the server
