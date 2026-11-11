# Deployment

Launch plan: **Vercel (Hobby) + one Neon project** that provides Postgres,
Auth and Object Storage. All of it runs on free tiers, on the `*.vercel.app`
URL first; a custom domain can come later. AI is **off** at launch.

Limits below were checked against each provider's own docs in **November
2026**; providers change them, so re-check the linked page when you sign up.
Anything I could not confirm is marked **(unverified)**.

```
Browser ──► Vercel (Next.js, region cle1) ──► Neon Postgres        (pooled URL, app data)
                  ├────────────────────────► Neon Auth             (users, sessions, email codes)
                  └────────────────────────► Neon Object Storage   (resumes, private bucket)
```

All three Neon pieces live in one project, `job-apps`, region AWS `us-east-2`
(Ohio). Auth and Object Storage are configured **per branch**: do everything
below on the **production branch** (the project's default branch), and keep a
separate branch for local development so test users never mix with real ones.

## Free-tier limits (read this first)

| Service | Free allowance | Caveat for this app |
| --- | --- | --- |
| **Neon** Postgres, Auth, Object Storage ([source](https://neon.com/docs/introduction/plans.md)) | 100 CU-hours compute/project/month; **1 GB Postgres**; **5 GB object storage**; Auth up to **60k monthly active users**; **5 GB egress/month, shared** by Postgres, Object Storage and Functions; no card | Compute **sleeps after 5 minutes idle** and can't be disabled on Free, so the first request after a nap is slower. If CU-hours run out the database is suspended until next month; data is kept. Resume downloads count toward the shared 5 GB egress |
| **Neon** restore ([source](https://neon.com/docs/introduction/plans.md)) | Instant restore for up to **6 hours** of history (max 1 GB of change history); **1 manual snapshot**; no scheduled backups (paid plans only) | See "Backups" below: a bad migration or deletion noticed after 6 hours can't be rolled back with Neon alone |
| **Vercel Hobby** ([source](https://vercel.com/docs/limits/fair-use-guidelines)) | 1M function invocations, 4 hours active CPU, 100 GB transfer/month; functions up to 300 s | **Non-commercial, personal use only.** If this app earns money or you're paid to run it, you need Pro |

### Email: what to expect

Neon Auth sends the two emails this app needs (the **sign-up verification
code** and the **password-reset code**) from Neon's **shared sender**,
`auth@mail.myneon.app`. That needs no domain, SMTP account or code on our side.
Neon describes the shared sender as intended for **development and testing**
and recommends your own provider for production ([production checklist](https://neon.com/docs/auth/production-checklist.md)).
**Neon does not publish a sending rate limit** (none appears in its docs as of
Nov 2026), so treat it as unknown: it may throttle or fail when many people sign up at once.
For a personal tracker with a handful of users that is an acceptable launch
risk, but see "If codes stop arriving" below. The upgrade path is Neon's
**custom SMTP provider** setting (Settings → Better Auth): you then send from
your own address, which needs a domain you control for good deliverability
(about $10/year) and an SMTP account (several have free tiers; when I last
checked in Nov 2026 Brevo's free plan allowed 300 emails/day, which you should
re-verify). A custom provider still sends Neon's templates.

## Setup

### 1. Neon: project, branch and database

1. Create the project `job-apps` in region **AWS US East 2 (Ohio)**. Its
   default branch is the production branch.
2. From **Connect** (pick the production branch, the owner role and your
   database), copy both strings:
   - **Pooled** host (contains `-pooler`) → `DATABASE_URL`. Append
     `&pgbouncer=true&connect_timeout=15`. Prisma 6 needs `pgbouncer=true`
     behind Neon's PgBouncer, and the timeout tolerates the idle wake-up.
     (Checked against this app's raw SQL and transactions.)
   - **Direct** host (no `-pooler`) → `DIRECT_URL`. Migrations use this one.
3. If a string contains `channel_binding=require`, remove it and keep
   `sslmode=require` (`sslmode=require` alone connects).
4. Run the migrations once from your laptop (below), and again before
   deploying any release that changes `prisma/`.

**Migrations.** Put the **direct** string in a gitignored file (`.env*` is
ignored), apply, then delete the file. Never use the pooled URL, and never run
`prisma migrate reset` or `migrate dev` against this database.

```bash
printf 'DATABASE_URL="<direct url>"\nDIRECT_URL="<direct url>"\n' > .env.neon
node --env-file=.env.neon node_modules/.bin/prisma migrate deploy
rm .env.neon
```

`migrate deploy` only touches the app's tables in the `public` schema. Neon
Auth keeps its own tables in the `neon_auth` schema of the same database; the
app deliberately has no foreign keys into it.

### 2. Neon Auth

Neon Auth is **managed Better Auth**; the app talks to it through its own
forms and server actions using the `@neon/auth` SDK ([overview](https://neon.com/docs/auth/about.md),
[Next.js server SDK](https://neon.com/docs/auth/reference/nextjs-server.md)).
On the **production branch**: Console → **Auth** → **Enable Auth** (it uses the
branch's default database), then in **Settings → Better Auth** (labels may
shift; the CLI and API equivalents are in Neon's docs):

| Setting | Value | Why |
| --- | --- | --- |
| Sign-up with Email / **Verify at sign-up** | on | Unverified addresses can't get an account. The app also refuses unverified users on its side |
| Verification **method** | **Code** (not link) | Links need a custom email provider; codes work with the shared sender ([email verification](https://neon.com/docs/auth/guides/email-verification.md)) |
| **Revoke sessions on password reset** | on | A reset ends every existing session on every device ([password reset](https://neon.com/docs/auth/guides/password-reset.md)). The app's reset flow relies on it |
| **Organization** plugin | off | The app has no organizations; less surface |
| **Trusted domain** | the **exact** production origin, e.g. `https://<project>.vercel.app` | Neon Auth rejects state-changing requests from untrusted origins with `INVALID_ORIGIN`. Include `https://`, no trailing slash. **Never add a wildcard** such as `https://*.vercel.app`: that would trust every Vercel app ([configure domains](https://neon.com/docs/auth/guides/configure-domains.md)) |
| **Allow localhost** | **off, at the very end** | On by default for development; it trusts any localhost origin. Turn it off for production once everything else works ([production checklist](https://neon.com/docs/auth/production-checklist.md)). It has no effect on your *development* branch |
| **Application name** | `Job Tracker` | Appears in the verification and reset emails; defaults to the project name |

Then copy the branch's **Auth URL** (Console → Auth → Configuration, or
Settings → Better Auth → Project Info; it ends in `/neondb/auth` or your
database name) into `NEON_AUTH_BASE_URL`, and generate a **new** cookie secret
for production: `openssl rand -base64 32` → `NEON_AUTH_COOKIE_SECRET` (at
least 32 characters; secret).

Session behaviour to know about: the app keeps a signed, short-lived copy of
the session in a cookie to avoid calling Neon Auth on every request (SDK
default 300 s; this app sets **60 s**, see `SESSION_CACHE_SECONDS` in
`src/lib/neon-auth.ts`). Password change and account deletion skip that cache.
The session cookie uses `SameSite=Lax`, so links clicked from an email or chat
open signed in.

**If codes stop arriving** (shared sender throttled or delayed):
1. Check the spam folder and wait a few minutes; the app limits resends to 4
   per address per hour on purpose.
2. Look at the deployment logs for `neon_auth_error` lines (they carry the
   status and code only, never emails or codes).
3. If it keeps happening, move to a custom SMTP provider (see "Email" above).
   No code change is needed.

### 3. Neon Object Storage (resume files)

1. On the production branch: Console → **Object storage** → **New bucket**,
   name `resumes`, access level **private**. The access level **can't be
   changed later** ([buckets](https://neon.com/docs/storage/buckets.md)); if a
   bucket was ever public, create a new private one and copy the objects.
2. Create a credential for that branch with **`storage:read` and
   `storage:write`**: Console → Settings → **Credentials** → Create credential
   (or Connect → Storage tab). The secret is shown **once**; copy it right away
   ([storage authentication](https://neon.com/docs/storage/authentication.md)).
   Credentials never expire unless you set `expires_at` (API/CLI).
3. Values:

| Variable | Value |
| --- | --- |
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT` | The production branch's storage endpoint (looks like `https://br-….storage.c-N.us-east-2.aws.neon.tech`; shown in Connect → Storage) |
| `S3_REGION` | `us-east-2` |
| `S3_FORCE_PATH_STYLE` | `true` (required for a custom endpoint) |
| `S3_BUCKET` | `resumes` |
| `S3_ACCESS_KEY_ID` | The credential's `token_id` (`nak_live_…`) |
| `S3_SECRET_ACCESS_KEY` | The credential's `s3_secret_access_key` (**secret**) |

**Downloads stay proxied.** The browser never receives a bucket URL: the app
checks the signed-in user, then streams the file from `/api/resumes/<id>`. This
keeps every resume private to its owner, so don't switch the bucket to
`public_read` or hand out presigned URLs. The cost is that downloads pass
through a Vercel function and count against the shared egress allowance.

**Resume uploads are capped at 4 MB.** Vercel rejects function request bodies
over 4.5 MB, and the file travels in the same request as the form.

### 4. Vercel

1. Import the GitHub repo. Framework preset: **Next.js** (defaults are right;
   `postinstall` runs `prisma generate`).
2. **Region.** Put the functions next to the database: Vercel's regions page
   lists **`cle1` (Cleveland)** as its `us-east-2` region, while new projects
   default to `iad1` (Washington, D.C.) ([regions](https://vercel.com/docs/regions),
   [function region](https://vercel.com/docs/functions/configuring-functions/region)).
   Set it in Project → Settings → Functions → Function Region (verify the exact
   label in the dashboard; I could not confirm what Hobby lets you change), then
   redeploy.
3. Add the environment variables below with scope **Production only** (untick
   Preview and Development). Preview deployments then have no secrets and no
   trusted origin, which is intended. Mark secrets as **Sensitive**.
4. Deploy, then open `/api/health`; it should return `{"status":"ok"}`.

| Variable | Value and where it comes from | Secret? |
| --- | --- | --- |
| `NEON_AUTH_BASE_URL` | Production branch's Auth URL (Console → Auth → Configuration) | No |
| `NEON_AUTH_COOKIE_SECRET` | New value from `openssl rand -base64 32` | **Yes** |
| `DATABASE_URL` | Pooled string + `&pgbouncer=true&connect_timeout=15` (Console → Connect) | **Yes** (has the password) |
| `DIRECT_URL` | Direct string (Console → Connect) | **Yes** |
| `STORAGE_DRIVER`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_BUCKET` | Section 3 | No |
| `S3_ACCESS_KEY_ID` | Credential `token_id` | Treat as yes |
| `S3_SECRET_ACCESS_KEY` | Credential secret | **Yes** |
| `SUPPORT_EMAIL` | Address shown on privacy/terms | No |
| `CLIENT_IP_HEADER` | Leave unset: the default `x-forwarded-for` is right on Vercel, which overwrites that header | No |
| `AI_ENABLED` | **Leave unset** (AI off) | No |

There is **no `APP_URL`** any more: the app no longer builds links in emails
(Neon Auth sends codes, not links), so nothing needs the public URL except
Neon Auth's trusted-domain list.

## Go-live checklist

1. **Secrets stay out of the (public) repo.** Real values live only in Vercel
   and Neon, never in git. `.env*` (except `.env.example`),
   `.test-account.local`, `data/` and `backups/` are gitignored. If a real
   secret is ever committed or pasted somewhere public, treat it as leaked:
   rotate it first, then clean the history.
2. Migrations applied to the production branch (Setup 1); Neon Auth settings
   set (Setup 2); private bucket and credential created (Setup 3); env vars
   set and deployed (Setup 4).
3. **Smoke test on the live URL**, with an inbox you can read:
   - `/api/health` returns `{"status":"ok"}`.
   - **Sign up**, then enter the emailed **6-digit code**; you land on the
     dashboard signed in. (Also try a wrong code once.)
   - **Resume upload and download** (a small PDF); open the downloaded file.
     Confirm `/api/resumes/<id>` returns 401 when signed out.
   - **Sign out, then password reset**: request a code, set a new password,
     sign in with it. Confirm a second browser that was signed in before the
     reset is signed out (revoke-on-reset).
   - **Change password** in Settings.
   - **Delete account**: the app deletes your applications, resumes and files
     and ends all sessions. The Neon Auth identity record may remain; see Known
     limitations.
   - **AI is hidden**: no "Write with AI" button, `/api/cover-letter` returns
     404, and `/privacy` and `/terms` don't mention AI.
   - **Headers**: `curl -sI https://<your-url>/login` shows
     `Content-Security-Policy`, `Strict-Transport-Security`,
     `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` (set in
     `next.config.ts`; HSTS is production-only).
4. **Turn Allow localhost off** in Neon Auth (production branch) and repeat the
   sign-in once to confirm nothing depended on it.
5. Point an uptime monitor (e.g. UptimeRobot free) at `/api/health` (returns
   `{"status":"ok"}`, or 503 when the database is unreachable).
6. Read `/privacy` and `/terms`. They're plain-language templates matching what
   the app does, **not legal advice**; have them reviewed, and set `SUPPORT_EMAIL`.
7. Take a first backup and a first restore test (below).
8. Remove any smoke-test users you don't want to keep (Neon console or API).

## Backups

What exists:

- **Neon instant restore** (Free): roll the branch back to a point in the last
  **6 hours**. Documented on Neon's plans page; **I have not tested a restore**.
  Auth data lives in the same database, so a restore should roll back users
  and sessions too (inference, **unverified**).
- **One manual Neon snapshot** on Free. Take one before risky migrations
  **(not tested)**.
- **`scripts/backup-db.sh`**: `pg_dump` of the database to
  `backups/jobapps-<timestamp>.sql.gz`, keeping the newest 14. It reads
  `DIRECT_URL` (falling back to `DATABASE_URL`) from **`./.env`**, which takes
  priority over variables already in your shell: to back up Neon, point `.env`
  at the production direct URL for the run (and put it back), or call `pg_dump`
  yourself. Use a `pg_dump` at least as new as the server's Postgres version.
  Whether the dump includes everything in `neon_auth` depends on the role's
  privileges **(unverified)**. Backups hold user data: keep them off shared
  drives and out of git. A restore (`gunzip -c … | psql "$DIRECT_URL"`)
  into a scratch branch or database is the only real proof; do it once.
- **Resume files are not in any database backup.** Copy the `resumes` bucket
  with any S3 client pointed at the branch's storage endpoint (for example
  `aws s3 sync` with `--endpoint-url`) and the same credential **(not tested)**.

## Operations

**After any credential exposure, rotate it.** For the database: Neon Console →
project → production branch → **Roles & Databases** → reset the owner role's
password (label may differ), then update `DATABASE_URL` and `DIRECT_URL` in
Vercel and redeploy. Whether Neon Auth keeps working across a role-password
reset isn't documented **(unverified)**: re-run the sign-in smoke test
afterwards. Likewise rotate the storage credential (Settings → Credentials →
rotate or create a new one, update `S3_*`, redeploy) and, if it leaked,
`NEON_AUTH_COOKIE_SECRET` (new value in Vercel; expect users to sign in again,
**unverified**).

**Custom domain, later.**
1. Vercel → Project → Settings → Domains → add the domain and the DNS records
   Vercel shows.
2. In Neon Auth, **add the new exact origin** (e.g. `https://app.example.com`,
   and `https://www.…` if you serve it) to trusted domains. Keep the old
   `*.vercel.app` origin until the new one is verified, then remove it.
3. No app setting changes: there's no `APP_URL` to update. Session cookies are
   host-only, so users sign in again on the new host.
4. Re-run the smoke test on the new origin.

## Later: adding AI

Set `AI_ENABLED=true` plus the `OLLAMA_*` variables (see `.env.example`) and
redeploy. The model runs on **hardware you control** with Ollama (free only if
you already own it), so the web app must be able to reach it. The privacy and
terms pages start describing AI automatically.

- **Ollama on your machine, app on Vercel (the layout that fits this
  launch).** Expose Ollama through a Cloudflare Tunnel protected by
  **Cloudflare Access service-token** auth. Set `OLLAMA_BASE_URL` to the tunnel
  URL and send the token headers via
  `OLLAMA_EXTRA_HEADERS='{"CF-Access-Client-Id":"…","CF-Access-Client-Secret":"…"}'`.
  **Never expose an unauthenticated Ollama to the internet.** A stable tunnel
  hostname needs a domain on Cloudflare. Drafts are unavailable while your
  machine is off (users see a clear "unavailable" message; everything else
  works). The route allows up to 300 s, matching Hobby's limit; the default
  `OLLAMA_TIMEOUT_MS` is 240 s.
- **Self-hosting the whole app on the Ollama machine** (`npm run build && npm
  start`, `STORAGE_DRIVER=local`, `UPLOAD_DIR` backed up, `CLIENT_IP_HEADER=cf-connecting-ip`
  behind Cloudflare Tunnel) still needs **Neon Auth** (users live there, so
  `NEON_AUTH_*` and a trusted origin for the tunnel hostname are required) and a
  Postgres for app data. I have not tested this layout.
- Scanned PDFs and legacy `.doc` resumes can be stored but not read by the AI;
  the draft is written without resume text and the user is told so. By default
  only one draft runs at a time (`OLLAMA_MAX_CONCURRENCY=1`); others queue
  briefly and then get a "busy" message.

## Known limitations

- **Shared email sender.** `auth@mail.myneon.app` is meant for development and
  testing and has an **undocumented rate limit**; deliverability to some
  providers may be poor. Upgrade path: custom SMTP in Neon Auth.
- **Code lifetime.** Verification and reset codes expire after **15 minutes**
  per [Neon's docs](https://neon.com/docs/auth/guides/email-verification.md),
  and the app's screens say the same. Confirm against the live service during
  the smoke test; if Neon changes it, update the three screens that mention it
  (`actions/auth.ts`, `(auth)/verify-email`, `(auth)/reset-password`).
- **Revoked sessions can linger briefly.** Ordinary page views trust the signed
  session cache for up to `SESSION_CACHE_SECONDS` (60 s in this app; the SDK's
  default is 300 s). Neon Auth itself checks the database on every real session
  check. Password change and account deletion always ask Neon Auth directly.
- **Account deletion doesn't remove the Neon Auth identity.** The app deletes
  all of a user's applications, resumes and files and revokes their sessions,
  but the SDK's delete-user call isn't supported by managed Neon Auth as far as
  the app's author could tell (answers 404; **unverified by me**, and not
  documented either way). The email address, password hash and name stay in
  Neon Auth until you remove the user in the Neon Console or through the Neon
  API's auth-users endpoint. The privacy page says this plainly.
- **Uploads are capped at 4 MB** (Vercel's 4.5 MB body limit).
- **Vercel Hobby is non-commercial, personal use only.**
- **Neon free-tier caps** (1 GB Postgres, 5 GB storage, 5 GB shared egress,
  100 CU-hours, 6-hour restore window) and a cold start after 5 idle minutes.
- **Rate limiting trusts a client-IP header.** `CLIENT_IP_HEADER` must name a
  header your proxy *overwrites*; if a client can set it, they can dodge the
  per-IP limits (per-account limits still apply). On Vercel the default
  `x-forwarded-for` is overwritten by the platform
  ([docs](https://vercel.com/docs/headers/request-headers)). Neon Auth also has
  its own throttling that is undocumented.
- **CSP allows inline scripts** (`'unsafe-inline'`) because Next's bootstrap
  scripts are inline and the legal pages are static. Everything else in the
  policy is strict. A nonce-based CSP would require rendering every page dynamically.
- **Tests don't exercise the real Neon Auth.** The e2e suite uses a mock that
  mirrors behavior checked against a Neon branch; the live service is covered
  only by the smoke test above.
- **`npm audit` reports 3 high-severity findings in `deepmerge-ts`,** reached
  only through the Prisma CLI's config loader (build/deploy time, never request
  handling). The suggested fix is a breaking Prisma 7 upgrade; revisit it when
  you next upgrade Prisma deliberately.
- Limits in this document come from provider pages checked Nov 2026 and will drift.
