# Wicket MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that fronts
**Wicket** — a generic JSON-RPC-over-Business-Central AL extension — so any
MCP-capable agent (Claude Desktop, Claude Code, etc.) gets the Wicket
operations as native tools.

It speaks MCP over **stdio**, authenticates to Business Central with an OAuth2
`client_credentials` service principal, and translates each tool call into a
Wicket bound-action POST, unwrapping the result (or surfacing the RFC 7807
problem) for the agent.

## Tools

| MCP tool | Wicket op | What it does |
|---|---|---|
| `wicket_discover` | `discover` | List reachable tables / enrolled codeunits / companies (rows carry the owning `app`; `publisher: "<>Microsoft"` lists solution objects only), or the tenant's API catalog (`kind: "apis"`) |
| `wicket_describe` | `describe` | Full schema for one table (incl. `app`, `apiRoutes`; `referencedBy: true` adds reverse relations; `summary: true` a compact view) — cached per connection on disk and revalidated against `describeVersion` on every call — the enrolled procedures of one codeunit, or one API page (`kind: "api"`: fields, `routable`) |
| `wicket_apis` | `discover` `apis` (cached) | The tenant's API pages and queries — cached per environment on disk, revalidated with one call against `catalogVersion` |
| `wicket_api_read` | `describe` `api` + a GET on the API | Read rows through one API page, after a fresh governance check (routable, readable fields) |
| `wicket_query` | `query` | Read records (`$filter` subset, select, orderBy, paging, `modifiedAfter`/`modifiedBefore`) or `aggregate`. Refuses `deliver` (use `wicket_query_deliver`) |
| `wicket_query_deliver` | `query` + `deliver` | Run a query **asynchronously** into an Azure Blob package; returns an `@async` acceptance (optional `idempotencyKey`) |
| `wicket_read_blob` | `readBlob` | Fetch one binary field as `{ contentType, bytesBase64 }` |
| `wicket_insert` | `insert` | Create one record (optional `idempotencyKey`) |
| `wicket_modify` | `modify` | Update one record (optimistic concurrency via `etag`; optional `idempotencyKey`) |
| `wicket_delete` | `delete` | Delete one record (optimistic concurrency via `etag`; optional `idempotencyKey`) |
| `wicket_invoke` | `invoke` | Run an enrolled AL procedure (deny-by-default; optional `idempotencyKey`) |
| `wicket_action` | `action` | Run a named business action (posting etc.) from the deny-by-default Action Catalog (optional `idempotencyKey`) |
| `wicket_capabilities` | `capabilities` | The Wicket self-description (transport, envelope, ops, limits, `actions`) |
| `wicket_page_url` | `pageUrl` | Deep link to open one record in the BC web client — `{ pageUrl, pageId }` |
| `wicket_whoami` | `whoAmI` | Identify the calling principal, company, and effective server posture |
| `wicket_status` | `status` | Track one async delivery request by `requestId` (caller-scoped) |
| `wicket_cancel` | `cancel` | Cancel one async delivery request by `requestId` (caller-scoped) |
| `wicket_requests` | `requests` | List your own async delivery requests (`status?`, `top?`) |
| `wicket_query_all` | `query` (looped) | Convenience: page a `query` to completion, concatenating every page up to `maxPages` / `maxRows` (no `aggregate`, no `deliver`) |
| `wicket_connections` | — (local) | List the configured connections (name, tenant, environment, company, `authMode`, default, selected), plus any load `problem` and `rejected` entries |
| `wicket_setup` | — (local, Entra, BC admin APIs) | Guided setup: `status` (silent health check), `locate` (tenant from a BC address, email or domain), `signin`, `environments`, `companies`, `save` (writes and tests the connection, live, no restart), `remove`, `setDefault`, `moveAsideBroken`. Driven by `/wicket:setup` in Claude Code |
| `wicket_use` | — (local) | Switch the session's active connection (caveated; prefer the per-call `connection` override) |
| `wicket_map` | `capabilities` (for `structureVersion`) | The tenant map: per-connection Markdown notes on solution tables (purpose, business key, joins, gotchas) — `read` / `upsert` / `remove` by `## ` section, structure only, stale when apps change |
| `wicket_skill` | — (local) | The bundled usage guide (SKILL.md plus reference files), with progressive disclosure: `toc`, one `section` or one whole reference file, or `full` |

Every BC-touching tool also accepts an optional **`connection`** parameter — the
per-call override that targets a named connection for that one call. See
[Connections](#connections).

Every tool carries **MCP tool annotations** (`readOnlyHint`, `destructiveHint`,
`idempotentHint`), so a host such as Claude Code can auto-approve the read tools and
prompt before `wicket_insert` / `wicket_modify` / `wicket_delete` / `wicket_invoke` /
`wicket_action` / `wicket_query_deliver`. `wicket_query_deliver` is the one open-world tool
(`openWorldHint: true`): it creates a request row and uploads a package with a shareable
link to Azure Blob storage, which is why async delivery is a separate tool rather than an
option on the read-only `wicket_query`. Annotations are hints; the enforcement is a
connection's [`readOnly` guard](#read-only-connections) and Wicket's own deny-by-default gates.

The server sends **instructions** at the MCP handshake — the skill's essentials (orient once per
connection, describe before touching a table, the filter grammar, aggregates on stored fields,
masked values, the write contract, where to present results) — which hosts such as Claude Code
inject into the session's system prompt, so an agent sees them before its first call.

The **discover → describe → query** ladder is the intended workflow: confirm an
object exists, learn its schema, then operate on it.

### API-first reads (`wicket_apis`, `wicket_api_read`)

When an API page already covers the data, reading through it is often the better route: a stable
contract, the API's own field names and shaping. Wicket's **API Routing** setting (Setup card,
`Off` / `Prefer`, off on every install) decides whether that is allowed; `wicket_capabilities` →
`apiRouting.mode` reports it.

