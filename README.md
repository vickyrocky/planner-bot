# Planner bot

A private Telegram planner that runs free on Cloudflare Workers.

- **7:00 AM**: shows your open tasks and asks for today's plan.
- **10:00 PM**: night review. Mark each task ✅ Done or ⏳ Not yet.
- **Any time**: send tasks as a normal message, one per line. The bot saves them encrypted, deletes your message, and replies only with codes (for example `K7, M2`).
- Tap a **🔒 code** to see the real text in a popup. Nothing readable stays in the chat.
- Done tasks disappear from every list. Tasks left as "Not yet" show up again the next morning.

**Cost:** free. One person's use fits easily in Cloudflare's free tier.

---

## Architecture

```
 ┌────────────────────┐                        ┌──────────────────────────┐
 │   YOU (phone /     │                        │        TELEGRAM          │
 │   Telegram app)    │◀──── messages ─────────│   (Bot API servers)      │
 │                    │───── texts, taps ─────▶│        your bot          │
 └────────────────────┘                        └───────┬──────────▲───────┘
                                                       │          │
                                      webhook POST     │          │  sendMessage /
                                      + secret header  │          │  editMessageText /
                                                       ▼          │  deleteMessage /
 ┌─────────────────────────────── CLOUDFLARE (free tier) ─────────┴────────────────┐
 │                                                                                 │
 │   ┌──────────────────┐        ┌──────────────────────────────────────────────┐  │
 │   │  Cron Triggers   │──────▶ │          WORKER  (src/index.js)              │  │
 │   │  01:30 UTC  7 AM │        │                                              │  │
 │   │  16:30 UTC 10 PM │        │  fetch()      → /webhook  (your messages)    │  │
 │   └──────────────────┘        │                 /setup    (one-time setup)   │  │
 │                               │  scheduled()  → morning / night list         │  │
 │   ┌──────────────────┐        │                                              │  │
 │   │ Secrets          │──────▶ │  encrypt()/decrypt()  AES-256-GCM            │  │
 │   │ BOT_TOKEN        │        │  allowedChatId()      only you get through   │  │
 │   │ ENC_KEY          │        └───────────────────────┬──────────────────────┘  │
 │   │ WEBHOOK_SECRET   │                                │ SQL                     │
 │   │ ALLOWED_CHAT_ID  │                                ▼                         │
 │   └──────────────────┘        ┌──────────────────────────────────────────────┐  │
 │                               │  D1 DATABASE  (planner-db)                   │  │
 │                               │  tasks: id │ code │ enc (ciphertext) │ status│  │
 │                               │  meta : list_msg → id of current list msg    │  │
 │                               └──────────────────────────────────────────────┘  │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

| Part | Role |
|---|---|
| **Telegram** | Carries messages between you and the bot |
| **Worker** | The bot's logic. Runs only when you send something or a scheduled time arrives |
| **Cron Triggers** | Wake the Worker at 7 AM and 10 PM |
| **D1** | Stores tasks. The text is encrypted, so the database only holds ciphertext and codes |
| **Secrets** | Stored by Cloudflare, never in the code |

### Adding tasks during the day

```
 You                     Telegram                  Worker                        D1
  │  "call bank\ngym"       │                        │                            │
  │────────────────────────▶│── POST /webhook ──────▶│                            │
  │                         │   + secret header      │ 1. secret header OK?       │
  │                         │                        │ 2. chat id == yours?       │
  │                         │                        │ 3. split into lines        │
  │                         │                        │ 4. make codes  K7, M2      │
  │                         │                        │ 5. encrypt each line       │
  │                         │                        │── INSERT (code, enc) ─────▶│
  │                         │◀── deleteMessage ──────│ 6. remove your plain text  │
  │  (your msg vanishes)    │                        │                            │
  │◀── "➕ Added 2: K7, M2"─│◀── sendMessage ────────│                            │
