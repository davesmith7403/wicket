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
