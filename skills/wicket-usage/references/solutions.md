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
