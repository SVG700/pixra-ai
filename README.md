# PIXRA AI — WhatsApp-native AI design agency (prototype)

A customer messages a WhatsApp number asking for a poster. The AI chats to collect the details,
writes a brief, generates the poster, checks it with AI vision, a human approves it in the admin
portal, and the final poster is sent back on WhatsApp. Target: delivered within **3 hours**.

```
WhatsApp ──► /webhook (signature-verified) ──► intake agent (Gemini) ──► brief ──► customer says YES
   ──► job (deadline +3h) ──► Gemini writes a no-text image prompt ──► FLUX (Cloudflare) makes 2 backgrounds
   ──► our canvas code draws ALL text + logo on 2 templates ──► Gemini vision QA ──► pending_review
   ──► admin approves in /admin ──► poster sent on WhatsApp ──► customer replies with changes ──► revision
```

Customers can use **WhatsApp**, **Telegram** or a password-protected **web chat** (`/demo`).
Everything uses free tiers: Meta WhatsApp Cloud API (test number), Telegram Bot API, Google Gemini (AI Studio),
Cloudflare Workers AI (FLUX + Whisper), Supabase (Postgres + Storage) and Render (hosting).

- Setup and accounts: **[MANUAL_STEPS.md](MANUAL_STEPS.md)**
- 5-minute demo walkthrough: **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)**

---

## 1. Quick start (no accounts needed — MOCK mode)

Requires Node.js 22 (`package.json` pins `22.x`, same as Render; Node 24 also works locally).
In PowerShell, in this folder:

```powershell
npm install
copy .env.example .env      # skip if .env already exists; MOCK_MODE=true needs no keys
npm start
```

| URL | What |
|---|---|
| http://localhost:3000/dev/chat | Chat with the bot as a fake customer (text, images, voice notes). Posters show inline. |
| http://localhost:3000/demo | Customer web demo chat (needs `DEMO_PASSWORD` in `.env`; see "Web demo mode"). |
| http://localhost:3000/admin | Admin portal (password = `ADMIN_PASSWORD` in `.env`). |
| http://localhost:3000/health | Service modes (`real`/`mock`/`missing`) + canvas/ffmpeg self-test. |

Try it in the dev chat:
1. Say *hi* and answer the questions, then reply *YES*.
2. In the admin portal, click **Approve & Send**. The poster appears in the chat.
3. Reply *change headline to Mega Sale*, then approve the new version.

```powershell
npm test                     # 140 automated tests (node:test)
npm run samples              # render example posters into samples/
npm run doctor               # check your real API keys (after filling .env)
npm run doctor -- --prod     # check EVERY production requirement before deploying
npm run telegram:set-webhook -- https://<service>.onrender.com   # register the Telegram webhook
npm run dev                  # auto-restart on file changes
```

## 2. Modes

| `.env` | Behaviour |
|---|---|
| `MOCK_MODE=true` (dev only) | Every external service is mocked: rule-based "Gemini", gradient backgrounds, fixed voice transcript, local JSON database (`data/db.json`) and files in `uploads/`. No WhatsApp calls. |
| `MOCK_MODE=false`, `DEV_MODE=true` | **Supabase is required**: the app exits if it is missing or unreachable, and never falls back to the JSON file. Other services with keys are real; those without keys fall back to mocks (with a warning). `/dev` simulator on. |
| Production: `NODE_ENV=production`, or `MOCK_MODE=false` + `DEV_MODE=false` | Every requirement is checked at startup (section 6); the app **refuses to start** if anything is missing. `/dev/*` returns 404. |

Simulated customers (from `/dev/chat`) are never messaged on WhatsApp.

### Web demo mode (`WHATSAPP_ENABLED=false`) — deploy before WhatsApp is ready

`WHATSAPP_ENABLED=false` swaps WhatsApp for a password-protected customer chat in the browser.
Everything else stays the same: the real AI, the real Supabase, and the admin portal.

