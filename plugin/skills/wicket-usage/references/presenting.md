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

In Claude Code, start with the Artifact tool's `quickstart` for the intent (`other` for a dashboard or data page): the account may list typed artifacts such as a Dashboard, which brings its own store, sources panel and design defaults, and the quickstart returns the page-design guidance you would otherwise load by hand. A typed Dashboard's live queries run from the reader's browser through a claude.ai connector, which a local Wicket server is not: attach the rows as a dataset snapshot, say when it was taken, and offer to refresh it. When the user wants the numbers to stay current, build a plain page that calls Wicket live instead (below), never answer that a dashboard cannot query Wicket.

Three kinds of page, by freshness:

- **Snapshot** (the default): the data is embedded at publish time; say when it was taken; republish to refresh.
- **Live** (proven 2026-10-30): a plain page calls Wicket itself through the `mcp` capability with a host server. The name is the local server's name in the app that opens the page, which is not always the name this session uses: the desktop app's own entry is usually `wicket` (`host:wicket`), a Claude Code plugin's is `plugin_wicket_wicket`. Declare both, each with every tool the page calls — `capabilities: { mcp: { servers: [{ server: "host:wicket", tools: ["wicket_query"] }, { server: "host:plugin_wicket_wicket", tools: ["wicket_query"] }] } }` (an empty list is refused) — and use the first that answers. It works only for the artifact's owner, opened inside the Claude desktop app with Wicket connected there; in a browser tab the page sees no host server and every call is `server_not_connected`. So embed the snapshot too and show it, marked with its time, whenever no host answers; tell the user to open the page in the desktop app for live data. Use `watchTool` for reads (`refetchInterval` 60 s or slower; the first call can take a few seconds), show `result.cache.storedAt` (or the receipt time) as the last-updated time, and let each section fail on its own with its error code. Read tools only (`wicket_query`, `wicket_query_all`, `wicket_whoami`); a page never writes. Load the `artifact-capabilities` skill before declaring any capability.
- **Persistent**: the `db` capability plus the `ArtifactData` tool let Claude push fresh rows into the page's own store (a `/loop` or a nightly job republishing the data) while viewers share one state; design the empty state and seed the store after the first publish. The `downloads` capability hands the viewer a CSV or XLSX of what they see.

A page is private until shared; a page that calls a connector or reads policy-masked data carries that data to whoever it is shared with. Say so when you publish.

## Documents for others

When the deliverable is a report people will read together, write it as a Claude Docs document (the docs connector, when present) rather than a file: a chart per series of five or more values, a table for a handful of rows, a sentence for a fact, the finding in the title. Hand the connector the rows, not a rendered picture, so the chart stays inspectable.

## In the chat

Lead with the answer and the numbers that change what the reader does; then how it was computed (table, filter, as-of); then the link, file path or page URL. Never more than a screenful of rows in the conversation, and never a dump of `@recordId` / `@etag` handles.
