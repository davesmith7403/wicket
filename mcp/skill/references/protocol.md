# Wire protocol for HTTP clients

Through the MCP server none of this is needed: the tools build the request and unwrap the answer. Read this when calling the endpoint directly from an HTTP client, a workflow engine, or an agent without MCP.

## The URL

Every operation is a bound action on one API page:

```
POST https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>/api/wicket/rpc/v1.0/companies({companyId})/wicketEndpoint(0)/Microsoft.NAV.{operation}
Authorization: Bearer <Entra ID JWT>
Content-Type: application/json
```

`wicketEndpoint(0)` and the `Microsoft.NAV.` prefix are literal. `{operation}` is one of `discover`, `describe`, `query`, `readBlob`, `insert`, `modify`, `delete`, `batch`, `invoke`, `capabilities`, `status`, `cancel`, `requests`, `changes`, `action`, `skill`, `pageUrl`, `whoAmI`. `{companyId}` is the company GUID from the standard `/companies` endpoint.

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
| `batch` | `{ items: [ { op: "insert"|"modify"|"delete", tableId, recordId? | { fromItem }, values? (a value may be { fromItem, field | fieldNo }), valuesByFieldNo?, etag?, validate?, init? } ], preview? }` → `{ items: [ { index, op, recordId, @etag? | deleted } ], count, preview? }`; one transaction, at most 100 items |
| `invoke` | `{ codeunitId, procedure, args?, returnShape? }` |
| `action` | `{ action, target?: { systemId }, args?, preview? }` |
| `capabilities` / `whoAmI` | `{}` |
| `status` / `cancel` | `{ requestId }` |
| `requests` | `{ status?, top? }` |
| `changes` | `{ from?, to?, tableId?, viaConnection?, kind?, user?, top?, cursor? }` → `{ value: [ { entryNo, createdAt, kind, tableId, tableName, recordKey, systemId?, user, connection, requestId, name?, outcome?, result?, fieldCount, fields: [ { fieldNo, fieldName, shownAs, old?, new?, truncated? } ] } ], @nextLink? }` |
| `pageUrl` | `{ table: "Customer"|"#18", systemId?|recordId?, pageId? }` → `{ pageUrl, pageId }` |
| `skill` | `{ mode?: "toc"|"section"|"full", section? }` — serves the document hosted at the tenant's *Skill Doc Url* (the single-file bundle of this guide) |

`capabilities` returns the authoritative, live version of all of this: `urlTemplate`, `transport`, `envelope`, every operation's `data` shape, `filterGrammar`, `limits`, the field policy, async and action configuration. Call it once at startup and configure the client from it rather than from this text; when the two disagree, `capabilities` is right.

## Caching for HTTP clients

Structure can be cached and revalidated; policy must not be assumed. `describe` answers carry `describeVersion` (send as `ifNoneMatch`), the API catalog carries `catalogVersion`, and `capabilities.structureVersion` moves whenever an app is installed, upgraded or removed. The MCP server does all of this on its own.