| What | In web demo mode |
|---|---|
| Customer chat | **`/demo`**. Customers sign in with their **name, phone number** and the shared **`DEMO_PASSWORD`** (12+ chars, not common, different from `ADMIN_PASSWORD`). The chat supports text, **voice notes** (record in the browser or upload a file), and **images/logos** (caption "logo"). The poster is delivered into the chat with a download link. |
| Limits | 5 failed demo logins per IP per 15 min. `DEMO_RATE_LIMIT_PER_10MIN` (40) messages/uploads per IP. |
| Privacy | Each signed-in customer only sees their own chat. The demo cookie is signed, `HttpOnly`, `SameSite=Strict`, `Path=/demo`, `Secure` in production, and can never open `/admin`. |
| `/webhook` | Answers **503 "WhatsApp not configured"**. |
| `/dev/*` | Still 404 in production. |
| Startup checks | **Only** the `WHATSAPP_*` variables are skipped. Supabase, a strong `ADMIN_PASSWORD`, `SESSION_SECRET`, Gemini/Cloudflare keys, secure cookies and "no JSON fallback" stay enforced, and `DEMO_PASSWORD` becomes required. |
| Admin portal | Shows the banner **"WhatsApp not connected - web demo mode"**. **Approve & Send** delivers into the customer's `/demo` chat. **Send test poster** delivers into the `/demo` chat of the number you enter. |

Delivery is decided by each customer's **channel** (`whatsapp`, `web` or `dev`), stored on the
customer row. Web demo customers are stored as `web:<number>`, so they never clash with WhatsApp
numbers.

### Switching to WhatsApp later (no code change)

1. Finish the Meta setup (MANUAL_STEPS D 11–18).
2. On Render → your service → **Environment**, set:
   - `WHATSAPP_ENABLED` = `true`
   - `WHATSAPP_TOKEN` = the permanent System User token (step 17)
   - `WHATSAPP_PHONE_NUMBER_ID` = the test number's Phone number ID (step 12)
   - `WHATSAPP_VERIFY_TOKEN` = a random string you invent (step 14)
   - `WHATSAPP_APP_SECRET` = Meta app → Settings → Basic → App secret (step 18)
   - Save, and Render redeploys.
3. In Meta → WhatsApp → **Configuration** → Webhook → **Edit**:
   - Callback URL **`https://<service>.onrender.com/webhook`**
   - Verify token = the same `WHATSAPP_VERIFY_TOKEN`
   - **Verify and save**, then subscribe to the **messages** field.
4. Check `/health`: `"whatsapp": "real"`. The banner disappears.
   - New WhatsApp customers are answered on WhatsApp.
   - Existing `/demo` customers keep using `/demo`, which stays available while `DEMO_PASSWORD`
     is set. Remove `DEMO_PASSWORD` to switch `/demo` off.

### Telegram channel (`TELEGRAM_ENABLED=true`) — the demo channel while WhatsApp is blocked

Customers chat with your Telegram bot. It's the same intake, brief, YES, generation, QA, admin
approval and revision flow; only the channel adapter (`src/services/telegram/`) is new.

| What | How |
|---|---|
| Identity | Telegram **chat id**, stored as `tg:<chat id>` with `channel = 'telegram'`. **`/start`** greets the customer and asks their **name**, then the normal intake asks the business name and the rest. No phone number is needed. Returning customers skip the name. |
| Messages | Text, **voice notes** (OGG/Opus, using the same Whisper + ffmpeg WAV fallback), **photos** and **image documents** (logos; caption "logo"). Media is downloaded with `getFile`. Group chats, edits and stickers are ignored or politely declined. |
| Delivery | An approved poster goes out as **`sendPhoto`** (with the "want any changes?" caption), plus **`sendDocument`** for the full-quality file. Revisions work as on the other channels. |
| Inbound (production) | `POST /telegram/webhook`. The `X-Telegram-Bot-Api-Secret-Token` header must equal `TELEGRAM_WEBHOOK_SECRET` (compared in constant time), otherwise the request gets **401**. It answers 200 immediately, processes in the background, and **deduplicates by `update_id`**. Rate limited, and returns 503 when Telegram is disabled. Register it with `npm run telegram:set-webhook -- https://<service>.onrender.com`. |
| Inbound (local) | With `DEV_MODE=true` the app uses **long polling** (`getUpdates`), so no tunnel is needed. Starting it **removes** any registered webhook; after local testing, run `telegram:set-webhook` again. |
| Security | The bot token appears only in Bot API URLs and is never logged (`bot[redacted]`). Chat ids are masked in logs (`tg:XXXXX6789`). Startup checks require `TELEGRAM_BOT_TOKEN` and a 32+ character `TELEGRAM_WEBHOOK_SECRET` **only when** `TELEGRAM_ENABLED=true`. |
| Admin | Jobs and customers show "Telegram chat ..1234 · Telegram". **Send test poster** can target any Telegram customer. |

