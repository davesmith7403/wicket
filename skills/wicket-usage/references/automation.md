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
