# MCP auth pre-flight

MCP servers that need OAuth (email, Outlook, Reddit, GitHub) must be pre-authorized
at setup time so they never block at runtime.

## Rules

1. Tokens live in `.env` (or the OS keyring), never in `config/tools.json`.
   `tools.json` stores only `{id, transport, command/args/url, tokenEnv}`.
   OAuth servers additionally store `{refreshEnv, tokenEndpoint, oauthClientIdEnv}`.
2. Dashboard Config → MCP servers tab runs an auth probe per server:
   - stdio: spawn server, call `tools/list`, expect a tool list within 20s.
   - http: OAuth-aware probe (`probeMcpHttp` in `src/oauth.js`) — bearer token
     from `tokenEnv` when set, else unauthenticated. On 401/403 it runs
     RFC8414/RFC9728 discovery and reports DCR support instead of just failing.
3. A server that fails the probe is saved with `"disabled": true` and a note.
   Workflows using it fail fast with a clear message (never hang).
4. Runtime behavior: on 401, refresh once, retry once, else mark step failed
   and persist the error in SQLite (`run_steps.status = 'failed'`).

## OAuth flow (setup UI, step 3)

For any HTTP MCP server that requires OAuth:

1. **Find** — "Find MCP server" searches GitHub (`github_search`) + web for
   maintained MCP servers matching the user's ask (repo, stars, install cmd).
2. **Discover** — `POST /api/oauth/discover { serverUrl }` probes 401 +
   `WWW-Authenticate`, fetches protected-resource metadata (RFC9728) then
   authorization-server metadata (RFC8414). Reports `authorization_endpoint`,
   `token_endpoint`, `registration_endpoint` (DCR) support, scopes.
   Agents can also run the `oauth_discover` tool for the same report.
3. **Register (DCR)** — `POST /api/oauth/register` uses RFC7591 Dynamic Client
   Registration when `registration_endpoint` exists (public PKCE client, no
   secret). Without DCR, create the client manually in the provider dashboard
   with redirect URI `http://localhost:3000/api/oauth/callback`.
4. **Authorize** — `POST /api/oauth/authorize` builds a PKCE S256 authorize URL
   (with `resource` param per MCP spec). Open it in a browser; the provider
   redirects to `GET /api/oauth/callback`, which exchanges the code and saves
   `<PREFIX>_ACCESS_TOKEN` (+ refresh) to `.env`, sets the server's `tokenEnv`.
5. **Refresh** — `POST /api/oauth/refresh { serverId }` uses the stored refresh
   token + token endpoint. Runtime does the same once on 401 before failing.

## Per-server notes (fill in as servers are added)

- `github`: PAT in `GITHUB_TOKEN`, scope `read`. No refresh needed.
  `github_search` tool uses it when set (5000/hr vs 60/hr anonymous).
- `email/outlook`: Microsoft Graph OAuth — DCR not supported; register the app
  manually, then Authorize. Needs `MS_CLIENT_ID/SECRET` + refresh token.
- `reddit`: script-app `REDDIT_CLIENT_ID/SECRET` + username/password; refresh
  automatically via `grant_type=refresh_token`.
- `finance-us`: stdio `npx -y yahoo-finance-mcp`, no key needed. 15 tools
  (get_quote, get_historical_data, get_news, ...). Granted to `finance-us`
  by default; same Yahoo data source as `src/finance.js`.
