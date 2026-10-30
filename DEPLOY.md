# Deploying as a remote MCP server

The stdio server in `src/index.ts` only works on the machine it runs on. To use
these tools from claude.ai or the Claude mobile app, deploy the Worker in
`src/worker/` to Cloudflare and add it as a custom connector.

The Worker holds the YNAB token server-side and puts an authentication layer in
front of it, chosen by `MCP_AUTH_MODE`. The template sets `secret`, which
accepts one shared secret. `github`, or no mode at all, keeps the legacy GitHub
sign-in restricted to a single GitHub account (see
[GitHub sign-in](#github-sign-in-optional)); any other value refuses every
request. The authentication layer controls who may connect, while the YNAB
Personal Access Token controls which YNAB account the server reaches. They
answer different questions, and neither substitutes for the other. The Worker
uses one server-wide YNAB token, so anyone admitted reaches the deployer's YNAB
account, money, and every plan available to that token—not their own YNAB
account.
`ynab_list_plans` lists all of those plans, and a caller-supplied `planId`
overrides the optional `YNAB_PLAN_ID` default. Write tools stay on unless
`YNAB_READ_ONLY` is `"true"`, and the template leaves it unset, so the tool set
includes create, update and delete.

### Shared-secret mode

Each request must carry `MCP_SHARED_SECRET`, either as an
`Authorization: Bearer <secret>` header on `/mcp` or in the path `/<secret>/mcp`.
The secret must be at least 64 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`; use
32 random bytes written as 64 hex characters. If it is missing or invalid, the
Worker answers every request with `503`, and a wrong secret gets `401`. The
Worker compares SHA-256 digests of the configured and presented values with
`timingSafeEqual`, so timing does not reveal how much of a guess matched. This
mode needs no GitHub OAuth app, GitHub credentials or KV namespace.

- Anyone with the secret can read and write every plan the YNAB token reaches.
- In the path form the URL itself is the credential, and URLs end up in logs,
  browser history and screenshots. Prefer the Bearer header. The template turns
  observability off so Workers Logs do not record request URLs.
- Keep the secret off the terminal: don't print it, paste it into a command or
  leave it in shell history.

## One-time setup

### 1. Create your local Wrangler config and log in

The repository provides a template; the real config is git-ignored because it
holds your deployment's settings.

```sh
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
```

If your login reaches more than one Cloudflare account, choose one with
`export CLOUDFLARE_ACCOUNT_ID='<your-account-id>'` (`npx wrangler whoami` lists
them). Do not edit `wrangler.example.jsonc` with account-specific values.

### 2. Deploy

```sh
npm run deploy
```

Wrangler prints the Worker's `https://ynab-mcp-server.<your-subdomain>.workers.dev`
address. Until the secrets below are set, it answers every request with `503`.

### 3. Generate the shared secret and set secrets

```sh
umask 077
mkdir -p .wrangler
secret_file=$(mktemp -p .wrangler mcp-shared-secret.XXXXXX)
openssl rand -hex 32 > "$secret_file"
npx wrangler secret put YNAB_API_TOKEN
npx wrangler secret put MCP_SHARED_SECRET < "$secret_file"
```

The secret goes straight from `openssl` into an owner-only file under the
git-ignored `.wrangler/` directory and never appears on screen. Keep that file:
the connector's credential is copied from it. `YNAB_API_TOKEN` is entered at
Wrangler's masked prompt. Each `secret put` creates and deploys a new Worker
version.

Optionally pin a default plan so tool calls can omit `planId`:

```bash
npx wrangler secret put YNAB_PLAN_ID
```

`YNAB_BUDGET_ID` is deprecated but still accepted as an alias; there is no
removal date. Use `YNAB_PLAN_ID` for new deployments.

Set the operator-owned TypeSafe credential as a Worker secret:

```bash
npx wrangler secret put TYPESAFE_API_KEY
```

Category suggestions remain off unless you also add
`"YNAB_AI_CATEGORIZATION": "true"` under `vars` in `wrangler.jsonc`. Both
settings are required to expose `ynab_suggest_categories`; the key never
belongs in `wrangler.jsonc` or a tool argument.

## Add the connector in Claude

1. claude.ai → Settings → Connectors → **Add custom connector**
2. Name: `YNAB`
3. URL: `https://ynab-mcp-server.<your-subdomain>.workers.dev/mcp`
4. Authentication: **No sign-in**. Under **Request headers**, add
   `authorization` with the value `Bearer ` followed by the contents of the
   secret file.

[Request headers](https://claude.com/docs/connectors/custom/add-unlisted#authenticate-with-request-headers)
are a limited beta. If the dialog has no Request headers section, the fallback
is the URL `https://ynab-mcp-server.<your-subdomain>.workers.dev/<secret>/mcp`
with No sign-in. That path form is untested in Claude's apps, and the URL then
carries the credential.

Once connected it works everywhere you are signed in to Claude, including the
mobile app. Your Mac does not need to be running.

## GitHub sign-in (optional)

The legacy mode admits only the GitHub account in `ALLOWED_GITHUB_LOGIN` and
stores OAuth grants in KV. In your local `wrangler.jsonc`, set
`"MCP_AUTH_MODE": "github"` under `vars` (or remove the line) and add the KV
binding:

```jsonc
"kv_namespaces": [
	{
		"binding": "OAUTH_KV",
		"id": "REPLACE_WITH_KV_NAMESPACE_ID",
		"remote": true
	}
],
```

Create the namespace with `npx wrangler kv namespace create OAUTH_KV` and copy
the printed `id` over `REPLACE_WITH_KV_NAMESPACE_ID`.

Create a GitHub OAuth app at <https://github.com/settings/developers> →
**New OAuth App**:

- **Homepage URL**: `https://ynab-mcp-server.<your-subdomain>.workers.dev`
- **Authorization callback URL**: `https://ynab-mcp-server.<your-subdomain>.workers.dev/callback`

Then set the GitHub values alongside `YNAB_API_TOKEN` and the optional settings
above, and deploy. Each command prompts for its value; until all three are set,
the sign-in pages answer `503`.

```sh
npx wrangler secret put ALLOWED_GITHUB_LOGIN
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npm run deploy
```

Add the connector with the URL `https://ynab-mcp-server.<your-subdomain>.workers.dev/mcp`
and complete the GitHub sign-in when prompted.

## Categorize reminders (optional)

The Worker can drop a reminder on a Google Calendar when transactions are
waiting to be categorized. It runs hourly and acts once a day, in the local
hour you choose. With no service account configured the job is a no-op, so this
is entirely opt-in.

### 1. Create a service account

In the [Google Cloud console](https://console.cloud.google.com/projectcreate):

1. Create a project, then enable the
   [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
2. APIs & Services → Credentials → Create credentials → Service account
3. On the new account, Keys → Add key → Create new key → JSON

A service account avoids the usual OAuth dance: there are no refresh tokens to
store and no consent screen, because access comes from sharing the calendar
with it directly.

### 2. Share the calendar with it

In Google Calendar, open the calendar's settings → "Share with specific people
or groups" → add the service account's email with **Make changes to events**.

### 3. Configure and deploy

Set the deployment-specific calendar ID and service-account key as Worker
secrets. Configure `NAG_TIMEZONE`, the `NAG_HOUR_MIN`/`NAG_HOUR_MAX` window,
and `NAG_SINCE_DAYS` in `wrangler.jsonc` if their defaults do not suit you:

```bash
npx wrangler secret put NAG_CALENDAR_ID
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < service-account.json
npm run deploy
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NAG_CALENDAR_ID` | — | Calendar to write to. Unset disables the job. |
| `NAG_TIMEZONE` | `America/Los_Angeles` | IANA zone the reminder is scheduled in |
| `NAG_HOUR_MIN` | `8` | Earliest local hour the event may land on |
| `NAG_HOUR_MAX` | `20` | Latest local hour, inclusive. Set equal to the minimum for a fixed time. |

### How it behaves

- **Nothing pending, no event.** The reminder only exists when there is work.
- **A different hour each day.** The slot is drawn from the configured window,
  derived from the date so that every hourly run agrees on it — a per-run
  random draw would fire several times some days and never on others.
- **One event per day.** The event id is derived from the date, so a re-run
  updates that day's event rather than stacking duplicates.
- **The count is the current month.** It resets on the 1st, so the month you
  are budgeting is the month you are reminded about. Anything older is a
  footnote in the description, not the headline.
- **Transfers are ignored.** Moving money between your own accounts shows up
  as uncategorized in YNAB but never needs a category. In the plan this was
  built against, 77 of 80 "uncategorized" items were transfer legs.
- **The wording rotates daily.** Same mechanism as the hour: derived from the
  date, so it is stable within a day and different the next.
- **Daylight saving is handled.** Cloudflare crons are UTC, so the job runs
  hourly and acts only in the configured local hour, holding its wall-clock
  slot year round.

## TypeSafe category preview (optional)

When enabled as described above, `ynab_suggest_categories` proposes categories
for eligible uncategorized outflows. It is a preview only and never writes to
YNAB. Applying a proposal requires a separate explicit write; see
[Category suggestions](./README.md#category-suggestions-optional) for the apply
tool and its safeguards.

See [Category suggestions](./README.md#category-suggestions-optional) for the
authoritative data-sharing contract, model and cost limits, and evaluation
caveats.

## Read-only mode

To expose only the tools that read data and none that change it, set
`YNAB_READ_ONLY` to `"true"` in `wrangler.jsonc` and redeploy. The write tools
disappear from `tools/list` entirely rather than failing when called. The
TypeSafe preview is registered as read-only and remains available in this mode
only when both its feature flag and secret are configured.

## Local development

```bash
npm run dev:worker
```

Uses `.dev.vars` for secrets (git-ignored). Secret mode needs
`MCP_SHARED_SECRET` and `YNAB_API_TOKEN` there. In GitHub mode, the OAuth flow
needs a real GitHub app to complete end to end; without one you can still
exercise the unauthorized paths and the OAuth metadata endpoints.

## Layout

| Path | Purpose |
| --- | --- |
| `src/registry.ts` | The one tool list, shared by both entry points |
| `src/index.ts` | stdio entry (local Claude Code / Claude Desktop) |
| `src/worker/index.ts` | Worker entry: shared-secret or GitHub auth in front of the MCP handler |
| `src/worker/secret-handler.ts` | Shared-secret check for the Bearer header and `/<secret>/mcp` |
| `src/worker/mcp.ts` | Builds the MCP server and serves `/mcp` |
| `src/worker/github-handler.ts` | GitHub sign-in and the single-user gate |
