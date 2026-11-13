# Architecture

> **Keep this file current.** Any change to how the system is built or wired
> updates the diagrams, tables and changelog below **in the same commit**: a new
> or removed service, route, table, flag, rate limit, environment, deploy step
> or integration, as well as anything in the job posting importer. The Cursor
> rule `.cursor/rules/architecture.mdc` reminds you. (The file keeps its old
> name, `import-architecture.md`, because the importer was documented first.)

Contents: [System](#system) · [Requests and access](#requests-and-access) ·
[Data](#data) · [Flags, limits and environments](#flags-limits-and-environments) ·
[Job posting importer](#job-posting-importer) · [Planned, not built](#planned-not-built) ·
[Changelog](#changelog)

## System

```mermaid
flowchart LR
    user(["Browser"])
    inbox(["Your inbox"])
    boards(["Public job sites<br/>Greenhouse · SmartRecruiters APIs<br/>Lever · any page"])

    subgraph dns["jobapphelp.net"]
        direction TB
        www["www.jobapphelp.net (canonical)"]
        apex["jobapphelp.net → www"]
        legacy["job-apps-pi.vercel.app → www (307)"]
    end

    subgraph vercel["Vercel Hobby (region cle1)"]
        direction TB
        proxy["proxy.ts<br/>redirects signed-out visitors"]
        app["Next.js 16 app<br/>pages · server actions · API routes"]
        proxy --> app
    end

    subgraph neon["Neon project (aws-us-east-2, Free plan)"]
        direction TB
        auth["Neon Auth<br/>managed Better Auth"]
        pg[("Postgres 18<br/>public + neon_auth schemas")]
        s3[("Object Storage<br/>private bucket: resumes")]
        auth -- "users, sessions, codes" --> pg
    end

    mail["Neon shared email sender"]
    gh["GitHub: ssamkough/job-apps"]
    ollama["Ollama (local model)<br/>OFF"]
    worker["Import worker (Inngest)<br/>NOT BUILT"]

    user -- "HTTPS" --> www
    apex --> www
    legacy --> www
    www --> proxy
    app -- "sign-up, sign-in, codes (SDK)" --> auth
    app -- "Prisma, pooled connection:<br/>app data, rate limits, import jobs" --> pg
    app -- "S3 API, server side only" --> s3
    app -- "importer fetches public pages<br/>(guarded, see importer)" --> boards
    app -. "AI_ENABLED=true" .-> ollama
    app -. "AI_IMPORT_ENABLED + queue" .-> worker
    worker -.-> ollama
    worker -. "completeJob / failJob" .-> pg
    auth --> mail -- "6-digit codes" --> inbox
    gh -- "push to main deploys" --> vercel
```

Dotted edges and "OFF" / "NOT BUILT" boxes are designed but not running. The
browser only ever talks to Vercel; Neon is reached from the server, and the
app does not expose Neon Auth's own endpoints (`/api/auth` is a 404).

## Requests and access

```mermaid
flowchart TD
    R["Request"] --> P{"Path protected?<br/>dashboard · applications · questions<br/>resumes · settings · admin"}
    P -->|no| PUB["Public pages: landing, login, signup,<br/>verify, reset, privacy, terms"]
    P -->|yes, no session| LOGIN["redirect to /login"]
    P -->|yes| PAGE["Page or server action"]
    PAGE --> RU["requireUser (the real check:<br/>the proxy is only a convenience)"]
    RU --> SCOPE["Every query scoped by userId"]
    PAGE --> RA["/admin: requireAdmin reads neon_auth.user.role<br/>on every call, 404 for non-admins"]
    API["API routes"] --> RL["rate limits (Postgres)"]
    RL --> RU
```

| Area | Routes |
| --- | --- |
| App (signed in) | `/dashboard`, `/applications` (+ `/new`, `/[id]`), `/questions` (+ `/[id]`), `/resumes`, `/settings`, `/admin` |
| Auth | `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` |
| Public | `/`, `/privacy`, `/terms` |
| API | `/api/health`, `/api/resumes/[id]` (streams private files), `/api/cover-letter`, `/api/import`, `/api/import/[id]` |

Sessions are cookies on one host (`www.jobapphelp.net`); Neon Auth owns
accounts, the app keeps only the user id in `public."User"`. Security headers
(CSP, HSTS, frame denial) are set in `next.config.ts`.

## Data

```mermaid
erDiagram
    NEON_AUTH_USER ||--o| USER : "same id, no foreign key"
    USER ||--o{ APPLICATION : owns
    USER ||--o{ RESUME : owns
    USER ||--o{ QUESTION : owns
    USER ||--o{ IMPORT_JOB : owns
    RESUME |o--o{ APPLICATION : "attached to"
    APPLICATION ||--o{ STATUS_EVENT : "status history"
    QUESTION ||--o{ ANSWER : "variants"
    APPLICATION ||--o{ APPLICATION_QUESTION : asks
    QUESTION ||--o{ APPLICATION_QUESTION : "asked by"
    ANSWER |o--o{ APPLICATION_QUESTION : "chosen for"
```

`RateLimit` (counters keyed by IP, email or user id) stands alone. Full column
lists are in `prisma/schema.prisma` and the README's data section.

- Deleting a user cascades to everything they own. Deleting a resume keeps the
  applications that used it. Deleting an answer keeps the question and clears
  the choice. Deleting a question removes it from every application.
- **Migrations are applied by hand** (not by the Vercel build): dry run on a
  throwaway Neon branch, then apply, **before** deploying code that needs them.
  See `DEPLOYMENT.md`. Never `migrate reset`.
- Resume files live in the private Object Storage bucket, keyed `{userId}/{uuid}`.

## Flags, limits and environments

| Flag | Effect | Production |
| --- | --- | --- |
| `AI_ENABLED` | AI cover letters via Ollama | off |
| `IMPORT_ENABLED` | "Import from a job posting" and the question finder | on |
| `AI_IMPORT_ENABLED` | Sends text-only imports to the AI worker (needs `IMPORT_ENABLED` and a queue) | off, no queue |

| Rate limit (Postgres-backed) | Limit |
| --- | --- |
| Sign-in | 20 / 15 min per IP; 10 failures / 15 min per email |
| Sign-up | 5 / hour per IP |
| Emailed codes | 15 / hour per IP; 4 / hour per email; code guesses 20 / 15 min per IP, 10 / 15 min per email |
| Password re-check | 10 / 15 min per user |
| AI cover letter | 15 / hour per user |
| Imports | 30 / day per user; 60 / hour per IP; AI imports 10 / day per user |

| Environment | Where |
| --- | --- |
| Production | Vercel Hobby, Neon production branch (`DATABASE_URL` pooled, `DIRECT_URL` for migrations) |
| Local dev and tests | local Postgres (`jobapps_dev`, `jobapps_test`), mock Neon Auth and mock services for e2e |

## Job posting importer

The importer turns a link, a PDF or pasted text into values for the Add
application form, and finds the questions the application asks. Everything runs
on the server in `POST /api/import`; the browser only fills in blank fields and
offers Undo.

### Flow

```mermaid
flowchart TD
    UI["ImportBox (browser)<br/>link · PDF · pasted text"] -->|POST /api/import| API

    subgraph API["POST /api/import (route.ts)"]
        direction TB
        G["Gate: IMPORT_ENABLED, signed in,<br/>verified email, rate limits<br/>(30/day/user, 60/h/IP)"]
        G --> K{Input kind}
        K -->|link| PU["prepareFromUrl"]
        K -->|PDF| PP["prepareFromPdf"]
        K -->|text| PT["prepareFromText"]
    end

    PU --> SF["safe-fetch: public hosts only, ports 80/443,<br/>3 redirects, 8 s, 2 MB, HTML only"]
    SF --> BA["readBoard (boards.ts)<br/>Greenhouse · SmartRecruiters public API<br/>(fetchJson, 5 s)"]
    SF --> LD["JSON-LD JobPosting (html.ts)<br/>the one matching the page url or id,<br/>else one with title and employer"]
    SF --> MD["readPageMeta (meta.ts)<br/>og:title · title · h1 · site name · board link"]
    BA --> M["mergeFields: board, then JSON-LD,<br/>then page metadata fills gaps"]
    LD --> M
    MD --> M
    SF --> Q["findQuestions (questions.ts)<br/>Lever /apply · form labels"]
    BA -->|its questions win| Q
    M --> UC["jobUrl: cleanJobUrl (url.ts)<br/>tracking parameters dropped"]
    UC -->|company + title| COMPLETE["complete"]
    UC -->|otherwise| TXT["page text (html.ts, chrome.ts): main or article,<br/>banners and Apply lines dropped,<br/>cut at a paragraph, 12k cap"]
    PP --> TXT
    PT --> TXT
    TXT --> PARTIAL["partial: text as description,<br/>plus any company or title found"]
    TXT -->|"link, under 200 characters,<br/>no company or title"| NOC["error: no_content"]

    COMPLETE --> JOB[("ImportJob row<br/>kept 7 days")]
    PARTIAL -->|"AI_IMPORT_ENABLED, a queue<br/>and 200+ characters of text"| QUEUE["ImportQueue (not wired yet)"]
    PARTIAL -->|otherwise| JOB
    QUEUE -.->|"completeJob / failJob"| JOB
    Q --> JOB

    JOB --> OUT["outcome: fields, questions, notice"]
    OUT --> UI
    UI -->|"fills blank fields only,<br/>marks them, Undo"| FORM["Application form"]
    UI -->|"question checklist"| QE["QuestionsEditor"]
```

Dotted edges are designed but not built.

### Sources of company and title

| Source | Gives | Used when |
| --- | --- | --- |
| Board API (`boards.ts`): Greenhouse, SmartRecruiters | company, title, location, work type, clean description, Greenhouse questions | the link is a Greenhouse or SmartRecruiters posting and the API answers; any failure is ignored |
| schema.org `JobPosting` JSON-LD | company, title, location, salary, description | the page has one; fills what the board API left empty. With several, the one whose `url` or `identifier` matches the page address, else the first with a title and employer, else the first |
| Page metadata (`meta.ts`): `og:title`, `<title>`, `<h1>`, `og:site_name`, the board link | company, title | last resort, for whatever the sources above left empty |
| Page text (`html.ts`, `chrome.ts`) | description only | no description from the sources above. Takes `<main>`, `[role=main]` or `<article>`, else the body, without the head. Drops cookie banners, lone Apply, Share and Back lines, copyright lines and footer link lists |

### Limits and guards

- Fetching: public addresses only (checked at connect time, redirects included), ports 80/443, 3 redirects, 8 s, 2 MB after decompression.
- Board APIs: only the known hosts (`boards-api.greenhouse.io` and its EU twin, `api.smartrecruiters.com`), same fetch guards, 5 s, failures swallowed so the page path still runs.
- Descriptions: page text is capped at 12,000 characters (20,000 when it is the description of an otherwise complete posting) and cut at a paragraph, else a sentence, else a word, never mid-word. Board and JSON-LD descriptions are cut the same way at 20,000.
- Stored link: the page that was read, minus `utm_*`, `gh_src`, `lever-source`, `lever-origin`, `fbclid`, `gclid` and similar, and `ref`, `src`, `source` unless numeric (`url.ts`). `gh_jid` stays unless the path already carries the same id (stripe.com/jobs/search needs it); the fragment stays.
- Thin pages: a link whose text is under 200 characters (a JavaScript shell) still returns a company or title that was found, with no description and a notice, and is never queued for the AI worker. With nothing found it is `no_content`.
- Questions: best effort, never fail an import, at most 30 offered.
- Jobs: queued jobs expire after 15 minutes, finished jobs are deleted after 7 days, at most 3 pending per person.

### Not built

- AI extraction (Phases 2 to 4): no queue or worker. Blocked on the Inngest install and a worker server.
- JavaScript-rendered boards (Meta, Workable, Workday) return "no readable text" unless the page's metadata names a company or title.

## Planned, not built

- Importer: see "Not built" above (AI worker, JavaScript-rendered boards).
- Importer: Lever, Ashby and Workable APIs are possible later.
- Drafting answers to saved questions with the local model (`Answer.source = "AI"` is the seam).
- Scheduled database backup (Neon Free has one manual snapshot only).
- `SUPPORT_EMAIL` is unset, so the privacy and terms pages show a placeholder address.

## Changelog

- Initial version: JSON-LD, page text, questions.
- Widened from the importer to the whole system: system, access, data, flags and limits sections.
- Importer fix 1: Greenhouse and SmartRecruiters read from their public APIs (`boards.ts`) before JSON-LD; Greenhouse questions moved there from `questions.ts`.
- Importer fix 2: company and title fall back to page metadata (`meta.ts`): `og:title`, `<title>` with the site name stripped, `<h1>`, `og:site_name`, and the employer named in a job board link.
- Importer fix 3: page-text descriptions drop cookie banners, Apply and Share lines and footer link lists, ignore the doctype and `<title>`, and are cut at a paragraph, sentence or word instead of mid-word (`chrome.ts`, `text.ts`).
- Importer fix 4: tracking parameters are stripped from the stored link (`url.ts`), the best of several JSON-LD `JobPosting`s is used, and a page with too little text still returns the company or title it found instead of failing.
