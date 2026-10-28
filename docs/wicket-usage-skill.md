---
name: wicket-usage
description: Use when a task touches Microsoft Dynamics 365 Business Central data through Wicket — any wicket_* MCP tool, "Wicket" or "BCMag", reading, exporting, syncing or updating BC records, BC dashboards or reports, posting through Wicket, what installed extensions let Wicket do, or a URL with /api/wicket/rpc/. Load before the first Wicket call of a session, before any write, and before building an export, dashboard or sync from BC data.
---

# Wicket usage

Wicket is a governed way into Microsoft Dynamics 365 Business Central (BC): one endpoint, any table by id, deny-by-default exposure, a per-field policy that hides or masks sensitive fields, idempotent writes, named business actions, and an audit log of every call. Through the Wicket MCP server its operations are the `wicket_*` tools. The tenant is the source of truth: when this text and `wicket_capabilities` or `wicket_describe` disagree, they are right.

## Essentials

Wicket fronts Microsoft Dynamics 365 Business Central: the wicket_* tools read, write, describe and run actions on any BC table through a governed endpoint. The rules that matter most:
- Orient once per connection, in one turn: wicket_whoami, wicket_capabilities (limits, field policy, apiRouting, actions), wicket_map read (what earlier sessions learned). Redo after wicket_use; handles never cross connections.
- wicket_describe summary:true before touching an unfamiliar table: field names, types, option ordinals and what you may read are not guessable; it is cached and cheap.
- Filters: double-quote a field name unless it is plain [A-Za-z0-9_] ("No." eq '10000', "Posting Date" ge 2025-01-01); options by ordinal ("Document Type" eq 1); dates bare, strings in single quotes; no cross-field or (split it); contains() is case-sensitive.
- Read only what you need: select the fields; aggregate for totals on stored fields (a FlowField such as Balance (LCY) is refused: sum the ledger instead); count:true to count; top for samples; wicket_query_all with maxRows from the count for exports, no orderBy.
- Masked values (@masked, ****) are display text: never filter, sort, compute on or write them back.
- Writes: one record per call; modify/delete with the row's @etag and an idempotencyKey; read it back; post via wicket_action, preview: true first; never edit a document's fields around a refused action.
- Beyond a dozen rows present outside the chat: a file for Excel, an artifact page or dashboard, a doc for a shared report, wicket_page_url (card pageId) for a record a person acts on.
- Small independent reads in parallel; heavy ones (1000-row discover, cold describe) one at a time. On an error read detail and suggest; retry a timed-out read once.
- Installed apps may do more: before saying Wicket cannot, or when the map has no solution notes, offer to explore them (read-only, on a yes).
- Depth: wicket_skill (toc, then a section or a file: tools, filters, errors, writes, presenting, automation, tables, solutions, protocol).

## Reference files

- [tools](references/tools.md) — every tool: inputs, result shapes, costs, gotchas.
- [filters](references/filters.md) — the `$filter` grammar, sorting, worked filters.
- [errors](references/errors.md) — every problem slug and what to do.
- [writes](references/writes.md) — etag, idempotency, replay, batches, actions and posting.
- [presenting](references/presenting.md) — chat, files, artifact pages and dashboards, live pages, Claude Docs, deep links.
- [automation](references/automation.md) — parallelism, subagents, exports, incremental sync, scheduled and unattended runs, memory.
- [tables](references/tables.md) — common table and page ids, option ordinals, which table holds the stored amount.
- [solutions](references/solutions.md) — finding what installed extensions let Wicket do: when to offer it, the metadata to read, the routes, what would unlock more, and the capability inventory that answers later requests directly.
- [protocol](references/protocol.md) — the wire protocol for HTTP clients without MCP.

## Workflow

1. **Orient** — `wicket_connections` when more than one tenant may be configured; then `wicket_whoami`, `wicket_capabilities` and `wicket_map read` in one turn. Note `readOnly`, `apiRouting.mode`, `async.enabled`, `actions`, `fieldPolicy.mode`, `limits`, `serverTime`, and any `Capability:` sections in the map: a matching one answers a request before any search ([solutions](references/solutions.md)).
2. **Plan the read** — name the table that holds the stored number you need ([tables](references/tables.md)); `wicket_describe summary:true` on it; if `apiRouting` is `Prefer`, check `wicket_apis` for a page that covers the fields.
3. **Read** — `select` the fields, `filter` with the grammar ([filters](references/filters.md)), `aggregate` or `count: true` for sizes and totals, then `wicket_query` for a page, `wicket_query_all` sized from the count, or `wicket_query_deliver` for a large export when async is configured. Independent reads in parallel.
4. **Present** — choose the medium by audience and size ([presenting](references/presenting.md)); keep rows in files, summaries in the chat.
5. **Write only when asked** — read the row, write with `etag` and `idempotencyKey`, read it back, link the card ([writes](references/writes.md)).
6. **Remember** — structure you learned about a solution table, and any capability you had to explore for, goes to `wicket_map upsert` (never record values); recurring work is set up per [automation](references/automation.md).

## Choosing the tool

| You need | Tool |
|---|---|
| Which tenant, company, posture, time | `wicket_whoami` |
| Limits, policy, routing, async, actions | `wicket_capabilities` |
| What earlier sessions learned here | `wicket_map` (`read`, `upsert`, `remove`) |
| Does a table exist; the tenant's custom tables | `wicket_discover` (`publisher: "<>Microsoft"` or `"<>Microsoft&<>Contoso"`, `top: 1000`; exactly `top` rows means truncated) |
| Fields, keys, option ordinals, what is readable | `wicket_describe summary:true`; `referencedBy: true` to map relations |
| Rows, a page, a count, a total | `wicket_query` |
| All rows for a file or a script | `wicket_query_all` (`maxRows` from a count) |
| A large export to Azure Blob Storage | `wicket_query_deliver` + `wicket_status` (only when `async.enabled`) |
| Rows through the tenant's own API page | `wicket_api_read` (only when `apiRouting` is `Prefer`; find the page with `wicket_apis`) |
| A picture or attachment | `wicket_read_blob` |
| Create, change, delete one record | `wicket_insert`, `wicket_modify`, `wicket_delete` |
| Post or run a business operation | `wicket_action` (verbs from `capabilities.actions`); `wicket_invoke` only for an enrolled raw procedure |
| A link a person can open | `wicket_page_url` (`pageId` = the card page) |
| What installed apps let Wicket do | the metadata tables in [solutions](references/solutions.md), read with `wicket_query` |
| More of this guide | `wicket_skill` |

Details, inputs and result shapes for every tool: [tools](references/tools.md).

## Reading efficiently

- No `select` returns only the primary key; `select: ["*"]` is for inspecting one row, not for lists. A FlowField in `select` needs `include: { flowFields: true }`.
- `top` defaults to 100 and caps at 1000; `@nextLink` continues a page; without `orderBy` paging is keyset and cheap, with it every skipped row is re-scanned against a 100,000-row budget. Sort small results client-side.
- Totals are server-side `aggregate` calls on stored fields, one per group, in parallel; counting is `count: true` or `aggregate: { count: true }`.
- `discover` returns at most `top` rows with no continuation marker: narrow by publisher or caption range when the count equals `top`.
- `describe` is cached and revalidated per call; describe the tables the question needs, not every table in the tenant.
- A result over roughly 50,000 characters is saved to a file by Claude Code: process it with a script instead of reading it.

## Writing safely

Read the row first; send `etag` on `modify`/`delete` and a fresh `idempotencyKey` on every write; send only the fields that change; never echo a masked rendering; verify by reading back; one record per call, a few in parallel for a batch, stop on the first unexpected failure. Posting commits at once and is never rolled back by Wicket: run the same call with `preview: true` first (it returns the entries, or why it would fail, and never posts), and never post twice. Full rules, replay semantics and the posting checklist: [writes](references/writes.md).

## Presenting

A sentence for a fact, a chat table up to a dozen rows, an artifact page or dashboard when the user wants to look at or filter the data, a Claude Docs document for a shared report, an `.xlsx`/`.csv` for Excel or another system, `wicket_page_url` for a record a person must act on. Load the `artifact-design` and `dataviz` skills before building a page; a page can even query Wicket live in Claude Code. Rules and recipes: [presenting](references/presenting.md).

## Automating

Parallel reads in one turn; subagents for fan-out that would flood the context; `modifiedAfter` watermarks from `serverTime` for incremental sync (inclusive, so upsert on the key; FlowField changes do not bump `SystemModifiedAt`, so sync the ledger too); `/loop` for checks during a session; a scheduled script against the MCP server or the endpoint for unattended pulls; cloud routines only once Wicket is reachable as a connector. Details: [automation](references/automation.md).

## Common mistakes

| Mistake | Instead |
|---|---|
| `Balance (LCY) gt 1000`, `No. eq '10000'` | `"Balance (LCY)" gt 1000`, `"No." eq '10000'` |
| `"Document Type" eq 'Order'` | `"Document Type" eq 1` (ordinal from `describe` `options`) |
| `aggregate: { sum: ["Balance (LCY)"] }` on Customer | sum `Amount (LCY)` on Detailed Cust. Ledg. Entry 379 |
| Fetching rows to count them | `count: true` or `aggregate: { count: true }` |
| Trusting a `discover` of exactly `top` rows | Narrow by `publisher` or caption range and merge |
| `wicket_invoke` on a posting codeunit, or setting a status field, after an action was refused | Report the gate (`unknown-action` or `action-disabled`) and what the administrator must enable |
| One `wicket_page_url` per row when the user wants to browse a list | A list-page link and the filter to apply; one call per record only when the user asks for a link to each (there is no batch form) |
| Describing every table of a tenant | `discover` plus counts; describe what the question needs |
| Writing record values or masked renderings into the tenant map | Structure only |
| Pasting hundreds of rows, or `@recordId`/`@etag` handles, into the chat | A file, a page, a summary |

# Tool reference

The 24 `wicket_*` MCP tools, in workflow order. Every tool that reaches Business Central (BC) accepts `connection: "<name>"` to target one configured connection for that call. A failed call returns an RFC 7807 problem as the tool error: read `detail` (the fix in words) and `suggest` (a machine hint such as the closest field name) before retrying. Recovery per error slug: `references/errors.md`.

## wicket_connections

Lists the configured connections: `name`, `tenantId`, `environment`, `companyId`, `authMode` (`client_credentials`, `device_code` or `browser`), `readOnly`, `unmask` (only when the connection sets it), `isDefault`, `isSelected`. Local, free. Call it once when more than one connection may exist, then pass `connection` on every call rather than switching with `wicket_use`. A `readOnly` connection refuses `insert`/`modify`/`delete`/`invoke`/`action` before anything is sent. When nothing usable is configured, the answer also carries `problem` (`missing`, `invalid` or `dangling-default`), and an entry set aside for a bad value is listed under `rejected` with its reason: offer `/wicket:setup`.

## wicket_whoami

