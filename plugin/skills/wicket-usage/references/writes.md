# Writing safely

Wicket writes one record per call, or many in one transaction with `wicket_batch`, always through the table's own validation, under the caller's BC permissions, behind a deny-by-default exposure and a per-field policy. The rules below hold on every tenant, whatever its Setup switches enforce: the switches decide whether the server refuses a careless write, never whether a write is safe.

## The write contract

1. **Read first.** Get the row with `wicket_query` (select the fields you will change plus any you need to decide) so you hold a fresh `@recordId` and `@etag`, and `wicket_describe summary:true` so you know which fields are writable and what an option field's members are.
2. **Send the `etag`** on every `wicket_modify` and `wicket_delete`. Without it the write is last-write-wins over anything that changed since your read. A `412 precondition-failed` means the row moved: re-read, re-apply your change to the fresh row, retry with the new `@etag`. A table without system fields (`hasSystemFields: false`) has no etag at all; say so to the user before writing it.
3. **Send an `idempotencyKey`** on `insert`, `modify`, `delete`, `batch`, `invoke`, `action` and a `deliver` submit: a fresh unique value per logical request (a UUID, or a name tied to the intent such as `cust-10000-phone-2026-10-14`). Reuse it **only** to retry that exact call after a timeout or a lost response: the retry replays the stored result (`"@replayed": true`) instead of executing again. `wicket_batch`, `wicket_invoke` and `wicket_action` mint one for you when you send none and return it as `@idempotencyKey`; reuse that value verbatim to retry.
4. **Send only what changes.** Omit fields you are not changing; never send back a masked rendering (a value listed in the row's `@masked`) — that is `400 masked-value`. Option values as the member name, the ordinal, or `{ "ord": n }`; `null` clears a field.
5. **Let the triggers run.** `init: false` and `validate: false` are refused on most tenants and skip the business rules you rely on. Primary-key fields cannot change (`pk-immutable`): insert a new record and delete the old one.
6. **Verify.** Read the row back after the write (one `wicket_query` on the key) and report what changed. For a person who should see or finish the result, add a `wicket_page_url` link to the card page.
7. **Report honestly.** A `422` carries the BC error text in `detail`: show it. After a `5xx` or timeout the outcome is unknown: resend with the same key, or query the record first when you sent none.

## What is stored under a key, and what is not

Final outcomes are stored: successes and the 4xx answers about the request itself (bad input, a missing record, a business failure such as `422 action-failed`). A corrected request therefore needs a **new** key; the old key keeps answering the stored 4xx. Not stored, so the **same** key is resent once the cause is fixed: every 5xx from the read and write planes, and the refusals an administrator can lift (`read-only`, `role-forbidden`, `not-exposed`, `invoke-disabled`, `action-disabled`, `trigger-bypass-disabled`, `async-not-configured`, `too-many-requests`). Exception: a 5xx from `invoke` or `action` settles the key, because the wrapper may have committed; the same-key resend answers `409 idempotency-indeterminate` and you must check the business result before using a new key. A replay is re-authorized: a stored success you may no longer see answers `403 replay-withheld` — the original request **did** complete, so never repeat it under a new key.

## Many records: `wicket_batch`

A change that spans more than one record goes in **one `wicket_batch`**, not a series of single writes: every item is written or none is, so a failure cannot leave the data half changed.

1. **Read first**, as for one write: resolve every row (one query with an `in (...)` filter, or a filtered `wicket_query_all`) so each modify and delete carries its `@recordId` and `@etag`.
2. **Build the items** in order: `{ op: "insert"|"modify"|"delete", tableId, recordId?, values?, etag?, validate?, init? }`, the same rules as the single-write tools. Up to 100 items (`capabilities.limits.maxBatchItems`); split larger changes into several batches and say so.
3. **Link items instead of guessing keys.** A value `{ "fromItem": n, "field": "No." }` (or `"fieldNo"`) is that field of the record item n wrote, read after it ran: create an order header, then its lines with `"Document No.": { "fromItem": 0, "field": "No." }`. `recordId: { "fromItem": n }` targets the record item n created or changed. Only earlier items; the field must be readable in clear (a hidden or masked field is refused).
4. **Preview first**: the same call with `preview: true` runs every item and rolls everything back. It answers each item's result, or the first failure, and writes nothing; show the user what would change. Then send it without `preview`.
5. **On a failure nothing was written.** The problem names the item (`item`, `itemOp`, and `detail` starting `items[i] (op, table n)`): fix that item and resend the **whole** batch with a new key.
6. **Verify and report**: the answer lists each item's `recordId` and new `@etag`; read the rows back and report what changed.

For hundreds of rows, say so before starting and ask whether a BC-side tool (a journal, a configuration package) is the better fit.

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
