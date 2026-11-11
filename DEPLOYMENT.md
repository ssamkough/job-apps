# Deployment

Runbook for the launch setup: **Vercel Hobby + one Neon project** providing
Postgres, Auth and Object Storage, all on free tiers. The app goes live on its
`*.vercel.app` URL first and has since moved to its own domain (see
[Custom domain](#custom-domain)). **AI is off** at launch (`AI_ENABLED` unset).

This repo is **public**. Never put real secrets, connection strings with
credentials, key ids, personal emails or passwords in this file or anywhere
else in git. Use placeholders such as `<project>` and `<app>`.

Limits below were checked against each provider's own docs in **November
2026**; providers change them, so re-check the linked page when you sign up.
Anything not confirmed is marked **(unverified)**. Notes headed **State at
launch** describe how the production setup was left on 10 Nov 2026, not steps
you must repeat.

## Contents

1. [Overview and architecture](#overview-and-architecture)
2. [Free-tier limits](#free-tier-limits)
3. [One-time setup](#one-time-setup): Neon database, Auth, Object Storage
4. [Vercel deploy](#vercel-deploy), env var table and `.env.vercel.local` import
5. [Go-live](#go-live): finalize Auth origin, smoke test
6. [Custom domain, later](#custom-domain-later)
7. [Operations](#operations): monitor, backups, rotating secrets
8. [Known limitations](#known-limitations)
9. [Later: adding AI](#later-adding-ai)

## Overview and architecture

```
Browser ──► Vercel (Next.js, function region cle1) ──► Neon Postgres        (pooled URL, app data)
                  ├───────────────────────────────────► Neon Auth             (users, sessions, email codes)
                  └───────────────────────────────────► Neon Object Storage   (resumes, private bucket)
```

- **Hosting:** Vercel Hobby (personal, non-commercial use only).
- **Neon:** one project in region AWS `us-east-2` (Ohio). Auth and Object
  Storage are configured **per branch**: everything in this file is done on the
  **production branch** (the project's default branch). Keep a separate branch
  for local development so test users never mix with real ones.
- **Neon Auth** stores identities in the `neon_auth` schema of the same
  database; the app's own tables are in `public` and have no foreign keys into
  `neon_auth`.
- **Resume files** live in a private bucket and are served only through the
  app's authenticated route (`/api/resumes/<id>`).

## Free-tier limits

| Service | Free allowance | Caveat for this app |
| --- | --- | --- |
| **Neon** Postgres, Auth, Object Storage ([source](https://neon.com/docs/introduction/plans.md)) | 100 CU-hours compute/project/month; **1 GB Postgres**; **5 GB object storage**; Auth up to **60k monthly active users**; **5 GB egress/month, shared** by Postgres, Object Storage and Functions; no card | Compute **sleeps after 5 minutes idle** and can't be disabled on Free, so the first request after a nap is slower. If CU-hours run out the database is suspended until next month; data is kept. Resume downloads count toward the shared 5 GB egress |
| **Neon** restore ([source](https://neon.com/docs/introduction/plans.md)) | Instant restore for up to **6 hours** of history (max 1 GB of change history); **1 manual snapshot**; no scheduled backups (paid plans only) | See [Backups](#backups): a bad migration or deletion noticed after 6 hours can't be rolled back with Neon alone |
| **Vercel Hobby** ([source](https://vercel.com/docs/limits/fair-use-guidelines)) | 1M function invocations, 4 hours active CPU, 100 GB transfer/month; functions up to 300 s | **Non-commercial, personal use only.** If this app earns money or you're paid to run it, you need Pro |

### Email: what to expect

Neon Auth sends the two emails this app needs (the **sign-up verification
code** and the **password-reset code**) from Neon's **shared sender**,
`auth@mail.myneon.app`. That needs no domain, SMTP account or code on our side.
Neon describes the shared sender as intended for **development and testing**
and recommends your own provider for production ([production checklist](https://neon.com/docs/auth/production-checklist.md)).
**Neon does not publish a sending rate limit** (none appears in its docs as of
Nov 2026), so treat it as unknown: it may throttle or fail when many people
sign up at once. For a personal tracker with a handful of users that is an
acceptable launch risk. The upgrade path is Neon's **custom SMTP provider**
setting (Settings → Better Auth), which needs a domain you control for good
deliverability and an SMTP account; some providers have free tiers (Brevo's was
300 emails/day when last checked, **unverified**, re-check). No code change is
needed for that switch.

**If codes stop arriving:**
1. Check the spam folder and wait a few minutes; the app limits resends to 4
   per address per hour on purpose (`otpSendEmail` in `src/lib/rate-limit.ts`).
2. Look at the Vercel function logs for `neon_auth_error` lines (they carry the
   status and code only, never emails or codes).
3. If it keeps happening, move to a custom SMTP provider.

## One-time setup

### 1. Neon: project, branch and database

1. Create the project in region **AWS US East 2 (Ohio)**. Its default branch is
   the production branch.
2. From **Connect** (production branch, owner role, your database) copy both
   strings:
   - **Pooled** host (contains `-pooler`) → `DATABASE_URL`, ending in
     `?sslmode=require&pgbouncer=true&connect_timeout=15`. Prisma 6 needs
     `pgbouncer=true` behind Neon's PgBouncer; the timeout tolerates the idle
     wake-up.
   - **Direct** host (no `-pooler`) → `DIRECT_URL`, ending in
     `?sslmode=require`. Migrations use this one.
3. Neon's strings may contain `channel_binding=require`: remove it and keep
   `sslmode=require` (which alone connects).
4. Apply the migrations (below).

**Migrations.** Migrations live in `prisma/migrations/` (`20261110184526_init`,
`20261110235900_neon_auth_slim_user`). `migrate deploy` only touches the app's
tables in `public`; it never touches `neon_auth`. Apply them from a laptop with
the **direct** string in a gitignored file (`.env*` is ignored), then delete the
file. Never use the pooled URL.

```bash
printf 'DATABASE_URL="<direct url>"\nDIRECT_URL="<direct url>"\n' > .env.neon
node --env-file=.env.neon node_modules/.bin/prisma migrate deploy
rm .env.neon
```

(`npm run db:deploy` is the same `prisma migrate deploy`.)

**Future schema changes**, in this order:
1. Take the one free **manual snapshot** of the production branch (or create a
   branch from it) so there is something to go back to. Not tested.
2. **Dry-run** `migrate deploy` on a **throwaway branch** created from
   production (use that branch's direct URL in `.env.neon`). Delete the
   throwaway branch afterwards.
3. Apply to production as above.
4. **Never** run `prisma migrate reset`, `migrate dev` or `db push` against
   production.

> **State at launch.** Both migrations were applied to the production branch
> with `prisma migrate deploy` over the direct host, after a dry run on a
> throwaway branch. The owner-role password was rotated afterwards because it
> had been exposed in tool output; `DATABASE_URL` and `DIRECT_URL` use the new
> one. A rotation test on a throwaway branch showed **Neon Auth keeps working
> after a role-password reset**.

### 2. Neon Auth

Neon Auth is **managed Better Auth**; the app talks to it through its own forms
and server actions using the `@neon/auth` SDK ([overview](https://neon.com/docs/auth/about.md),
[Next.js server SDK](https://neon.com/docs/auth/reference/nextjs-server.md)).
On the production branch: Console → **Auth** → **Enable Auth** (it uses the
branch's default database), then Settings → **Better Auth** (labels may shift;
CLI and API equivalents are in Neon's docs):

| Setting | Value | Why |
| --- | --- | --- |
| Sign-in method | **Email + password only** | The app has no social login. If Google (or another provider) is enabled by default, remove it |
| Sign-up with Email / **Verify at sign-up** | **required** | Unverified addresses can't get an account. The app also refuses unverified users on its side |
| Verification **method** | **Code** (OTP), not link | Links need a custom email provider; codes work with the shared sender ([email verification](https://neon.com/docs/auth/guides/email-verification.md)) |
| **Revoke sessions on password reset** | **on** | A reset ends every existing session on every device ([password reset](https://neon.com/docs/auth/guides/password-reset.md)). The app's reset flow relies on it |
| **Organization** plugin | **off** | The app has no organizations; less surface |
| **Application name** | `Job Tracker` | Shown in the verification and reset emails; defaults to the project name. Changeable under Settings → Better Auth → Project Info |
| **Trusted domains** | Empty until the live URL is known, then the **exact** origin (see [Go-live](#go-live)) | Neon Auth rejects state-changing requests from untrusted origins with `INVALID_ORIGIN`. **Never add a wildcard** such as `https://*.vercel.app`: that would trust every Vercel app ([configure domains](https://neon.com/docs/auth/guides/configure-domains.md)) |
| **Allow localhost** | On until go-live, then **off** | On by default for development; it trusts any localhost origin. Turn it off once the live origin works ([production checklist](https://neon.com/docs/auth/production-checklist.md)). It has no effect on your development branch |

> **State at launch.** Production Auth: email + password only; verification
> required, method = code; revoke-sessions-on-reset on; Organization plugin
> off; the Google provider (Neon's shared dev credentials) removed; application
> name `Job Tracker`; **trusted domains empty and Allow localhost on**, because
> the live URL wasn't known yet. **Until the origin is added, sign-up from the
> deployed URL fails with an invalid-origin error. That is expected on the very
> first deploy.**

Then copy the branch's **Auth URL** (Console → Auth → Configuration, or
Settings → Better Auth → Project Info; it ends in `/neondb/auth` or your
database name) into `NEON_AUTH_BASE_URL`, and generate a **new** cookie secret
for production: `openssl rand -base64 32` → `NEON_AUTH_COOKIE_SECRET` (at least
32 characters; secret).

Session behaviour to know about: the app keeps a signed, short-lived copy of the
session in a cookie to avoid calling Neon Auth on every request (SDK default
300 s; this app sets **60 s**, see `SESSION_CACHE_SECONDS` in
`src/lib/neon-auth.ts`). Password change and account deletion skip that cache.
The session cookie uses `SameSite=Lax`, so links clicked from an email or chat
open signed in.

### 3. Neon Object Storage (resume files)

1. On the production branch: Console → **Object storage** → **New bucket**,
   name `resumes`, access level **private**. The access level **can't be
   changed later** ([buckets](https://neon.com/docs/storage/buckets.md)); if a
   bucket was ever public, create a new private one and copy the objects.
2. Create a dedicated credential for the app with **`storage:read` and
   `storage:write`** only: Console → Settings → **Credentials** → Create
   credential (or Connect → Storage tab). The secret is shown **once**; copy it
   right away ([storage authentication](https://neon.com/docs/storage/authentication.md)).
   Credentials never expire unless you set `expires_at` (API/CLI).
3. Values:

| Variable | Value |
| --- | --- |
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT` | The production branch's storage endpoint, `https://<branch>.storage.<cluster>.us-east-2.aws.neon.tech` (Console → Connect → Storage) |
| `S3_REGION` | `us-east-2` |
| `S3_FORCE_PATH_STYLE` | `true` (required for a custom endpoint) |
| `S3_BUCKET` | `resumes` |
| `S3_ACCESS_KEY_ID` | The credential's `token_id` (starts `nak_live_`) |
| `S3_SECRET_ACCESS_KEY` | The credential's `s3_secret_access_key` (**secret**) |

`S3_KEY_PREFIX` (optional folder inside the bucket) is also read by the app and
is not needed here.

> **State at launch.** Bucket `resumes` exists, is **private** and is empty. A
> dedicated credential named `vercel-production` (scopes `storage:read` +
> `storage:write`) was created for Vercel. The original **Default object storage
> credential** still exists. Once you are happy that the app works with
> `vercel-production`, revoke the default one (destructive; your call).

**Downloads stay proxied.** The browser never receives a bucket URL: the app
checks the signed-in user, then streams the file from `/api/resumes/<id>`. This
keeps every resume private to its owner, so don't switch the bucket to
`public_read` or hand out presigned URLs. The cost is that downloads pass
through a Vercel function and count against the shared egress allowance.

**Resume uploads are capped at 4 MB** (`MAX_RESUME_MB` in `src/lib/constants.ts`).
Vercel rejects function request bodies over 4.5 MB, and the file travels in the
same request as the form.

## Vercel deploy

1. Import the GitHub repo. Framework preset: **Next.js** (defaults are right;
   `postinstall` runs `prisma generate`).
2. **Region.** Put the functions next to the database. Vercel's regions page
   lists **`cle1` (Cleveland)** as its `us-east-2` region, while new projects
   default to `iad1` (Washington, D.C.) ([regions](https://vercel.com/docs/regions),
   [function region](https://vercel.com/docs/functions/configuring-functions/region)).
   Set it in Project → Settings → **Functions** → Function Region, then
   redeploy. The exact dashboard label for Cleveland is **unverified**, and
   so is whether Hobby lets you change the region; check on screen.
3. Add the environment variables below with scope **Production only** (untick
   Preview and Development). Preview deployments then have no secrets and no
   trusted origin, which is intended. Consider marking the secrets as
   **Sensitive** (whether the `.env` import does this is unverified; check the
   dashboard).
4. Deploy, then open `/api/health`; it should return `{"status":"ok"}`.

### Environment variables

Every variable the code reads (checked against `process.env` in `src/` and
`scripts/`):

| Variable | Value and where it comes from | Secret? |
| --- | --- | --- |
| `NEON_AUTH_BASE_URL` | Production branch's Auth URL (Console → Auth → Configuration, or Settings → Better Auth → Project Info) | No |
| `NEON_AUTH_COOKIE_SECRET` | New random value, `openssl rand -base64 32` (≥ 32 characters) | **Yes** |
| `DATABASE_URL` | Pooled string (Console → Connect) with `?sslmode=require&pgbouncer=true&connect_timeout=15`, no `channel_binding` | **Yes** (has the password) |
| `DIRECT_URL` | Direct string (Console → Connect) with `?sslmode=require` | **Yes** |
| `STORAGE_DRIVER` | `s3` | No |
| `S3_ENDPOINT` | Production branch's storage endpoint (Console → Connect → Storage) | No |
| `S3_REGION` | `us-east-2` | No |
| `S3_BUCKET` | `resumes` | No |
| `S3_FORCE_PATH_STYLE` | `true` | No |
| `S3_ACCESS_KEY_ID` | Credential `token_id` (Console → Settings → Credentials, or at creation) | Treat as yes |
| `S3_SECRET_ACCESS_KEY` | Credential secret (**shown once**, at creation or rotation) | **Yes** |
| `SUPPORT_EMAIL` | Address shown on `/privacy` and `/terms` (defaults to a placeholder if unset) | No |
| `CLIENT_IP_HEADER` | Leave unset: the default `x-forwarded-for` is right on Vercel, which overwrites that header | No |
| `AI_ENABLED` | **Leave unset** (AI off) | No |
| `UPLOAD_DIR`, `S3_KEY_PREFIX`, `OLLAMA_*` | Not needed on Vercel at launch (see [Later: adding AI](#later-adding-ai) for `OLLAMA_*`) | n/a |

The app no longer reads `APP_URL`, `SMTP_*`, `EMAIL_FROM` or
`EMAIL_DAILY_LIMIT`: Neon Auth sends the codes, and nothing builds links in
emails. The public URL matters only for Neon Auth's trusted-domain list.

### Importing the variables with `.env.vercel.local`

The owner keeps a local, **gitignored** file `.env.vercel.local` (covered by the
`.env*` rule in `.gitignore`) that contains exactly these keys and nothing else:

`DATABASE_URL`, `DIRECT_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`,
`STORAGE_DRIVER`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`SUPPORT_EMAIL`.

Procedure:
1. Edit `SUPPORT_EMAIL` in the file to the address you want published.
2. Vercel → Project → Settings → **Environment Variables** → **Import .env** →
   pick the file → select **only Production** → save.
3. Delete the file: `rm .env.vercel.local`. The values now live in Vercel and
   Neon only. (Trying to back the file up elsewhere defeats the purpose.)
4. Redeploy so the new values take effect.

To **recreate the file later** (for example after a rotation), create it again
with the keys above and take each value from:

| Key | Where to find it |
| --- | --- |
| `DATABASE_URL` | Neon Console → project → production branch → **Connect**: pooled string (`-pooler` host), owner role and your database. Add `?sslmode=require&pgbouncer=true&connect_timeout=15` (no `channel_binding`) |
| `DIRECT_URL` | Same Connect dialog, direct string (no `-pooler`), ending `?sslmode=require` |
| `NEON_AUTH_BASE_URL` | Console → Auth → Configuration (Auth URL) |
| `NEON_AUTH_COOKIE_SECRET` | Generate a new one with `openssl rand -base64 32`. Sensitive values in Vercel are, as far as I know, not viewable again (**unverified**), so plan on generating a new one; that signs everyone out (see [Rotating secrets](#rotating-secrets)) |
| `STORAGE_DRIVER`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` | Fixed values from the table above |
| `S3_ENDPOINT` | Console → Connect → Storage tab |
| `S3_ACCESS_KEY_ID` | Console → Settings → Credentials (`token_id` of `vercel-production`) |
| `S3_SECRET_ACCESS_KEY` | Shown **once** when a credential is created or rotated; if lost, rotate or create a new credential |
| `SUPPORT_EMAIL` | Your choice |

If your password manager or shell history ever captures the file's contents,
treat those values as exposed and rotate them.

## Go-live

### Finalize Neon Auth (needs the live URL)

Do this as soon as the first deploy gives you the exact URL:

1. Neon Console → Auth (production branch) → Settings → Better Auth → trusted
   domains: add the **exact origin**, `https://<app>.vercel.app`: scheme
   included, no trailing slash, **no wildcard**.
2. Turn **Allow localhost off**.
3. Run the smoke test below. If sign-up fails with an origin error, the
   trusted origin doesn't match what the browser shows; fix that rather than
   re-enabling localhost.

### Smoke test (manual, on the live URL, with an inbox you can read)

- `/api/health` returns `{"status":"ok"}`.
- **Sign up**, then enter the emailed **6-digit code**; you land on the
  dashboard signed in. Also try a wrong code once. Codes live **5 minutes**,
  so enter it promptly.
- **Resume upload and download** (a small PDF); open the downloaded file.
  Confirm `/api/resumes/<id>` returns 401 when signed out.
- **Sign out, then password reset**: request a code, set a new password, sign
  in with it. Confirm a second browser that was signed in before the reset is
  signed out (revoke-on-reset). A revoked session can linger for up to 60 s
  (see Known limitations).
- **Change password** in Settings.
- **Delete account**: the app deletes your applications, resumes and files and
  ends all sessions. The Neon Auth identity record remains; see Known
  limitations.
- **AI is hidden**: no "Write with AI" button, `/api/cover-letter` returns 404,
  and `/privacy` and `/terms` don't mention AI.
- **Headers**: `curl -sI https://<app>.vercel.app/login` shows
  `Content-Security-Policy`, `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` (set in
  `next.config.ts`; HSTS is production-only).

Optional automated post-deploy check: `LIVE_BASE_URL=https://<app>.vercel.app npm run test:live`.
By default it only runs read-only checks (health, headers, AI hidden, protected
pages, a bogus session cookie). The account journey (a real signup) runs only if
you also set `LIVE_ALLOW_ACCOUNT_JOURNEY=1`, `LIVE_TEST_EMAIL` and
`LIVE_DATABASE_URL`; see the comment header in `e2e/live/smoke.spec.ts`.

### Before announcing

1. **Secrets stay out of the public repo.** Real values live only in Vercel and
   Neon. `.env*` (except `.env.example`), `.test-account.local`, `data/` and
   `backups/` are gitignored. If a real secret is ever committed or pasted
   somewhere public, treat it as leaked: rotate it first, then clean the
   history.
2. Read `/privacy` and `/terms`. They are plain-language templates matching what
   the app does, **not legal advice**; have them reviewed, and set
   `SUPPORT_EMAIL`.
3. Set up the [uptime monitor](#uptime-monitor) (read the health-check caveat
   first) and take a [backup](#backups).
4. Remove any smoke-test users you don't want to keep. The app's own "Delete
   account" removes only app data, so remove the identity itself in the Neon
   Console (the Auth section's users list; exact label unverified) or through the Neon API.

## Custom domain

The app lives at **https://www.jobapphelp.net**. The apex `jobapphelp.net` is
redirected to `www` by Vercel (Settings -> Domains), and the original
`job-apps-pi.vercel.app` address forwards to `www` from `next.config.ts`
(`LEGACY_HOSTS`, a temporary 307; make it permanent once you're sure).

What was changed to move, and what to repeat for any future move:

1. Vercel -> Project -> Settings -> Domains -> add the domain and the DNS records
   Vercel shows.
2. In Neon Auth, **add the exact origin** of every host people can reach
   (here `https://www.jobapphelp.net` and `https://jobapphelp.net`; never a
   wildcard). Keep the old origin until traffic has moved, then remove it.
   Check with a wrong-password sign-in carrying the new `Origin` header: a
   trusted origin answers `INVALID_EMAIL_OR_PASSWORD`, an untrusted one
   `INVALID_ORIGIN`.
3. Update `SUPPORT_EMAIL` in Vercel if you want an address on the new domain,
   then redeploy. Do this only once that mailbox exists.
4. Nothing else changes: there's no `APP_URL` to update. Accounts live in Neon
   Auth and aren't tied to a domain, but session cookies are host-only, so
   people sign in again on the new host.
5. Re-run the smoke test on the new origin
   (`LIVE_BASE_URL=https://www.jobapphelp.net npm run test:live`).

## Operations

### Uptime monitor

`/api/health` returns `{"status":"ok"}`, or **503** `{"status":"down"}` when the
database is unreachable. Any free monitor can poll it (UptimeRobot's free plan
is one example; its minimum interval is, as far as I know, 5 minutes,
**unverified**).

**Tension to resolve.** Today `src/app/api/health/route.ts` runs `SELECT 1`
against Postgres on every call, so each ping wakes Neon's compute, and a ping
at least every 5 minutes (the idle timeout) **keeps it awake around the
clock**. Rough estimate, assuming the 5-minute idle timeout, the smallest
compute size of 0.25 CU (**unverified**), 720 hours in a month, and ignoring real
traffic and wake-up time:

| Ping interval | Compute awake | CU-hours/month at 0.25 CU |
| --- | --- | --- |
| 5 min or less | ~100 % | ~180 (**over the 100 free**) |
| 10 min | ~50 % | ~90 |
| 15 min | ~33 % | ~60 |
| 30 min | ~17 % | ~30 |

So a continuously pinged database would **exceed the free allowance** (0.25 ×
720 = 180 > 100), and a 5-minute interval doesn't avoid that. Options:

- **Recommended follow-up (code change, not done yet):** give the health route a
  shallow mode, for example `/api/health?shallow=1`, that returns `ok` without
  touching the database. Point the 5-minute monitor at the shallow URL (is the
  app up?). Optionally add a second, infrequent monitor on the deep URL (for
  example hourly) to catch database outages. A shallow check can't see a
  database failure.
- **Or** accept that the database sleeps: use an interval of 30 minutes or
  more, or no monitor.

Until the shallow mode exists, don't point a 5-minute monitor at the plain
`/api/health`.

### Backups

What exists:

- **Neon instant restore** (Free): roll the branch back to a point in the last
  **6 hours**. Documented on Neon's plans page; **not tested by us**. Auth data
  lives in the same database (schema `neon_auth`), and a branch restore should
  roll back users and sessions along with `public` (inference, **unverified**).
- **One manual Neon snapshot** on Free. Take it before risky migrations.
  **Not tested.**
- **`scripts/backup-db.sh`**: `pg_dump --no-owner --no-privileges` of the
  database to `backups/jobapps-<timestamp>.sql.gz`, keeping the newest 14. It
  reads `DIRECT_URL` (falling back to `DATABASE_URL`) from **`./.env`**, which
  takes priority over variables already in your shell: to back up Neon, point
  `.env` at the production direct URL for the run (and put it back), or call
  `pg_dump` yourself. Use a `pg_dump` at least as new as the server's Postgres
  version. It needs a machine that is on when you run it; a scheduled GitHub
  Action is a possible later improvement (it would need the direct URL as a
  repository secret, so weigh that). Backups hold user data: keep them off
  shared drives and out of git.
- **Resume files are not in any database backup.** Copy the `resumes` bucket
  with any S3 client pointed at the branch's storage endpoint (for example
  `aws s3 sync` with `--endpoint-url`) and the same credential. **Not tested.**

**Not verified:** whether the script's dump is enough to restore a working app.
The script dumps the whole database, not only `public`, but whether the
connecting role can read everything in `neon_auth`, and whether that data
restores into a working Auth service, is **unverified**. A Neon branch restore
covers both schemas; a `pg_dump` restore is the only way to prove the dump, so
restore one into a scratch branch once (`gunzip -c … | psql "<scratch direct
url>"`) before relying on it.

### Rotating secrets

Rotate immediately after any exposure; otherwise on your own schedule. Update
the value in Vercel (Production), then **redeploy**.

| Secret | How | What breaks |
| --- | --- | --- |
| **Database role password** | Console → project → production branch → Roles & Databases → reset the owner role's password (label may differ); update `DATABASE_URL` and `DIRECT_URL` | The app can't reach the database from the moment of the reset until the redeploy. **Neon Auth keeps working** after a role-password reset (tested on a throwaway branch). Re-run the sign-in smoke test anyway |
| **Storage credential** | Console → Settings → Credentials → create a new one (or rotate); update `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`; then revoke the old one | Resume uploads and downloads fail until the redeploy. Revoking a credential is destructive: do it only after the new one works |
| **`NEON_AUTH_COOKIE_SECRET`** | New value from `openssl rand -base64 32` | Cookies signed with the old secret should stop validating, so **everyone is signed out** and has to sign in again (**unverified**; not tested). It doesn't affect stored accounts or passwords |

## Known limitations

- **Account deletion doesn't remove the Neon Auth identity.** The app deletes
  all of a user's applications, resumes and files and revokes their sessions.
  The managed delete-user call returned **404** in testing, so the email
  address, name and password hash stay in Neon Auth until removed in the Neon
  Console or through the Neon API (or support). Whether the call is meant to be
  supported is **unverified** (the docs don't say either way). The `/privacy`
  page states this and asks users to email to have the details deleted.
- **Shared email sender.** `auth@mail.myneon.app` is meant for development and
  testing and has an **undocumented rate limit**; deliverability to some
  providers may be poor. Upgrade path: custom SMTP in Neon Auth (see Email).
- **Code lifetime.** Verification and reset codes expire after **5 minutes**.
  [Neon's docs](https://neon.com/docs/auth/guides/email-verification.md) say
  15, but a test against a real Neon Auth branch measured 300 seconds, so the
  app's screens say 5. The value lives in `OTP_LIFETIME_MINUTES`
  (`src/lib/constants.ts`); if Neon changes it, change it there.
- **Signing in with an unverified address sends no code.** Neon Auth emails
  nothing on sign-in, so the app requests a fresh code itself (under the same
  per-address cap as every other email-sending form).
- **Revoked sessions.** A browser still holding a cookie for a revoked session
  (after a password reset or sign-out elsewhere) is handled without a 500; this
  was found and fixed during the real-service test.
- **Revoked sessions can linger for up to 60 s.** Ordinary page views trust the
  signed session cache for `SESSION_CACHE_SECONDS` (60 s in this app; the SDK's
  default is 300 s). Neon Auth itself checks the database on every real session
  check. Password change and account deletion always ask Neon Auth directly.
- **Per-email rate limits can be abused to annoy a known address.** Anyone who
  knows an email can use up that address's limits (4 code emails per hour, and
  the failed-login lockout of 10 failures per 15 minutes, see
  `src/lib/rate-limit.ts`), delaying the owner's sign-in or code emails for a
  while. Low severity: it blocks, it doesn't expose anything. A CAPTCHA is the
  upgrade.
- **Rate limiting trusts a client-IP header.** `CLIENT_IP_HEADER` must name a
  header your proxy *overwrites*; if a client can set it, they can dodge the
  per-IP limits (per-account limits still apply). On Vercel the default
  `x-forwarded-for` is overwritten by the platform
  ([docs](https://vercel.com/docs/headers/request-headers)). Neon Auth also has
  its own throttling that is undocumented.
- **Uploads are capped at 4 MB** (Vercel's 4.5 MB body limit).
- **Vercel Hobby is non-commercial, personal use only.**
- **Neon free-tier caps** (1 GB Postgres, 5 GB storage, 5 GB shared egress,
  100 CU-hours, 6-hour restore window) and a cold start after 5 idle minutes.
  See the monitor caveat above.
- **Health check touches the database** (see Uptime monitor).
- **CSP allows inline scripts** (`'unsafe-inline'`) because Next's bootstrap
  scripts are inline and the legal pages are static. Everything else in the
  policy is strict. A nonce-based CSP would require rendering every page
  dynamically.
- **Tests don't exercise the real Neon Auth.** The e2e suite uses a mock that
  mirrors behavior checked against a Neon branch; the live service is covered
  only by the smoke test above.
- **`npm audit` reported 3 high-severity findings in `deepmerge-ts`** (not
  re-run for this document), reached only through the Prisma CLI's config loader
  (build/deploy time, never request handling). The suggested fix was a breaking
  Prisma 7 upgrade; revisit it when you next upgrade Prisma deliberately.
- Limits in this document come from provider pages checked Nov 2026 and will
  drift.

## Later: adding AI

Set `AI_ENABLED=true` plus the `OLLAMA_*` variables (see `.env.example`) and
redeploy. The model runs on **hardware you control** with Ollama (free only if
you already own it), so the web app must be able to reach it. The privacy and
terms pages start describing AI automatically.

- **Ollama on your machine, app on Vercel.** Expose Ollama through a Cloudflare
  Tunnel protected by **Cloudflare Access service-token** auth. Set
  `OLLAMA_BASE_URL` to the tunnel URL and send the token headers via
  `OLLAMA_EXTRA_HEADERS='{"CF-Access-Client-Id":"…","CF-Access-Client-Secret":"…"}'`.
  **Never expose an unauthenticated Ollama to the internet.** A stable tunnel
  hostname needs a domain on Cloudflare. Drafts are unavailable while your
  machine is off (users see a clear "unavailable" message; everything else
  works). The route allows up to 300 s (`maxDuration` in
  `src/app/api/cover-letter/route.ts`), matching Hobby's limit; the default
  `OLLAMA_TIMEOUT_MS` is 240 s.
- **Self-hosting the whole app on the Ollama machine** (`npm run build && npm
  start`, `STORAGE_DRIVER=local` with `UPLOAD_DIR` backed up,
  `CLIENT_IP_HEADER=cf-connecting-ip` behind Cloudflare Tunnel) still needs
  Neon Auth (`NEON_AUTH_*` and a trusted origin for the tunnel hostname) and a
  Postgres for app data. **Not tested.**
- Scanned PDFs and legacy `.doc` resumes can be stored but not read by the AI;
  the draft is written without resume text and the user is told so. By default
  only one draft runs at a time (`OLLAMA_MAX_CONCURRENCY=1`); others queue
  briefly and then get a "busy" message.