`{ userSecurityId, userId, company, readOnly, fieldPolicy, strongEtag, unmaskGranted, activeExceptions, serverTime }` — the principal and company the connection resolves to and the endpoint posture. One small call; cheaper than `wicket_capabilities` when identity is all you need. `serverTime` is the watermark to store for an incremental sync. A `device_code` connection answers `401 sign-in-required` with a URL and code until the user has signed in: show them, then retry. A `browser` connection answers the same problem without a code: a sign-in window has opened, so ask the user to finish there, then retry.

## wicket_capabilities

The endpoint's self-description (about 5 KB). Read: `limits` (`defaultTop` 100, `maxTop` 1000, `scanBudget` 100000, `maxInMembers` 20, `maxSelectFields`, `maxFilterLength`), `readOnly`, `exposureMode` (`Open` or `Allowlisted`), `fieldPolicy` (mode, classification verdicts, your `principal` grants), `apiRouting.mode` (`Prefer` allows `wicket_api_read`; `Off` means `wicket_query` only), `async.enabled` (whether `wicket_query_deliver` can work), `actions` (every enrolled business verb with `enabled`, `mutating`, `previewSupported` and `argsSchema`; empty means no action companion is installed, `enabled: false` means an administrator has not allowed that verb), `structureVersion` (moves when apps change). Once per connection per session, and again after `wicket_use`.

## wicket_map

The tenant map: Markdown notes per connection about what `describe` cannot say — what a solution table is for, its business key versus primary key, how it joins to core tables, what option values mean in practice, which API page covers it, gotchas. Stored on this machine at `~/.config/wicket/maps/<connection>.md` (outside any repository), 128 KB cap, sections are `## ` headings, one per table or topic. `read` first when a question touches data you do not recognise; it reports `stale: true` when apps changed since the last write, so re-verify a section with `wicket_describe` before trusting it. `upsert { section, content }` replaces one section; `remove { section }` deletes one. Structure only: never a record value, name, amount, e-mail, document number or anything that came back masked.

## wicket_discover

`kind`: `tables`, `codeunits`, `companies` or `apis`. `filter` is a plain AL filter on the object **caption** (`"*Contract*"`, `"..M"`, `"M.."`), not the `$filter` grammar and not the object name: captions are localized (German on a German-language tenant) and an ISV's captions may lack its name prefix, so split a large tenant by `publisher`, an AL filter on the owning app's publisher (`"<>Microsoft"` for everything custom, `"<>Microsoft&<>Contoso"` for the custom tables without one vendor's suite, `"Contoso"` with caption ranges for that suite itself); each row carries `app { id, name, publisher, version }`. `top` defaults to 100 and silently truncates: pass up to 1000 or narrow the filter. A 1000-row answer is about 470 KB and takes a while: run one such discover at a time, never two in parallel, and expect the host to save it to a file. Rows carry `permissions { read, insert, modify, delete }` from your BC permissions. For codeunits the list is what the exposure mode lets you see — in `Open` mode with Setup *Allow Invoke In Open Mode* on that is every reachable codeunit, otherwise only enrolled ones — and `permissions.invoke: true` does **not** mean a procedure is callable; only `wicket_describe kind:"codeunit"` lists the enrolled procedures (empty means nothing is callable). For `apis` prefer `wicket_apis`, which caches the catalog.

## wicket_describe

The schema for one object. `kind:"table"` with `tableId`: use `summary: true` by default — it returns `app`, `primaryKey` (field numbers), `keys` (indexes you may sort by), and `fields` as `{ no, name, type, length, class?, access?, writable?, relation?, options? }` where an absent `class` means a stored (`Normal`) field and `class: "FlowField"` a computed one; an absent `access` means clear, `access: "masked"` a masked rendering and `access: "hidden"` a restricted field the tenant chose to advertise (not readable); an absent `writable` means writable; `relation` is `"18"` or `"18.1"` (table, field); `options` maps each Option/Enum member's ordinal to its name (`{ "0": " ", "1": "Ship", "50000": "Member" }`) — the ordinal is what you filter with, and extended enums use ordinals such as 50000, so never count positions. Ask for the full answer only when you need captions, classifications or option captions. Answers are cached per connection and revalidated with the endpoint on every call (`fromCache: true` means unchanged), so describing again is cheap. `referencedBy: true` adds the fields of other tables that point at this one (how custom tables hanging off Customer or Item are found); it scans all field metadata, so ask when mapping relations, not by default. `kind:"codeunit"` lists the enrolled procedures with their `argsSchema`. `kind:"api"` with a `pageId` says whether `wicket_api_read` may read through that page (`routable`) and which fields are `readable`. Note: the `$systemId` field may show as masked; query rows still carry `@systemId` in clear.

## wicket_apis

The tenant's API catalog (pages and queries, routes such as `v2.0/customers`, source table, operations), cached per environment and revalidated with one cheap call. Without arguments it returns a summary by route prefix; `tableId`, `search` or `group` list entries. The answer carries `apiRouting`: read it before considering `wicket_api_read`.

## wicket_api_read

Reads rows through one of the tenant's API pages (`pageId` from `wicket_apis` or a table's `apiRoutes`) when `apiRouting` is `Prefer`: a stable contract with the API's own camelCase field names. It checks governance fresh on every call and refuses with `suggest: { use: "wicket_query", tableId }` when routing is off or no field is readable; a field you name that is not readable is `403 field-restricted` with `suggest.fields` (the readable names) and an unknown one `400 unknown-api-field`. `select`, `filter` (OData over the API's fields), `orderBy`, `top` (default 100, max 1000), `skip` (pass back `@nextSkip`), `count`. Not recorded in the Wicket Operation Log. Use `wicket_query` when routing is `Off`, when the API lacks a field, or when the user asks for dynamic access.

## wicket_query

Reads rows from one table. Inputs: `tableId`; `select` (field names) or `selectFieldNo`, never both — **without either you get only the primary key**; `select: ["*"]` alone returns every readable stored and FlowField field (narrowed by the field policy; refused with 413 when the readable set exceeds `maxSelectFields` — select explicit fields then); `filter` (`references/filters.md`); `orderBy` (`["Name asc"]`, one direction, indexed fields only, never a FlowField — omit it for deep paging and sort client-side); `top` (default 100, max 1000); `count: true` adds `@count`, the total for the filter; `include: { flowFields: true }` is required for a FlowField in `select` to be computed; `modifiedAfter` / `modifiedBefore` (ISO 8601) bound `SystemModifiedAt` for incremental sync and must not be combined with a `filter` on that field; `cursor` (pass back `@nextLink`) or `skip` for paging. `aggregate: { count?, sum?: [fields], avg?, min?, max? }` composes with `filter` (optional) and the modified window and with nothing else, and returns one summary object instead of rows; `sum`/`avg` accept numeric **stored** fields only — a FlowField such as `Balance (LCY)` is refused with `400 invalid-aggregate`, so aggregate the table it is computed from (`references/tables.md`). Rows carry `@recordId` (opaque handle for `modify`/`delete`/`readBlob`), `@systemId` (the stable GUID for `action` targets and `pageUrl`), `@etag` (concurrency token) and, when present, `@masked` (fields whose values are renderings, not data). The three handles are always present and usable whatever the field policy says about the underlying system fields. Option values arrive as `{ ord, name }`; empty text as `null`; dates `YYYY-MM-DD`; large decimals as strings. `@pagingMode` is `keyset` without `orderBy` (each page costs only its own rows) and `offset` with it (skipped rows are re-scanned against the 100,000-row scan budget). Binary fields are dropped: use `wicket_read_blob`. A `deliver` block is refused here: use `wicket_query_deliver`.

## wicket_query_all

`wicket_query` that follows `@nextLink` to the end and returns one `value` array, with `@pages`, `@count` (when `count: true`), and `@truncated: true` plus a resume `@nextLink` when it stops at `maxRows` (default 5,000, max 50,000) or `maxPages` (default 100). A page failure after the first returns the rows so far with `@error`. No `aggregate`, no `deliver`. Size it: get `@count` first, set `maxRows` just above it, select only the needed fields, omit `orderBy`. A result this large is for a file or a script, not for reading in the chat; hosts that save an oversized tool result to a file (Claude Code does, above roughly 50,000 characters) let you process it with a script. Budget about 300 characters per row: the three handles roughly double a five-field row, so 150 such rows already reach that threshold.

## wicket_read_blob

One binary field (`type` `BLOB` or `Media` in `describe`) of one record as `{ contentType, bytesBase64 }`; decode the base64 yourself. Up to 10 MB; a MediaSet field is `422 mediaset-unsupported`; an empty field `404 empty-blob`; a non-binary field `400 not-binary`. Takes the row's `@recordId` and the field number from `describe`.

## wicket_insert

Creates one record: `values` by field name (or `valuesByFieldNo`), coerced to AL types and validated field by field. Option values as the member name, the ordinal, or `{ ord }`; `null` clears a field. `init: false` skips the insert trigger and is refused unless the tenant allows trigger bypass. Returns `{ recordId, @etag }`. Send an `idempotencyKey` so a retry after a lost response replays instead of inserting twice. A failed validation is `422 validation` with `suggest.field`.

## wicket_modify

Updates one record by `recordId`: send `etag` from your most recent read of the row (a mismatch is `412 precondition-failed`: re-read, re-apply, retry with the new `@etag`), only the fields that change in `values`, and an `idempotencyKey`. Primary-key fields are immutable (`400 pk-immutable`: insert a new record and delete the old one). Never send back a masked rendering (`400 masked-value`). `validate: false` skips field validation and is refused unless the tenant allows trigger bypass. Returns `{ recordId, @etag }` with the new token.

## wicket_delete

Deletes one record by `recordId` with `etag` and an `idempotencyKey`. Returns `{ deleted: true, recordId }`.

## wicket_invoke

Runs one procedure enrolled in the Wicket Procedure Catalog (`codeunitId`, `procedure`, `args` object). Nothing else is callable, whatever `wicket_discover` lists: `wicket_describe kind:"codeunit"` is the only source of truth. Synchronous. When you send no `idempotencyKey` the server mints one and returns it as `@idempotencyKey`: reuse it verbatim to retry the same call. Prefer `wicket_action` for business operations such as posting.

## wicket_action

Runs a named business action from the deny-by-default Action Catalog: `action` (a verb from `capabilities.actions` with `enabled: true`, such as `post-sales`; its `argsSchema` names the arguments), `target: { systemId }` (a row's `@systemId`), `args` (verb-specific, such as `{ ship: true, invoice: true }`), `preview: true` (only when the verb's `previewSupported` is true: returns `{ preview, wouldPost, errors, entries, glAccounts }` and never posts). Gates in order: `403 read-only` (not for a preview or a `mutating: false` verb, which run inside a forced rollback) and `403 role-forbidden` (checked before any handler), then `404 unknown-action` (not enrolled or no companion installed), `403 action-disabled` (enrolled, `Allow Run` off — an administrator enables it per action and company), `400 preview-unsupported`, `422 action-failed` (the BC error text is in `detail`). A posting commits immediately and is never rolled back by Wicket; see `references/writes.md` before running a mutating verb. The server mints an `@idempotencyKey` when you send none; reuse it to retry a lost response.

## wicket_query_deliver

