# Job Tracker

Track every job application in one place: status, the resume you sent, an
AI-assisted cover letter, dates, notes, contacts, and dashboard insights.
Email/password accounts with email verification and password reset.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 ·
PostgreSQL via Prisma · Ollama (local model) for cover letters · any SMTP
provider for email · local disk or any S3-compatible bucket for resumes.

> This repo uses a newer Next.js than most training data. Before changing
> framework code, read the matching guide in `node_modules/next/dist/docs/`.

## Run it locally

Prerequisites: Node 20.9+ (developed on Node 24), PostgreSQL, and (for AI drafts) [Ollama](https://ollama.com).

```bash
npm install
cp .env.example .env              # then edit DATABASE_URL etc.
createdb jobapps_dev              # or use any Postgres you like
npx prisma migrate deploy         # applies prisma/migrations
npm run dev                       # http://localhost:3000
```

- **Email in development:** leave `SMTP_HOST` empty. Verification and reset
  emails are printed in the server terminal (including the link to click).
- **AI drafts (off by default):** set `AI_ENABLED="true"` in `.env`, then
  `ollama pull qwen3.8:27b` (or set `OLLAMA_MODEL` to any model
  you have). With the flag off, the "Write with AI" button is hidden and
  `/api/cover-letter` returns 404; the cover letter is just a textarea. Drafts need a *verified* email address; in dev, click the link
  from the terminal. A local model takes a minute or two per letter.
- **Dev test account:** `node --env-file=.env scripts/create-test-account.mjs`
  creates the verified account described in `.test-account.local` (gitignored).

## Quality checks

```bash
npm run typecheck
npm run lint
npm test            # unit + integration (Vitest, real Postgres `jobapps_test`)
npm run test:e2e    # builds, then Playwright against the production build
```

First-time setup for tests:

```bash
psql postgres -c 'CREATE DATABASE jobapps_test' -c 'CREATE DATABASE jobapps_e2e'
npx playwright install chromium
```

`npm test` and the e2e run only ever touch databases named `*_test` / `*_e2e`
(the scripts refuse anything else). The e2e run uses a mock Ollama and a local
SMTP sink, so it is offline and free. Run `E2E_AI=false npm run test:e2e` to
test the no-AI configuration (AI specs skip; a check that the AI UI is gone runs
instead). It also writes mobile screenshots to
`e2e/screenshots/`.

## Where things live

| Path | What |
| --- | --- |
| `src/app/actions/` | Server actions: auth, account, applications, resumes. Every export here is a public endpoint, so shared helpers live in `src/lib/`, not here. |
| `src/app/api/` | `cover-letter` (AI), `resumes/[id]` (download), `health` |
| `src/lib/rate-limit.ts` | Postgres-backed fixed-window limiter (no Redis) |
| `src/lib/email.ts` | SMTP sender with a daily cap that protects free-tier quotas |
| `src/lib/ai.ts` | Ollama client with a concurrency queue and timeouts |
| `src/lib/storage.ts` | Resume storage (local disk or S3-compatible) + upload validation |
| `prisma/` | Schema and migrations |
| `scripts/backup-db.sh` | `pg_dump` backup with rotation |

## Deploying

See [DEPLOYMENT.md](./DEPLOYMENT.md): free-tier limits (verified Nov 2026),
the two hosting layouts, and a go-live checklist.
