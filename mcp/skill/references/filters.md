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