The query inputs plus a required `deliver: { mode: "azureBlob", package?: "ndjson"|"json"|"zip", scheduleAt? }`: the query runs in the background under your identity and the result is written as a package to Azure Blob Storage. Only when `capabilities.async.enabled` is true (`403 async-not-configured` otherwise). Returns an acceptance `{ @async: true, requestId, status, packageUrl?, scheduledFor, expiresAt, statusVia }` at once; `packageUrl` 404s until the package is written and a scheduled request withholds it until completion — take the signed URL from `wicket_status` once `status` is `succeeded`. Escapes the scan budget and inline paging: the right tool for a large export when it is configured. Pass an `idempotencyKey` so a resubmit replays to the same request. `scheduleAt` is one-shot (no recurrence), within `maxScheduleAheadDays`. The package respects the field policy exactly as an inline read would, but `packageUrl` is a bearer link: whoever holds it can download the package until `expiresAt`, so share it no more widely than the data itself.

## wicket_status

The lifecycle projection of one async request (`queued`, `scheduled`, `running`, `succeeded`, `failed`, `cancelled`, `expired`), with `progressRows`, `resultRowCount`, `resultBytes`, `expiresAt`, `packageUrl` (freshly signed, only once succeeded) and `problem` on failure. Poll it; the server never polls for you.

## wicket_requests

Your own async requests, newest first, optionally filtered by `status`, `top` up to 100. Caller-scoped: nobody else's requests are ever visible.

## wicket_cancel

Cancels one async request: outright before it starts, cooperatively while running, a no-op once finished.

## wicket_page_url

A BC web-client deep link for one record: `table` (a name such as `"Customer"` or `"#36"`), `systemId` (preferred) or `recordId`, optional `pageId`. Without `pageId` the server picks the table's default lookup page, which for document tables is often the **list** (Sales Header opens page 45): pass the card page when a person should act on the record (`references/tables.md` lists common card pages). The link opens under the viewer's own BC login and permissions. Requires read exposure on the table.

## wicket_skill

This guide, with progressive disclosure: `mode:"toc"` (default) lists every file and section; `mode:"section"` with a section title or a reference file name (`filters`, `errors`, `writes`, `presenting`, `automation`, `tables`, `protocol`, `tools`) returns that text; `mode:"full"` returns everything (large). Local and free.

## wicket_setup