```

### Scheduled messages (7 AM and 10 PM)

```
 Cron (01:30 / 16:30 UTC)
        │
        ▼
 Worker.scheduled()
        │  which cron fired?  ──  matches MORNING_CRON ? ──┬── yes → MORNING mode
        │                                                  └── no  → NIGHT mode
        ▼
 SELECT open tasks from D1
        │
        ▼
 Build the message:
 ┌────────────────────────────────┐      ┌────────────────────────────────────────┐
 │ ☀️ Good morning!               │      │ 🌙 Night review                        │
 │ Open tasks: 2                  │      │ Open tasks: 2                          │
 │ What's the plan for today?     │      │                                        │
 │ [🔒 K7] [✅ Done]              │      │ [🔒 K7] [✅ Done] [⏳ Not yet]         │
 │ [🔒 M2] [✅ Done]              │      │ [🔒 M2] [✅ Done] [⏳ Not yet]         │
 │ [👁 Reveal all]                │      │ [👁 Reveal all]                        │
 └────────────────────────────────┘      └────────────────────────────────────────┘
        │
        ▼
 Send the new list → delete the previous list → remember the new one's id (meta)
 (morning also: permanently delete tasks closed more than 7 days ago)
```

### Tapping buttons

```
                        You tap a button
                               │
       ┌───────────────┬───────┴───────┬────────────────┐
       ▼               ▼               ▼                ▼
   🔒 K7           👁 Reveal all    ✅ Done          ⏳ Not yet
       │               │               │                │
  decrypt task    decrypt every   status='done'    nothing changes
       │          task in list    in D1            in D1
       ▼               │               │                │
  popup alert ◀────────┘               └───────┬────────┘
  (≤190 chars)                                 ▼
  — or —                         edit the list message and remove
  temp message, deleted after    that row; when no rows are left:
  20 s (longer text)             "All reviewed" / "No open tasks"
```

### A task's lifecycle

```
   you send text
        │
        ▼
   ┌─────────┐   ✅ Done    ┌─────────┐   7 days later   ┌───────────┐
   │  OPEN   │─────────────▶│  DONE   │─────────────────▶│  DELETED  │
   │ (K7)    │◀─────────────│ (hidden)│  (morning purge) │ (gone)    │
   └─────────┘    /undo     └─────────┘                  └───────────┘
     │    ▲
     └────┘  ⏳ Not yet → stays open, appears again next morning
```

### Privacy layers

| What someone could see | What protects it |
|---|---|
| Lock-screen notification | Shows only codes like `K7`. Also turn off message previews in Telegram |
| Chat history on the phone | Your typed message is deleted, and the real text shows only in popups |
| Telegram app opened by someone else | Telegram Passcode Lock |
| Someone else messaging your bot | `ALLOWED_CHAT_ID`: the bot ignores everyone but you |
| Fake requests to the Worker URL | `WEBHOOK_SECRET` header: other requests are rejected with 403 |
| Cloudflare database | Task text is AES-256-GCM encrypted with `ENC_KEY` |
| Secrets in this repo | They live in `.dev.vars` and `wrangler.toml`, which git ignores |

The one gap: Telegram's servers see what you type before the bot deletes it, because bot chats aren't end-to-end encrypted. If that matters, type short aliases instead of full details.

---

## Project files

| File | Purpose |
|---|---|
| `src/index.js` | All the bot logic |
| `schema.sql` | Database tables |
| `wrangler.example.toml` | Cloudflare config template. Copy it to `wrangler.toml` (git-ignored) |
| `.dev.vars.example` | Secrets template. Copy it to `.dev.vars` (git-ignored) |

---

## Setup

The commands are for **PowerShell** on Windows. Run them inside the project folder.

### 1. Install Node.js (one time)

Download the **LTS** installer from https://nodejs.org, or run `winget install OpenJS.NodeJS.LTS`. Then reopen your terminal and check that it works:

```powershell
node --version
```

### 2. Create the Telegram bot

1. In Telegram, open **@BotFather** (check for the blue verified tick) and send `/newbot`.
2. Pick a name and a username. Use something neutral.
3. Copy the **token** it gives you (it looks like `123456:ABC-xyz...`). Keep it private.

### 3. Create a Cloudflare account

1. Sign up for free at https://dash.cloudflare.com/sign-up and **verify your email**. Workers are blocked until you do.
2. In the dashboard, open **Workers & Pages** and choose your **workers.dev subdomain**. Use a neutral name, because it's part of the bot's public URL.

### 4. Get the code and log in

```powershell
git clone <this-repo-url> planner-bot
cd planner-bot
npm install
npx wrangler login
```

A browser window opens. Approve the access within about a minute.

### 5. Create the config and the database

```powershell
Copy-Item wrangler.example.toml wrangler.toml
npx wrangler d1 create planner-db
```

It prints a `database_id`. Open `wrangler.toml` and replace `PASTE_DATABASE_ID_HERE` with it. Then create the tables:

```powershell
npx wrangler d1 execute planner-db --remote --file=schema.sql
```

### 6. Create your secrets file

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Generate two random keys:

```powershell
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$a = New-Object byte[] 32; $rng.GetBytes($a)
$b = New-Object byte[] 24; $rng.GetBytes($b)
"ENC_KEY=" + [Convert]::ToBase64String($a)
"WEBHOOK_SECRET=" + (-join ($b | ForEach-Object { $_.ToString('x2') }))
```

Fill in `.dev.vars`:
- `BOT_TOKEN`: the token from BotFather.
- `ENC_KEY` and `WEBHOOK_SECRET`: the two values printed above.
- Delete the `ALLOWED_CHAT_ID=` line for now. You'll add it in step 9.

> **Back up `ENC_KEY`** in a password manager. Without it, your saved tasks can't be decrypted.

### 7. Deploy and upload the secrets

```powershell
npx wrangler deploy
npx wrangler secret bulk .dev.vars
```

`deploy` prints your Worker URL, for example `https://planner-bot.<your-subdomain>.workers.dev`.

