---
description: Set up Wicket's connection to Business Central from the chat - view what is configured, add a connection (no GUIDs to look up), fix one that fails, change the default, or remove one. Use when no connection is configured, when a Wicket call fails with connection-unavailable or a sign-in problem, or when the user wants another tenant, environment or company.
argument-hint: "[view|add|fix|default|remove] [connection name]"
allowed-tools: AskUserQuestion, mcp__plugin_wicket_wicket__wicket_setup, mcp__plugin_wicket_wicket__wicket_connections, mcp__plugin_wicket_wicket__wicket_whoami
---

Guide the user through Wicket's connection setup. Request: $ARGUMENTS (when empty, start from the menu).

Ask every question with `AskUserQuestion`, putting the recommended choice first with "(Recommended)" after its label. A question shows at most four options; "Other" is added automatically and takes typed text. When a list has more than four entries (environments, companies, connections), show it as a short numbered list in your message, offer the three most likely as options, and let "Other" take a typed name or number. Keep each message short and plain: no GUIDs unless the user asks, and never ask the user to type one.

Never ask for, accept or repeat a client secret in the chat. If the user pastes one, tell them it is now in the transcript and that they should rotate it.

## 1. Where things stand

Call `wicket_setup` with `action: "status"`. It never prompts a sign-in.

- If `problem.kind` is `invalid`, the file can't be read. Show the message and ask: "I'll fix the file by hand" or "Move it aside and start fresh". Only on the second answer, call `moveAsideBroken`, tell the user where the old file went, and continue with **Add**.
- If there are no connections, go straight to **Add**.
- When `$ARGUMENTS` says `view`, go to **View**.
- Otherwise, summarise each connection in one line (name, company or description, environment, health), plus any `rejected` entry with its reason. Then ask what to do: Add a connection · View the connections · Fix `<the first unhealthy one>` (only when one is unhealthy) · Change the default or remove one. For the last choice, ask which of the two next. Honour `$ARGUMENTS` when it already says which.

## View

Read-only: change nothing. From the `status` answer, show one short block per connection, the default first:

- **`<name>`**, marked "(default)" when `isDefault` is set.
- **Business Central:** the `company` (or else the `description`), then the environment.
- **Sign-in:** browser, device code, or an app with a client secret.
  - For a person's sign-in, say whether it goes through Wicket's default app (`usesDefaultClient`) or the user's own app registration.
  - For an app, say the secret is in the Keychain under `<keychainAccount>`, or comes from the variable `<secretEnv>`.
- **Writes:** "read-only" when `readOnly` is set, else "allowed (as far as the user's Business Central permissions go)".
- **Health:** the `health.message` in plain words.
- **Source:** `source: "env"` connections say they come from environment variables.

After the blocks, add:
- every `rejected` entry with its reason;
- the `problem`, if there is one;
- the file path, on one line at the end.

Show IDs (tenant, company, client) only if the user asks for them. Then ask what to do next, with the same menu, minus View.

## 2. Add

1. **How do you want to sign in?**
   - Browser sign-in (Recommended): a browser window opens and you sign in there.
   - Device code: a code to enter at microsoft.com/devicelogin. Use it when no browser can open on this machine, for example over SSH.
   - App with a client secret: a service principal, for unattended use.

   For the app path, go to **2b**.
2. **Which app should Wicket sign in through?**
   - Wicket's default (Recommended): no app registration needed.
   - My own app registration: the user types the client ID.
3. **Where is your Business Central?**
   - Sign in first and pick from the list (Recommended for your own organisation).
   - Paste the BC address from your browser.
   - The customer's domain or email: for guest access in someone else's tenant.

   For an address or a domain, call `locate` with it as `hint`, and keep its `tenantId`, `environment` and `companyName`. When `unresolved` contains `tenant`, say the address or domain wasn't recognised and ask again.
4. **Sign in.** Call `signin` with `method`, plus `tenantId` from step 3 and `clientId` from step 2 when they're known.
   - For `pending` with `kind: "browser"`, say a sign-in window has opened in their browser and ask them to tell you when they've finished.
   - For `pending` with `kind: "device_code"`, show the address and the code. Say up front that after multi-factor sign-in the page may ask for the code again, and that the same code works.
   - Call `signin` again with the same arguments when the user says they've finished. If it's still pending, wait for them again.
   - If the user closed the window, the code expired, or nothing happened, call `signin` with the same arguments plus `restart: true`.
   - For `failed`, show the message and offer to try again, or to use another sign-in method.
   - For `signedIn`, ask **"Signed in as `<upn>`. Is that the right account?"** On No, call `signin` with the same arguments plus `restart: true`, and tell them to choose the other account in the window that opens.
