
# Attendance Tracker — Time Off Request (MVP)

Monorepo with **server** (Node/Express + TypeScript + PostgreSQL) and **web** (Vite + React + TS).
Built to run locally with Dockerized Postgres. Open the repo in **WebStorm** and use npm workspaces.

## Quickstart

1) **Requirements**
   - Node.js 20 (see `.nvmrc`)
   - Docker + docker-compose (optional but recommended for Postgres)
   - psql CLI (for applying migrations)

2) **Clone & Install**
```bash
npm install
```

3) **Start Postgres (Docker)**
```bash
docker-compose up -d
```

4) **Create .env files**
   - Copy `server/.env.example` to `server/.env` and fill values.
   - Copy `web/.env.example` to `web/.env` and adjust API URL if needed.

5) **Run DB migrations**
```bash
psql "$POSTGRES_URL" -f server/sql/migrations/001_init.sql
```

6) **Dev servers**
```bash
npm run dev
```
- API: http://localhost:4000
- Web: http://localhost:5173  (served by Vite; the web app proxies to API)

## Structure
- `/server` — Express API, auth stubs, email/calendar stubs, SQL schema
- `/web` — React app with the Time Off page (drop-in after Zoho consent)

## Notes
- This is an MVP scaffold. Wire Zoho OAuth in `server/src/auth.ts`.
- Replace email service with SES/SendGrid and set `HR_EMAILS` in env.
- For NGINX, proxy `/api/*` to `http://localhost:4000` and serve Vite build from `/web/dist` in production.