- **Knowledge, cached.** `wicket_apis` lists the tenant's API pages and API queries (route, source table,
  operations). The catalog is cached per environment in memory and in
  `~/.config/wicket/cache/apis-<hash>.json` (or `$WICKET_CACHE_DIR`), and revalidated with ONE call:
  `discover kind:"apis"` with `ifNoneMatch: <catalogVersion>` answers `notModified` while no app has
  been installed, upgraded or removed. Without `tableId` / `search` / `group` it returns a summary by
  route prefix. `wicket_describe` of a table also lists its `apiRoutes`.
- **Governance, fresh.** `wicket_api_read` asks `describe kind:"api"` on every call — never cached —
  and refuses unless `routable` is true (routing is `Prefer`, and Wicket's exposure allowlist and BC
  permissions let this caller read the source table). Every field it selects, filters on or orders by
  must be one Wicket marks `readable` under the field policy; a computed API field (no table field
  behind it) is never readable. With no `select`, it selects exactly the readable fields, and it
  drops anything else BC returns. Navigation and lambdas (`/`) in a filter are refused.
- **Choosing.** Prefer `wicket_api_read` when routing is `Prefer` and an API covers the table and
  fields you need; use `wicket_query` when routing is `Off`, when no API covers the data, or when the
  user asks for dynamic access. A refusal carries `suggest: { use: "wicket_query", tableId }`.
- **Audit.** An API read does not pass Wicket's endpoint, so it is not in the Wicket Operation Log;
  the MCP server writes one line per read to stderr (`api read connection=… route=… rows=…`).

### Schema knowledge (`wicket_describe`, `wicket_map`)

- **Describe cache.** Table answers are stored per connection in `$WICKET_CACHE_DIR` (default
  `~/.config/wicket/cache/describe-<hash>.json`, at most 500 tables) and every call sends
  `ifNoneMatch: <describeVersion>`. Wicket hashes its own answer as the caller sees it, so a policy or
  permission change is never served stale; an unchanged answer costs one fingerprint (`fromCache: true`).
- **Tenant map.** `~/.config/wicket/maps/<connection>.md` (+ `.meta.json` with the `structureVersion`
  at the last write and the time). Sections are `## ` headings; 128 KB cap. It is meant for structure —
  what a table is for, keys, joins, gotchas — and never for record values: the file sits outside
  Wicket's field policy.

### The usage guide (`wicket_skill`) and the skill

The agent-facing guide is an Agent Skill: `skills/wicket-usage/SKILL.md` (the entry point —
essentials, workflow, tool choice, common mistakes) plus `skills/wicket-usage/references/*.md`
(tools, filters, errors, writes, presenting, automation, tables, solutions, protocol), loaded one file or one
section at a time. The MCP server bundles a byte-for-byte mirror in `skill/`, so an agent learns
Wicket from the tool surface alone:

- `mode: "toc"` (default) — the description, then every file with its section titles. Start here.
- `mode: "section"`, `section: "<title>"` — one section (matched case-insensitively: exact, then
  prefix, then fuzzy), or one whole reference file by name (`"filters"`, `"errors"`, `"writes"`,
  `"presenting"`, `"automation"`, `"tables"`, `"tools"`, `"protocol"`).
- `mode: "full"` — the entire guide (large; prefer sections).

After editing the skill run `bun run skill:sync`: it refreshes `skill/` and writes
`docs/wicket-usage-skill.md`, the single-file bundle an administrator hosts for the endpoint's own
`skill` operation. The suite fails when either is out of date, when a tool has no section, or when
the essentials outgrow the instructions budget.

