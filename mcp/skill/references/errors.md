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
| `batch-too-large` | A `batch` with more than `capabilities.limits.maxBatchItems` (100) items | Split it into several batches |
| `invalid-reference` | A batch `{ fromItem }` that names a later item, a deleted record, or a field that does not exist | Reference only earlier items that wrote a record; take the field name from `describe` |
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
| `not-exposed` | The table or codeunit is not enrolled in Wicket Exposure (mode Exposed tables only), or your BC permissions lack it; also gates `pageUrl` and `deliver` | An administrator enrols it or switches the mode; `describe` to confirm permissions |
| `field-restricted` | You named a field the policy hides (`select`, `filter`, `orderBy`, `aggregate`, `readBlob`, a write), an index whose later field is hidden, or a non-existent field number | Drop it; `describe` shows what is readable and writable |
| `field-masked` | A masked field in `filter`, `orderBy`, `aggregate`, an effective key, the modified window or `readBlob` | Drop the masked field from that clause |
| `read-only` | A write or a mutating `action` while the endpoint is read-only (an action preview and a `mutating: false` verb still run) | Reads and previews only until an administrator lifts it; check `capabilities.readOnly` |
| `connection-read-only` (MCP) | A mutating tool on a connection marked `readOnly` in the MCP server; nothing was sent | Pass `connection` naming a writable one |
| `role-forbidden` | The principal's Wicket role is below the operation (`Execute` for invoke/action, `Edit` for writes) | A human assigns the rung `detail` names |
| `trigger-bypass-disabled` | `init: false` / `validate: false` while the tenant forbids it | Omit the member |
| `invoke-disabled` / `action-disabled` | Enrolled, but `Allow Run` is off | An administrator enables it; the same idempotency key can then be reused |
| `async-not-configured` | `deliver` on a tenant without a usable async configuration | Read inline or page; an administrator completes the setup |
| `replay-withheld` | A resend under a key whose original request completed, but whose stored result you may no longer see (`originalStatus`, `reason`) | It already happened: never repeat it under a new key |
| `changes-off` | `changes` while the change history is off, or not readable by the agent, on the Wicket Setup card | Say so; an administrator turns it on (Change History). The Wicket Changes page in BC still shows what was recorded |
| `changes-forbidden` | `changes` with `user` without the Wicket - Audit Changes permission set | Omit `user` to see your own changes; an administrator assigns the set for everyone's |
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
| `unknown-operation` | The operation name is not one of the eighteen (HTTP clients) | One of `suggest`'s operations |
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
