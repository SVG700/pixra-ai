# MANUAL_STEPS — things only you can do

Everything here needs your accounts or a browser login. Claude never needs to see the values:
put them **only** in your local `.env` file (and later in Render's Environment tab).

Legend: **[P1]**…**[P5]** = the phase that first needs this step. ✅ = tick when done.

> Edit `.env` with any text editor, e.g. `notepad .env` in PowerShell from the project folder.
> After changing `.env`, restart the server (Ctrl+C, then `npm start`).

---

## A. Supabase (database + poster storage) — [P1]

> ✅ **Done for project `pixra-ai` (ref `rcxgrctyhmnylkdsklqe`) via the CLI on 8 Nov 2026:** `npx supabase login`,
> `npx supabase link --project-ref rcxgrctyhmnylkdsklqe`, `npx supabase db push --linked` (migration in
> `supabase/migrations/`), all 6 tables + public `posters` bucket verified. `SUPABASE_URL` and the
> `sb_secret_…` key are set on Render; to run locally against this project, copy them into your `.env` too.
> The manual dashboard steps below are only needed for a *different* project.

1. ☐ Go to https://supabase.com → **Sign in** → **New project**.
   - Name: `pixra-ai`; set a database password (save it in your password manager; the app doesn't need it).
   - Region: **South Asia (Mumbai)** (closest to IST customers). Plan: **Free**. → **Create new project** and wait ~2 min.
2. ☐ Left sidebar → **SQL Editor** → **New query**. Open `schema.sql` from this folder, copy **all** of it,
   paste, click **Run**. You should see "Success. No rows returned".
3. ☐ Left sidebar → **Storage**: check that a bucket named **posters** exists and shows a **Public** badge.
   (schema.sql creates it. If it's missing: **New bucket** → name `posters` → turn **Public bucket** ON → Create.)
4. ☐ Left sidebar → **Project Settings** (gear) → **Data API** → copy **Project URL**
   → `.env`: `SUPABASE_URL=https://xxxx.supabase.co`
5. ☐ **Project Settings → API Keys** → copy the **service_role** key (on the "Legacy API keys" tab, click **Reveal**)
   *or* a **Secret key** (`sb_secret_...`) from the new API keys tab — either works.
   → `.env`: `SUPABASE_SERVICE_ROLE_KEY=...`
   ⚠️ This key bypasses all security. Never paste it into chat, a browser page, or a git commit.
6. ☐ Run `npm run doctor` — the Supabase section should show two ✔.
   Then in `.env` set `MOCK_MODE=false` (keep `DEV_MODE=true` so services without keys still use mocks), restart.
   ⚠️ With `MOCK_MODE=false` Supabase is **required**: if the URL/key is missing or wrong, the app prints
   "REFUSING TO START" and exits (it never silently falls back to the local JSON file). Then
   and open http://localhost:3000/health — `"db": "real"` means it's connected. Messages you send via
   http://localhost:3000/dev/chat should now appear in Supabase → **Table Editor → messages**, and posters in
   **Storage → posters → jobs/**.

## B. Google Gemini API key — [P2]

7. ☐ Go to https://aistudio.google.com/apikey → sign in with a Google account → **Create API key**
   (pick or create a Google Cloud project when asked). Copy it.
   → `.env`: `GEMINI_API_KEY=...`
7b. ☐ Run `npm run doctor`. The Gemini section lists the models your key can use and checks `GEMINI_MODEL`
    and `GEMINI_FALLBACK_MODEL` (defaults `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`). If it says a model is
    NOT available, copy its `suggestion:` line into `.env`.

## C. Cloudflare Workers AI (image generation + voice-note transcription) — [P2] Whisper, [P3] FLUX

8. ☐ Sign up / log in at https://dash.cloudflare.com (free plan; no domain needed).
9. ☐ Copy your **Account ID**: on the account home page, click the **⋮** menu next to the account name → **Copy account ID**
   (or it's the long hex string in the URL `dash.cloudflare.com/<ACCOUNT_ID>/...`).
   → `.env`: `CF_ACCOUNT_ID=...`
10. ☐ Top-right profile icon → **My Profile** → **API Tokens** → **Create Token** → find the **Workers AI** template → **Use template**
    → (Account Resources: your account) → **Continue to summary** → **Create Token**. Copy it (shown once).
    → `.env`: `CF_API_TOKEN=...`
10b. ☐ Run `npm run doctor` (Gemini + Cloudflare sections should be ✔). To also test one real FLUX image:
    `npm run doctor -- --image` → look at `samples/doctor-flux-test.jpg`.

## D. Meta WhatsApp Cloud API (test number) — [P1] webhook test, [P2]+ real chats

11. ☐ Go to https://developers.facebook.com → **My Apps** → **Create App**.
    - Use case: **Connect with customers through WhatsApp** (or "Other" → type **Business**). Name: `PIXRA AI`.
    - Link/create a **Business portfolio** when asked → **Create app**.
12. ☐ In the app: left menu **WhatsApp → API Setup**.
    - Copy **Phone number ID** (under the test "From" number) → `.env`: `WHATSAPP_PHONE_NUMBER_ID=...`
    - Click **Generate access token** and copy it → `.env`: `WHATSAPP_TOKEN=...`
      (this temporary token expires in ~24 h; step 17 replaces it with a permanent one).
13. ☐ Still on API Setup, under **To** → **Manage phone number list** → add **your own WhatsApp number**
    and enter the code WhatsApp sends you. (The test number can only message up to 5 verified numbers.)
    Use **Send message** on that page once to confirm a "hello_world" template arrives on your phone.
14. ☐ Invent a random verify token (e.g. `pixra-` + random letters) → `.env`: `WHATSAPP_VERIFY_TOKEN=...`
15. ☐ Get a public URL for your local server (needed so Meta can reach your laptop):
    ```powershell
    winget install --id Cloudflare.cloudflared
    ```
    Close & reopen PowerShell, start the app (`npm start`), then in a **second** window:
    ```powershell
    cloudflared tunnel --url http://localhost:3000
    ```
    Copy the `https://<random>.trycloudflare.com` URL it prints → `.env`: `PUBLIC_BASE_URL=https://<random>.trycloudflare.com`
    and restart `npm start`. (The URL changes every time you restart cloudflared — repeat steps 15–16 then.)
16. ☐ **Do step 18 first** (app secret) — every webhook POST is signature-checked, and without
    `WHATSAPP_APP_SECRET` all incoming messages are rejected with 401.
    In the Meta app: **WhatsApp → Configuration** → Webhook → **Edit**:
    - Callback URL: `https://<random>.trycloudflare.com/webhook`
    - Verify token: the same value as `WHATSAPP_VERIFY_TOKEN` → **Verify and save**.
    - Then under **Webhook fields** → **Manage** → subscribe to **messages** → Done.
    Now send "hi" from your phone to the test number: the server log shows `<- text: hi` and you get a reply.
17. ☐ **Permanent token** (so you don't regenerate every day) — [P4/P5, before deploying]:
    - Go to https://business.facebook.com → **Settings** (gear) → **Users → System users** → **Add** →
      name `pixra-bot`, role **Admin** → Create.
    - Select it → **Assign assets** → **Apps** → your app → **Full control**; also **WhatsApp accounts** →
      your test WhatsApp account → **Full control** → Save.
    - **Generate new token** → app: your app → expiration **Never** → permissions:
      `whatsapp_business_messaging` and `whatsapp_business_management` → Generate. Copy it.
      → `.env` (and later Render): `WHATSAPP_TOKEN=...`
18. ☐ **Required.** Meta app → **App settings → Basic** → **App secret** → **Show** (asks for your Facebook
    password) → copy → `.env`: `WHATSAPP_APP_SECRET=...`. The app verifies `X-Hub-Signature-256` on every
    webhook POST with it and rejects anything unsigned or wrong (401, logged as "webhook rejected").
    (Dev-only escape hatch: `WEBHOOK_SKIP_SIGNATURE=true` works only while `MOCK_MODE`/`DEV_MODE` is true.)

## T. Telegram bot (demo channel while WhatsApp is blocked)

T1. ☐ In Telegram, open **@BotFather** (blue tick) → send `/newbot` → choose a display name (e.g. `PIXRA AI`) and a
    username ending in `bot` (e.g. `pixra_poster_bot`). BotFather replies with a **token** like `123456789:AA…`.
    → `.env`: `TELEGRAM_BOT_TOKEN=...` (keep it secret; if it ever leaks: BotFather → /revoke).
    Optional: `/setdescription` and `/setuserpic` in BotFather to make the bot look nice for the demo.
T2. ☐ `TELEGRAM_WEBHOOK_SECRET` is already generated in your local `.env` (48 random characters). Use the **same**
    value on Render (step 23). `TELEGRAM_ENABLED=true` is already set locally.
T3. ☐ Local test (no tunnel needed - long polling): run `npm run doctor` (Telegram section should show "token works -
    bot @…"), then start the app in real mode and send **/start** to your bot from your phone. Claude can run this for you.
    ⚠️ Local polling removes any registered webhook; after local testing run step 25b again.
T4. ☐ Production (after the Render deploy, step 25b): `npm run telegram:set-webhook -- https://<service>.onrender.com`
    → registers `https://<service>.onrender.com/telegram/webhook` with the secret. Check with
    `npm run telegram:set-webhook -- --info`.

## H. Hugging Face images (optional second image provider)

H1. ☐ **Token**: https://huggingface.co/settings/tokens → **Create new token** → **Fine-grained** → name `pixra-images` →
    under *Inference* tick **"Make calls to Inference Providers"** → Create → copy it into `.env`: `HF_TOKEN=hf_...`
    (never paste it in chat). Then `npm run doctor` → section "Hugging Face images" must show "token works" and
    "model … is live on: …".
H2. ☐ **Credits**: a FREE account has **no included credits** - Hugging Face answers *402 out of credits* and the app
    falls back to Cloudflare. Either buy a few dollars of credits at https://huggingface.co/settings/billing or use a
    **PRO** token ($2.00/month included). Usage: https://huggingface.co/settings/inference-providers/overview
H3. ☐ **Choose the mode** in `.env` (and on Render → Environment): `IMAGE_PROVIDER=compare` for the side-by-side demo
    (v1 Hugging Face, v2 Cloudflare), `huggingface` for both, `cloudflare` to switch HF off.
H4. ☐ Test: `npm run doctor -- --image` (makes ONE Hugging Face image -> `samples/doctor-hf-test.jpg`).

### H5. Switching to Vaibhav's Hugging Face PRO token (no code change)

**Locally** - open `.env`, change, save, restart the app:
| Line | New value |
|---|---|
| `HF_TOKEN=` | Vaibhav's PRO token (fine-grained, "Make calls to Inference Providers") - **replace** the free one |
| `HF_BILL_TO=` | leave **empty** if the PRO credits are on Vaibhav's personal account; set to the **organization name** if the credits belong to an org (Vaibhav's token must be a member - doctor checks it) |
| `IMAGE_PROVIDER=` | `compare` (demo) or `huggingface` |
Then run `npm run doctor -- --image`: it must say "token works - account … (PRO)" and generate one image.

**On Render** - service `pixra-ai` → **Environment** → edit:
| Variable | Value |
|---|---|
| `HF_TOKEN` | Vaibhav's PRO token (same as local) |
| `HF_BILL_TO` | empty, or the org name (same as local) |
| `IMAGE_PROVIDER` | `compare` or `huggingface` |
→ **Save Changes** (Render redeploys, ~2-4 min) → open `https://<service>.onrender.com/health` →
`"images": {"provider": "compare", "huggingface": {"state": "ready"}}`.
If Hugging Face was paused after the free token ran out of credits, the redeploy clears the pause.

## E. Admin portal — [P4]

19. ☐ `.env` already has a random `ADMIN_PASSWORD` and `SESSION_SECRET` generated for local use.
    For production (Render) choose a **new** password: at least **12 characters** and not a common/default
    word (e.g. `admin`, `password`, `changeme`) — otherwise the app refuses to start. Login is limited to
    5 failed attempts per IP per 15 minutes.
19b. ☐ (Optional, for demos) `DEMO_TEST_NUMBERS=919876543210,...` — limits the portal's **Send test poster**
    button to these numbers. They must also be allowed recipients (step 13).
19c. ☐ **Web demo mode** (while WhatsApp is blocked): choose a **DEMO_PASSWORD** that customers/testers type at
    `/demo` — at least 12 characters, not a common word, and **different from ADMIN_PASSWORD**. Locally, `.env`
    already has a random one plus `WHATSAPP_ENABLED=false`. For Render pick a new one (step 22).

## F. GitHub + Render deployment (web demo mode) — [P5]

You deploy with `WHATSAPP_ENABLED=false` (set by `render.yaml`), so **no Meta/WhatsApp values are needed**.

20. ☐ **Check before pushing** (Claude can run this for you once the Gemini/Cloudflare keys are in `.env`):
    ```powershell
    $env:NODE_ENV='production'; $env:MOCK_MODE='false'; $env:DEV_MODE='false'; $env:WHATSAPP_ENABLED='false'; npm run doctor -- --prod
    ```
    It must end with **"All production checks passed."** Then close that PowerShell window (the `$env:` values only
    live in that window; your `.env` is unchanged).
21. ☐ **Create the private GitHub repo**: https://github.com/new → Repository name `pixra-ai` → select **Private** →
    do **not** tick "Add a README", ".gitignore" or "license" → **Create repository**. Copy the HTTPS URL it shows
    (`https://github.com/<your-user>/pixra-ai.git`).
22. ☐ **Push** (PowerShell, in this project folder). First create the local repo (`git init`, `git add .`, `git commit -m "PIXRA AI initial import"`):
    ```powershell
    git status
    git remote add origin https://github.com/<your-user>/pixra-ai.git
    git branch -M main
    git push -u origin main
    ```
    `git status` must say "nothing to commit". The first push opens a GitHub sign-in window (Git Credential
    Manager) — sign in there. Afterwards open the repo page and check that **no `.env` file** is listed.
23. ☐ **Render Blueprint**: https://dashboard.render.com → sign in (GitHub login is easiest) → **New +** → **Blueprint**
    → **Connect GitHub** / "Configure account" → give Render access to **only** the `pixra-ai` repo → select it →
    Blueprint name `pixra-ai` → Render reads `render.yaml` and shows the variables to fill:

    | Variable | Value |
    |---|---|
    | `GEMINI_API_KEY` | from your `.env` |
    | `CF_ACCOUNT_ID` | from your `.env` |
    | `CF_API_TOKEN` | from your `.env` |
    | `SUPABASE_URL` | `https://rcxgrctyhmnylkdsklqe.supabase.co` |
    | `SUPABASE_SERVICE_ROLE_KEY` | from your `.env` (the `sb_secret_…` key) |
    | `ADMIN_PASSWORD` | a **new** password, 12+ characters |
    | `DEMO_PASSWORD` | a **new** password, 12+ characters, different from ADMIN_PASSWORD |
    | `TELEGRAM_BOT_TOKEN` | from your `.env` (BotFather token) |
    | `TELEGRAM_WEBHOOK_SECRET` | from your `.env` - must be the **same** value |
    | `HF_TOKEN`, `HF_BILL_TO` | optional - leave empty to use Cloudflare only (section H) |
    | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | **leave empty** (web demo mode) |
    | `PUBLIC_BASE_URL`, `DEMO_TEST_NUMBERS` | leave empty |

    Everything else (`NODE_ENV=production`, `MOCK_MODE=false`, `DEV_MODE=false`, `WHATSAPP_ENABLED=false`, model
    names, a random `SESSION_SECRET`) comes from `render.yaml`. → **Apply** / **Deploy Blueprint**.
    (If Render refuses an empty WhatsApp field, type `unused` — it is ignored while `WHATSAPP_ENABLED=false`.)
24. ☐ Wait for **Live** (first build ~3–5 min). If the log says **"REFUSING TO START"**, it lists exactly which
    variable is missing or weak — fix it under **Environment** (Render redeploys automatically).
    Open `https://<service>.onrender.com/health` and check `"ready": true`, `"whatsapp": "disabled"`, the other
    services `"real"`, and `"selfTest": {"status": "ok"}` (canvas + fonts + ffmpeg work on Render's Linux).
25b. ☐ **Register the Telegram webhook** (from your PC, in this folder):
    ```powershell
    npm run telegram:set-webhook -- https://<service>.onrender.com
    ```
    It prints `✔ webhook set to https://<service>.onrender.com/telegram/webhook`. Then send /start to the bot.
    (Don't run the app locally with polling afterwards - that removes the webhook; just re-run this command if you do.)
25. ☐ Try it: `https://<service>.onrender.com/demo` (name + phone + DEMO_PASSWORD) → make a poster → approve it in
    `https://<service>.onrender.com/admin` (banner "WhatsApp not connected - web demo mode") → poster appears in the
    `/demo` chat. 🎉

### F2. Switching to WhatsApp later (no code change)

25b. ☐ Do D 11–18 (Meta app, test number, permanent token, app secret).
25c. ☐ Render → service → **Environment**: set `WHATSAPP_ENABLED=true`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
     `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` → **Save** (redeploys).
25d. ☐ Meta → WhatsApp → **Configuration** → Webhook → **Edit**: Callback URL **`https://<service>.onrender.com/webhook`**,
     Verify token = `WHATSAPP_VERIFY_TOKEN` → **Verify and save** → Webhook fields → subscribe **messages**.
25e. ☐ `/health` shows `"whatsapp": "real"`; send "hi" to the test number. `/demo` keeps working while
     `DEMO_PASSWORD` is set — delete that variable to turn `/demo` off.

## G. Demo prep

26. ☐ Read **DEMO_SCRIPT.md** (it covers both web demo mode and WhatsApp). Before the demo: open `/health` (wakes
    Render), sign in to `/demo` once with the demo phone number, and make sure at least one poster is already
    **delivered** so the **Send test poster** fallback has something to send.

---

### Which phase needs what

| Phase | To test with real services, do |
|---|---|
| P1 (setup, DB, webhook) | A (1–6), D (11–16) |
| P2 (intake, voice notes) | B (7), C (8–10b) |
| P3 (posters + QA) | C (already done) |
| P4 (admin + delivery) | E (19), D 17–18 |
| P5 (deploy) | F (20–25), G (26); WhatsApp later: F2 |

### Suggested order (all code is built)

1. **A → B → C**, running `npm run doctor` after each. Then set `MOCK_MODE=false` and do a full poster in
   http://localhost:3000/dev/chat. You'll see real AI chat, real FLUX backgrounds and real QA, with no WhatsApp yet.
2. **D 11–16 + 18** (tunnel, webhook, app secret) → chat from your phone, approve in http://localhost:3000/admin, and receive the poster.
3. **D 17, F** → `npm run doctor -- --prod`, then deploy to Render. **G** before any demo.

### Test checklist with real WhatsApp

- ☐ Text chat → brief → YES → "final review" message → approve in portal → poster arrives on phone
- ☐ Send a voice note → bot understands it (if Whisper rejects WhatsApp's OGG, the log shows "converting to WAV and retrying")
- ☐ Send your logo with caption "logo" → it appears on the poster
- ☐ After delivery reply "change the date to …" → new version re-rendered → approve → arrives
- ☐ Reply "make the background more colourful" → new backgrounds → approve → arrives
- ☐ Reply "NEW" → returning-customer flow (not asked for business name/logo again)
- ☐ Portal → **Send test poster** to your own number → arrives