**Claude Code plugin (recommended for Claude Code).** `plugin/` packages the server (bundled into
one file by `bun run plugin:build`, so it needs Bun but no `bun install`), the skill, and two
user-invoked skills: `/wicket:orient` (posture and map in one turn) and `/wicket:inventory` (build or
refresh the tenant's capability inventory). The repository root is its marketplace:

```
/plugin marketplace add davesmith7403/wicket
/plugin install wicket@wicket
```

(or `/plugin marketplace add /path/to/this/repo` for a local checkout). Connections and credentials
stay in `~/.config/wicket/` as for the standalone server. The plugin's tools are named
`mcp__plugin_wicket_wicket__wicket_*`; remove a standalone `wicket` server (`claude mcp remove
wicket`) and any `~/.claude/skills/wicket-usage` link on the same machine so nothing loads twice.
Rebuild after changing the server or the skill: `bun run plugin:build` (the suite fails while
`plugin/` is out of date); `claude plugin validate --strict plugin` checks the manifest.

**Installing the skill in a host.** Claude Code without the plugin: symlink or copy `skills/wicket-usage` into
`~/.claude/skills/` (personal) or `.claude/skills/` (project). claude.ai: zip the folder and upload
it under Customize › Skills; an enabled skill also syncs into Claude Code and Cowork. Use one of the
two per machine, so the same name is not loaded twice.

### Field policy

Every table is subject to a **field policy**. `wicket_describe` reports each field's
`dataClassification` and `readable` / `writable` flags, and the policy may **omit
restricted fields entirely** from the schema. Don't assume a field is readable or
writable — describe the table and check. The same policy narrows `query`: a
`select: ["*"]` returns only the fields you may read (see below), and aggregating a
restricted field is refused with `403 field-restricted`.

**Masked values.** A field can be masked rather than hidden: it is readable but comes back
as a masked rendering. `wicket_describe` marks it `access: "masked"` (plus `mask`,
`filterable: false`, `sortable: false`; on `kind: "api"` it is `readable: false`, so
`wicket_api_read` refuses it), and each `wicket_query` row lists such fields in
`"@masked": [...]` — display text, not data. Filtering, ordering, aggregating or windowing
on one is `403 field-masked`; sending a masked rendering back through `wicket_modify` is
`400 masked-value`. `capabilities.fieldPolicy` carries `classifications`
(`[{name, access, maskProfile}]`), `maskProfiles`, `unmaskTierEnabled` and
`principal { unmaskGranted, activeExceptions }`.

### `select: ["*"]`

`query` accepts `select: ["*"]` (as the sole entry) to project **every readable
scalar field**. Because the field policy narrows it, `["*"]` may return **fewer**
fields than `describe` lists. `wicket_query_all` pages `["*"]` results just fine.

### `aggregate`

`query` accepts an `aggregate` object — `{ count?: bool, sum?: [field], avg?:
[field], min?: [field], max?: [field] }` — that composes **only with `filter`** and
returns a **single summary object** instead of a row array. It cannot be combined
with `select` / `selectFieldNo` / `orderBy` / `top` / `skip` / `cursor` / `count` /
`include` (→ `400 invalid-aggregate`). Every named field must be readable under the
field policy (→ `403 field-restricted` otherwise). Use `wicket_query` for aggregates;
`wicket_query_all` deliberately does **not** support `aggregate`, since a summary
object is not pageable.

### Incremental sync (`modifiedAfter` / `modifiedBefore`)

`query` (and `wicket_query_all`, which shares the schema) accepts two optional ISO 8601
datetime strings that bound the platform's **`SystemModifiedAt`** field:

- `modifiedAfter` — only rows modified **after** this instant.
- `modifiedBefore` — only rows modified **before** this instant.

Both are **ANDed with `filter`**, and together they are the **blessed incremental-sync
pattern**: remember the max `SystemModifiedAt` you have seen and pass it as
`modifiedAfter` on the next pull (optionally with `modifiedBefore` to close the
window). A caller `filter` that *also* targets `SystemModifiedAt` conflicts with these
parameters and is refused with `400 invalid-field` — use one mechanism or the other.

### Deep links (`wicket_page_url`)

`wicket_page_url` (Wicket op `pageUrl`) returns a **BC web client deep link** for one
record: `{ pageUrl, pageId }`. Identify the record with:

- `table` — required; a table **name** (`"Customer"`) or `"#<number>"` (`"#18"`).
- `systemId` **or** `recordId` — one required; **`systemId` wins** when both are passed.
- `pageId` — optional; omit to let the server pick the table's page.

The table's exposure must **Allow Read** (same gate as `query`) — otherwise
`403 not-exposed`. An unknown record returns `404 unknown-record`; if the server
cannot determine a page for the table it returns `404 no-page` — pass `pageId`
explicitly then.

### Identity (`wicket_whoami`)

`wicket_whoami` (Wicket op `whoAmI`) takes no input and returns
`{ userSecurityId, userId, company, readOnly, fieldPolicy, strongEtag, unmaskGranted, activeExceptions, serverTime }` —
the calling principal, the company the connection is pinned to, and the effective
server posture. Call it to verify **which connection/tenant you are actually on**
(especially after `wicket_use`) and whether the server is in read-only mode.

### Idempotency (`idempotencyKey`)

The state-changing tools — `wicket_insert`, `wicket_modify`, `wicket_delete`,
`wicket_invoke`, `wicket_action` and `wicket_query_deliver` — accept an optional
`idempotencyKey` (a caller-supplied string, ≤ 128 printable chars) that is stamped on the
envelope. (For `wicket_query_deliver` a resubmit with the same key replays to the **same**
`requestId` instead of spawning a duplicate export.) The server never
auto-generates one; it is sent only when you provide it. Retrying with the **same
key + same `{operation, data}`** replays the stored result (the response carries
`"@replayed": true`); the **same key with a different body** returns a
`409 idempotency-conflict` problem. A key executes at most once: a resend while the
first request is still running returns `409 idempotency-in-progress` (wait, resend
the identical call); if the earlier attempt's outcome is unknowable the server
returns `409 idempotency-indeterminate` — query the affected records, then retry
with a **new** key. The read tools do not offer it (a read is always safe to repeat).

Wicket-side rules the agent should know: a tenant with Wicket Setup *Require Key For
Actions* on (the fresh-install default) refuses `wicket_invoke`/`wicket_action` without a
key (`400 idempotency-key-required`). Refusals raised before anything ran
(`read-only`, `role-forbidden`, `not-exposed`, `invoke-disabled`, `action-disabled`,
`trigger-bypass-disabled`, `async-not-configured`, `too-many-requests`) and a 5xx are
not stored — resend with the **same** key once fixed. Exception: a 5xx from `invoke`/`action`
settles the key (the wrapper may have committed), so the same-key resend answers
`409 idempotency-indeterminate` — verify first. A resend of a stored success the caller may
no longer see answers `403 replay-withheld` (`originalStatus`, `reason`): the original
request **completed**, so it must not be repeated under a new key.

**Lost responses.** When a write's response never arrives — a gateway `5xx` or the 120 s
timeout — the transport problem's `detail` says so: the outcome is **unknown** and the
write may have committed. With a key, resend the identical call with the **same** key;
without one, query the affected records before retrying. Reads say they are safe to retry.

### Named actions (`wicket_action`)

`wicket_action` runs a **named business action** — a higher-level verb like posting a
document — from a **deny-by-default Action Catalog**. The verbs are not built in: they
are supplied by an installed **action-provider companion** (e.g. *Wicket Actions - Base*,
which enrols the posting verbs `post-sales`, `post-purchase`, `post-gen-journal`,
`post-item-journal`, plus `release-*` / `reopen-*`, the quote conversions `make-order-from-quote`,
`make-invoice-from-quote`, `make-purchase-order-from-quote`, and the non-mutating `document-pdf` and
`item-availability`).
Until such a companion is installed and its actions are allowed, no actions run.

**Discover the verbs via `wicket_capabilities` → `actions`.** Each entry is
`{ action, enabled, category?, mutating, previewSupported, description?, argsSchema? }`, so you
learn every enrolled verb and — before calling — whether an administrator has enabled it,
whether it mutates, whether it supports a preview, and its arguments. The list is empty until
the companion is installed; a verb with `enabled: false` answers `403 action-disabled`.

```json
{ "action": "post-sales",
  "target": { "systemId": "<@systemId from a wicket_query row>" },
  "args": { },
  "preview": false }
```

- `action` — required; the verb to run. Unknown → `404 unknown-action` (its `suggest`
  lists the enrolled actions). Enrolled but switched off → `403 action-disabled`.
- `target.systemId` — the stable per-record handle. **Query rows now carry `@systemId`**
  alongside `@recordId`/`@etag`; pass that value here and it is merged into the action's
  args as `systemId`. An `args.systemId` naming a different record → `400 invalid-field`.
- `args` — optional action-specific arguments (merged with `target.systemId`); a JSON
  object. `args.preview` is reserved (`400` unless `preview: true` is also set).
- `preview` — optional; Wicket runs the wrapper with `args.preview: true` inside its forced
  rollback, so nothing persists. Only valid when the action's `previewSupported` is true (else
  `400 preview-unsupported`). The four posting verbs return Business Central's posting preview:
  `{ preview: true, wouldPost, errors, entries, glAccounts }` — the entries per ledger (count and
  amounts) and the debit/credit per G/L account, or `wouldPost: false` with the reasons.

