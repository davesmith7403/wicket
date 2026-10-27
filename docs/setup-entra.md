# Wicket — Entra ID setup

Before any caller can hit `/api/wicket/rpc/v1.0/...`, BC SaaS needs to know who's calling **and** that they're allowed in. That requires two coordinated registrations:

1. An **Entra ID app registration** in your Azure tenant — produces a token.
2. A matching **Microsoft Entra Applications** entry inside BC — turns that token into BC permissions.

Without step 2 the token validates but every call returns `401 / "User does not exist"`.

This doc covers the service-to-service (S2S) flow, which is what LLM agents and backend services typically use. Delegated-user OAuth works too but requires the user to sign in interactively; not covered here.

---

## 1. Azure side — Entra app registration

1. **Azure portal → Microsoft Entra ID → App registrations → New registration.**
   - Name: `Wicket` (or whatever).
   - Supported account types: **Single tenant** for internal use, **Multi-tenant** if you'll install across customer tenants.
   - No redirect URI needed for S2S.
   - Register.

2. **Certificates & secrets → New client secret.**
   - Description, expiry. Copy the **value** immediately — you can't see it again.
   - Production should use a certificate instead of a secret.

3. **API permissions → Add a permission → APIs my organization uses → "Dynamics 365 Business Central".**
   - For S2S: **Application permissions → `app_access`**. Check it.
   - (For delegated user flows you'd add `Financials.ReadWrite.All` under Delegated permissions instead.)
   - **Grant admin consent for <tenant>.** Without admin consent the token will lack the right scope.

4. Note these three values — you'll need them every time:
   - **Application (client) ID**
   - **Directory (tenant) ID**
   - **Client secret value**

---

## 2. BC side — Microsoft Entra Applications

In your BC SaaS environment:

1. Search **Microsoft Entra Applications** (older versions: "Azure Active Directory Applications").
2. **New.**
3. **Client ID:** paste the Application (client) ID from Azure step 4.
4. **Description:** anything meaningful — `Wicket service principal` works.
5. **State:** `Enabled`.
6. **User Permission Sets** subform — assign at least:
   - One Wicket **role** for the endpoint itself: `Wicket - Read` (read operations only), `Wicket - Execute` (adds `invoke`/`action`) or `Wicket - Edit` (adds `insert`/`modify`/`delete`). Pick the lowest rung the agent needs — Wicket's role gate refuses the operations above that rung with a typed `403 role-forbidden` problem (naming the permission set required) before any handler runs. (`Bcmag Rpc`, the pre-2026-09 name, still works as an alias of `Wicket - Edit`.)
   - A permission set covering the **data** the app actually queries. `Wicket Data - Read` grants Read on every table plus table/page/query Execute in one assignment ("read any information"); `Wicket Data - Exec` adds Execute on every codeunit/report/xmlport while keeping direct table data read-only. For sandbox testing, `D365 BUS PREMIUM` is also fine (`SUPER` cannot be assigned to an application). For a production write-capable agent, build a tight custom set that grants only the specific tabledata RIMD bits the use case needs.
7. Save.

Without that user-permission-set assignment, the app principal exists but has zero rights — every call returns 403, even though the token is valid.

### Read vs. write vs. invoke

The Wicket role sets (`Wicket - Read` / `Wicket - Execute` / `Wicket - Edit`) only grant access to Wicket's own tables, the API page and the operation handlers of that rung — they are the price of admission, not authority over your business data. `Wicket - Admin` is for the human who configures Wicket and `Wicket - Audit` for someone who must see the logs, the queue and the policy pages without changing them.

- **Read** (`query`, `readBlob`, `describe`, `discover`) needs the app principal to hold **read** permission on the target tables, and those tables to be exposed for read in **Wicket Exposure** (or `Mode = Open` in **Wicket Setup**).
- **Write** (`insert`, `modify`, `delete`) additionally needs the app principal to hold **write** (Insert/Modify/Delete) permission on the target tables, and the per-row `Allow Insert` / `Allow Modify` / `Allow Delete` flags set in **Wicket Exposure**. Both gates are independent: a missing tabledata write bit returns `422`, a missing exposure flag returns `403`.
- **Invoke** (`invoke`) is deny-by-default on two gates of its own: the codeunit must be exposed for invoke (`Allow Invoke` in **Wicket Exposure**), **and** the `{codeunitId, procedure}` pair must be enrolled in the **Wicket Procedure Catalog** with `Allow Run = true`. Open mode does not bypass invoke unless `Allow Invoke In Open Mode` is set in **Wicket Setup**. The app principal must also hold whatever permissions the wrapper codeunit's own logic exercises.

So for a write/invoke-capable agent, assign the app principal `Wicket - Edit` (or `Wicket - Execute` for invoke/action without the generic write plane) together with a permission set that includes the write (and, for invoke, the underlying business) permissions, then enrol the tables/procedures in Wicket Exposure and (for invoke) the Procedure Catalog. A principal holding only `Wicket - Read` is refused `insert`/`modify`/`delete`/`invoke`/`action` no matter what else it holds — the dispatcher checks the rung's role-gate table before the handler runs and answers a `403 role-forbidden` problem whose detail names the permission set required. This holds even for `Wicket Data - Exec`, whose codeunit wildcard reaches the write handlers: the Write Gate is granted only by `Wicket - Edit`.

Two **Wicket Setup** write-plane policies also apply, whatever the role: on a fresh install *Require Key For Actions* is on, so an `invoke` or `action` call without an envelope `idempotencyKey` is refused with `400 idempotency-key-required`, and *Allow Trigger Bypass* is off, so `insert` with `init: false` or `modify` with `validate: false` is refused with `403 trigger-bypass-disabled`. A tenant upgraded from an earlier build keeps the old behaviour (keys optional, bypass allowed) until an administrator changes the switches.

---

## 3. Acquire a token

```http
POST https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<application-client-id>
&client_secret=<secret-value>
&scope=https://api.businesscentral.dynamics.com/.default
```

The response `access_token` is the `Bearer` value.

Quick local check via Azure CLI (works once you've `az login`'d as a user with rights to your subscription):

```bash
az account get-access-token \
  --resource https://api.businesscentral.dynamics.com \
  --query accessToken -o tsv
```

That returns a delegated user token rather than an app token, which works against BC if your user has permissions in BC. Useful for smoke-testing without juggling secrets.

---

## 4. Plug it into the smoke test

`docs/smoke-test.http` declares `@token`. Paste the access token you got above. The full base URL pattern is:

```
https://api.businesscentral.dynamics.com/v2.0/<tenant-id>/<environment-name>/api/wicket/rpc/v1.0
```

`<environment-name>` is the BC SaaS environment (e.g. `production`, `sandbox`, or your custom name). It's NOT the Azure tenant.

`<companyId>` in the URL is BC's company GUID — find it via:

```http
GET https://api.businesscentral.dynamics.com/v2.0/<tenant-id>/<env>/api/v2.0/companies
Authorization: Bearer <token>
```

---

## 5. Common errors and what they mean

| Status / message | Cause |
|---|---|
| `401 Unauthorized` | Token missing, expired, malformed, or for the wrong audience (the `scope=https://api.businesscentral.dynamics.com/.default` matters). |
| `401 / "User does not exist"` | Token is valid but you skipped step 2 — there's no Microsoft Entra Applications entry for this Client ID in this BC environment. |
| `403 Forbidden` on a specific table | App principal exists but the assigned permission sets don't grant the table. Add a permission set to the Microsoft Entra Applications entry. |
| `403` on `/api/wicket/rpc/v1.0/...` itself | No Wicket role set (`Wicket - Read` / `Wicket - Execute` / `Wicket - Edit`) was assigned. |
| `403 role-forbidden` | The principal's Wicket role is below the operation: `Wicket - Read` cannot run mutating operations, `Wicket - Execute` cannot run the write plane. Assign the rung named in `detail`. |
| `404` on `companies({id})` | Wrong company GUID, or the app principal doesn't have access to that company. |
| `400 / "Invalid envelope"` | Token / auth is fine; the request body shape is wrong. Re-read `skills/wicket-usage/SKILL.md`. |

---

## 6. Granting an Entra app access to additional companies

Microsoft Entra Applications is a *per-environment* registration. If you have multiple BC companies in the same environment, the same registration covers all of them — but you might want different permission sets per company. Use the **Permission Set By User Group** or **Effective Permissions** tooling in BC to scope per-company. For multiple environments (sandbox + production), you register the app in each one.
