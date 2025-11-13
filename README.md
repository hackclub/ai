# AI Proxy

OpenAI API proxy with Slack authentication, usage tracking, and API key management.

## Features

- Slack OAuth authentication
- Multiple API keys per user with revocation support
- Complete request/response logging to PostgreSQL
- Token usage tracking with statistics dashboard
- IP address detection (Cloudflare and Traefik compatible)
- Model allowlist configuration
- Clean, minimalistic UI
- Unlimited token usage
- Streaming support for LLM responses
- Environment validation with ArkType

## Tech Stack

- Bun runtime
- Hono web framework
- Drizzle ORM + Drizzle Kit
- PostgreSQL database
- Hono JSX for views
- ArkType for environment validation

## Setup

1. Install dependencies:

```bash
bun install
```

2. Copy environment variables:

```bash
cp .env.example .env
```

3. Configure environment variables in `.env`:

Required:
- `DATABASE_URL`: PostgreSQL connection string
- `BASE_URL`: Your application URL
- `PORT`: Server port
- `SLACK_CLIENT_ID`: Slack OAuth client ID
- `SLACK_CLIENT_SECRET`: Slack OAuth client secret
- `OPENAI_API_URL`: OpenAI API URL
- `OPENAI_API_KEY`: Your OpenAI API key

Optional:
- `ALLOWED_MODELS`: Comma-separated list of allowed models (if empty, all models allowed)
- `NODE_ENV`: Environment (development, production, test)

4. Set up Slack OAuth:

- Go to https://api.slack.com/apps
- Create a new app
- Add OAuth scopes: `openid`, `profile`, `email`
- Add redirect URL: `{BASE_URL}/auth/callback`
- Copy client ID and secret to `.env`

5. Push database schema:

```bash
bun run db:push
```

6. Start the server:

```bash
bun run dev
```

## Database Management

- Generate migrations: `bun run db:generate`
- Run migrations: `bun run db:migrate`
- Push schema directly: `bun run db:push`
- Open Drizzle Studio: `bun run db:studio`

## Docker Deployment

Build and run with Docker:

```bash
docker build -t ai-proxy .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/db" \
  -e BASE_URL="http://localhost:3000" \
  -e PORT="3000" \
  -e SLACK_CLIENT_ID="your_client_id" \
  -e SLACK_CLIENT_SECRET="your_client_secret" \
  -e OPENAI_API_URL="https://api.openai.com" \
  -e OPENAI_API_KEY="your_api_key" \
  ai-proxy
```

Or use Docker Compose:

1. Create a `.env` file with required environment variables:
```bash
SLACK_CLIENT_ID=your_client_id
SLACK_CLIENT_SECRET=your_client_secret
OPENAI_API_KEY=your_api_key
OPENAI_API_URL=https://api.openai.com
```

2. Start the stack:
```bash
docker-compose up -d
```

The compose file includes PostgreSQL with health checks and automatic restarts.

## Usage

1. Navigate to `http://localhost:3000`
2. Sign in with Slack
3. Create an API key from the dashboard
4. Use the proxy endpoint:

Non-streaming:
```bash
curl http://localhost:3000/proxy/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Streaming:
```bash
curl http://localhost:3000/proxy/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## Database Schema

### users
- User accounts linked to Slack IDs
- Stores profile information

### api_keys
- Multiple keys per user
- Soft deletion via `revokedAt`

### request_logs
- Complete request/response logging
- Token usage tracking
- IP address and timestamp
- Indexed for performance

### sessions
- User session management
- 30-day expiration

## Security

- Session-based authentication with HTTP-only cookies
- API key authentication for proxy endpoints
- IP address logging with reverse proxy support
- Environment variable validation with ArkType
- API key revocation support
- Model allowlist enforcement

## License

MIT
