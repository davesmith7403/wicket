# Tool reference

The 24 `wicket_*` MCP tools, in workflow order. Every tool that reaches Business Central (BC) accepts `connection: "<name>"` to target one configured connection for that call. A failed call returns an RFC 7807 problem as the tool error: read `detail` (the fix in words) and `suggest` (a machine hint such as the closest field name) before retrying. Recovery per error slug: `references/errors.md`.

## wicket_connections

Lists the configured connections: `name`, `tenantId`, `environment`, `companyId`, `authMode` (`client_credentials`, `device_code` or `browser`), `readOnly`, `unmask` (only when the connection sets it), `isDefault`, `isSelected`. Local, free. Call it once when more than one connection may exist, then pass `connection` on every call rather than switching with `wicket_use`. A `readOnly` connection refuses `insert`/`modify`/`delete`/`invoke`/`action` before anything is sent. When nothing usable is configured, the answer also carries `problem` (`missing`, `invalid` or `dangling-default`), and an entry set aside for a bad value is listed under `rejected` with its reason: offer `/wicket:setup`.

## wicket_whoami

`{ userSecurityId, userId, company, readOnly, fieldPolicy, strongEtag, unmaskGranted, activeExceptions, serverTime }` — the principal and company the connection resolves to and the endpoint posture. One small call; cheaper than `wicket_capabilities` when identity is all you need. `serverTime` is the watermark to store for an incremental sync. A `device_code` connection answers `401 sign-in-required` with a URL and code until the user has signed in: show them, then retry. A `browser` connection answers the same problem without a code: a sign-in window has opened, so ask the user to finish there, then retry.

## wicket_capabilities

The endpoint's self-description (about 5 KB). Read: `limits` (`defaultTop` 100, `maxTop` 1000, `scanBudget` 100000, `maxInMembers` 20, `maxSelectFields`, `maxFilterLength`), `readOnly`, `exposureMode` (`Open`, or `Allowlisted` for the mode Exposed tables only), `fieldPolicy` (mode, classification verdicts, your `principal` grants), `apiRouting.mode` (`Prefer` allows `wicket_api_read`; `Off` means `wicket_query` only), `async.enabled` (whether `wicket_query_deliver` can work), `actions` (every enrolled business verb with `enabled`, `mutating`, `previewSupported` and `argsSchema`; empty means no action companion is installed, `enabled: false` means an administrator has not allowed that verb), `structureVersion` (moves when apps change). Once per connection per session, and again after `wicket_use`.

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

## wicket_batch

Inserts, modifies and deletes up to 100 records (any tables) in one transaction: all are written or none. Items are `{ op, tableId, recordId?, values?, etag?, validate?, init? }`; a value `{ fromItem: n, field }` or a `recordId: { fromItem: n }` uses an earlier item's record. `preview: true` runs everything and rolls back. A failure names the item (`item`, `itemOp`, `detail` from `items[i]`) and writes nothing. Returns `{ items: [ { index, op, recordId, @etag? } ], count, preview? }`. Mints an `@idempotencyKey` when you send none. Workflow: `references/writes.md`, "Many records".

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

## wicket_changes

What the agent created, changed or deleted through Wicket, and the actions and procedures it ran, newest first: each entry with `kind`, the table and record, the user and connection, and per field `old` → `new` with `shownAs` (`clear`, `masked` as the stored mask, `hidden` without values). Filters: `from`/`to` (ISO date-times), `tableId`, `viaConnection`, `kind` (`created`, `changed`, `deleted`, `action`, `procedure`), `top` up to 100, `cursor` from `@nextLink`. Your own changes only; `user` and everyone's entries need the **Wicket - Audit Changes** permission set. Use it for "what did you (or the agent) change …" questions and present the answer as a report or a file, not a long chat list. Knock-on changes in other records (a posting's entries, a recalculated header) are not listed: BC's Change Log has those. `403 changes-off` means the history is off on the Wicket Setup card.

## wicket_cancel

Cancels one async request: outright before it starts, cooperatively while running, a no-op once finished.

## wicket_page_url

A BC web-client deep link for one record: `table` (a name such as `"Customer"` or `"#36"`), `systemId` (preferred) or `recordId`, optional `pageId`. Without `pageId` the server picks the table's default lookup page, which for document tables is often the **list** (Sales Header opens page 45): pass the card page when a person should act on the record (`references/tables.md` lists common card pages). The link opens under the viewer's own BC login and permissions. Requires read exposure on the table.

## wicket_skill

This guide, with progressive disclosure: `mode:"toc"` (default) lists every file and section; `mode:"section"` with a section title or a reference file name (`filters`, `errors`, `writes`, `presenting`, `automation`, `tables`, `protocol`, `tools`) returns that text; `mode:"full"` returns everything (large). Local and free.

## wicket_setup

Shows, adds, fixes, re-defaults and removes connections, and works when none is configured. In Claude Code, `/wicket:setup` drives it with questions; elsewhere follow its description. The add path is `locate` (a BC address, email or domain) → `signin` (`browser`, `device_code` or `client_credentials`; call it again while it answers `pending`) → `environments` → `companies` (pass the address's `companyName` to get its `match`) → `save`, which tests the new connection with `whoami`. `status` checks each connection without prompting a sign-in and names its company, sign-in method and read-only setting; `/wicket:setup view` shows that and changes nothing. Confirm with the user before `remove`. A client secret never passes through it: `secretPage` opens a one-time page in the user's browser, and the secret goes from there into the system's own store (the Keychain on macOS, protected for the user's account on Windows).

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