### 8. Connect Telegram to the Worker

Open this in your browser:

```
https://planner-bot.<your-subdomain>.workers.dev/setup?key=<WEBHOOK_SECRET>
```

You should see `"ok":true` twice.

### 9. Lock the bot to your account

1. In Telegram, open your bot and send `/start`. It replies with **your chat ID**.
2. Add `ALLOWED_CHAT_ID=<your chat ID>` to `.dev.vars` and upload it:
   ```powershell
   npx wrangler secret bulk .dev.vars
   ```
3. Send `/start` again. You should now see the help message.

From now on the bot ignores everyone else.

### 10. Test it

1. Send a few tasks, one per line. Your message disappears and the bot replies `➕ Added 3: …`.
2. Send `/open` and tap a 🔒 code. The real text appears in a popup.
3. Send `/review` and tap ✅ Done on one task. It disappears.
4. Send `/morning` to preview the 7 AM message.

---

## Daily use

| You do | Bot does |
|---|---|
| Send lines of text | Adds each line as a task and replies with its code |
| `/open` | Shows open tasks |
| `/review` | Starts the night review now |
| `/undo` | Reopens the last task you marked done |
| `/help` | Shows help |

Any message that doesn't start with `/` becomes a task. Only one task list is kept in the chat: each new list replaces the previous one.

### Recommended Telegram privacy settings

- **Settings → Notifications → Private chats → Message preview: off.**
- **Settings → Privacy and Security → Passcode Lock: on.**

## Changing the times

Cron times in `wrangler.toml` are **UTC**. The defaults are for India (IST = UTC+5:30):

| Local time (IST) | UTC | Cron |
|---|---|---|
| 7:00 AM | 01:30 | `30 1 * * *` |
| 10:00 PM | 16:30 | `30 16 * * *` |

The format is `minute hour * * *`. If you change the morning time, set `MORNING_CRON` to the same string. Then run `npx wrangler deploy`.

## Troubleshooting

- **The bot doesn't reply.** Run `npx wrangler tail` to see live logs, then message the bot.
  - Check that step 8 showed `"ok":true`.
  - Check that `ALLOWED_CHAT_ID` matches the number from `/start` exactly.
- **"You need to verify your email address" on deploy.** Verify your Cloudflare email (step 3).
- **"Could not register workers.dev subdomain".** Choose a subdomain in the dashboard (step 3).
- **No 7 AM or 10 PM message.** Check that `ALLOWED_CHAT_ID` is set. Cloudflare can run a cron up to a minute or so late.
- **"forbidden" on /setup.** The `key=` value must match `WEBHOOK_SECRET` exactly.

## Dashboard changes

Every `npx wrangler deploy` makes the Worker match `wrangler.toml`, which overwrites bindings, variables and schedules you changed in the Cloudflare dashboard. Secrets are the exception and are kept. Make changes in the files and redeploy.
