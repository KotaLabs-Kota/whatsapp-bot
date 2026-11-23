# WhatsApp ⇄ Gemini Bot

A production-ready **WhatsApp Business Cloud API** webhook server that answers incoming text messages using **Google Gemini** (`gemini-2.5-flash`) through the official [`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK — *not* the deprecated `@google/generative-ai` package.

```
WhatsApp user ──► Meta Cloud API ──► POST /webhook ──► 200 OK (instant ack)
                                            │
                                            └── async ──► Gemini (@google/genai)
                                                              │
WhatsApp user ◄── Meta Graph API v25.0 ◄── POST /{PHONE_NUMBER_ID}/messages
```

## Features

| | |
|---|---|
| **Instant ack** | `POST /webhook` returns `200` immediately; Gemini + sending happen in the background, so Meta never retries due to timeouts. |
| **Safe parsing** | Tolerates missing `entry`, empty `changes`, status updates, reactions, media and malformed JSON. Never crashes on a bad payload. |
| **No loops** | Ignores `statuses` (sent/delivered/read) and every non-text message type. |
| **Duplicate protection** | Remembers processed `message.id`s for 10 minutes, so Meta retries don't produce double replies. |
| **Conversation memory** | One Gemini chat session per WhatsApp number, bounded to `MAX_HISTORY_TURNS` turns and evicted after idle `SESSION_TTL_MINUTES`. |
| **Signature verification** | Optional HMAC-SHA256 check of `X-Hub-Signature-256` when `WHATSAPP_APP_SECRET` is set. |
| **Robust sending** | Native `fetch`, request timeouts, retry with exponential backoff on `429`/`5xx`/network errors, and automatic splitting of replies longer than WhatsApp's 4096-character limit. |
| **Typing indicator** | Optional read receipt + "typing…" as soon as a message arrives (`SEND_READ_RECEIPTS=true`). |
| **Privacy-safe logs** | Structured JSON logs with ids, latencies and token counts — **message contents are never logged**. |
| **Tests** | `npm test` runs 15 tests over the webhook contract, helpers and error paths with no network access needed. |

## Requirements

- **Node.js 22+** (required by `@google/genai`; `fetch` and `AbortSignal.timeout` are built in)
- A WhatsApp Business Cloud API app in the [Meta Developer Dashboard](https://developers.facebook.com/apps/)
- A Google AI Studio API key — <https://aistudio.google.com/app/apikey>

---

## 1. Install & run locally

```bash
# 1. Clone and enter the project
git clone https://github.com/KotaLabs-Kota/whatsapp-bot.git
cd whatsapp-bot

# 2. Install dependencies
npm install

# 3. Create your local env file and fill it in
cp .env.example .env
#    then edit .env with a real GEMINI_API_KEY, WHATSAPP_TOKEN,
#    PHONE_NUMBER_ID and a VERIFY_TOKEN you invent

# 4. Start the server
npm start
# → {"level":"info","msg":"server:listening","port":3000,...}

# optional: auto-restart on file changes while developing
npm run dev

# optional: run the test suite
npm test
```

Health check: <http://localhost:3000/health>

### Where do the values come from?

| Variable | Where to find it |
|---|---|
| `GEMINI_API_KEY` | [Google AI Studio → API keys](https://aistudio.google.com/app/apikey) |
| `WHATSAPP_TOKEN` | Meta dashboard → your app → **WhatsApp → API Setup** → *Temporary access token* (24 h) or a **System User** token for production |
| `PHONE_NUMBER_ID` | Same page — the numeric **Phone number ID**, *not* the phone number |
| `VERIFY_TOKEN` | Any random string you choose (e.g. `openssl rand -hex 24`). It must match the dashboard exactly |
| `PORT` | Local HTTP port, default `3000` |

> ⚠️ `.env` is git-ignored. Never commit real tokens.

---

## 2. Expose the local server with ngrok

Meta can only reach a public HTTPS URL, so tunnel your local port:

```bash
# install (macOS: brew install ngrok/ngrok/ngrok; Windows: choco install ngrok)
# or download from https://ngrok.com/download, then authenticate once:
ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>

# tunnel port 3000 (must match PORT in .env)
ngrok http 3000
```

Copy the `Forwarding` URL — e.g. `https://a1b2-c3d4.ngrok-free.app`.

### Wire it up in the Meta Developer Dashboard

1. Open your app → **WhatsApp → Configuration** (WhatsApp Business Platform → Configuration).
2. Click **Edit** next to *Webhook*.
3. **Callback URL:** `https://a1b2-c3d4.ngrok-free.app/webhook` — the `/webhook` path is required.
4. **Verify token:** the exact `VERIFY_TOKEN` from `.env`.
5. Click **Verify and save**. Meta calls `GET /webhook`; you should see `webhook:verified` in the terminal.
6. Under **Webhook fields**, subscribe to **`messages`** (that's the field this server handles).
7. Add a recipient: **WhatsApp → API Setup → To** field → add and verify your own number, then message the business number.

Send a WhatsApp message to the test number — the terminal logs `message:received` → `gemini:reply` → `whatsapp:sent`, and the reply arrives in the chat.

> The ngrok URL changes every time you restart the free tunnel — update the Callback URL each session, or use a static domain (`ngrok http --url=your-name.ngrok-free.app 3000` with a paid plan).

### Manual end-to-end check (no WhatsApp needed)

```bash
# 1. verification handshake — should print the challenge with HTTP 200
curl -i "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=12345"

# 2. simulate an inbound text message (calls Gemini + Graph API for real)
curl -X POST http://localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "id": "WABA_ID",
      "changes": [{
        "field": "messages",
        "value": {
          "messaging_product": "whatsapp",
          "messages": [{
            "from": "919999999999",
            "id": "wamid.TEST",
            "timestamp": "1700000000",
            "type": "text",
            "text": { "body": "Hello from curl!" }
          }]
        }
      }]
    }]
  }'
# → 200 EVENT_RECEIVED, then the reply is delivered on WhatsApp
```

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/webhook` | Meta verification handshake: checks `hub.mode === 'subscribe'` and `hub.verify_token`, echoes `hub.challenge` with `200`. Wrong token → `403`; wrong mode → `400`. |
| `POST` | `/webhook` | Receives messages/statuses. Verifies the signature (when configured), acks `200` instantly, processes in the background. |
| `GET` | `/health` | Liveness probe with uptime and configured model. |
| `GET` | `/` | Small JSON index of the endpoints. |

Outbound requests go to:

```
POST https://graph.facebook.com/v25.0/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {WHATSAPP_TOKEN}
```

---

## Configuration reference

Everything except the five core variables is optional.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | **required** | Google AI Studio key. |
| `WHATSAPP_TOKEN` | **required** | Cloud API access token (permanent System User token in production). |
| `PHONE_NUMBER_ID` | **required** | Numeric phone number ID from the dashboard. |
| `VERIFY_TOKEN` | **required** | Shared secret for the `GET /webhook` handshake. |
| `PORT` | `3000` | HTTP port. |
| `WHATSAPP_APP_SECRET` | – | Meta app secret. When set, unsigned `POST /webhook` requests are rejected with `401`. **Recommended in production.** |
| `GRAPH_API_VERSION` | `v25.0` | Graph API version for sending messages. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model id. |
| `GEMINI_THINKING_BUDGET` | `0` | Thinking tokens for `gemini-2.5-flash`: `0` = off (fastest replies), `-1` = automatic. |
| `SYSTEM_PROMPT` | friendly assistant | Persona/behaviour instructions. |
| `MAX_HISTORY_TURNS` | `20` | User+model pairs kept per WhatsApp number. |
| `SESSION_TTL_MINUTES` | `30` | Idle time after which a conversation is forgotten. |
| `SEND_READ_RECEIPTS` | `false` | Blue ticks + "typing…" while Gemini works. |
| `REQUEST_TIMEOUT_MS` | `30000` | Outbound timeout for Gemini and Graph API calls. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug`. |

---

## Production notes

- **Permanent token.** The 24-hour test token expires; generate a **System User** token with `whatsapp_business_messaging` + `whatsapp_business_management` scopes and set an expiry you rotate deliberately.
- **Enable `WHATSAPP_APP_SECRET`.** Without it anyone who learns your URL can post fake messages and burn Gemini quota.
- **Ack latency.** The handler acks before calling Gemini, which is exactly what Meta's retry logic wants; long Gemini calls can never cause redelivery storms.
- **Multi-instance caveat.** Dedupe and chat memory are in-process. Behind a load balancer, use a shared Redis (or make the service sticky) if you need strict idempotency and shared history. For a single webhook VM/container it is no different from the reference implementation.
- **Rate limits.** Gemini free tier has per-minute quotas; Graph API is rate-limited per phone number. The sender retries 429/5xx with backoff, and failures are logged with the Meta error payload.
- **Serverless platforms** (Vercel/Lambda) work for the webhook itself, but each cold start loses in-memory history and dedupe — use a long-running container (Render, Railway, Fly.io, Cloud Run, ECS) if conversation memory matters.
- **Logging.** Only ids, sizes, latencies and token counts are logged — no message bodies, no tokens.
- **Costs.** Every inbound text triggers one Gemini request; long replies are split into up to N messages at no extra cost per message, but your Cloud API conversation charges apply.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required environment variable(s)` | `.env` missing/incomplete — copy `.env.example`. |
| Dashboard says "The callback URL or verify token couldn't be validated" | Token mismatch with `VERIFY_TOKEN`, server not running, or tunnel URL missing `/webhook`. Check `curl` handshake above. |
| `webhook:invalid-signature` | `WHATSAPP_APP_SECRET` doesn't belong to the app sending the webhook. |
| Message arrives but no reply | Look for `gemini:request-failed` (bad key / quota) or `whatsapp:send-failed` (expired token, unverified recipient, 24-hour messaging window). |
| `whatsapp:api-error 401` | Access token expired — regenerate it. |
| `whatsapp:api-error 400 … (#131030)` | The recipient number isn't in the allowed list of the test number. |
| No `POST /webhook` logs at all | Webhook field `messages` isn't subscribed in the dashboard, or the tunnel is down. |

## Project structure

```
├── index.js          # Express server: webhook routes, Gemini responder, Graph API client
├── test/
│   └── server.test.js # node:test suite (no network)
├── .env.example      # documented environment template
├── package.json
└── README.md
```

`index.js` exports its building blocks (`createApp`, `loadConfig`, `createGeminiResponder`, `createWhatsAppClient`, `splitMessage`, …) so they can be reused and tested independently; `main()` only runs when the file is executed directly.

## License

MIT
