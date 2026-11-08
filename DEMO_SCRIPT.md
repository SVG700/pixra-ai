# PIXRA AI — 5-minute demo script

**Story to tell:** "A small business owner orders a professional poster just by chatting on WhatsApp.
AI does the design work, a human designer approves it, and it's delivered back on WhatsApp within
3 hours. Today it'll take about 3 minutes."

You need:
- **your phone**, with WhatsApp, on the test number's allowed list;
- **a laptop** with the admin portal open: `https://<service>.onrender.com/admin`, or `http://localhost:3000/admin`
  locally.

If you're projecting, mirror the phone screen, or just hold the phone up when the poster arrives.

> **No WhatsApp available?** Run the same script in the browser simulator at `/dev/chat`. That
> needs local `DEV_MODE=true`; it's disabled on Render. It shows the same conversation and poster.

---

## Current setup: demo on Telegram, with the `/demo` web chat as backup

While WhatsApp is blocked, the **customer side of the demo is your Telegram bot**. Everything in the
script below is the same; read "WhatsApp" as "Telegram".

- **Story line:** "Customers order by chatting with our bot. Today that's Telegram, while our WhatsApp
  number is being approved. It's the same AI and the same flow, and WhatsApp is just a switch."
- **Start:** on the demo phone open the bot (search its @username) and tap **Start**, or send
  `/start`. The bot greets you and asks your **name**, then your business name and the rest of the
  questions.
- **Voice note:** hold the microphone button in Telegram and speak (for example the offer details).
  It's transcribed automatically.
- **Logo:** send the logo as a photo with the caption "logo". Sending it as a *file* keeps full
  quality.
- **Delivery:** after **Approve & Send** in the portal, the poster arrives as a photo with the
  feedback question, followed by the **full-quality file**.
- **Revision:** reply e.g. "change the date to 5 Nov". The new version shows up in the portal;
  approve it and it arrives in Telegram.

**10 minutes before (Telegram):**
1. Open `/health`. Check `"telegram": "real"`, `"ready": true` and `"selfTest": {"status": "ok"}`.
2. Run `npm run telegram:set-webhook -- --info`. It must show the Render webhook URL with no recent
   error.
3. Send `/start` to the bot once, to check it answers. If it was asleep, wait ~30 s.
4. Have one poster already **delivered** to your Telegram chat for the backup below.

| Telegram problem | What to do |
|---|---|
| Bot doesn't answer at all | Render was asleep: wait 30–60 s, since Telegram retries. Still nothing? Run `npm run telegram:set-webhook -- --info`. If the URL is empty (for example after a local test), run `npm run telegram:set-webhook -- https://<service>.onrender.com`. |
| `--info` shows "last error: …401" | `TELEGRAM_WEBHOOK_SECRET` on Render differs from your `.env`. Copy the same value to Render, then re-run set-webhook. |
| Telegram not possible at all (no network, blocked app) | Switch to the **`/demo` web chat** (next section). It's the same flow in the browser. |
| Generation is slow | **Send test poster** → choose your Telegram name in "Send to a Telegram customer". |

## Backup: web demo mode (`/demo` in the browser)

On Render the app runs with `WHATSAPP_ENABLED=false`, so besides Telegram there is the **`/demo`** page.
The rest of the script is identical. Wherever it says "phone" or "WhatsApp", use the `/demo` chat:

- **Customer screen:** open `https://<service>.onrender.com/demo` on your phone's browser, or in a
  second browser window. Sign in with a **name**, a **phone number** and the **demo password**
  (`DEMO_PASSWORD`).
- **Story line:** "This chat page stands in for WhatsApp until our WhatsApp number is approved. It's
  the same AI and the same flow. Switching is just a setting."
- **Voice note:** tap **Voice** to record and **Stop** to send. The browser asks for microphone
  permission the first time, so allow it before the demo.
- **Logo:** tap **Image**, pick the logo, and type "logo" in the message box first. It's sent as the
  image's caption.
- **Delivery:** after **Approve & Send** in the admin portal, the poster appears in the `/demo` chat
  within about 2 seconds, with a **Download poster** link.
- **Before the demo**, in addition to the steps below: sign in to `/demo` once with the demo phone
  number, so the **Send test poster** backup can target it.

| Web demo problem | What to do |
|---|---|
| "Wrong demo password" / "Too many attempts" | Check `DEMO_PASSWORD` in Render → Environment. After 5 failed tries an IP is blocked for 15 minutes, so use another network or wait. |
| "You are sending messages too fast" | The per-IP message limit was hit (`DEMO_RATE_LIMIT_PER_10MIN`, default 40). Wait a few minutes. |
| Voice button missing or "Microphone not available" | The chat switches to a **File** button. Upload a short audio file instead, or type. |

