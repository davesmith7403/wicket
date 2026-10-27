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