On success the tool returns the action's own result object — e.g. `post-sales` returns
`{ posted: true, sourceDocumentType, sourceNo, postedInvoiceNo?, postedShipmentNo?,
postedReturnReceiptNo? }` (for a credit memo or return order `postedInvoiceNo` is the posted
credit memo no.); the journal actions return `{ posted: true, template, batch }` plus the
register (`glRegisterNo`/`itemRegisterNo`, `firstEntryNo`, `lastEntryNo`) or
`noEntriesPosted: true`. A post that committed but hit an error in later code still returns
`posted: true`, with `postCommitWarning` and `postCommitEvidence` — never post it again.

**Read-only interaction:** a preview, and a verb whose capabilities entry says
`mutating: false`, run inside the server's **forced rollback** (explicit commits ignored, every
write in Business Central undone), so they are allowed on a read-only endpoint, on a connection
configured `readOnly` (the client reads the verb's flag from capabilities first; one extra call per
non-preview action on such a connection), and without an idempotency key. They can still return
data — a PDF, a preview's amounts — that the exposure allowlist and field policy do not govern.
Every other `action` call is refused with `403 read-only`. The posting error text of a failed
action surfaces as `422 action-failed`.

### Async delivery (`wicket_query_deliver`)

A query can hand off its result to run in the background and be written to **Azure Blob
storage** instead of returning rows. Call `wicket_query_deliver` with the usual query
inputs plus a required `deliver` block (and optionally an `idempotencyKey`):

```json
{ "tableId": 18, "select": ["No.","Name"], "idempotencyKey": "nightly-customers-2026-07-05",
  "deliver": { "mode": "azureBlob", "package": "ndjson", "scheduleAt": "2026-07-05T02:00:00Z" } }
```

The server sends it as the Wicket `query` operation with `deliver` in `data`. `wicket_query`
itself refuses a `deliver` block with a `400 use-deliver-tool` problem pointing here (zod
would otherwise strip the key silently and run a plain read).