## 10 minutes before

1. Open `/health` in the browser. This wakes the Render free server, which sleeps after ~15 min
   idle. Check `"ready": true` and `"selfTest": {"status": "ok"}`.
2. From the demo phone, send **hi** to the test number, then reply **NEW**. This opens WhatsApp's
   24-hour window and resets the chat.
3. Log in to the admin portal.
4. Make sure at least one poster is already **delivered**. You'll need it for the backup in step 6.
5. Keep this page open with the answers below, ready to copy.

## The demo (about 5 minutes)

| Time | You do | You say |
|---|---|---|
| 0:00 | Show the phone with the WhatsApp chat open. | "This is a customer: a café owner who needs a poster. No app, no website, just WhatsApp." |
| 0:20 | Type **Hi, I need a poster for my café** | "An AI assistant replies and asks one simple question at a time." |
| 0:40 | Answer the questions with the lines below. Send one answer as a **voice note** to show off. | "Customers can type or just speak. Voice notes are transcribed automatically." |
| 2:00 | The bot shows the **brief summary**. Reply **YES**. | "It writes a design brief and asks the customer to confirm. Here's the promised delivery time." |
| 2:15 | Switch to the **admin portal** jobs list and click the new job. | "This is our designers' dashboard. The job has a 3-hour deadline countdown." |
| 2:30 | The job page shows live steps: *Writing the image prompt… Generating background 1 of 2…* | "The AI paints a background image with no text. Then our software adds all the text and the logo, so spelling is always perfect." |
| 3:15 | Two poster options appear with **QA scores**. | "A second AI checks each poster: is all the text there, is it readable? A human still makes the final call." |
| 3:30 | Click **Approve & Send** on the best one and confirm. | "One click, and it's sent to the customer." |
| 3:45 | Show the phone: the poster has arrived. | "Delivered on WhatsApp." |
| 4:00 | On the phone, reply **change the date to 5 Nov** | "Changes are just a message. Text changes are re-done in seconds, and we never lose old versions." |
| 4:30 | In the portal, the new version appears. Approve & Send. | "Version 3, approved and delivered." |
| 5:00 | Wrap up. | "Everything you saw runs on free tiers. The target is any poster within 3 hours, with a human in the loop." |

### Answers to paste (café example)

1. Business name: **Chai Point Cafe**
2. Purpose: **Weekend coffee offer**
3. Headline: **Buy 1 Get 1 Free**
4. Details: **On all coffees and iced teas, Saturday and Sunday** (or say it as a voice note)
5. Date/time: **25-26 Oct, 8 AM to 8 PM**
6. Contact: **Order on WhatsApp 98765 43210**
7. Size: **portrait**
8. Style: **warm brown and cream, cosy**
9. Logo: **SKIP** (or send a logo image with the caption "logo")

The AI may combine or reorder questions; just answer what it asks.

---

## If something goes wrong live

| What you see | What to do | What to say |
|---|---|---|
| The bot doesn't reply within ~20 s | The server is probably waking up. Wait 30 s; Meta retries the message automatically. Still nothing? Send **hi** again. | "Free servers take a moment to wake up." |
| The portal job shows **⏳ Waiting for … rate limit** | Nothing; it retries by itself and the banner shows when. Keep talking. If it takes too long, use the **backup** below. | "We're on free AI quotas, so it's queuing politely. In production that's a paid tier." |
| Job shows **failed** (e.g. "daily quota reached") | Click **Retry**. If it fails again, use the **backup** below. | "This is the safety net: the designer sees exactly what failed and can retry." |
| Generation is just slow | Use the **backup** below, and come back to the job later. | "While that renders, here's one we made earlier." |
| Poster approved but **not delivered**, with an error about 24 hours | The phone hasn't messaged in 24 h. Send **hi** from the phone, then click Approve & Send again. | "WhatsApp only lets businesses reply within 24 hours of a message. That's a privacy rule." |
| Error "not in allowed list" | The phone isn't a verified recipient of the test number (MANUAL_STEPS step 13). Use the simulator instead. | — |
| A voice note isn't understood | The bot politely asks the customer to type, so type the answer. | "It falls back to text gracefully." |
| Can't log in to the portal ("Too many attempts") | Wait 15 minutes, or log in from another network. Keep the password handy beforehand. | — |
| Everything is down | Show the **samples/** folder posters and walk through the flow verbally. | — |

### Backup: "Send test poster"

In the admin portal, click **Send test poster** (top right). Enter the demo phone number, pick an
already approved poster, and press **Send**. The poster arrives on the phone within seconds, with no
AI generation involved. It doesn't change any job.
