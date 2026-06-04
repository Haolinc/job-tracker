# Job Application Tracker

A Kanban board that tracks your job applications and **auto-syncs them from Gmail** — detecting the
company, role, and status (applied / interview / offer / rejected) from your application emails. All
email classification runs **locally** via Ollama, so your inbox content never leaves your machine.

## Features

- **Gmail auto-sync** — scans the last 30 / 60 / 90 / 180 days for application-related emails and turns
  them into tracked applications, with a live streaming progress bar.
- **Hybrid classification** — a fast deterministic parser handles the common templates (LinkedIn,
  Indeed, Workday, Greenhouse, …); a local LLM handles everything else.
- **Smart dedup & matching** — the confirmation, interview, and rejection emails for the same job
  collapse into **one** application, even when the company name is spelled differently across emails.
  Different roles at the same company stay as separate applications.
- **Sticky interview tracking** — an application that reached an interview keeps that status for the
  "Interview Rate" stat even if it's later rejected.
- **Two views** — **Kanban board** (collapsible columns) and a sortable **table**.
- **Provenance badges** — each auto-detected card shows whether the **⚙️ parser** or **🤖 AI** classified
  it (cleared once you edit it), and newly-synced cards are highlighted after a sync.
- **Unknown-role warnings** — applications whose title couldn't be extracted are flagged for a quick
  manual fix.
- **Manual entry & editing** — add or edit applications by hand; manual edits are never overwritten by
  a later sync.

## Tech stack

| Layer | Stack |
|---|---|
| Client | React + Vite + Tailwind, axios |
| Server | Node + Express (TypeScript), Mongoose |
| Database | MongoDB |
| Auth / email | Google OAuth 2.0 + Gmail API (read-only) |
| Classification | **Ollama** running `qwen2.5:7b` (local) |

## Prerequisites

- **Node.js** (18+) and **npm**
- **MongoDB** running locally (or a connection string to a remote instance)
- **[Ollama](https://ollama.com)** installed and running, with the model pulled:
  ```bash
  ollama pull qwen2.5:7b
  ```
- A **Google Cloud project** with the Gmail API enabled and OAuth credentials (see
  [Gmail integration](#gmail-integration))

## Quick start

### 1. Configure environment
```bash
cp .env.example server/.env
# fill in the values (see the table below)
```

### 2. Install dependencies
```bash
cd server && npm install
cd ../client && npm install
```

### 3. Make sure MongoDB and Ollama are running
```bash
ollama serve            # if not already running as a service
ollama pull qwen2.5:7b  # one-time
```

### 4. Run the app (two terminals)
```bash
# Terminal 1 — backend
cd server && npm run dev

# Terminal 2 — frontend
cd client && npm run dev
```

Open http://localhost:5173, click **Connect Gmail**, then **Sync**.

## Gmail integration

1. Create a Google Cloud project and **enable the Gmail API**.
2. Create **OAuth 2.0 credentials** (Web application).
3. Add the redirect URI: `http://localhost:3001/api/auth/google/callback`.
4. Add your Google account as a **test user** on the OAuth consent screen (the only scope used is
   `gmail.readonly`).
5. Put the Client ID + Secret in `server/.env` and click **Connect Gmail** in the app header.

## Environment variables

Copy `.env.example` to `server/.env` and fill in:

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (e.g. `mongodb://localhost:27017/job-tracker`) |
| `PORT` | Backend port (default `3001`) |
| `CLIENT_URL` | Frontend origin (default `http://localhost:5173`) |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3001/api/auth/google/callback` |
| `SESSION_SECRET` | Any long random string |

> Classification is fully local via Ollama — **no API key is required**. (Earlier versions used a hosted
> model; `ANTHROPIC_API_KEY` is no longer needed and can be removed from your `.env`.)

## Notes

- The Gmail scope is **read-only** — the app never modifies or sends mail.
- Re-syncing is cheap: already-processed messages are skipped before any body is downloaded, so widening
  the scan window only backfills newly in-range emails.
- All data lives in your local MongoDB; there is no per-account separation — everything you sync (from any
  connected Gmail account) accumulates in one board and dedups together.
