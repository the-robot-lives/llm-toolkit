# Local API Perimeter

Trust boundary: anything that can open a TCP connection to the API port vs. the API process.

## Bind scope (T-001)

`packages/api/src/index.ts` calls `serve({ fetch: app.fetch, port })` with no
`hostname`; `@hono/node-server` forwards `undefined` to `server.listen(port, undefined)`,
which Node interprets as **all interfaces**. The startup log prints
`http://localhost:3100`, but that string does not restrict the socket. Any host on
the LAN (and any other local user, subject to firewall) can read transcripts,
invoke write routes (edits, memory CRUD, service start, MCP registration), and
read `settings.app_config` including LLM provider keys.

**Mitigation present**: CORS middleware returns the origin only for
`localhost`/`127.0.0.1` hosts. This constrains *browsers*, not `curl`/scripts.

**Recommended**: `serve({ ..., hostname: "127.0.0.1" })` (plus an opt-in env
var for users who deliberately want LAN exposure).

## DNS rebinding (T-006)

CORS allows any origin whose hostname is `localhost` or `127.0.0.1` — including
ports other than the API's. Combined with **no `Host` header validation**, a
remote attacker page can rebind a domain to `127.0.0.1:3100`; the request then
passes same-origin checks (origin host = `localhost`/rebound name? origin hostname
must be localhost — rebinding makes the *attacker's* hostname resolve to
127.0.0.1, so the Origin header hostname is the attacker domain and CORS
rejects the *read*). The remaining exposure is **no-preflight writes**: simple
requests (`POST` with form/text/plain content types, `GET`-parameter routes)
still execute server-side even when the page cannot read the response. Several
mutating routes accept query params or non-JSON bodies.

**Recommended**: reject requests whose `Host`/`Origin` is not an expected
localhost form.

## Secrets in stores and responses (T-005 / T-007)

`settings.app_config` (SQLite) holds provider selection + API keys; `config`
and `llm` route groups return them. Read exposure is the same perimeter as
T-001; accepted for a single-user local tool, but the plaintext-at-rest and
plaintext-in-response combination means any T-001/T-006 compromise yields keys
directly.

## Transcript corpus

Indexed JSONL contains full source code, paths, and pasted credentials
(frequent in agent conversations). The API offers bulk read/search/download of
all of it with no auth. Treat the API port as equivalent to shell access.