Shows, adds, fixes, re-defaults and removes connections, and works when none is configured. In Claude Code, `/wicket:setup` drives it with questions; elsewhere follow its description. The add path is `locate` (a BC address, email or domain) → `signin` (`browser`, `device_code` or `client_credentials`; call it again while it answers `pending`) → `environments` → `companies` (pass the address's `companyName` to get its `match`) → `save`, which tests the new connection with `whoami`. `status` checks each connection without prompting a sign-in and names its company, sign-in method and read-only setting; `/wicket:setup view` shows that and changes nothing. Confirm with the user before `remove`. A client secret never passes through it: the user stores it in the Keychain themselves.

## wicket_use

Switches the session's default connection. Avoid it: a per-call `connection` is race-free, while a session switch can flip the connection under a parallel call. After any switch, every handle from the old connection (`@recordId`, `@etag`, `@systemId`, cursors, async `requestId`) is invalid, and `wicket_capabilities` must be read again.

## Field policy in practice

Every tenant applies a per-field read/write policy on top of table exposure (`capabilities.fieldPolicy.mode`: `AllFields`, `ByClassification` — the fresh-install default, which clears customer content and system metadata, masks personal identifiers and hides everything else — or `Explicit`). What it means for a call:

- The readable and writable field set differs per tenant, per principal and over time: take it from `wicket_describe` every session, never from a remembered list; a hidden field is simply absent from `fields`, and `select: ["*"]` silently narrows to what you may read.
- A masked field is readable as a rendering (`****1234`, a hashed token, `null` for a masked Boolean or option) and each row lists such fields in `@masked`; naming one in `filter`, `orderBy`, `aggregate`, the modified window or `readBlob` is `403 field-masked`, and echoing a rendering in a write is `400 masked-value`.
- Primary-key fields are always readable and writable, and `@recordId` embeds the primary-key values in base64: a table whose key is itself sensitive is not protected by hiding its other fields.
- Masking follows each field's own data classification, not the concept: `Assigned User ID` on a document may be masked while `User ID` on User Setup is clear, and a custom table can expose a person's details that the member table masks. Read each table's `describe` rather than assuming.
- Some principals hold unmask grants (`whoAmI.unmaskGranted`, `activeExceptions`); a connection configured `unmask: false` never uses them. There is no way to ask for more visibility than the policy grants.
- Nothing masked or hidden belongs in a file, a page, a doc or the tenant map.

# Filter cookbook

`filter` on `wicket_query` and `wicket_query_all` is a bounded OData `$filter` subset translated to Business Central's `SetFilter`. Anything outside the forms below is `400 invalid-filter`, with `detail` naming the offending token and `suggest.field` when a field name was nearly right.

## Filter syntax

| You want | Write |
|---|---|
| Equality on a Code or Text field | `"No." eq '10000'`, `Name eq 'Acme'` |
| Field name with a space, dot, slash or parenthesis | double-quote it: `"Posting Date"`, `"Balance (LCY)"`, `"Country/Region Code"`, `"No."` — only `[A-Za-z0-9_]` names may stay bare |
| Field by number instead of name | `#4 ge 2025-01-01` (localization-proof) |
| Numbers, dates, date-times | `Amount gt 1000`, `"Posting Date" ge 2025-01-01` (bare, no quotes), `SystemModifiedAt gt 2026-01-01T00:00:00Z` (field 2000000003; for a sync window prefer `modifiedAfter`) |
| Option or Enum field | by **ordinal**: `"Document Type" eq 1`, `Status eq 0`. Take the ordinal from `wicket_describe summary:true`, whose `options` maps ordinal to member name (extended enums use ordinals such as 50000, so never count positions). Member names depend on the session language and are rejected on non-English tenants. A blank member is usually ordinal 0; check `options`. |
| Boolean field | `"Privacy Blocked" eq true` (bare `true`/`false`) |
| AND, any number of terms | `"Country/Region Code" eq 'US' and Blocked eq 0 and "Balance (LCY)" gt 0` — one field may appear at most twice, and then only as a numeric, date or date-time range (`ge` with `le`); two conditions on a text field, or a function plus a comparison on the same field, are `400 invalid-filter` |
| OR on the same field | `"No." in ('10000','20000','30000')` — at most 20 members, each exact |
| Prefix, suffix, substring | `startswith(Name,'Acme')`, `endswith(Name,'ltd')`, `contains(Name,'co')` |
| Blank / non-blank | `"VAT Registration No." eq null` (or `eq ''`), `ne null` for "has a value" |
| Apostrophe inside a string | double it: `Name eq 'O''Brien'` |
| Changed since a watermark | not in `filter`: use `modifiedAfter` / `modifiedBefore` on the query |

## Not supported

- **Cross-field OR** (`Name eq 'x' or City eq 'x'`): run one query per field and merge client-side, de-duplicating on `@systemId`.
- **Standalone `not`**: invert the comparison (`ne`, `lt`).
- Arithmetic, lambdas (`any`/`all`), `cast`/`isof`, navigation (`Customer/Name`), `$expand`, joins. One table per call: read the relation from `describe` and query the related table with the key values in an `in (...)` list.
- A masked field in `filter`, `orderBy`, `aggregate` or the modified window (`403 field-masked`).

## Value rules

- Comparisons and `in (...)` members are exact; `*` and `?` are literal there. Inside `startswith`/`endswith`/`contains` they are live BC wildcards (any run / one character) with no escape, so avoid them in those values unless you mean them.
- `Code` fields are stored upper-case; write `'US'`, not `'us'`.
- Text values are never trimmed: leading and trailing spaces are data.
- Names and places with accented letters often exist in both accented and ASCII spellings (`Zürich` and `Zurich`): search with a prefix that stops before the first accented character, or run both spellings, and remember that `contains` is case-sensitive on Text fields.
- `eq null` and `eq ''` both mean the field's blank value (empty text, `0D`, `0DT`, `0`).
- A filter longer than `limits.maxFilterLength` (2048) is `413`: split it.

## Sorting (`orderBy`)

- `["Name asc"]` or `["Amount desc"]`; field names are written bare here, never quoted (`"Balance (LCY)" desc` is `400 unknown-field`). All terms must share one direction.
- The fields must match a key listed by `wicket_describe` (`keys`), so a FlowField or an arbitrary column is `400 invalid-orderby`. Descending works only on indexed fields.
- With `orderBy` paging is offset-based and every skipped row counts against the 100,000-row scan budget; without it paging is keyset and each page costs only its own rows. For anything beyond a page or two, omit `orderBy` and sort the result client-side.
- A key whose later fields are hidden by the field policy is refused (`403 field-restricted`) because the tie-break order would leak them.

## Worked filters

```text
Open sales orders:                 tableId 36, filter "\"Document Type\" eq 1 and Status eq 0"
Posted invoices in a month:        tableId 112, filter "\"Posting Date\" ge 2026-09-01 and \"Posting Date\" le 2026-09-30"
One customer's ledger:             tableId 21, filter "\"Customer No.\" eq '10000'"
US, unblocked customers:          tableId 18, filter "\"Country/Region Code\" eq 'US' and Blocked eq 0"
Items of a vendor, by prefix:      tableId 27, filter "\"Vendor No.\" eq 'V-10' and startswith(\"No.\",'A-')"
Changed today (sync):              tableId 18, modifiedAfter "2026-10-14T00:00:00Z", filter "Blocked eq 0"
```

# Error recovery

Every failure is an RFC 7807 problem `{ type, title, status, detail, instance, operation, suggest? }` returned as the tool error. `type` ends in a stable slug; `status` is the logical HTTP status (the transport itself is always 200). Branch on the slug, read `detail` (the fix in words) and apply `suggest` (`field`, `fields`, `use`, `kinds`, `procedures`, `actions`, `sections`, `tighten`, `paging`) before guessing. `instance` carries the request id for support.

## Fix the request (400)

| Slug | Cause | Do |
|---|---|---|
| `invalid-filter` | A form outside the grammar, an unquoted field name with spaces, an option member name, a malformed `in (...)`, cross-field `or`, standalone `not`, a field used more than twice or twice other than as a numeric/date range | Rewrite per `references/filters.md`; take `suggest.field` when offered |
| `invalid-field` | A member of the wrong JSON type (a numeric string for `tableId`, `null` instead of omitting), an inverted modified window, a `filter` on `SystemModifiedAt` together with the window, more than 5 `languages`, non-object `args` | Fix the member `detail` names; numbers as numbers, booleans as booleans, omit rather than `null` |
| `missing-field` | A required `data` member is absent | Add it |
| `unknown-field` | A field name does not exist on the table | Use `suggest.field` (closest match) or `wicket_describe` |
| `unknown-kind` | Bad `discover`/`describe` kind | One of `suggest.kinds` |
| `select-and-selectFieldNo` / `invalid-select` | Both select forms, or `"*"` mixed with names | One form; `"*"` alone |
| `invalid-aggregate` | Aggregate combined with a row-plane key, an unknown key, or `sum`/`avg` on a FlowField or non-numeric field | Aggregate with `filter` only; sum the stored field of the table the FlowField is computed from (`references/tables.md`) |
| `invalid-orderby` | Mixed directions, or fields that match no key | One direction; a key from `describe`, or no `orderBy` and client-side sort |
| `invalid-cursor` | A cursor from another table, query shape or connection | Pass `@nextLink` back unchanged with the same query, or restart |
| `record-table-mismatch` | A `recordId` from another table | Re-query the right table |
| `not-binary` | `readBlob` on a non-binary field | A `BLOB`/`Media` field from `describe` |
| `pk-immutable` | `modify` would change a primary-key field | Insert a new record, delete the old |
| `masked-value` | A `modify` echoed a masked rendering | Send only fields with genuinely new values |
| `idempotency-key-required` | `invoke`/`action` without a key while the tenant requires one | Add a fresh key |
| `invalid-deliver` / `async-unsupported-op` / `use-deliver-tool` | Bad `deliver` block, or `deliver` on a non-query / on `wicket_query` | `wicket_query_deliver` with `mode: "azureBlob"` and a future `scheduleAt` within the limit |
| `preview-unsupported` | `preview: true` on a verb without `previewSupported` | Drop `preview` |
| `invalid-mode` | Bad `skill` mode | `toc`, `section` or `full` |
| `invalid-envelope` | The envelope itself is malformed (HTTP clients only; the MCP server builds it) | Fix the member `detail` names (`references/protocol.md`) |
| `unknown-api-field` (MCP) | A `wicket_api_read` field the API does not have | A name from `suggest.fields` |
| `invalid-route` (MCP) | An API route not from the catalog | Take the route from `wicket_apis` |
| `map-invalid` (MCP) | A tenant-map section name or content broke a rule (empty, multi-line, `## ` inside, over 128 KB) | Follow `detail` |

## Access and policy (403): fix the setup, do not retry blindly

| Slug | Cause | Do |
|---|---|---|
| `not-exposed` | The table or codeunit is not enrolled in Wicket Exposure (Allowlisted mode), or your BC permissions lack it; also gates `pageUrl` and `deliver` | An administrator enrols it or switches the mode; `describe` to confirm permissions |
| `field-restricted` | You named a field the policy hides (`select`, `filter`, `orderBy`, `aggregate`, `readBlob`, a write), an index whose later field is hidden, or a non-existent field number | Drop it; `describe` shows what is readable and writable |
| `field-masked` | A masked field in `filter`, `orderBy`, `aggregate`, an effective key, the modified window or `readBlob` | Drop the masked field from that clause |
| `read-only` | A write or a mutating `action` while the endpoint is read-only (an action preview and a `mutating: false` verb still run) | Reads and previews only until an administrator lifts it; check `capabilities.readOnly` |
| `connection-read-only` (MCP) | A mutating tool on a connection marked `readOnly` in the MCP server; nothing was sent | Pass `connection` naming a writable one |
| `role-forbidden` | The principal's Wicket role is below the operation (`Execute` for invoke/action, `Edit` for writes) | A human assigns the rung `detail` names |
| `trigger-bypass-disabled` | `init: false` / `validate: false` while the tenant forbids it | Omit the member |
| `invoke-disabled` / `action-disabled` | Enrolled, but `Allow Run` is off | An administrator enables it; the same idempotency key can then be reused |
| `async-not-configured` | `deliver` on a tenant without a usable async configuration | Read inline or page; an administrator completes the setup |
| `replay-withheld` | A resend under a key whose original request completed, but whose stored result you may no longer see (`originalStatus`, `reason`) | It already happened: never repeat it under a new key |
| `api-not-routable` (MCP) | `wicket_api_read` while routing is `Off` or the source table is not readable | `wicket_query` on `suggest.tableId` |

## Not found (404)

| Slug | Cause | Do |
|---|---|---|
| `unknown-table` / `unknown-codeunit` / `unknown-api` | The id does not exist | `wicket_discover` / `wicket_apis` |
| `unknown-record` | A stale or foreign `recordId`/`systemId`, or a record outside your security scope | Re-query for a current handle |
| `unknown-procedure` | Not enrolled | `suggest.procedures` or `describe kind:"codeunit"` |
| `unknown-action` | The verb is not enrolled, or no action companion is installed | `capabilities.actions` / `suggest.actions`; ask for the companion when the list is empty |
| `no-page` | `pageUrl` on a table without a default lookup page | Pass `pageId` |
| `empty-blob` | The media field has no content | Nothing to fetch |
| `unknown-request` | An async request that is unknown, malformed or not yours | A `requestId` from your own submit or `wicket_requests` |
| `unknown-operation` | The operation name is not one of the sixteen (HTTP clients) | One of `suggest`'s operations |
| `unknown-section` | `skill` section matching no `## ` heading | A title from `suggest.sections` |
| `skill-not-configured` | The endpoint has no hosted guide | Irrelevant through MCP: `wicket_skill` is local |

## Concurrency and idempotency (409, 412)

| Slug | Cause | Do |
|---|---|---|
| `precondition-failed` (412) | Your `etag` is stale | Re-read, re-apply your change, retry with the new `@etag` |
| `etag-required` / `no-etag-available` | The tenant requires an etag and you sent none, or the table has no system fields | Read the row first; a table without system fields cannot be written under that setting |
| `idempotency-conflict` | The same key with a different `{ operation, data }` | A fresh key for a new request; the identical request to replay |
| `idempotency-in-progress` | The same key is still executing | Wait, then resend the identical request |
| `idempotency-indeterminate` | The earlier attempt's outcome is unknowable (session died) — it may have taken effect | Query the affected records; only then retry with a **new** key |

## Limits (413, 422, 429)

| Slug | Cause | Do |
|---|---|---|
| `payload-too-large` | `filter` over 2048 characters or more than `maxSelectFields` fields | Split the filter; select fewer fields |
| `blob-too-large` | A binary over 10 MB | Not readable inline |
| `scan-budget` | One page examined more than 100,000 rows | Add a filter on an indexed field (`suggest.tighten`); drop `orderBy` for keyset paging (`suggest.paging`) |
| `aggregate-overflow` | A sum does not fit its type (an Integer past 2,147,483,647) | Narrow the filter or aggregate in slices |
| `mediaset-unsupported` | `readBlob` on a MediaSet | An individual Media/Blob field |
| `too-many-requests` | More than `maxActiveRequests` async requests in flight | Wait or cancel one; the same key may be resent |

## Business failures (422): read `detail`, it is the BC error text

| Slug | Cause | Do |
|---|---|---|
| `validation` | A field failed `OnValidate` (`suggest.field`) | Fix the value and retry |
| `insert-failed` / `modify-failed` / `delete-failed` | BC raised during the write; nothing of it persisted | Fix the cause and send the corrected request under a **new** key: the 422 is stored under the old one and replays |
| `invoke-failed` | The enrolled wrapper raised | Fix args or state; new key |
| `action-failed` | The posting or action raised — the document may be partly processed (released, numbers assigned, partly shipped) | Re-read the document before anything else; fix it; a **new** key |

## Server and transport (5xx, MCP synthetic)

| Slug | Cause | Do |
|---|---|---|
| `internal` (500) | An unhandled AL error, or a commit failure in which nothing persisted | Reads: retry with backoff. A keyed `insert`/`modify`/`delete`: resend with the **same** key (a 5xx is not stored). A keyed `invoke`/`action`: the same key answers `idempotency-indeterminate` — verify the result first |
| `transport` (HTTP status, MCP) | BC's gateway answered non-200: 401/403 auth, 404 routing, 5xx outage; the handler never ran or its answer was lost | 4xx: fix per `detail` (a 401 was already retried once with a fresh token). 5xx on a write: resend with the same key, or query the records first when you sent none |
| `transport-timeout` (504, MCP) | No answer within 120 s. The first heavy call to an idle sandbox (`capabilities`, a first `describe`) can take that long while the environment warms up, while `whoami` answers at once | Same as a 5xx: a read is retried once; for a slow query also narrow it. Several heavy metadata calls fired in parallel on a cold environment can all time out: retry them one at a time |
| `sign-in-required` (401, MCP) | A `device_code` or `browser` connection needs the user to sign in | Device code: show `verificationUri` and `userCode`. Browser: say a sign-in window opened. Retry after they sign in |
| `connection-unavailable` (503, MCP) | No connection is configured, connections.json cannot be read, the default names nothing usable, or the named connection was set aside for a bad value; nothing was sent | Offer `/wicket:setup` (or `wicket_setup` `status`); `detail` says which |
| *no problem document at all* (a bare error such as "socket connection was closed", "MCP error", a timeout from the host) | The MCP connection itself dropped or the host cut the call; nothing says whether BC ran it | A read: retry once. A write: query the record first, or resend with the same `idempotencyKey` |
| `async-start-failed` (503) | No background worker could start; the request is recorded as failed | Retry shortly |
| `async-upload-failed` / `async-task-failed` / `async-stale` | Worker-side failure, reported on a request's `problem` by `wicket_status` | Read `problem.detail`; resubmit (the same key dedupes) |
| `api-error` (BC's HTTP status, MCP) | Business Central's own API refused a `wicket_api_read` | Read `detail` (BC's message); fall back to `wicket_query` |
| `skill-url-invalid` / `skill-fetch-failed` / `skill-too-large` (502) | The endpoint's hosted guide is misconfigured (HTTP clients) | An administrator fixes the Skill Doc Url; irrelevant through MCP |

# Writing safely

Wicket writes one record per call, through the table's own validation, under the caller's BC permissions, behind a deny-by-default exposure and a per-field policy. The rules below hold on every tenant, whatever its Setup switches enforce: the switches decide whether the server refuses a careless write, never whether a write is safe.

## The write contract

1. **Read first.** Get the row with `wicket_query` (select the fields you will change plus any you need to decide) so you hold a fresh `@recordId` and `@etag`, and `wicket_describe summary:true` so you know which fields are writable and what an option field's members are.
2. **Send the `etag`** on every `wicket_modify` and `wicket_delete`. Without it the write is last-write-wins over anything that changed since your read. A `412 precondition-failed` means the row moved: re-read, re-apply your change to the fresh row, retry with the new `@etag`. A table without system fields (`hasSystemFields: false`) has no etag at all; say so to the user before writing it.
3. **Send an `idempotencyKey`** on `insert`, `modify`, `delete`, `invoke`, `action` and a `deliver` submit: a fresh unique value per logical request (a UUID, or a name tied to the intent such as `cust-10000-phone-2026-10-14`). Reuse it **only** to retry that exact call after a timeout or a lost response: the retry replays the stored result (`"@replayed": true`) instead of executing again. `wicket_invoke` and `wicket_action` mint one for you when you send none and return it as `@idempotencyKey`; reuse that value verbatim to retry.
4. **Send only what changes.** Omit fields you are not changing; never send back a masked rendering (a value listed in the row's `@masked`) — that is `400 masked-value`. Option values as the member name, the ordinal, or `{ "ord": n }`; `null` clears a field.
5. **Let the triggers run.** `init: false` and `validate: false` are refused on most tenants and skip the business rules you rely on. Primary-key fields cannot change (`pk-immutable`): insert a new record and delete the old one.
6. **Verify.** Read the row back after the write (one `wicket_query` on the key) and report what changed. For a person who should see or finish the result, add a `wicket_page_url` link to the card page.
7. **Report honestly.** A `422` carries the BC error text in `detail`: show it. After a `5xx` or timeout the outcome is unknown: resend with the same key, or query the record first when you sent none.

## What is stored under a key, and what is not

Final outcomes are stored: successes and the 4xx answers about the request itself (bad input, a missing record, a business failure such as `422 action-failed`). A corrected request therefore needs a **new** key; the old key keeps answering the stored 4xx. Not stored, so the **same** key is resent once the cause is fixed: every 5xx from the read and write planes, and the refusals an administrator can lift (`read-only`, `role-forbidden`, `not-exposed`, `invoke-disabled`, `action-disabled`, `trigger-bypass-disabled`, `async-not-configured`, `too-many-requests`). Exception: a 5xx from `invoke` or `action` settles the key, because the wrapper may have committed; the same-key resend answers `409 idempotency-indeterminate` and you must check the business result before using a new key. A replay is re-authorized: a stored success you may no longer see answers `403 replay-withheld` — the original request **did** complete, so never repeat it under a new key.

## Many records

There is no bulk write. For a batch: resolve all rows first (one query with an `in (...)` filter, or a filtered `wicket_query_all`), then write them one call each with their own etag and key, a few in parallel, and stop at the first unexpected failure rather than ploughing on. Report counts: written, skipped, failed, with the failures' `detail`. For hundreds of rows, say so before starting and ask whether a BC-side batch (a journal, a configuration package) is the better tool.

## Business actions (`wicket_action`) and posting

`wicket_action` runs a named verb (`post-sales`, `post-purchase`, `post-gen-journal`, `post-item-journal`, `release-sales`, `reopen-sales`, `release-purchase`, `reopen-purchase`, `make-order-from-quote`, `make-invoice-from-quote`, `make-purchase-order-from-quote`, and the read-only `document-pdf` and `item-availability`) from the Action Catalog of an installed companion app; `wicket_invoke` runs a raw enrolled procedure. Prefer `action`: it is discoverable, read-only-aware and named by business intent. Never work around a refused action by editing document fields (setting a status, a posting flag, a quantity) — that does not post anything and leaves the document inconsistent.

Before a mutating verb:

- **Is it available?** `capabilities.actions` lists every enrolled verb with `enabled`. Empty means no action companion is installed; `enabled: false` means an administrator must switch on Allow Run for that verb in this company (say exactly that, do not probe). `argsSchema` on the verb names its arguments. A refusal from those gates is not stored under the idempotency key: once an administrator enables the verb, the same request can be resent as it was. `capabilities.readOnly` must be false for the real post (a preview runs either way).
- **Preview it** (`previewSupported` on the verb — the four `post-*` verbs). Send the same call with `preview: true`: one call runs Business Central's posting preview and returns `{ preview: true, wouldPost, errors, entries, glAccounts }` without posting. `wouldPost: false` with `errors` (Business Central's reasons, in the session language) means the post would fail: report the reasons, do not post, do not hand-edit around them. Otherwise show the user `entries` (per ledger: count, G/L `debit`/`credit`, VAT `amount`, customer/vendor `amount`, item `quantity`) and `glAccounts` before posting. This replaces a hand-built pre-flight. A preview runs inside a forced rollback: it never posts, needs no key, does not consume a number, and works on a read-only endpoint.
- **Check the flags.** Ship/receive and invoice (`args` such as `{ ship: true, invoice: true }`) are what the user asked for; the preview applies them too.
- **Key it.** One fresh key per post; the same key to retry a lost response. A `422 action-failed` is stored under that key: fix the document and use a new key.

After a mutating verb:

- **Posting commits immediately** and is outside any Wicket rollback. Treat it as the last write of the request.
- **A failed post can leave committed changes** (the document released, numbers assigned, an order partly shipped). Re-read the document before retrying.
- **`postCommitWarning` + `postCommitEvidence`** mean the posting succeeded but later code failed: the document **is** posted — surface the warning, never post again.
- **Release and reopen** (`release-sales`, `reopen-sales`, `release-purchase`, `reopen-purchase`) are what the document page's Release and Reopen actions do: approval and prepayment rules apply (a document pending approval is refused). Use them instead of editing `Status`. Result: `{ released | reopened: true, sourceDocumentType, sourceNo, status, changed }` — `changed: false` means it already had that status.
- **Quote conversion** (`make-order-from-quote`, `make-invoice-from-quote`, `make-purchase-order-from-quote`) is the quote page's Make Order / Make Invoice: it checks the customer or vendor, copies the lines and **deletes the quote** — say so before running it. Result: `{ converted: true, sourceNo, quoteDeleted, createdDocumentType, createdNo, createdSystemId }`; continue with `createdSystemId`. A sales quote tied to an opportunity in progress is refused (`422`): the opportunity has to be closed in Business Central first.
- **Answers Business Central computes** need no pre-flight: `item-availability` `{ itemNo, locationCode?, variantCode?, date?, quantity? }` returns `inventory`, `grossRequirement`, `scheduledReceipt`, `availableToPromise` (and with `quantity`, `earliestAvailableDate`, null when not within the look-ahead) — use it instead of summing ledger entries to promise a delivery. It and `document-pdf` are `mutating: false`: they run inside a forced rollback, need no key and work on a read-only endpoint.
- Result shapes: `post-sales` `{ posted, sourceDocumentType, sourceNo, postedShipmentNo?, postedReturnReceiptNo?, postedInvoiceNo? }` (`postedInvoiceNo` is the credit memo number for a credit memo or return order); `post-purchase` the receipt/return-shipment/invoice equivalents; `post-gen-journal` / `post-item-journal` `{ posted, template, batch, glRegisterNo | itemRegisterNo, firstEntryNo, lastEntryNo }` or `noEntriesPosted: true`.

## Who may write

`Wicket - Read` cannot write or run anything; `Wicket - Execute` adds `invoke`/`action`; `Wicket - Edit` adds `insert`/`modify`/`delete`. A call below the principal's rung is `403 role-forbidden` before anything runs — a human assigns the rung `detail` names; retrying cannot help. On top of the rung, the principal needs the normal BC permissions, and the table must be exposed for that operation unless the mode is `Open`. A connection marked `readOnly` in the MCP server refuses all five mutating tools client-side, and the endpoint's own read-only mode refuses them server-side (actions included, previews too).

# Presenting results

Business Central data is rarely best read as JSON in a chat. Pick the medium by who will use the result and how much there is, then shape the data for it.

## Choose the medium

| Situation | Medium |
|---|---|
| A number, a yes/no, two or three facts | A sentence, with the unit and the as-of time |
| Up to about a dozen rows and six columns | A chat table: units and currency in the header, dated rows newest first, no column you cannot fill |
| More rows, or the user wants to sort, filter, drill or "look at it" | An artifact page: a sortable table, or a dashboard with KPI tiles and charts (Claude Code's Artifact tool, or a claude.ai artifact) |
| A report other people will read, comment on or edit | A Claude Docs document, with charts built from the rows (at most 2,000 rows per chart source) |
| Data for Excel, a CRM or another system | A file: `.xlsx` (the `xlsx` skill when its dependencies — openpyxl, LibreOffice — are present; on a bare machine write the workbook with the standard library as a zip of XML parts, no formulas) or `.csv` (UTF-8 with a BOM and `;` as separator for Excel in a decimal-comma locale, which otherwise needs Data › From Text/CSV for a comma file); NDJSON for a pipeline |
| A record a person must check, approve or finish in BC | `wicket_page_url` with the card `pageId` (`references/tables.md`), one link per record that matters |
| The document itself ("send me the invoice", a quote or order to forward) | `wicket_action` `document-pdf` with `{ document, systemId \| no }` when `capabilities.actions` has it enabled: the PDF the document's Print action produces, as base64 — decode it and save `fileName`. It changes nothing (not even No. Printed) |
| A picture or attachment | `wicket_read_blob`, decode the base64, save with the right extension from `contentType` |

Whatever the medium: state the connection and company, the filter, the as-of time (`serverTime` from `wicket_whoami`) and the currency (`LCY Code` from General Ledger Setup 98); show masked values as the rendering with a note, never as a figure; keep the raw rows in a file and summarise from it.

## Build the data for a page before the page

1. Totals per group come from one row read when the rows fit a page or two, or from one `aggregate` call per group, in parallel, when they do not (`references/tables.md` for which table holds the stored amount and which route to take). Never 5,000 rows for twelve numbers.
2. Say which window you took: "the last 12 months" means the twelve calendar months ending with the current, partial one unless the user says complete months; name the first and last month and mark a partial month on the page.
3. Row-level pages embed a few thousand rows at most; pre-aggregate beyond that. Select only the columns the page shows.
4. Compute derived numbers (shares, deltas versus the previous period) once, in a script, and embed the results; never from masked fields.
5. Sort by what the reader scans for; round for display, keep full precision in the file.

## Pages and dashboards

Load the `artifact-design` skill (page contract: title, theme tokens for light and dark, allowed CDNs, size) and the `dataviz` skill (charts, stat tiles, palette) before writing the page; a generic dashboard template conflicts with the artifact contract (it ships a doctype, cycles colours and is light-only), so follow those two skills. The rules that matter most for BC data: one sequential palette by default and categorical colours only when series identity is the point (at most seven); status colours (good, warning, serious, critical) reserved for status and always paired with a label; bars from zero; compact ticks (`1K`, `2.4M`); tabular numerals in columns; no dual-axis charts; a table view behind every chart; a filter row above the charts that re-renders all of them. Take one look at the result before handing it over.

In Claude Code, start with the Artifact tool's `quickstart` for the intent (`other` for a dashboard or data page): the account may list typed artifacts such as a Dashboard, which brings its own store, sources panel and design defaults, and the quickstart returns the page-design guidance you would otherwise load by hand. A typed Dashboard's live queries run from the reader's browser through a claude.ai connector, which a local Wicket server is not: attach the rows as a dataset snapshot, say when it was taken, and offer to refresh it.

Three kinds of page, by freshness:

- **Snapshot** (the default): the data is embedded at publish time; say when it was taken; republish to refresh.
- **Live**: in Claude Code, a page can call Wicket itself through the `mcp` capability — `capabilities: { mcp: { servers: [{ server: "host:wicket", tools: ["wicket_query"] }] } }` (list every tool the page calls; an empty list is refused). It answers only for the artifact's owner, opened inside the Claude app with the same local Wicket server connected (a browser tab gets `server_not_connected`); use `watchTool` for reads (refetch at 30 s or slower), show `result.cache.storedAt` as the last-updated time, and let each section fail on its own. Read tools only. In claude.ai, an artifact can call a remote connector but never a local server. Load the `artifact-capabilities` skill before declaring any capability.
- **Persistent**: the `db` capability plus the `ArtifactData` tool let Claude push fresh rows into the page's own store (a `/loop` or a nightly job republishing the data) while viewers share one state; design the empty state and seed the store after the first publish. The `downloads` capability hands the viewer a CSV or XLSX of what they see.

A page is private until shared; a page that calls a connector or reads policy-masked data carries that data to whoever it is shared with. Say so when you publish.

## Documents for others

When the deliverable is a report people will read together, write it as a Claude Docs document (the docs connector, when present) rather than a file: a chart per series of five or more values, a table for a handful of rows, a sentence for a fact, the finding in the title. Hand the connector the rows, not a rendered picture, so the chart stays inspectable.

## In the chat

Lead with the answer and the numbers that change what the reader does; then how it was computed (table, filter, as-of); then the link, file path or page URL. Never more than a screenful of rows in the conversation, and never a dump of `@recordId` / `@etag` handles.

# Automation and scale

How to get more done per call, per turn and per session, and how to run Wicket work without a person in the loop.

## Parallel calls in one turn

Independent reads belong in the same turn: the twelve monthly aggregates of a chart, the `whoami` + `capabilities` + `map` orientation trio, the describes of three related tables. The server handles concurrent calls; each is its own request to BC. The exception is heavy metadata: a 1000-row publisher-filtered `discover`, or the first `describe` on an environment that has been idle, can take most of the 120-second budget on its own, and two of them in parallel both time out — run those one at a time, paired only with cached describes and small counts. Keep writes to one record sequential (read, write, read back), and pin `connection: "<name>"` on every call of a parallel batch — never switch with `wicket_use` while calls are in flight.

## Subagents

Use a subagent when the work would flood the main context with rows or schemas: inventorying a tenant's hundreds of custom tables, reconciling a thousand rows against a file, reading several companies or connections side by side. Brief it with the exact question, the connection name to pass on every call, the tools it may use (reads only unless the task is a write), and the shape of the answer: counts, findings and file paths, never raw rows. A subagent that learns tenant structure reports it back; only the main agent writes `wicket_map`, so two writers never race on the map file. A forked agent inherits the conversation (good for continuing a long analysis); a fresh one starts from its brief (good for an isolated side quest). The Workflow tool (many agents in phases) is used only when the user has asked for multi-agent orchestration in their own words.

## Large reads without reading them

1. `aggregate: { count: true }` with the filter, to size the job.
2. Under a few thousand rows: one `wicket_query_all` with `maxRows` just above the count, the needed `select` only, no `orderBy` (keyset paging). Write the result to a file; summarise from the file. A host that saves an oversized tool result to a file (Claude Code does, and tells you the path) lets a script transform it without the rows passing through the chat.
3. Beyond that, or for a recurring export: `wicket_query_deliver` when `capabilities.async.enabled` is true (the worker pages for you and writes a package to Azure Blob Storage), otherwise page with `cursor` in a script and never in the conversation.
4. Totals: never fetch rows to add them up; `aggregate` on the stored field (`references/tables.md`).

## Incremental sync

- Watermark: the `serverTime` from `wicket_whoami` at the **start** of the pull, kept in a state file next to the output; next run uses it as `modifiedAfter`. Never the local clock.
- `modifiedAfter` / `modifiedBefore` are inclusive (`>=` / `<=`), so a row on the boundary repeats rather than disappears; the CRM import must upsert on the key. Keep a few minutes of overlap for commits in flight.
- A FlowField change never touches the record's `SystemModifiedAt`: a customer whose balance moved because an invoice was posted is unchanged in table 18. Sync the ledger or line tables that feed the number as well (Cust. Ledger Entry 21 by `Customer No.`), and union the keys.
- Deleted rows leave no trace. Reconcile by key periodically (`select` the primary key only, `wicket_query_all`), and treat what is missing as deleted.
- A failed run must not advance the watermark; the next run re-covers the window.
- Masked fields: refuse to export a value listed in `@masked`; the file would carry a rendering, not data.

## Recurring and unattended runs

Choose by what can reach the MCP server and whether judgment is needed:

| Need | Use |
|---|---|
| Keep checking something during a working session (a posting, an async package, a sync landing) | `/loop` in the live Claude Code session; it reaches the local server and stops when told |
| A fixed nightly pull or export, no judgment needed | A script on a scheduler (launchd, cron, Task Scheduler) that drives the MCP server over stdio or calls the endpoint over HTTP (`references/protocol.md`). The server never blocks on sign-in: a lapsed `device_code` token fails the call with the sign-in hint, so the job exits non-zero and the next interactive session fixes it. Service-principal connections never lapse |
| A scheduled run that needs judgment (triage, a report with commentary) | Headless Claude Code (`claude -p "<prompt>"`) from the scheduler, with the read tools pre-approved for non-interactive use and the prompt naming the connection and the output path |
| A cloud routine (`/schedule`) | Only once Wicket is reachable as a claude.ai connector: routines run in the cloud and cannot see a local stdio server |
| One large export at a set time | `wicket_query_deliver` with `scheduleAt` — one-shot, no recurrence, async must be configured |

Whatever runs unattended writes dated files atomically (temp file, then rename), logs each run, and never writes to BC without the same etag-and-key discipline as an interactive session.

## Memory: what to keep where

- **Tenant structure** — what a solution table is for, keys, joins, option meanings, which API page covers it, gotchas (a FlowField that is slow, a table that needs a date filter) — goes to `wicket_map`: per connection, outside any repository, policy-safe, read by every later session. Write it at the end of an exploration, one section per table or topic (`## 50110 Contoso Contract`), replacing a section rather than appending to it. Connection-level facts — routing mode, async, which actions are enabled, the field-policy mode, the session language — go in one `## Connection posture` section with the date they were observed, not repeated under every table.
- **How the user works** — preferred connection, output formats, which company is "ours" — goes to the host's own memory.
- **Record values** go nowhere: no names, amounts, e-mails, document numbers or masked renderings in either store.

## Keeping a session cheap

- `wicket_describe summary:true` only for the tables the question needs; a tenant inventory is `discover` plus counts, not a describe of every table.
- Read `capabilities` once per connection; it answers most "can I" questions (`readOnly`, `apiRouting`, `async`, `actions`, limits).
- Select the fields you will show or compute with; `select: ["*"]` is for a one-row inspection, not a list.
- `top` small for a look at the shape of the data; counts and aggregates for the size of it.
- Fetch a section of this guide (`wicket_skill`) rather than the whole of it.

# Business Central data map

What to expect from standard Business Central tables before you describe them. Always confirm field names, option ordinals and what you may read with `wicket_describe summary:true`; the numbers here are stable across localizations, the captions are not.

## Common table ids

| Area | Table (id) | Lines / entries |
|---|---|---|
| Master data | Customer 18 · Vendor 23 · Item 27 · Contact 5050 · Bank Account 270 · Fixed Asset 5600 · Resource 156 · Employee 5200 · G/L Account 15 | Ship-to Address 222 · Item Unit of Measure 5404 · Item Variant 5401 |
| Sales documents | Sales Header 36 (quotes, orders, invoices, credit memos, blanket and return orders) | Sales Line 37 |
| Purchase documents | Purchase Header 38 | Purchase Line 39 |
| Posted sales | Sales Invoice Header 112 · Sales Cr.Memo Header 114 · Sales Shipment Header 110 · Return Receipt Header 6660 | Lines 113 · 115 · 111 · 6661 |
| Posted purchase | Purch. Inv. Header 122 · Purch. Cr. Memo Hdr. 124 · Purch. Rcpt. Header 120 · Return Shipment Header 6650 | Lines 123 · 125 · 121 · 6651 |
| Ledgers | G/L Entry 17 · Cust. Ledger Entry 21 · Vendor Ledger Entry 25 · Item Ledger Entry 32 · Value Entry 5802 · Bank Account Ledger Entry 271 · Job Ledger Entry 169 | Detailed Cust. Ledg. Entry 379 · Detailed Vendor Ledg. Entry 380 |
| Journals | Gen. Journal Line 81 · Item Journal Line 83 · Gen. Journal Batch 232 · Gen. Journal Template 80 | |
| Inventory | Location 14 · Transfer Header 5740 · Transfer Line 5741 · Item Category 5722 · Unit of Measure 204 | |
| Setup | Company Information 79 · General Ledger Setup 98 (`LCY Code`, allowed posting dates) · User Setup 91 · Sales & Receivables Setup 311 · Purchases & Payables Setup 312 · Currency 4 · Payment Terms 3 · Country/Region 9 · Post Code 225 · Salesperson/Purchaser 13 · Dimension 348 · Dimension Value 349 · Customer Posting Group 92 · Gen. Business Posting Group 250 · VAT Posting Setup 325 | |
| Finance | Reminder Header 295 · Finance Charge Memo Header 302 · Job 167 | |

For an ISV or partner extension do not guess ids: `wicket_discover { kind: "tables", publisher: "<>Microsoft", top: 1000 }`, narrowed with a caption `filter` (`"*Contract*"`), then read and extend the tenant map. `discover` returns at most `top` rows (max 1000) with no continuation marker: a result of exactly `top` rows is truncated — slice by publisher or by caption range (`filter: "..I"`, `"I..P"`, `"P..S"`, `"S.."`).

## Option ordinals you will filter by

| Table.field | Ordinals |
|---|---|
| Sales Header / Purchase Header `Document Type` | 0 Quote · 1 Order · 2 Invoice · 3 Credit Memo · 4 Blanket Order · 5 Return Order |
| Sales Header / Purchase Header `Status` | 0 Open · 1 Released · 2 Pending Approval · 3 Pending Prepayment |
| Cust. Ledger Entry / Vendor Ledger Entry `Document Type` | 0 blank · 1 Payment · 2 Invoice · 3 Credit Memo · 4 Finance Charge Memo · 5 Reminder · 6 Refund |
| Customer / Vendor `Blocked` | 0 blank (not blocked) · 1 Ship · 2 Invoice · 3 All (Vendor: 1 Payment · 2 All) |
| Item Ledger Entry `Entry Type` | 0 Purchase · 1 Sale · 2 Positive Adjmt. · 3 Negative Adjmt. · 4 Transfer · 5 Consumption · 6 Output · 7 … |
| Gen. Journal Line `Account Type` | 0 G/L Account · 1 Customer · 2 Vendor · 3 Bank Account · 4 Fixed Asset · 5 IC Partner · 6 Employee |

Take any other field's ordinals from `describe summary:true`, whose `options` maps ordinal to member name.

## Amounts: which table holds the stored number

Document headers and master records carry totals as FlowFields, computed from lines or ledger entries. A FlowField can be selected (with `include: { flowFields: true }`) and read per row, and it can be filtered on (computed per row, slow on a large table), but it cannot be summed, averaged or sorted on server-side. Aggregate the stored field underneath:

| You want | Do not aggregate | Aggregate instead |
|---|---|---|
| Total customer balance, balance per customer group | Customer `Balance (LCY)` | Detailed Cust. Ledg. Entry 379 `Amount (LCY)` (filter `Customer No.` / `Posting Date`); per customer, read the FlowField per row |
| Sales per month, per customer, per item | Sales Invoice Header 112 `Amount`, `Amount Including VAT` | Sales Invoice Line 113 `Amount` / `Amount Including VAT` (filter `Posting Date`, `Sell-to Customer No.`, `Type`/`No.`), or Cust. Ledger Entry 21 `Sales (LCY)` (stored) with `Document Type` 2 |
| Open receivables, overdue | Customer `Balance Due (LCY)` | Cust. Ledger Entry 21 with `Open eq true` and `Due Date`; the remaining amount is `Remaining Amt. (LCY)` (FlowField) — read per row, or sum 379 by `Cust. Ledger Entry No.` |
| Vendor balances, purchases | Vendor `Balance (LCY)`, Purch. Inv. Header `Amount` | Detailed Vendor Ledg. Entry 380 `Amount (LCY)`; Purch. Inv. Line 123 `Amount` |
| Inventory on hand, by location | Item `Inventory` | Item Ledger Entry 32 `Quantity` (filter `Item No.`, `Location Code`) or `Remaining Quantity` with `Open eq true` |
| Sales and cost amounts, margins | Item `Sales (LCY)`, `COGS (LCY)` | Value Entry 5802 `Sales Amount (Actual)`, `Cost Amount (Actual)` |
| G/L balances, P&L by account | G/L Account `Balance`, `Net Change` | G/L Entry 17 `Amount` (filter `G/L Account No.`, `Posting Date`). Over all accounts the sum of a period is 0 by construction (every posting balances): a control total for an export, not a figure |

Group totals (per month, per customer) have two routes and the row count decides: when the filtered rows fit in a page or two (a few hundred invoices), read them once with the grouping fields selected (and `include: { flowFields: true }` when the amount is a FlowField) and total client-side in a script; when the rows are many, send one `aggregate` call per group with a `filter` per group, in parallel. There is no `groupBy`.

When you report a total taken from FlowFields read per row (a balance list, a stock list), reconcile it with one `aggregate` on the stored table over the same scope and say that they agree: one extra call, and the number is proven rather than added up. Rank and group master records by their number (`No.`), never by `Name`: several records can carry the same person or company name.

## Card pages for `wicket_page_url`

`wicket_page_url` without `pageId` opens the table's default lookup page, which is often a list. Pass the card when a person should act on the record:

| Record | Card page | List page |
|---|---|---|
| Customer | 21 | 22 |
| Vendor | 26 | 27 |
| Item | 30 | 31 |
| Contact | 5050 | 5052 |
| G/L Account | 17 | 16 (Chart of Accounts) |
| Sales quote / order / invoice / credit memo | 41 / 42 / 43 / 44 | 9300 / 9305 / 9301 / 9302 |
| Purchase quote / order / invoice / credit memo | 49 / 50 / 51 / 52 | 9306 / 9307 / 9308 / 9309 |
| Posted sales invoice / credit memo / shipment | 132 / 134 / 130 | 143 / 144 / 142 |
| Posted purchase invoice / credit memo / receipt | 138 / 140 / 136 | 146 / 147 / 145 |
| Customer / vendor / G/L / item ledger entries | — | 25 / 29 / 20 / 38 |
| Bank account · Fixed asset · Job · Employee | 370 · 5600 · 88 · 5200 | 371 · 5601 · 89 · 5201 |

One call returns one link. For many records, give one list-page link and the filter the user should apply, or the few links that matter, rather than a call per row.

## Facts that save calls

- `Code` values are upper-case; text comparisons in filters are case-sensitive; `No.` is the primary key of master records and documents are keyed by `Document Type` + `No.`.
- One-row setup tables can be queried directly by the field names given here, without a describe: General Ledger Setup 98 (`LCY Code`, `Allow Posting From`, `Allow Posting To`), Sales & Receivables Setup 311, Purchases & Payables Setup 312, Inventory Setup 313 (`Prevent Negative Inventory`), Company Information 79 (`Name`, `VAT Registration No.`), and User Setup 91 (one row per user, `User ID`, `Allow Posting From/To`). `(LCY)` fields are in the `LCY Code` currency, the unsuffixed ones in the document currency.
- `SystemModifiedAt` exists on every table with system fields and drives `modifiedAfter`; deleted rows leave no trace (reconcile by key for a full sync).
- A document header's lines are in the line table with the same `Document Type` and `Document No.`; a posted document's lines use `Document No.` only.
- Dimension values live in Dimension Set Entry 480 by `Dimension Set ID`; the two global dimensions are copied onto entries as `Global Dimension 1 Code` / `Global Dimension 2 Code`.
- Binary content is in `Media` and `BLOB` fields read with `wicket_read_blob` (Customer `Image` is a Media field); a MediaSet such as Item `Picture` cannot be read through it (`422 mediaset-unsupported`); documents attached by users are in Document Attachment 1173.

# Finding what installed solutions can do

A tenant is more than standard Business Central: extensions from other publishers add tables, processes, setups, job queue work and APIs. Wicket can read the metadata that describes all of it, so you can work out what a solution does, whether it is set up and in use, and how Wicket can make use of it for the user, without knowing the app in advance. This file is the method; there is no list of known apps, because the tenant describes itself.

## When to offer it

Exploring costs calls, so offer it at the moment it pays off, in one sentence, and explore only on a yes:

- **A request standard BC cannot meet.** Before answering "Wicket cannot do that", look for an installed solution that can (a quick caption search, see the recipes below), or offer to. Anything that needs an outside system or a process standard BC lacks is a request some extension may serve.
- **The first session on a connection.** After orienting, when `wicket_map read` has no solution sections and `wicket_discover` with `publisher: "<>Microsoft"` shows apps from other publishers, end your first answer with the offer: name the apps and say what you would find out. Example: "This company also runs <app> and <app>. I can check what they let me do for you here: what I can read, what I can trigger, and what an admin would have to enable. Shall I?"
- **The map is stale.** `wicket_map read` answering `stale: true` means apps were installed or upgraded since the notes were written: offer to re-check the solutions it lists.
- **The user asks** what Wicket can do in this company, or what an app is for.

Once the user declines, do not offer again in the same session. Never explore before answering what was asked.

## What the tenant tells you

Every row below was verified readable through Wicket on BC 28 online. Ordinals are those tables' own: read `options` from `wicket_describe` before filtering on any other option field.

| Table | Read | It tells you |
|---|---|---|
| 2000000153 NAV App Installed App | `Name`, `Publisher`, `App ID`, `Package ID`, `Version Major`, `Version Minor`, `Version Build`, `Version Revision`, `Published As` (0 Global, 1 PTE, 2 Dev) | What is installed. PTE and Dev apps are per tenant: the customer's own code, partner add-ons, and Wicket itself. |
| 2000000058 AllObjWithCaption | `Object Type` (1 Table, 3 Report, 5 Codeunit, 6 XMLport, 8 Page, 9 Query, 14 PageExtension, 15 TableExtension, 17 EnumExtension, 20 PermissionSet), `Object ID`, `Object Name`, `Object Caption`, `App ID` | Every object an app owns. Count per type first, then search. `Object Caption` comes in the session language and an app may carry captions in one language only; `Object Name` is the developer's name, usually English: search both. |
| 2000000136 Table Metadata | `Caption`, `DataPerCompany`, `TableType`, `ObsoleteState`, `Access`, `App ID` | What data the app keeps, and whether it is per company. |
| 2000000041 Field | `TableNo`, `No.`, `FieldName`, `Field Caption`, `Type`, `Class`, `RelationTableNo`, `DataClassification` | What a record means; which fields point at objects (`RelationTableNo` 2000000038 or 2000000058: a "Processing Codeunit" style hook). |
| 2000000138 Page Metadata | `ID`, `Caption`, `PageType` (0 Card, 1 List, 11 API), `SourceTable`, `CardPageID`, `APIPublisher`, `APIGroup`, `APIVersion`, `EntitySetName`, `App ID` | The pages people use on a table, its card for `wicket_page_url`, and the app's API pages (`"App ID" eq '<id>' and APIGroup ne ''`). |
| 2000000137 CodeUnit Metadata | `ID`, `Name`, `TableNo`, `SubType`, `SingleInstance`, `App ID` | A codeunit with a `TableNo` processes one row of that table: a processor of queued work. |
| 472 Job Queue Entry | `Object Type to Run`, `Object ID to Run`, `Description`, `Status` (0 Ready, 1 In Process, 2 Error, 3 On Hold, 4 Finished, 5 On Hold with Inactivity Timeout, 6 Waiting), `Recurring Job`, `No. of Minutes between Runs`, `Parameter String`, `Job Queue Category Code`, `Last Ready State`, `Error Message` | What actually runs in this company, how often, and whether it is failing. `User ID` comes back masked. |
| 1990 Guided Experience Item | `Object Type to Run` (1 Codeunit here), `Object ID to Run`, `Guided Experience Type`, `Completed` | Assisted and manual setups, and whether they were finished. Join `Object ID to Run` to AllObjWithCaption for the owning app. |
| 2000000167 Aggregate Permission Set | `App Name`, `Role ID`, `Name`, `Scope` | The roles the publisher expects people to have. |
| 2000000168 Tenant Web Service | `Object Type`, `Object ID`, `Service Name`, `Published` | Objects the tenant exposes as OData or SOAP services. |

Also: `wicket_discover` (`kind: "tables"` or `"codeunits"`, `publisher: "<>Microsoft"`) returns objects with their owning app; `wicket_apis` lists every API page and query with its route and source table, whatever the routing mode (it has no app filter: take an app's API pages from Page Metadata); `wicket_query` with `aggregate: { count: true, max: ["SystemModifiedAt"] }` on an app's table tells you how much data it holds and when it last changed.

GUID values in filters go in single quotes: `"App ID" eq '5ecfc871-5d82-43f1-9c54-59685e82318d'`.

**Not reachable, so never claim it:** an app's manifest description (2000000208 Published Application is refused on BC online), the procedures and parameters of a codeunit, event subscribers, and page actions. Names and captions are the self-description you have.

## Reading the evidence

Work from evidence to a capability, and say how sure you are:

- **What it is for:** the app name, the captions of its setup tables, its main list and card pages, its job queue descriptions and its permission set names. Captions are written for users and usually name the job plainly.
- **Set up:** a setup table (caption ending in "Setup" or "Configuration", usually one row) with a row, an enabled or active flag set, and endpoint or account fields that are filled in; its guided setup `Completed`. The field policy may hide credential and endpoint fields (in `wicket_capabilities` `fieldPolicy`, classifications such as AccountData or OrganizationIdentifiableInformation are often hidden). The Field table still shows that such a field exists: report "could not verify, hidden by policy", never "not configured".
- **In use:** job queue entries that run its codeunits in `Status` 0 (Ready) with a recent `Last Ready State` and no `Error Message`; recent `SystemModifiedAt` on its working tables. An app with no data and no running job is installed, not used.
- **Queued work:** a table with a status or processed field, a codeunit whose `TableNo` is that table, and a job queue entry that runs it. Inserting a row into such a table is how the app is asked to act.

## How Wicket can use a capability

Classify every capability by the first route that works:

| Route | When | What Wicket does |
|---|---|---|
| Read | The data is in tables or API pages Wicket can read | `wicket_query`, or `wicket_api_read` when `apiRouting` is `Prefer` |
| Hand it work | The app processes rows from a table (queued work, above) | `wicket_insert` one row with the fields its own page would set, then read it back for the status. Look at a few existing rows first to learn which fields a valid request fills, and confirm with the user before the first insert: the app acts on it for real. |
| Run an enrolled action | Only a codeunit can do it | `wicket_action` when the verb is in `capabilities.actions`; otherwise name the codeunit and why it qualifies: an administrator decides whether to wrap and enrol it |
| Not reachable | Setup incomplete, permission missing, field hidden, nothing callable | Say exactly what is missing and who can change it |

Exploring is read-only. Never write to a setup table, change a job queue entry or start a job to make a capability work; those are the administrator's decisions.

## What the user can do to give Wicket more

End every finding that is not fully usable with the step that would unlock it, and who takes it:

- **Complete the app's setup:** the setup page or the guided setup that is not `Completed` (a user with the app's permission set).
- **Enable an action:** a verb listed in `capabilities.actions` with `enabled: false` (Wicket administrator, Action Catalog).
- **Wrap and enrol a procedure:** a capability only a codeunit offers (a developer writes the wrapper; the administrator enrols it).
- **Grant access:** a table or field Wicket cannot read for this user (permission set, or the Wicket field policy for a classification).
- **Allow API reads:** an app API page that covers the need while `apiRouting` is `Off` (Wicket administrator).

## Recipes

Keep calls small: count first, read targeted slices, run independent reads in parallel.

**Inventory: what is here beyond standard BC.**
1. `wicket_query` 2000000153 with `filter: "Publisher ne 'Microsoft'"`, selecting `Name`, `Publisher`, `App ID`, `Version Major`, `Version Minor`, `Published As`. Leave out test apps (names ending in "Tests") and Wicket's own apps (Wicket, Wicket Actions …): `wicket_capabilities` already describes those. When the map already has solution sections, compare names and versions with it and re-check only the apps that are new or changed; drop the sections of apps that are gone.
2. Per app, in parallel: `aggregate: { count: true, min: ["Object ID"], max: ["Object ID"] }` on AllObjWithCaption with `"App ID" eq '<id>' and "Object Type" eq 1`, and the same for 5 and 8 (an aggregate has no group-by, so one call per type; `"Object Type" in (1,5,8)` gives a single total). The ranges place job queue objects in step 3. Its API pages: Page Metadata with `"App ID" eq '<id>' and APIGroup ne ''`.
3. All of 472 Job Queue Entry (usually a few dozen rows); place `Object ID to Run` in an app by the codeunit ranges from step 2, or look it up in AllObjWithCaption.
4. Per app: setup tables (`contains("Object Name",'Setup')` and the caption search, since captions may not be English), queued-work candidates (CodeUnit Metadata rows with a `TableNo` among its tables), and recency on its main tables. The main tables are the source tables of its API pages and of its list pages that have a `CardPageID`.
5. One card per app: what it is for, set up, in use, what Wicket can do with it, what would unlock more. For a tenant with many apps, give each app to a subagent and merge the cards.

**Intent: can Wicket do X here.**
1. Turn X into a few caption words: the user's own words, their synonyms, and the business object involved.
2. Search names and captions: AllObjWithCaption with `contains("Object Name",'Word')` and `contains("Object Caption",'Word')`, Table Metadata with `contains(Caption,'Word')` (case-sensitive: try `Word` and `word`; captions are in the session language, so also try the words in that language), `wicket_apis` with `search`, and job queue `Description` the same way. An empty result is not proof: say which words you searched.
3. For each hit: its app, its setup, its activity, and the route from the table above.
4. Answer with what works now, then what would unlock the rest; if nothing matches, say what you searched for.

A large app (thousands of objects) is never paged in full: count it, then search it.

## The capability inventory

The solution cards say what each app is; the inventory says what the user can ask for. It is a set of map sections, one per thing a person can ask Wicket to do in this tenant, titled in the user's own terms, so that a later request goes straight to the right objects and route instead of exploring again. It covers standard Business Central as well as extensions, and `capabilities.actions` as well as what is only readable or locked.

**Use it first.** The map is read when you orient. On every request, look for a `Capability:` section whose "Asked as" or "Does" matches; when one does, run its live checks and follow its route (writes still follow [writes](writes.md), and handing an app work still needs the user's yes). When its state is not usable, answer at once with the unlock step instead of exploring. Explore only when no entry matches, or an entry's route fails.

**Entry format.** One map section per capability, titled `Capability: <what the user asks for>`, at most about ten lines:

```
Asked as: <the phrases users use, in the languages they use>
Does: <one sentence in business terms>
Objects: <ids and names of the report, codeunit, table or API page that do it, and the owning app>
Inputs: <each input and how to resolve it, e.g. a customer by name -> table 18 "No.">
Check live: <the per-record settings to read when the request comes, as table and fields: whether this record is set up for it>
Route: read | hand it work (table, fields a valid row fills) | action <verb> | not reachable
State: usable | needs <step> (<who>)
Verified: <date>, <app> <version>
```

"Check live" names where per-record settings are, never what they are: whether a given customer receives a document by e-mail is record data, read at request time. The map stays structure only.

**Build it** when the user asks for an inventory or accepts the offer: run the inventory recipe, turn each card into the capabilities it supports, and add the standard BC capabilities this company actually uses (data present, setups completed, jobs running). Ask which business areas matter when the tenant is large rather than listing everything.

**Grow it.** After a request that needed exploration, upsert the capability you found, so the next request is direct. When a request fails because of a locked route, record the unlock step in its State.

**Keep it current.** An entry carries its app and version: when `wicket_map read` says `stale: true` or inventory step 1 shows an app changed, re-verify the entries of that app. Fix or remove an entry whose route fails. Merge near-duplicates; the map holds 128 KB per connection, so keep entries short.

## Remember what you found

Write one map section per solution with `wicket_map upsert`, e.g. "Solution: <app name>": what it is for, its setup table and card page ids, its queued-work table and the processing codeunit, the job queue entries that drive it, its API routes, the route Wicket uses, and what is still locked. Structure only: table, field, page and codeunit ids and names, never record values or anything that came back masked. When `wicket_map read` says `stale: true`, re-verify a section before relying on it (inventory step 1 says which apps changed).

# Wire protocol for HTTP clients

Through the MCP server none of this is needed: the tools build the request and unwrap the answer. Read this when calling the endpoint directly from an HTTP client, a workflow engine, or an agent without MCP.

## The URL

Every operation is a bound action on one API page:

```
POST https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>/api/wicket/rpc/v1.0/companies({companyId})/wicketEndpoint(0)/Microsoft.NAV.{operation}
Authorization: Bearer <Entra ID JWT>
Content-Type: application/json
```

`wicketEndpoint(0)` and the `Microsoft.NAV.` prefix are literal. `{operation}` is one of `discover`, `describe`, `query`, `readBlob`, `insert`, `modify`, `delete`, `invoke`, `capabilities`, `status`, `cancel`, `requests`, `action`, `skill`, `pageUrl`, `whoAmI`. `{companyId}` is the company GUID from the standard `/companies` endpoint.

## Transport: always 200, one string in, one string out

A bound action cannot set an HTTP status or read headers, so the logical status lives in the body and every parameter rides in it. The request body has one member, `envelope`, holding the envelope serialised as a JSON string: `{"envelope": "{\"id\":…,\"data\":{…}}"}`. The response is `{"@odata.context": "…#Edm.String", "value": "<the result serialised as JSON>"}`: parse `value` once more. If the parsed object has both a string `type` and a numeric `status`, it is an RFC 7807 problem (`references/errors.md`); otherwise it is the operation result. A successful body carries `@requestId`; problems carry `instance: "urn:wicket:request:<id>"`.

A real non-200 HTTP status comes from the BC gateway before the action ran: 401 (token missing, expired, wrong audience `https://api.businesscentral.dynamics.com`, or no Microsoft Entra Applications entry in BC for the client id: "User does not exist"), 403 (no Wicket role permission set), 404 (malformed path). Those are setup problems; `docs/setup-entra.md` in the repository walks through them.

## The envelope

```json
{
  "id":             "<uuid v4>",
  "issuedAt":       "<RFC 3339 UTC>",
  "origin":         "<your app tag, e.g. crm.sync/nightly@1.4>",
  "idempotencyKey": "<optional, ≤128 printable chars>",
  "data":           { "…operation-specific…" }
}
```

`id`, `issuedAt`, `origin` (≤ 256 chars, charset `[A-Za-z0-9._@/+\-:]`) and `data` are required; a bad one is `400 invalid-envelope` before any operation runs. `origin` is recorded in the Wicket Operation Log, so make it identify the caller. `idempotencyKey` is required for `invoke` and `action` while the tenant's *Require Key For Actions* is on; semantics in `references/writes.md`.

## Operation payloads (`data`)

| Operation | `data` |
|---|---|
| `discover` | `{ kind: "tables"|"codeunits"|"companies"|"apis", filter?, publisher?, top?, languages?, tableId?, skip?, ifNoneMatch? }` |
| `describe` | `{ kind: "table"|"codeunit"|"api", tableId?|codeunitId?|pageId?|queryId?, languages?, ifNoneMatch?, include?: { referencedBy? } }` — send a cached `describeVersion` as `ifNoneMatch`; unchanged answers `{ tableId, describeVersion, notModified: true }` |
| `query` | `{ tableId, select?|selectFieldNo?, filter?, orderBy?, top?, skip?, cursor?, count?, include?: { flowFields? }, aggregate?, modifiedAfter?, modifiedBefore?, deliver?, unmask? }` — page by re-issuing the same query with `cursor: <@nextLink>` until no `@nextLink` |
| `readBlob` | `{ tableId, recordId, fieldNo }` → `{ contentType, bytesBase64 }` |
| `insert` | `{ tableId, values|valuesByFieldNo, init? }` → `{ recordId, @etag? }` |
| `modify` | `{ tableId, recordId, values|valuesByFieldNo, etag?, validate? }` → `{ recordId, @etag? }` |
| `delete` | `{ tableId, recordId, etag? }` → `{ deleted: true, recordId }` |
| `invoke` | `{ codeunitId, procedure, args?, returnShape? }` |
| `action` | `{ action, target?: { systemId }, args?, preview? }` |
| `capabilities` / `whoAmI` | `{}` |
| `status` / `cancel` | `{ requestId }` |
| `requests` | `{ status?, top? }` |
| `pageUrl` | `{ table: "Customer"|"#18", systemId?|recordId?, pageId? }` → `{ pageUrl, pageId }` |
| `skill` | `{ mode?: "toc"|"section"|"full", section? }` — serves the document hosted at the tenant's *Skill Doc Url* (the single-file bundle of this guide) |

`capabilities` returns the authoritative, live version of all of this: `urlTemplate`, `transport`, `envelope`, every operation's `data` shape, `filterGrammar`, `limits`, the field policy, async and action configuration. Call it once at startup and configure the client from it rather than from this text; when the two disagree, `capabilities` is right.

## Caching for HTTP clients

Structure can be cached and revalidated; policy must not be assumed. `describe` answers carry `describeVersion` (send as `ifNoneMatch`), the API catalog carries `catalogVersion`, and `capabilities.structureVersion` moves whenever an app is installed, upgraded or removed. The MCP server does all of this on its own.