5. **Environment.** Skip this step when step 3 gave one. Otherwise call `environments`. With one environment, just confirm it. With several, ask, preferring a sandbox when the user has said they're testing. If the call fails, ask for the BC address instead and `locate` it.
6. **Company.** Call `companies` with the environment, plus the `companyName` from step 3 when there is one. When the answer has a `match`, offer that company first (Recommended). With one company, confirm it. Otherwise ask by name.
7. **Name.** Suggest `<company>-<environment>`: lower case, with anything outside `a-z0-9-` turned into `-`. When that name is taken, add `-2`. Offer the suggestion (Recommended) or a typed name. When other connections exist, also ask whether this one becomes the default.
8. **Save and test.** Call `save` with `name`, `environment`, `companyId`, `companyName` (the company's name from step 6) and `makeDefault`.
   - If it answers that the name exists, ask whether to replace it. Only on a yes, save again with `replace: true`.
   - When `health.state` is `ok`, report in a few lines: signed in as, environment, company, and whether the connection is read-only (from `health.identity`). Then suggest `/wicket:orient`.
   - Any other state: say what it means and continue with the matching **Fix** step. The connection stays saved.

### 2b. App with a client secret

1. Ask for the tenant: a pasted BC address or a domain, which goes to `locate`, or a tenant ID typed by the user.
2. Ask for the app's client ID, which the user types.
3. Ask for the connection name, as in step 7. The secret is filed under that name.
4. Ask the user to copy the client secret to the clipboard, then run this themselves in this chat, so the secret never appears in it:

   `! security add-generic-password -U -s wicket -a <name> -w "$(pbpaste)"`

   Ask them to tell you when they've done it.
5. Call `signin` with `method: "client_credentials"`, the `tenantId`, the `clientId`, `keychainService: "wicket"` and `keychainAccount: <name>`. If it fails, show the message, which says whether the secret or the app was refused.
6. The environment comes from the address if there was one. Otherwise call `environments`; if that's refused, which is common for apps, ask the user to type the environment name.
7. Run the company step, then save as in step 8, with the same `name`.

## 3. Fix `<name>`

Explain the connection's `health.state` in one sentence, then offer the matching fix:

| state | fix |
|---|---|
| `signInNeeded` | When the message says the connection keeps no saved sign-in, nothing needs fixing: the first Wicket call shows the sign-in prompt. Otherwise, sign in again: `signin` with `restart: true` and the connection's `authMode` as `method`, plus the `tenantId` and `clientId` from its status row (and its `keychainService`/`keychainAccount` for an app). Then `save` with `replace: true` and the same name, environment and company. |
| `secretMissing` | The Keychain line from 2b step 4 (same name), then `status` again. |
| `tokenRefused` | Show the message. A wrong or expired secret goes back to the Keychain line; an unknown client ID or missing consent means rerunning **Add** with Wicket's default client, or asking the tenant's admin. |
| `wicketNotFound` | Say that Wicket isn't installed in that environment, or that the environment was renamed. Offer to pick the environment again (`environments`), then save with `replace: true`. |
| `bcRefused` | Show the message: the BC admin must add the user or app, or assign a Wicket permission set. Change nothing here. |
| `unreachable` | Say Business Central didn't answer in time. Suggest checking the network and running `/wicket:setup` again. |

If the company is gone or renamed, pick it again with `companies`. For anything else, rerun **Add** with the current values as the recommended choices.

A `rejected` entry carries its reason, such as an unknown key or a bad value. Rerun **Add** under the same name and save with `replace: true`. Only the fields setup writes change; the user's other settings stay.

## 4. Change the default / Remove

- **Default.** Ask which connection, then call `setDefault`.
- **Remove.** Ask which connection, then confirm by name: "Remove `<name>`? This can't be undone." Only on a yes, call `remove`. Say that its saved sign-in is gone too. When the answer has `defaultCleared: true`, ask right away which connection becomes the default, and call `setDefault`. Until then, calls that name no connection are refused. If it used a Keychain secret, give the line to delete it: `! security delete-generic-password -s wicket -a <name>`.

A connection that comes from environment variables (`source: "env"`) can't be changed here. Say so, and say which `BC_*` variables set it.
