<a id="readme-top"></a>

<br />
<div align="center">
  <h3 align="center">Job Application Tracker</h3>

  <p align="center">
    A Kanban board that fills itself: your job applications, auto-synced from Gmail,
    classified by a local AI so your inbox never leaves your machine.
    <br />
    <a href="https://haolin-portfolio.vercel.app/job-tracker">See the UI walkthrough</a>
    <br />
    <a href="https://github.com/Haolinc/job-tracker/issues">Report Bug</a>
    &middot;
    <a href="https://github.com/Haolinc/job-tracker/issues">Request Feature</a>
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li><a href="#built-with">Built With</a></li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#step-1-google-cloud-project-required-for-both-options">Step 1: Google Cloud project</a></li>
        <li><a href="#step-2-option-a-download-the-packaged-app-windows">Option A: Download the packaged app</a></li>
        <li><a href="#step-2-option-b-run-from-source">Option B: Run from source</a></li>
        <li><a href="#configuration">Configuration</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#privacy-notes">Privacy notes</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

## About The Project

Tracking job applications by hand means copying every confirmation, interview invite, and rejection
into a spreadsheet, and forgetting half of them. This tracker does it for you:

- **Syncs from Gmail**: scan the last 30 to 180 days and every application email becomes a card, with
  live progress while it runs.
- **Classifies locally**: a fast parser handles the common job boards; a local AI (Ollama) handles
  the rest. No cloud API, no key, no inbox data leaving your machine.
- **Keeps one card per job**: confirmations, interviews, and rejections for the same job merge into
  a single application, even when company names are spelled differently across emails.
- **Two views**: a Kanban board with collapsible columns, or a sortable table.
- **Links back to the source**: every card links to the actual Gmail messages behind each status
  change, and shows whether the parser or the AI classified it.
- **Stays out of your way**: manual entries and edits are never overwritten by a sync, and CSV
  import/export gets your data in or out anytime.
- **Desktop launcher**: one window that starts and stops everything, manages Ollama and its models,
  and holds your configuration. No terminal needed, and it packages into a **Windows app**
  (installer or portable zip) that runs on a machine with nothing preinstalled and keeps itself
  current with automatic updates.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Built With

* [![React][React.js]][React-url]
* [![Vite][Vite.js]][Vite-url]
* [![TailwindCSS][Tailwind.css]][Tailwind-url]
* [![TypeScript][TypeScript]][TypeScript-url]
* [![Express][Express.js]][Express-url]
* [![SQLite][SQLite]][SQLite-url]
* [![Electron][Electron]][Electron-url]
* [![Ollama][Ollama]][Ollama-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

There are two ways to get the app: download the ready-made Windows package, or run it from source.
**Both** need a Google Cloud project first (that's how the app gets read-only access to *your* Gmail
with *your own* credentials; nothing is shared with anyone else).

### Step 1: Google Cloud project (required for both options)

Follow the
[**Google Cloud setup guide**](https://github.com/Haolinc/job-tracker-gmail-setup), it walks
through this whole step in detail.

Keep the **Client ID** and **Client Secret**, you'll enter them in the next step.

### Step 2, Option A: Download the packaged app (Windows)

1. Grab the latest version from [**Releases**](https://github.com/Haolinc/job-tracker/releases):
   `JobTracker-win-Setup.exe` installs the app with Start Menu and Desktop shortcuts, or take
   `JobTracker-win-Portable.zip`, unzip it anywhere, and run `Job Tracker.exe`.
2. Either way the app is fully self-contained, so the machine needs **nothing preinstalled**: no
   Node.js, and the launcher will offer to install Ollama and download the AI model for you.
3. Open **Config**, paste your Client ID and Secret, and press **Save**; the server starts on its
   own. Then hit **Open App**.
4. The app checks for updates on launch and asks before installing one, so you never have to come
   back here for new versions.

### Step 2, Option B: Run from source

Prerequisites: **Node.js** 22+ with **npm**, and **[Ollama](https://ollama.com)** (or let the
desktop launcher install it for you).

```bash
git clone https://github.com/Haolinc/job-tracker.git
cd job-tracker
npm run install:all
```

Then pick one:

**Desktop launcher**
```bash
npm run desktop
```
Enter your Client ID and Secret in **Config**, press **Save**, then **Open App**.

**Terminal**
```bash
cp .env.example server/.env   # fill in the values (see Configuration)
ollama pull qwen2.5:7b        # one-time, before the first sync
npm run dev                   # Ollama + backend + frontend, one terminal
```
Then open http://localhost:5173.

(You can also build the Windows installer and portable zip yourself with `npm run package`)

### Configuration

The desktop launcher's **Config** panel manages all of these for you. For the terminal workflow,
fill them into `server/.env`:

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3001/api/auth/google/callback` |
| `SESSION_SECRET` | Any long random string |
| `PORT` | Optional: backend port (default `3001`) |
| `CLIENT_URL` | Optional: frontend origin (default `http://localhost:5173`) |
| `DB_PATH` | Optional: SQLite file location (default `data/job-tracker.db`) |
| `OLLAMA_MODEL` | Optional: classifier model (default `qwen2.5:7b`) |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

1. Click **Connect Gmail** in the app header and approve read-only access.
2. Pick a scan window (last 30 / 60 / 90 / 180 days) and hit **Sync Gmail**; a progress bar streams
   results as they come in.
3. Newly synced cards land on the board highlighted; drag them between columns or switch to the
   table view. Cards whose role couldn't be detected are flagged for a quick manual fix.
4. Re-sync whenever you like: already-processed emails are skipped, so it's fast, and your manual
   edits are never touched.
5. Use the toolbar to add applications by hand or import/export CSV.

If you use the desktop launcher: it warms up Ollama before starting the server, shows sync progress
in its log console, and asks before letting you stop or quit while a sync is still running (an
interrupted sync loses that run's work).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Privacy notes

- Email classification runs **entirely on your machine** via Ollama; no API key, no cloud calls.
- The Gmail scope is **read-only**; the app never modifies or sends mail.
- All data lives in a local SQLite file (gitignored). The packaged desktop app keeps its
  configuration, database, and logs in your per-user app-data folder, and uninstalling asks
  whether to delete that data too.
- There is no per-account separation: everything you sync from any connected Gmail account
  accumulates in one board and dedups together.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

Haolin - haolin5175@gmail.com

Project Link: [https://github.com/Haolinc/job-tracker](https://github.com/Haolinc/job-tracker)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[React.js]: https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB
[React-url]: https://react.dev/
[Vite.js]: https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white
[Vite-url]: https://vite.dev/
[Tailwind.css]: https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white
[Tailwind-url]: https://tailwindcss.com/
[TypeScript]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Express.js]: https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white
[Express-url]: https://expressjs.com/
[SQLite]: https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white
[SQLite-url]: https://www.sqlite.org/
[Electron]: https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white
[Electron-url]: https://www.electronjs.org/
[Ollama]: https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white
[Ollama-url]: https://ollama.com/
