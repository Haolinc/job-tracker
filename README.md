# Job Application Tracker

A Kanban board for tracking job applications with optional Gmail auto-sync powered by Claude AI.

## Quick Start

### 1. Set up environment variables
```bash
cp .env.example server/.env
# Fill in your values (see .env.example for all keys)
```

### 2. Install dependencies
```bash
cd server && npm install
cd ../client && npm install
```

### 3. Run the app
Open two terminals:
```bash
# Terminal 1 — backend
cd server && npm run dev

# Terminal 2 — frontend
cd client && npm run dev
```

Open http://localhost:5173

## Gmail Integration

1. Set up a Google Cloud project and enable the Gmail API
2. Create OAuth 2.0 credentials (Web Application type)
3. Add redirect URI: `http://localhost:3001/api/auth/google/callback`
4. Copy Client ID + Secret to `server/.env`
5. Click "Connect Gmail" in the app header

## Environment Variables

See `.env.example` — copy it to `server/.env` and fill in all values.

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `SESSION_SECRET` | Any long random string |
| `GMAIL_SCAN_DAYS` | How many days back to scan (default: 30) |