The WhatsApp code path is unchanged. Delivery is chosen per customer by `channel`
(`whatsapp` | `telegram` | `web` | `dev`).

### Background image providers: Cloudflare and Hugging Face

| `IMAGE_PROVIDER` | Poster backgrounds come from |
|---|---|
| `cloudflare` (default) | Cloudflare Workers AI, `@cf/black-forest-labs/flux-1-schnell` |
| `huggingface` | Hugging Face **Inference Providers**, `HF_IMAGE_MODEL` (default `black-forest-labs/FLUX.1-schnell`) |
| `compare` | Option 1 from Hugging Face, option 2 from Cloudflare, for side-by-side quality comparison |

- **Same contract for both providers:** prompt in, text-free background out, then the same canvas
  text, QA, approval and revisions. `src/services/images/` is the only new code; the Cloudflare
  path is unchanged.
- **Routed through Hugging Face** with the official `@huggingface/inference` client, so the
  account's monthly credits apply. `HF_INFERENCE_PROVIDER=auto` uses the first provider in your
  [HF settings](https://hf.co/settings/inference-providers) order. Today `FLUX.1-schnell` is live on
  **nscale**, **fal-ai** and **wavespeed**. `HF_BILL_TO=<org>` sends `X-HF-Bill-To`, for when the
  credits belong to an organization.
- **Fallback:** if Hugging Face fails, Cloudflare makes that background instead and the reason is
  stored. That covers out of credits (402), quota/rate limit (429), bad token or missing permission
  (401/403), model unavailable (404/410), or timeout (`HF_TIMEOUT_MS`).
  - The portal shows e.g. **"Background: Cloudflare (fallback: HF out of credits)"**, otherwise
    **"Background: Hugging Face / black-forest-labs/FLUX.1-schnell (via nscale)"**.
  - After **out of credits**, Hugging Face is **paused until the next day (IST)** instead of being
    retried for every poster.
  - Requests are never retried on Hugging Face, so a failure costs no extra credit.
  - Set `IMAGE_FALLBACK_ENABLED=false` to surface the error instead.
- **Reject & Regenerate** can force Hugging Face or Cloudflare for that one round.
- **No `HF_TOKEN`:** the app works normally on Cloudflare. `/health` and `npm run doctor` say
  "Hugging Face not configured (optional)". The token is never logged (`hf_[redacted]`).
- **Switching to a PRO token** (Vaibhav's) is an env change only. See MANUAL_STEPS section H.

**Cost notes (check the providers' current pricing):**

| | Cloudflare Workers AI | Hugging Face Inference Providers |
|---|---|---|
| Included | Free daily "neurons" allowance; one FLUX schnell image uses a small fraction | **Free account: $0 included** (credits must be purchased). **PRO: $2.00/month** of compute credits. Team/Enterprise: $2.00 per seat. |
| Per poster job | 2 images (one per template) | `compare` uses 1 HF image per job; `huggingface` uses 2 |
| When it runs out | Jobs fail with "daily quota reached" until the next day | Falls back to Cloudflare and pauses HF until the next day |
| Where to see usage | Cloudflare dashboard → Workers AI | https://huggingface.co/settings/billing and https://huggingface.co/settings/inference-providers/overview (not exposed by the API for personal accounts) |

## 3. Going live — setup steps

The exact clicks are in **[MANUAL_STEPS.md](MANUAL_STEPS.md)**. In short:

1. **Supabase**. Create a free project, then apply the schema with the CLI (`npx supabase login`,
   `npx supabase link --project-ref <ref>`, `npx supabase db push --linked`). The migration in
   `supabase/migrations/` is a copy of `schema.sql`, which you can also paste into the SQL editor.
   It creates the tables and the public `posters` bucket. Set `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` (the legacy `service_role` JWT or a new `sb_secret_…` key; both
   work).
2. **Gemini**. Create a key at https://aistudio.google.com/apikey and set `GEMINI_API_KEY`.
   `npm run doctor` lists the models your key can use and suggests `GEMINI_MODEL` and
   `GEMINI_FALLBACK_MODEL`.
3. **Cloudflare Workers AI**. Set `CF_ACCOUNT_ID`, and create a token from the "Workers AI" template
   for `CF_API_TOKEN`.
4. **Meta WhatsApp Cloud API** (skip for now with `WHATSAPP_ENABLED=false` and use web demo mode):
   - Create a Business app with WhatsApp.
   - From API Setup, take the test number's **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`,
     and a token → `WHATSAPP_TOKEN`. Add your phone as an allowed recipient.
   - Invent `WHATSAPP_VERIFY_TOKEN`.
   - Copy the **App secret** → `WHATSAPP_APP_SECRET`. This is **required**: unsigned webhooks get
     401.
   - Create a permanent System User token (MANUAL_STEPS 17).
5. Run `npm run doctor`. It checks every key and names the step to fix.
6. **Run locally with a tunnel**:
   - Run `npm start`, and in a second window `cloudflared tunnel --url http://localhost:3000`.
   - Put the printed URL in `PUBLIC_BASE_URL` and restart.
   - In Meta → WhatsApp → Configuration, set the Callback URL to `<url>/webhook` and the verify
     token, and subscribe to **messages**.
7. **Deploy on Render**:
   - Run `npm run doctor -- --prod` with your production values.
   - Push to GitHub, then Render → New → **Blueprint** (uses `render.yaml`).
   - Fill the secrets, and check that `/health` shows `"ready": true` and `"selfTest": {"status": "ok"}`.
   - Point the Meta webhook at `https://<service>.onrender.com/webhook`.

## 4. How posters are made (the core rule)

- The image model (FLUX) only makes a **background with no text**. All text and the logo are drawn
  by our code (`@napi-rs/canvas`), so spelling is always exact.
- Two templates: **Bold headline top** and **Centered card**. Two sizes: square 1080×1080 and
  portrait 1080×1350.
- Text auto-shrinks to fit its box. A dark scrim is added automatically (stronger on bright
  backgrounds), and logos sit on a white badge.
- Fonts: Montserrat + Inter, bundled in `fonts/` (SIL OFL). They are committed to git, so Render
  gets them.
- Each job makes 2 options, and each is QA-checked by Gemini vision (score 0–10, required text
  present, readability issues, notes).
- Versions are **never overwritten**.

## 5. Customer experience (WhatsApp)

- The bot asks one short question at a time. The fields are business name, purpose, headline,
  details, date/time (or N/A), contact/CTA, size, style, and logo (optional; *SKIP*).
- **Voice notes** (OGG/Opus) are transcribed with Whisper:
  - If Whisper rejects the original file or returns nothing, the app converts it to 16 kHz WAV with
    the bundled ffmpeg (`ffmpeg-static`) and retries once.
  - If that also fails, the customer is politely asked to type instead.
- **Images:** an image captioned "logo", or sent when the bot asked for the logo, becomes the logo.
  Returning customers aren't asked again for their business name or logo.
- **Brief:** *YES* confirms the brief (with the delivery time in IST); anything else is treated as
  a change.
- **After delivery**, the customer can reply:
  - with a text change, which is re-rendered on the same background;
  - with a visual change, which gets new backgrounds;
  - *DONE* if they're happy, or *NEW* for another poster.
- *RESTART* or *NEW* works at any time.

## 6. Security & production safety

| What | How |
|---|---|
| Webhook authenticity | Every `POST /webhook` must carry `X-Hub-Signature-256`: an HMAC-SHA256 of the **raw** request body with `WHATSAPP_APP_SECRET`, compared in constant time. Invalid, missing or malformed signatures get 401 and a log line. The raw-body parser is mounted before `express.json()`. |
| Dev-only skip | `WEBHOOK_SKIP_SIGNATURE=true` skips the check **only** when `MOCK_MODE` or `DEV_MODE` is true, and is ignored in production. |
| Simulator | Every `/dev/*` route is a hard 404 unless `DEV_MODE=true`, and always 404 in production. |
| Database | Never falls back to the local JSON file when `MOCK_MODE=false` or in production. The app exits if Supabase is missing or the startup ping fails (Render's free disk is wiped on restart). |
| Startup refusal (production) | Refuses to start if any of these are missing: Supabase, WhatsApp token / phone number ID / verify token / app secret, Gemini key, Cloudflare keys, or a `SESSION_SECRET` of at least 32 characters. Also refuses if `MOCK_MODE=true`, or if `ADMIN_PASSWORD` is missing, under 12 characters, or a common/default password. `npm run doctor -- --prod` shows the same list. |
| Admin session | HMAC-signed cookie: `HttpOnly`, `SameSite=Strict`, `Path=/admin`, and `Secure` in production. |
| Rate limits | Admin login: 5 failed attempts per IP per 15 minutes (`ADMIN_LOGIN_MAX_ATTEMPTS`). Webhook: 600 requests/min per IP (`WEBHOOK_RATE_LIMIT_PER_MIN`); excess requests get 429. |
| Logs | Phone numbers are masked (`91XXXXXX1234`) in every line, including message previews and errors. Configured secret values (tokens, keys, passwords) are replaced with `[redacted]`. |
| Git | `.env`, `.env.*` (except `.env.example`), `data/`, `uploads/` and logs are ignored. The history was scanned and contains no keys. |

## 7. Admin portal (`/admin`)

- **Jobs list**: customer, business, status, time left (red when under 30 minutes), assignee, and a
  live activity line, for example *⚙ Generating background 1 of 2*, *⏳ queued (1 ahead)* or
  *⏳ waiting: rate limit (Gemini)*. Refreshes every 30 seconds.
- **Job page** shows the brief, the chat history, every version with its QA report, and errors.
  Actions:
  - Approve & Send
  - Reject & Regenerate (with a note)
  - Edit Text (same background)
  - Assign to
  - Upload a replacement (optionally send it)
  - Retry, for failed jobs
- **Live status, so a job never looks stuck.** While a job runs, the page refreshes every 4 seconds
  and shows one of:
  - the current step;
  - its queue position (jobs run one at a time to stay inside free quotas);
  - or, when a free-tier rate limit is hit, a banner like *"Waiting for Gemini free-tier rate limit
    (HTTP 429). Automatic retry 2 of 4 at 4:05:12 PM. Nothing to do; this is not stuck."*
  - If the limit outlasts the retries, the job fails with *"Free-tier rate limit / daily quota
    reached … click Retry"*.
- **Send test poster** (header button): sends an already approved poster to a chosen test number
  without touching any job. Use it to show delivery in a demo when generation is slow.
  `DEMO_TEST_NUMBERS` can restrict which numbers are allowed.

## 8. Reliability

- **Webhook:** replies 200 immediately and processes in the background.
  - Messages are deduplicated by WhatsApp message id, in memory and with a unique DB column.
  - Status callbacks are ignored, and each customer's messages are handled in order.
  - If handling a message crashes, the customer gets a short apology instead of silence.
- **HTTP calls:** Gemini, Cloudflare and Graph API calls retry with exponential backoff on 429/5xx
  and respect `Retry-After`.
- **Gemini:**
  - JSON is parsed leniently, with one "fix your JSON" retry.
  - If `GEMINI_MODEL` is not found, or still rate-limited after retries, `GEMINI_FALLBACK_MODEL`
    is used. A missing primary model is skipped from then on.
  - If Gemini is unavailable entirely, intake and revision triage fall back to built-in rules.
- **Generation:**
  - If both poster options fail, the job is marked `failed` and the error is shown with a Retry
    button. If only one fails, the other still goes to review.
  - Jobs left mid-flight are resumed on startup, which matters on the Render free tier.
- **Logs:** every line carries the job id (`[job:1a2b3c4d]`).
- **WhatsApp errors** are explained in plain words: the 24-hour window, a recipient not on the
  allowed list, an expired token, or an image WhatsApp couldn't fetch.
- **Self-test:** at startup the app renders a test poster and runs ffmpeg. The result is in
  `/health → selfTest` and the log, so you can confirm canvas and ffmpeg work on Render, where the
  free plan has no shell.

## 9. Free-tier limits to know

| Service | Limit (check the provider's current numbers) | Effect |
|---|---|---|
| **Render free web service** | Sleeps after ~15 min idle; cold start ~30–60 s. Disk wiped on restart. | The first message after idle may be slow; Meta retries the webhook. Open `/health` before a demo to wake it. |
| **Meta test number** | Can only message up to **5 verified recipient numbers**. | Add each tester under API Setup → "To". |
| **WhatsApp 24-hour window** | Free-form messages (including the poster) only within 24 h of the customer's last message. | Delivery outside the window fails with a clear error. Ask the customer to message first, then re-send. |
| **Gemini free tier** | Per-minute and per-day request caps per model. | One poster uses ~10–15 calls. The portal shows rate-limit waits; the fallback model and built-in rules keep chat working. |
| **Cloudflare Workers AI free** | Daily "neurons" allowance. | 2 FLUX images per job, plus Whisper for voice. If you run out, jobs fail with a "daily quota reached" explanation; Retry the next day. |
| **Supabase free** | 500 MB DB, 1 GB storage; pauses after ~1 week idle. | Un-pause in the dashboard; the app refuses to start while it is unreachable. |

## 10. Project layout

```
src/
  server.js            startup checks → listen → self-test → resume stuck jobs
  app.js               express app (testable)        config.js   all env vars      logger.js   masked logs
  routes/              webhook.js (raw body + HMAC) · telegram.js (secret-token webhook) · admin.js · demo.js · dev.js · health.js
  pipeline/            inbound.js · transcribe.js (Whisper + ffmpeg retry) · conversation.js · jobs.js
                       (generate → QA → review, live activity) · review.js · revisions.js · outbound.js
  services/            select.js · whatsapp/ · telegram/ (api, parse, updates, poller, mock) · gemini/ (gemini.js, models.js, mock.js, prompts.js)
                       cloudflare/ · poster/ · db/ (supabase.js | local-json.js)
  templates/           bold-top.js · centered-card.js
  views/               EJS: admin/* (jobs, job, demo, login), dev-chat
  lib/                 startup-checks.js · deploy-checks.js · self-test.js · rate-limit.js · session.js
                       job-context.js · audio.js · brief.js · json.js · http.js · time.js
fonts/  samples/  tests/ (+ fixtures/sample-voice.ogg)  scripts/ (doctor.js, make-samples.js)
schema.sql · supabase/ (CLI config + migration) · render.yaml · .env.example · .nvmrc · MANUAL_STEPS.md · DEMO_SCRIPT.md
```

## 11. Troubleshooting

- **The app exits at start with "REFUSING TO START"** → the log lists every missing or weak setting.
  Run `npm run doctor -- --prod`.
- **Webhook POSTs get 401** → `WHATSAPP_APP_SECRET` is missing or wrong (Meta app → Settings →
  Basic → App secret).
- **The webhook doesn't verify** → `WHATSAPP_VERIFY_TOKEN` must match, and the app must be
  reachable (tunnel running, Render awake).
- **No reply on WhatsApp** → check that the **messages** webhook field is subscribed and your
  number is an allowed recipient. Then look for `<- text:` in the log.
- **Voice notes always fail** → check `/health → selfTest.ffmpeg`. If ffmpeg is missing, run
  `npm install` again (`ffmpeg-static` downloads its binary at install) or set `FFMPEG_PATH`.
- **Jobs fail with a "model not found" error** → run `npm run doctor`, which suggests a valid Flash
  model, and set `GEMINI_FALLBACK_MODEL`.
- **The portal shows "Waiting for … rate limit"** → nothing is broken. The free tier is
  throttling, and the job continues automatically.
