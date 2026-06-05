# erxes Ai Assistant Gateway

Central Discord gateway for the official erxes Ai Assistant bot.

## Architecture

This service uses one official Discord application and bot named `erxes Ai Assistant`.

```text
Discord guildId + channelId
-> erxes-ai-assistant-gateway
-> tenantId
-> assistantId
-> OpenClaw runtime URL
-> assistant answer
-> Discord reply
```

Customers do not create Discord applications, provide bot tokens, enable privileged intents, or calculate permissions. The gateway-generated installation URL requests the configured bot permission integer, and Erxes Admin owns tenant authorization and channel binding.

## Discord Application Setup

Create the Discord application manually in the Discord Developer Portal.

Use:

```text
Application name: erxes Ai Assistant
Bot name: erxes Ai Assistant
```

Collect:

```text
Application ID
Client ID
Client Secret
Public Key
Bot Token
```

Do not enable these privileged intents for the MVP:

```text
Presence Intent
Server Members Intent
Message Content Intent
```

Use OAuth installation scopes:

```text
bot
applications.commands
```

The gateway-generated installation flow requests Discord Administrator permission:

```text
Administrator permission integer: 8
```

Administrator grants the official erxes Ai Assistant bot full permissions in the selected Discord server. SaaS users do not use the Discord Developer Portal OAuth2 URL Generator directly; they use `/discord/oauth/start`, which generates the install URL with `permissions=8`.

Configure hosted URLs:

```text
Interactions Endpoint URL:
https://<gateway-domain>/discord/interactions

OAuth Redirect URI:
https://<gateway-domain>/discord/oauth/callback
```

For local Discord testing, expose port `3001` through an HTTPS tunnel and use the tunnel URLs for those two Discord settings.

## Environment

Copy `.env.example` to `.env` and fill the Discord credentials.

```env
NODE_ENV=development
PORT=3001
PUBLIC_BASE_URL=http://localhost:3001
MONGO_URL=mongodb://127.0.0.1:27017/erxes_ai_assistant_gateway

DISCORD_APPLICATION_ID=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
DISCORD_REDIRECT_URI=http://localhost:3001/discord/oauth/callback
DISCORD_TEST_GUILD_ID=
DISCORD_BOT_PERMISSIONS=8
ENABLE_MOCK_OPENCLAW=false

ERXES_GATEWAY_ADMIN_SECRET=change-me
ERXES_ALLOWED_RETURN_URLS=http://localhost:3000

OPENCLAW_REQUEST_TIMEOUT_MS=120000
ERXES_ASSISTANT_REPLY_MAX_CHARS=1800
OPENCLAW_SHARED_SECRET=
```

Never commit `.env`. Never log Discord tokens, client secrets, gateway admin secrets, or OpenClaw shared secrets.

## Local Development

```bash
cd /home/batzorig/Erxes/erxes-ai-assistant-gateway
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm install
pnpm dev
```

Checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Health:

```bash
curl http://localhost:3001/health
```

OAuth start:

```bash
curl -I "http://localhost:3001/discord/oauth/start?tenantId=test-saas-1&assistantId=support-assistant-1&erxesUserId=local-admin-1&returnUrl=http%3A%2F%2Flocalhost%3A3000%2Fsettings%2Fautomations%2Fagents%2Fsupport-assistant-1"
```

Register slash command:

```bash
pnpm register:commands
```

If `DISCORD_TEST_GUILD_ID` is set, this registers a guild command. Otherwise it registers the global command:

```text
/assistant question:<text>
```

Mock OpenClaw is disabled by default. Enable it only for local development or a short-lived deployed mock test:

```env
ENABLE_MOCK_OPENCLAW=true
```

Do not enable the mock route in production. Startup validation rejects `ENABLE_MOCK_OPENCLAW=true` when `NODE_ENV=production`.

Mock OpenClaw:

```bash
curl -X POST http://localhost:3001/mock-openclaw/api/erxes-ai-assistant/ask \
  -H 'content-type: application/json' \
  -d '{
    "tenantId": "test-saas-1",
    "assistantId": "support-assistant-1",
    "question": "hello",
    "user": { "id": "discord-user-id", "username": "Discord Name" },
    "discord": { "guildId": "guild-id", "channelId": "channel-id" },
    "source": "discord"
  }'
```

Create a test binding after a `DiscordInstallation` exists:

```bash
curl -X POST http://localhost:3001/api/bindings \
  -H 'content-type: application/json' \
  -H 'x-erxes-gateway-admin-secret: change-me' \
  -d '{
    "installationId": "<installation-object-id>",
    "tenantId": "test-saas-1",
    "assistantId": "support-assistant-1",
    "assistantName": "Support Assistant",
    "discordGuildId": "<discord-guild-id>",
    "discordChannelId": "<discord-channel-id>",
    "openclawUrl": "http://localhost:3001/mock-openclaw"
  }'
```

List installations, channels, and bindings:

```bash
curl "http://localhost:3001/api/installations?tenantId=test-saas-1" \
  -H 'x-erxes-gateway-admin-secret: change-me'

curl "http://localhost:3001/api/installations/<installation-object-id>/channels" \
  -H 'x-erxes-gateway-admin-secret: change-me'

curl "http://localhost:3001/api/bindings?tenantId=test-saas-1" \
  -H 'x-erxes-gateway-admin-secret: change-me'
```

## Routes

Public:

```text
GET /health
GET /discord/oauth/start
GET /discord/oauth/callback
POST /discord/interactions
POST /mock-openclaw/api/erxes-ai-assistant/ask  # only when ENABLE_MOCK_OPENCLAW=true
```

Protected with `x-erxes-gateway-admin-secret`:

```text
GET /api/installations
GET /api/installations/:id
GET /api/installations/:id/channels
GET /api/bindings
GET /api/bindings/:id
POST /api/bindings
PATCH /api/bindings/:id
DELETE /api/bindings/:id
```

## Security

Implemented:

- Discord Ed25519 request signature verification.
- Raw request body preservation for interactions.
- Secure expiring single-use OAuth state.
- OAuth callback only saves connected installations after OAuth code exchange succeeds, Discord returns the installed guild, the bot can fetch the guild, and returned permissions include Administrator.
- Erxes return URL allowlist.
- Protected internal APIs with `x-erxes-gateway-admin-secret`.
- No privileged Discord intents for MVP.
- The gateway-generated install URL requests Administrator permission with `permissions=8`.
- OAuth scopes remain only `bot` and `applications.commands`.
- No customer bot tokens.
- No secrets in redirect URLs.
- OpenClaw request timeout handling.
- Optional `x-erxes-ai-assistant-secret` forwarding.
- Tenant/guild installation validation before binding writes.
- One active binding per Discord guild/channel.
- Production startup rejects placeholder gateway admin secrets and refuses to enable the mock OpenClaw route.

TODO: replace the shared gateway admin secret with stronger service authentication, signed requests, and audit logging.

## Ubuntu 24.04 Hosting

Assumptions:

- A DNS record points `gateway-domain` to the server.
- MongoDB is either managed or reachable privately.
- Node.js 22, pnpm, PM2, Nginx, and Certbot are allowed.

Install packages:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm pm2
```

Deploy:

```bash
git clone <repo-url> /opt/erxes-ai-assistant-gateway
cd /opt/erxes-ai-assistant-gateway
cp .env.example .env
pnpm install
pnpm test
pnpm build
pm2 start dist/src/main.js --name erxes-ai-assistant-gateway
pm2 save
pm2 startup
```

Nginx:

```nginx
server {
  server_name <gateway-domain>;

  client_max_body_size 5m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 130s;
  }
}
```

Enable SSL:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d <gateway-domain>
```

Verify:

```bash
curl https://<gateway-domain>/health
```

Configure Discord:

```text
Interactions Endpoint URL:
https://<gateway-domain>/discord/interactions

OAuth Redirect URI:
https://<gateway-domain>/discord/oauth/callback
```

Register global command:

```bash
cd /opt/erxes-ai-assistant-gateway
DISCORD_TEST_GUILD_ID= pnpm register:commands
```

Useful logs and rollback:

```bash
pm2 logs erxes-ai-assistant-gateway
pm2 restart erxes-ai-assistant-gateway
pm2 stop erxes-ai-assistant-gateway
```

Rollback by deploying the previous git revision, running `pnpm install && pnpm build`, then `pm2 restart erxes-ai-assistant-gateway`.

## End-To-End MVP Test

1. Create one official Discord application and bot named `erxes Ai Assistant`.
2. Configure this gateway with the official Discord credentials.
3. Register `/assistant question:<text>`.
4. Start Erxes with `ERXES_AI_ASSISTANT_GATEWAY_URL` and `ERXES_AI_ASSISTANT_GATEWAY_SECRET`.
5. Open an Erxes AI assistant.
6. Click `Connect Discord`.
7. Approve the official bot in Discord.
8. Return to Erxes and select a Discord server/channel.
9. Click `Connect channel`.
10. Run `/assistant question: hello` in Discord.
11. The gateway resolves guild/channel to tenant/assistant/OpenClaw and edits the Discord reply with the final answer.