- `mode` — only `"azureBlob"` is supported.
- `package` — `ndjson` (default from setup), `json`, or `zip`.
- `scheduleAt` — optional RFC 3339 date-time to run it later (must be in the future,
  within the server's Max Schedule Ahead window). Omit to run immediately in the
  background.

Instead of rows, the call returns an **`@async` acceptance** right away:

```json
{ "@async": true, "requestId": "<id>", "status": "queued",
  "packageUrl": "<url>", "scheduledFor": null, "expiresAt": null,
  "statusVia": { "operation": "status", "data": { "requestId": "<id>" } } }
```

- `packageUrl` **404s until the package is written** — poll `wicket_status` and only
  download once `status` is `"succeeded"`. Take the URL from the latest `wicket_status`:
  Wicket signs it per response (a Service SAS is re-minted on every status call), and a
  replay of the acceptance under the same `idempotencyKey` carries it without a token.
- `expiresAt` is `null` at acceptance; retention starts when the request finishes, and
  `wicket_status` reports `expiresAt` (completion + the package TTL) from then on.
- A **scheduled** request withholds `packageUrl` (and `scheduledFor` is set) until it
  completes; read the URL from `wicket_status`.
- **Only `wicket_query_deliver` delivers.** `wicket_query` refuses `deliver`
  (`400 use-deliver-tool`), `wicket_query_all` rejects it (async returns one acceptance
  object, not pageable rows), and on the Wicket side any operation other than `query`
  returns `400 async-unsupported-op`.

Track the request with the three async tools — all **strictly caller-scoped**: you
only ever see or act on requests you submitted, and a foreign or unknown `requestId`
returns `404 unknown-request` (indistinguishable from a nonexistent one):

- `wicket_status` `{ requestId }` — the lifecycle projection `{ requestId, status,
  operation, packageFormat, createdAt, scheduledFor, startedAt, completedAt, expiresAt,
  progressRows, resultRowCount, resultBytes, packageUrl? (only once succeeded),
  problem? (on failure) }`.
- `wicket_cancel` `{ requestId }` — cancel it. A scheduled or queued request is
  cancelled outright; a running one stops cooperatively at its next checkpoint; a
  finished one is a no-op. Returns `{ requestId, status }`.
- `wicket_requests` `{ status?, top? }` — list your own requests, newest first (`top`
  defaults to 20, capped at 100; an unknown `status` filter yields an empty list).

Async problem slugs you may see: `async-not-configured` (403 — the server has no Azure
account/container/credential, or its download mode is incomplete: Ready SAS without a
stored read token, Service SAS without Shared Key upload auth, or Stream Proxy), `async-unsupported-op` (400), `invalid-deliver` (400 —
bad `mode`/`package`/`scheduleAt`), `invalid-field` (400 — a `deliver` member of the
wrong JSON type), `not-exposed` (403 — the table is not readable by you; checked at
submit), `too-many-requests` (429 — you hit your in-flight cap), `async-start-failed`
(503 — BC could not start a worker; retry shortly) and `unknown-request` (404). A failed
request's `problem.type` on `wicket_status` may be `async-upload-failed`,
`async-task-failed` or `async-stale`. The MCP server has no polling loop: it returns the
acceptance promptly and leaves polling `wicket_status` to the agent.

## How it talks to Wicket

Every tool call becomes:

```
POST {baseUrl}/api/wicket/rpc/v1.0/companies({companyId})/wicketEndpoint(0)/Microsoft.NAV.{operation}
Authorization: Bearer <Entra ID token>
Content-Type: application/json

{ "envelope": "<the envelope below, serialised as a JSON string>" }
```

where the envelope is
`{ "id": "<uuid>", "issuedAt": "<now ISO>", "origin": "mcp.wicket/2.4.2+<connection>", "data": { ... } }`.
Business Central publishes a bound action only for simple parameter types, so the envelope
crosses the wire as one string and the result comes back as one string in `value`.

The `origin` is stamped `mcp.wicket/<version>+<connection>` so the active connection
shows up in the Wicket Operation Log. The implicit env `default` connection honours a
`BC_ORIGIN` override if you set one (it then stamps that verbatim instead).

For the state-changing tools, when the caller supplies an `idempotencyKey` the server
adds it to the envelope alongside `data` (`{ ..., "data": { ... },
"idempotencyKey": "<key>" }`); it is omitted otherwise.

The bound action **always returns HTTP 200**. The result arrives as a JSON string
in `value`; the server parses it and then inspects that object:

- If `value` has a string `type`, a string `title` **and** a numeric `status` (the
  members the AL problem builder always emits), it is an RFC 7807 problem
  (`{ type, title, status, detail, instance, operation, suggest? }`) — the
  server returns it as an MCP tool error (`isError: true`) with the full problem
  document, so the agent sees `detail` + `suggest` and can self-correct. Slugs
  you may see include `field-restricted` (403), `role-forbidden` (403 — the
  principal's Wicket role is below the operation; do not retry), `invalid-aggregate`
  (400), `invalid-select` (400), `idempotency-conflict`, `idempotency-in-progress`
  and `idempotency-indeterminate` (all 409).
- If `value` arrives as a **string** holding a JSON object (a gateway/serializer quirk),
  it is parsed first, so a problem inside it is still detected.

The MCP server also generates a few problems of its own, same shape:

| `type` slug · `status` | When |
|---|---|
| `transport` · HTTP status | BC answered non-200 (gateway / auth / routing). A `5xx` `detail` adds the retry guidance above. |
| `transport-timeout` · 504 | No response within 120 s. `detail` carries the retry guidance. |
| `connection-read-only` · 403 | A mutating tool on a `readOnly` connection (nothing sent). |
| `sign-in-required` · 401 | A `device_code` connection is waiting for the user to sign in; `detail`, `verificationUri` and `userCode` carry the URL + code. |
| `use-deliver-tool` · 400 | `wicket_query` called with `deliver` (nothing sent). |
- Otherwise `value` is the result. For `query`, the OData annotations
  `@nextLink` / `@count` / `@pagingMode` are preserved alongside it; an
  `aggregate` request instead returns a single summary object. A replayed
  idempotent write carries `"@replayed": true`. A `value` array of two or more
  objects (a page of rows, a discover list) is rendered one row per line — still
  valid JSON, at a fraction of the tokens of a pretty-printed page.

## Install

Requires [Bun](https://bun.sh) ≥ 1.0.

```bash
cd mcp
bun install
```

## Guided setup

In Claude Code with the plugin installed, run **`/wicket:setup`**: it asks how you sign in (browser,
device code, or an app with a client secret), finds the tenant from a pasted BC address or an
email, lists the environments and companies to pick from, saves the connection to
`~/.config/wicket/connections.json` and tests it, all without a GUID typed by hand or a restart. The
same command shows what is configured (`/wicket:setup view`), fixes a connection that fails, changes the
default and removes connections. It drives
the `wicket_setup` tool, which any MCP host can call directly. The server starts even with no
connection configured; every tool then answers `503 connection-unavailable` naming `/wicket:setup`.

The rest of this section configures the server by hand.

## Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Meaning |
|---|---|---|
| `BC_TENANT_ID` | yes | Entra ID (Azure AD) tenant GUID |
| `BC_ENVIRONMENT` | yes | BC environment name (e.g. `PRODUCTION`, `SANDBOX`) |
| `BC_COMPANY_ID` | yes | Company GUID used in `companies({companyId})` |
| `BC_CLIENT_ID` | yes | Service-principal app (client) ID |
| `BC_CLIENT_SECRET` | yes | Service-principal client secret |
| `BC_BASE_URL` | no | Override the API host. Defaults to `https://api.businesscentral.dynamics.com/v2.0/{tenantId}/{environment}` |
| `BC_ORIGIN` | no | `origin` tag stamped on every envelope by the env `default` connection. Defaults to `mcp.wicket/<server version>+<connection>` |
| `BC_READ_ONLY` | no | `1` / `true` / `yes` makes the env `default` connection **read-only** client-side (see [Read-only connections](#read-only-connections)) |
| `WICKET_CONNECTIONS_FILE` | no | Path to the multi-connection `connections.json`. Defaults to `~/.config/wicket/connections.json`. See [Connections](#connections) |

Auth is OAuth2 `client_credentials` against
`https://login.microsoftonline.com/{BC_TENANT_ID}/oauth2/v2.0/token` with scope
`https://api.businesscentral.dynamics.com/.default`. The access token is cached
in-process until ~60 s before expiry; a `401` from BC drops the cached token and resends
the call **once** with a fresh one (a 401 is refused before the handler runs, so the
resend cannot double-execute). Both HTTP calls are bounded: the RPC POST
times out after 120 s (surfaced as a synthetic RFC 7807 transport-timeout problem
naming the connection) and the token POST after 30 s — a hung gateway never
blocks a tool call forever.

> **Note:** the service principal needs a matching **Microsoft Entra
> Applications** entry inside the BC environment with a Wicket role set (`Wicket - Read`,
> `Wicket - Execute` or `Wicket - Edit`) assigned to the same client ID — otherwise a valid-looking token fails with
> `401 / "User does not exist"`. See [docs/setup-entra.md](../docs/setup-entra.md).

Get `BC_COMPANY_ID` from `wicket_discover` (`kind: "companies"`) once auth works,
or from BC's `/companies` OData endpoint.

> **Set up before the rename to Wicket?** The server reads only the Wicket names: `WICKET_*`
> variables, `~/.config/wicket/connections.json`, `~/.config/wicket/auth/`, and keychain service
> `wicket`. Move the file and the auth folder from `~/.config/bcmag/`, rename any `BCMAG_*` variable,
> and re-add a keychain secret under service `wicket`. The tools are `wicket_*`, the BC route is
> `/api/wicket/rpc/v1.0/…/wicketEndpoint(0)`, and the server registers as `wicket`
> (see [Use from Claude](#use-from-claude)).

## Connections

The server can front **many** Business Central environments at once. A *connection*
is a named, pinned `{ tenantId, environment, companyId, credentials }` bundle.
Connections come from two sources, merged (a `connections.json` entry wins over the
env `default` on a name collision):

1. **Env vars** (`BC_TENANT_ID` etc.) → an implicit connection named **`default`**.
   This is the back-compat path: an env-var-only setup keeps working unchanged, with
   no `connections.json` present.
2. **`~/.config/wicket/connections.json`** (or the path in `$WICKET_CONNECTIONS_FILE`).

`companyId` is **required** on every connection — Wicket's endpoint is company-scoped
(`companies({companyId})/wicketEndpoint(0)/…`), so there is no companyless route to
discover it. The optional `companies` array is a client-side allowlist
(defense-in-depth, not a security boundary — the real check is BC's per-principal
company access); when present, the connection's `companyId` must be a member or the
server refuses to load it.

### `connections.json` format

```json
{
  "default": "contoso",
  "connections": {
    "contoso": {
      "tenantId": "00000000-1111-2222-3333-444444444444",
      "environment": "ContosoSandbox",
      "companyId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "authMode": "client_credentials",
      "clientId": "app-guid-here",
      "keychainService": "wicket",
      "keychainAccount": "contoso",
      "description": "contoso sandbox — S2S service principal"
    },
    "fabrikam": {
      "tenantId": "55555555-6666-7777-8888-999999999999",
      "environment": "Production",
      "companyId": "ffffffff-0000-1111-2222-333333333333",
      "companies": ["ffffffff-0000-1111-2222-333333333333"],
      "clientId": "app-guid-here",
      "secretEnv": "FABRIKAM_BC_SECRET",
      "readOnly": true,
      "description": "Fabrikam Inc. — production, secret from an env var, writes refused client-side"
    },
    "northwind": {
      "tenantId": "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
      "environment": "Production",
      "companyId": "cccccccc-dddd-eeee-ffff-000000000000",
      "authMode": "device_code",
      "clientId": "public-client-guid-here",
      "description": "Northwind Traders — I sign in as myself (guest); BC user perms apply, calls attributed to me"
    }
  }
}
```

A connection name must match `[A-Za-z0-9._-]` and be ≤ 64 chars (it is stamped into
`origin`). `default` (optional) names the connection used when a call passes no
`connection` and no `wicket_use` selection is active; it must name a configured
connection or the server refuses to start (naming the bad value and the available
connections). If omitted it is the env `default`, else the first entry.

### Load-time validation

The whole file is validated when the server starts, never at the first token fetch, but a
problem no longer stops the server: an entry that fails a check below is **set aside** with
its reason (`wicket_connections` and `wicket_setup status` list it under `rejected`, e.g.
`connections.contoso.keychainSevice: Unrecognized key`) while the other entries load. A file that
is not valid JSON, no configuration at all, or a `default` naming no usable connection is
reported as `problem` (`invalid`, `missing`, `dangling-default`); calls then answer `503
connection-unavailable`. A dangling default never falls back to another connection.

- **`clientId`** is required for `client_credentials`; the delegated modes (`device_code`,
  `browser`) default it to Wicket's default public client `1950a258-227b-4e31-a9cf-717495945fc2`.

- **Strict keys** — an unknown key on a connection (e.g. a typo'd `keychainSevice`)
  is rejected instead of being silently stripped (which would change which rung of
  the secret ladder applies).
- **Secret source required** — a `client_credentials` connection must configure one
  rung of the secret ladder (`keychainService`+`keychainAccount`, `secretEnv`, or
  `clientSecret`); a half-configured keychain pair is also an error. Only the
  source's *existence* is checked — the secret value itself is still resolved lazily
  at token fetch. A `device_code` connection with a configured secret source loads
  fine but warns on stderr that the source is ignored.
- **`companyId` must be a brace-less GUID** — it is interpolated verbatim into the
  request URL (`companies({companyId})`). This applies to the env `default`'s
  `BC_COMPANY_ID` too.
- **URL-safe identity** — `tenantId` must be a GUID or a domain (e.g.
  `contoso.onmicrosoft.com`), `environment` must match `[A-Za-z0-9_-]`, and `baseUrl`
  must be an absolute `https://` URL (the bearer token rides on every request). The env
  `default` gets the same checks (`BC_TENANT_ID`, `BC_ENVIRONMENT`, `BC_BASE_URL`), plus
  `BC_ORIGIN` must fit the envelope origin rule (`[A-Za-z0-9._@/+:-]`, ≤ 256 chars).
- **A broken env `default`** is set aside like a bad file entry, unless `connections.json`
  defines its own `default` connection (which replaces the env one).
- **`readOnly`** (optional boolean, default `false`) — see
  [Read-only connections](#read-only-connections).
- **`unmask`** (optional boolean, default unset) — set `false` to make the connection
  ignore its principal's unmask grants (Unmask permission-set tier, per-user exceptions):
  the server stamps `"unmask": false` on the data of every `query`, `readBlob` and
  `describe` it sends (including `wicket_api_read`'s describe pre-check), so results are never
  more visible than baseline. Unset leaves the server default (grants apply); `true` is
  accepted but never sent — the client cannot ask for more visibility. Listed by
  `wicket_connections` only when set.

### The secret ladder

Each connection resolves its client secret in this order (first match wins), and the
secret is **never logged**:

1. **`keychainService` + `keychainAccount`** — looked up from the **macOS Keychain**
   via `security find-generic-password -s <service> -a <account> -w`. Store it with:

   ```bash
   security add-generic-password -s wicket -a contoso -w '<client-secret>'
   ```

   This is macOS-only.
2. **`secretEnv`** — the name of an environment variable holding the secret. This is
   the **cross-platform** path (use it on Linux/Windows, or in CI).
3. **`clientSecret`** — an inline secret in the JSON. **Dev only** — the server warns
   on stderr (once per connection) when a connection uses it, and additionally warns at load if a
   `connections.json` carrying an inline secret is group/other-readable (suggesting
   `chmod 600`). Prefer the keychain or `secretEnv`.

### Selecting a connection

Resolution ladder, most specific first:

- **Per-call `connection` override** — pass `connection: "<name>"` on any BC-touching
  tool. This is the **preferred, race-free** mechanism: it targets that one call and
  never mutates shared state.
- **Session selection** — `wicket_use { name }` sets the active connection for the rest
  of the session. It is a **caveated convenience**: a stdio server can interleave tool
  calls, so a `wicket_use` from one turn can flip the connection under another. After
  switching, previously fetched `@recordId`/`@etag`/`@systemId` tokens, async
  `requestId`s, and cursors belong to the OLD connection — re-run discover/query
  rather than reusing them, and re-fetch `wicket_capabilities` (it is per-connection).
- **Default** — the `default` connection when neither of the above applies.

Use `wicket_connections` to list what's configured and see which is default/selected
(secrets are never shown).

### Auth modes

Each connection picks one of three `authMode`s.

**`client_credentials`** (default) — a service principal (app identity). The app's own
client + secret get a token via `client_credentials`; every call is attributed to the
**app** in BC. This is the S2S path described above; it needs a **Microsoft Entra
Applications** entry in the BC environment with a Wicket role set assigned to the client ID
(`Wicket - Read`, `Wicket - Execute` for invoke/action, or `Wicket - Edit` for the write plane).

**`device_code`** — delegated user sign-in. The consultant signs in **as themselves**;
BC applies **that human's** user permissions and the Wicket Operation Log attributes each
call to the person (not an app). It is a **public-client** flow — no client secret — and
works with **guest access** in a customer's tenant. Set `authMode: "device_code"` and a
public-client `clientId`; omit every secret field.

- **First-call sign-in (non-blocking).** On the first token fetch the server starts the
  device-code flow, waits up to ~10 s for the sign-in prompt, and then **fails the tool
  call** with a `401 sign-in-required` problem whose `detail` carries the URL and code
  ("sign in, then retry the call") — so the agent can show them to the user. The same
  line also goes to **stderr** (stdout is the MCP protocol channel):

  ```
  [wicket:<connection>] Sign in: https://microsoft.com/devicelogin code: ABCD-EFGH
  ```

  The flow keeps polling in the background; the retry after signing in picks up the
  token (a retry before sign-in repeats the same code). No call ever waits on the human
  for longer than that ~10 s window. After that MSAL caches and silently refreshes the
  token, and the sign-in **survives server restarts**: MSAL's token cache is kept in the OS
  keychain (via `@azure/identity-cache-persistence`; on macOS the entry
  `Microsoft.Developer.IdentityService` / `MSALCache`) and the account record in
  `~/.config/wicket/auth/<connection>.json` (mode 600; `$WICKET_AUTH_DIR` overrides).
  You sign in again only when the refresh token lapses or the connection's tenant/client
  changes. Set `"persistTokenCache": false` on a connection to keep the token in memory only
  (shared machines). If the keychain is unavailable the server warns on stderr and falls
  back to memory. A sign-in that fails after you complete it (e.g. an AADSTS error) is
  reported by the next call instead of a fresh code.
- The `@azure/identity` dependency is loaded **lazily**: it is imported only when a
  `device_code` connection actually fetches a token, so a pure `client_credentials`
  deployment never touches it.

**`browser`** — the same delegated sign-in as `device_code`, but a browser window opens on the
machine running the server (MSAL's `InteractiveBrowserCredential`, redirect to `http://localhost`),
so there is no code to type. Everything else is shared with `device_code`: the non-blocking first
call (the `401 sign-in-required` problem says a window opened, with no `userCode`), the Keychain-
persisted token cache and the account record in `~/.config/wicket/auth/<connection>.json`. It needs
a desktop session; over SSH use `device_code`. For both delegated modes `clientId` is optional and
defaults to Wicket's default public client `1950a258-227b-4e31-a9cf-717495945fc2`.

#### Entra prerequisites (`device_code`, `browser`)

1. **App registration** (a single multi-tenant public-client app used across customers,
   or one per tenant):
   - **Authentication → Allow public client flows → Yes** (device code is a
     public-client grant). For `browser`, also add the platform **Mobile and desktop
     applications** with the redirect URI `http://localhost`.
   - **API permissions → Dynamics 365 Business Central → Delegated →
     `user_impersonation`**, admin-consented in each target tenant. (The server requests the
     `.default` scope, which resolves to that consented permission.) For your own tenant,
     Wicket's default public client `1950a258-227b-4e31-a9cf-717495945fc2`, which Business
     Central already trusts, works without a registration.
2. In **each customer's BC**, the consultant's (guest) user needs a **Wicket role set**
   (`Wicket - Read` for a read-only engagement, `Wicket - Execute` or `Wicket - Edit` when
   the agent may invoke or write) plus the relevant data permissions. There is **no
   Microsoft Entra Applications entry** — the token carries a **user**, not an app.

(`client_credentials` connections keep the requirement from above: a Microsoft Entra
Applications entry in BC with a Wicket role set assigned to the client ID.)

### Read-only connections

Set `"readOnly": true` on a connection (or `BC_READ_ONLY=1` for the env `default`) and
the server refuses `insert`, `modify`, `delete`, `invoke` and `action` for it **before a
token is even minted**, answering a `403 connection-read-only` problem that names the
connection and points the agent at `wicket_connections` to pick a writable one. Reads,
`status`/`cancel`/`requests`, `pageUrl` and `whoAmI` are unaffected.

**`wicket_query_deliver` is allowed on a read-only connection.** The guard mirrors Wicket's
own mutating list (AL `IsMutating`: insert/modify/delete/invoke/action), and Wicket treats
an async delivery as a read — the worker re-runs the query under your identity and its
own read-only mode does not refuse it. Delivery still creates a request row and a
shareable blob package, so if a connection must not export data at all, restrict it on
the BC side (async not configured, or the principal's role).

This is defense in depth over Wicket's server-side **Read-Only Mode** and over the
principal's BC permission sets, not a replacement for them — but it is the cheapest
guard you can put in front of a production tenant, it lets one MCP process front a
read-only production and a writable sandbox side by side, and it keeps holding if the
principal's rights in BC are widened later. Recommended for every production
connection an agent can reach.

## Run

```bash
bun run start        # or: bun run src/index.ts
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit (covers src/ and test/)
bun test             # the suite in test/ — no BC tenant or network needed
```

The server logs a readiness line to **stderr** (stdout is reserved for the MCP
protocol) and then serves over stdio. MCP clients launch it themselves — you
normally don't run it by hand except to smoke-test config.

### Tests

`test/` exercises the server without Business Central: `fetch` is stubbed per test, and
the tool layer runs behind a real MCP `Client` over the SDK's in-memory transport, so
zod validation, the handlers and result rendering are all on the path. Coverage in
brief: connection loading and validation (env, `connections.json`, strict keys, default
resolution, allowlist, secret ladder), token caching/coalescing/timeouts, the transport
contract (URL, envelope, OData unwrapping, RFC 7807 detection, synthetic problems), the
`readOnly` guard, per-connection token isolation, retry guidance and the one-shot 401
retry, the non-blocking device-code sign-in (stubbed credential), `wicket_query_all`
paging incl. row caps and partial results, the API catalog cache (memory, disk, `ifNoneMatch`
revalidation) and the `wicket_api_read` pre-check, the connection tools, the skill loader (files,
sections, lookup, bundle, instructions), the server instructions and tool titles, the row rendering,
and that `skill/` mirrors `skills/wicket-usage/` and `docs/wicket-usage-skill.md` is current. `src/index.ts` exports its
internals for this and starts `main()` only when it is the entrypoint
(`import.meta.main`), so importing it in a test opens no stdio transport.

## Use from Claude

> **Where the secret lives matters.** The `claude mcp add --env BC_CLIENT_SECRET=…` and
> `.mcp.json` forms below put the client secret in a file that is easy to commit, sync, or
> paste. Prefer a [`connections.json`](#connections) whose secret comes from the macOS
> Keychain (`keychainService` / `keychainAccount`) or an environment variable
> (`secretEnv`), register the server with **no** secret in its arguments, and mark
> production connections `readOnly`. The env-var form is fine for a first smoke test.

### Claude Code

Register it as a stdio MCP server (run from the repo root, adjust the absolute
path to `mcp/src/index.ts`):

```bash
claude mcp add wicket \
  --env BC_TENANT_ID=<tenant-guid> \
  --env BC_ENVIRONMENT=PRODUCTION \
  --env BC_COMPANY_ID=<company-guid> \
  --env BC_CLIENT_ID=<client-id> \
  --env BC_CLIENT_SECRET=<client-secret> \
  -- bun run /absolute/path/to/Wicket/mcp/src/index.ts
```

Or add it directly to `.mcp.json` / your Claude Code settings:

```json
{
  "mcpServers": {
    "wicket": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/Wicket/mcp/src/index.ts"],
      "env": {
        "BC_TENANT_ID": "<tenant-guid>",
        "BC_ENVIRONMENT": "PRODUCTION",
        "BC_COMPANY_ID": "<company-guid>",
        "BC_CLIENT_ID": "<client-id>",
        "BC_CLIENT_SECRET": "<client-secret>"
      }
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "wicket": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/Wicket/mcp/src/index.ts"],
      "env": {
        "BC_TENANT_ID": "<tenant-guid>",
        "BC_ENVIRONMENT": "PRODUCTION",
        "BC_COMPANY_ID": "<company-guid>",
        "BC_CLIENT_ID": "<client-id>",
        "BC_CLIENT_SECRET": "<client-secret>"
      }
    }
  }
}
```

Use absolute paths — Claude Desktop does not run from this directory. Restart
Claude Desktop after editing. The Wicket tools (plus `wicket_query_all`) then
appear in the tool list.

## Example session (what the agent does)

1. `wicket_discover` `{ "kind": "tables", "filter": "*Customer*" }` — confirm table 18 is reachable.
2. `wicket_describe` `{ "kind": "table", "tableId": 18 }` — learn fields, keys, permissions, `hasSystemFields`.
3. `wicket_query` `{ "tableId": 18, "select": ["No.","Name","Balance (LCY)"], "filter": "\"Country/Region Code\" eq 'US' and Blocked eq ' '", "orderBy": ["Name asc"], "top": 5, "include": { "flowFields": true } }` — note: field names with spaces/`/` must be quoted, `Blocked eq ' '` is the blank (not-blocked) state, and `orderBy` must be an indexed field (not a FlowField).
4. `wicket_read_blob` `{ "tableId": 18, "recordId": "<@recordId from step 3>", "fieldNo": <the binary field's `no` from step 2> }` — fetch the picture (take the exact `fieldNo` from `describe`, don't guess).

## Notes & limits

- One record per `insert` / `modify` / `delete` (no bulk). Pass an
  `idempotencyKey` to make a retry safe (replays with `"@replayed": true`).
- `invoke` is deny-by-default: only procedures enrolled in the Wicket Procedure
  Catalog are callable; discover them with `wicket_describe` `kind: "codeunit"`.
- `readBlob` returns base64 in `value.bytesBase64`.
- `wicket_query_all` follows `@nextLink` up to `maxPages` (default 100) and
  `maxRows` (default 5000, max 50000 — it stops after the page that reaches the cap,
  so it can overshoot by up to one page) and flags `@truncated` with the `@nextLink`
  resume cursor if one remains. It does not accept `aggregate`. If a page fetch
  fails **mid-pagination** — for any reason, not only a problem document — the rows
  already fetched are returned as a partial result — `@truncated: true`, an
  `@nextLink` resume cursor, and the error under `@error` (the problem document,
  or `{ message }` for a non-problem failure) — instead of being discarded; a
  failure on the very first page errors normally.
- `aggregate` composes only with `filter`; every named field must be readable
  under the field policy, and FlowFields cannot be aggregated server-side.
