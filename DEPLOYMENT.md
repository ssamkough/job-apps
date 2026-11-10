# Deployment

Everything here can run on free tiers. Limits below were checked against each
provider's own docs in **November 2026**; providers change them, so re-check
the linked page when you sign up.

## Free-tier limits (read this first)

### Email: the one with real constraints

The app sends two kinds of email: **verification** (once per signup, plus
resends) and **password reset**. Each costs one send. `EMAIL_DAILY_LIMIT`
makes the app stop sending a little *under* your provider's cap and show users
a clear "try again tomorrow" instead of the provider rejecting mail.

| Provider | Free limit | What happens at the limit | Gotchas |
| --- | --- | --- | --- |
| **Brevo** (recommended) | **300/day**, no monthly cap, no expiry, no card ([source](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)) | Up to 1,000 extra transactional emails wait in a retry queue; beyond that they're dropped | Free-plan emails carry a "Sent with Brevo" sticker (can't be removed on Free). You must verify a sender; see domain note below |
| **Resend** | **100/day and 3,000/month**, hard cap, no overage ([source](https://resend.com/docs/knowledge-base/resend-sending-limits)) | API returns 429 `daily_quota_exceeded` / `monthly_quota_exceeded` | Daily window resets at 00:00 UTC. Sent *and received* mail count. Multiple recipients count separately |
| **SMTP2GO** | **200/day and 1,000/month**; only 25/hour until a sender domain is verified ([source](https://support.smtp2go.com/hc/en-gb/articles/223087947-Free-Plan)) | Daily overflow is queued to the next day; **monthly overflow is rejected, not queued** | Prohibits cold email (opt-in only). 5 days of logs |

**What this means for you, concretely:**

- Signups drive almost all volume (about 1 to 2 emails each, plus resets).
  At **Brevo's 300/day** you can absorb roughly 150 to 250 new users a day
  before the cap bites. At **Resend's 100/day** it's more like 50 to 80.
- **Set `EMAIL_DAILY_LIMIT` below the cap:** Brevo `270`, Resend `90`
  (the default; 90 × 31 stays under 3,000/month), SMTP2GO `30` (1,000/month ÷ 31).
- **The app only enforces a *daily* cap.** Monthly caps (Resend 3,000, SMTP2GO
  1,000) are enforced by the provider, and hitting them makes sends fail until
  the month rolls over. Choosing Brevo avoids this entirely.
- When the cap is hit, signup still works (the account is created and the user
  is signed in) but the verification email isn't sent; they can retry from
  Settings the next day. Password reset shows "can't send email right now".
- Watch your provider dashboard for the first weeks. If you outgrow the free
  tier, the cheapest step is a paid plan (Brevo Starter has no daily limit; its
  tiers start at 5,000 emails/month).
- **You need a domain you control** to send reliably. Free mail addresses
  (`@gmail.com`) as the From address will be rejected or land in spam because
  of DKIM/DMARC. A domain costs money (about $10/year), so the one truly
  non-free item is a domain. Without one, use a throwaway mailbox only for
  testing, and expect poor deliverability.

### Everything else

| Service | Free allowance | Caveat for this app |
| --- | --- | --- |
| **Neon** Postgres ([source](https://neon.com/faqs/free-plan-limits-and-quotas)) | 100 CU-hours compute/project/month, **1 GB storage/project**, 5 GB transfer/month, no card | Compute **sleeps after 5 minutes idle** (first request after a nap is slower; can't be disabled on Free). When CU-hours run out, the DB is suspended until next month; data is kept. 1 GB holds many thousands of applications (resume *files* live elsewhere) |
| **Cloudflare R2** files ([source](https://developers.cloudflare.com/r2/pricing/)) | 10 GB, 1M writes, 10M reads/month, free egress | **A payment method is required to enable R2**, even though you're only charged if you exceed the free tier. If that's a dealbreaker, use Backblaze B2 or self-host with `STORAGE_DRIVER=local` |
| **Vercel Hobby** ([source](https://vercel.com/docs/limits/fair-use-guidelines)) | 1M function invocations, 4 hours active CPU, 100 GB transfer/month; functions up to 300 s | **Non-commercial, personal use only.** If this app earns money or you're paid to run it, you need Pro. Waiting on the AI is I/O, not "active CPU", so it doesn't burn the 4 hours |
| **Ollama** (self-run) | Free (your hardware and electricity) | Only works while your machine is on and reachable; see below |
| **Cloudflare Tunnel** | Free | Needs a Cloudflare account (and a domain on Cloudflare for a stable hostname) |

## Where does the AI run?

The model runs on **your machine** with Ollama, so the web app must be able to
reach it. Pick one layout:

### A. Self-host everything on the Ollama machine (simplest, fully free)

Run the Next.js app, Postgres and Ollama on one computer and expose the app
with a Cloudflare Tunnel. No Neon, R2 or Vercel needed.

```bash
npm ci && npx prisma migrate deploy && npm run build
APP_URL=https://jobs.example.com NODE_ENV=production npm start   # use pm2/systemd to keep it up
```

- `STORAGE_DRIVER=local`, `UPLOAD_DIR=/var/lib/jobapps/uploads` (back this up).
- `CLIENT_IP_HEADER=cf-connecting-ip` when behind Cloudflare Tunnel.
- Ollama stays on `127.0.0.1:11434`, never exposed.
- The site is only up while this machine is. Back up with `scripts/backup-db.sh`
  (cron it) **and** copy `UPLOAD_DIR`.

### B. App on Vercel + Neon + R2, Ollama on your machine via a tunnel

- Expose Ollama through a Cloudflare Tunnel protected by **Cloudflare Access
  service-token** auth; set `OLLAMA_BASE_URL` to the tunnel URL and send the
  token headers via `OLLAMA_EXTRA_HEADERS='{"CF-Access-Client-Id":"…","CF-Access-Client-Secret":"…"}'`.
  **Never expose an unauthenticated Ollama to the internet.**
- `STORAGE_DRIVER=s3` with your R2/B2 credentials (the disk is ephemeral on Vercel).
- Neon: `DATABASE_URL` = pooled host (`-pooler`), `DIRECT_URL` = direct host.
  Add `?connect_timeout=15` to tolerate the wake-up delay.
- Hobby is non-commercial (see above). AI drafts are unavailable when your
  machine is off (users see a clear "unavailable" message; everything else works).
- `CLIENT_IP_HEADER` can stay `x-forwarded-for` on Vercel.

## Go-live checklist

1. **Keep secrets out of the (public) repo.** Real values live only in your
   host's environment settings, never in git. `.env`, `.test-account.local`,
   `data/`, and `backups/` are gitignored; only `.env.example` (placeholders)
   is committed. If a real secret is ever committed, treat it as leaked:
   rotate it first, then clean the history.
2. Set environment variables (see `.env.example`). Required in production:
   `APP_URL`, `DATABASE_URL`, `DIRECT_URL`, SMTP settings (`SMTP_HOST`,
   `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`), `SUPPORT_EMAIL`. The app refuses to
   send mail in production without SMTP, and refuses to build links without `APP_URL`.
3. `npx prisma migrate deploy` against the production database (never
   `migrate reset`/`dev` there).
4. Verify the email domain's SPF/DKIM/DMARC in your provider's dashboard.
5. Sign up with a real address, confirm the email arrives and the link works,
   then test password reset and an AI draft.
6. Point an uptime monitor (e.g. UptimeRobot free) at `/api/health`
   (returns `{"status":"ok"}` or 503).
7. Read `/privacy` and `/terms`. They're plain-language templates matching what
   the app does, **not legal advice**; have them reviewed, and set `SUPPORT_EMAIL`.
8. Schedule `scripts/backup-db.sh` and test a restore once.
9. Confirm HTTPS only. Headers (CSP, HSTS, frame-ancestors, nosniff) are set by
   `next.config.ts`; HSTS applies only in production over HTTPS.

## Known limitations

- **Rate limiting trusts a client-IP header.** Only point `CLIENT_IP_HEADER` at
  a header your proxy *overwrites*. If a client can set it, they can dodge
  per-IP limits (per-account limits still apply). Behind nginx use
  `proxy_set_header X-Forwarded-For $remote_addr;` (overwrite, not append).
- **CSP allows inline scripts** (`'unsafe-inline'`) because Next's bootstrap
  scripts are inline and the legal pages are static. Everything else in the
  policy is strict. A nonce-based CSP would require rendering every page dynamically.
- **Scanned PDFs and legacy `.doc` resumes can be stored but not read by the AI**;
  the draft is written without resume text and the user is told so.
- **One AI draft at a time** by default (`OLLAMA_MAX_CONCURRENCY=1`); others
  queue briefly and then get a "busy" message. Raise it only if your hardware allows.
- **`npm audit` reports 3 high-severity findings in `deepmerge-ts`,** reached
  only through the Prisma CLI's config loader (build/deploy time, never request
  handling). The suggested fix is a breaking Prisma 7 upgrade; revisit it when
  you next upgrade Prisma deliberately.
- Limits in this document come from provider pages checked Nov 2026 and will drift.
