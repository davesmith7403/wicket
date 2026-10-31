# Wicket

**Business Central for AI agents, through one governed endpoint.**

Wicket lets an agent work with Microsoft Dynamics 365 Business Central: discover the tenant's
tables and APIs, read and aggregate data, write records with optimistic concurrency and idempotency
keys (one at a time, or many in one all-or-nothing batch), run named business actions such as
posting a document — with a real posting preview first — and look back at what the agent changed. Everything goes through a deny-by-default endpoint inside Business Central: an administrator
decides which tables are exposed, which fields are masked or hidden, and which actions may run.

> **New here?** The [quick start](https://davesmith7403.github.io/wicket-bc/quick-start.html) connects Claude to a customer's Business Central in six steps, from
> Windows or a Mac: three in Business Central, three in Claude Code or the Claude desktop app.

This repository is the **agent side** of Wicket:

| Folder | What it is |
|---|---|
| [`plugin/`](plugin/) | The plugin: the server launcher for Windows and Mac, the usage skill, and the `/wicket:setup`, `/wicket:orient` and `/wicket:inventory` commands; the same files make the desktop app extension |
| [`mcp/`](mcp/README.md) | The MCP server source (TypeScript, compiled per platform) and its launcher (Go): 26 `wicket_*` tools, multi-connection, OAuth2 service principal, browser or device-code sign-in |
| [`skills/wicket-usage/`](skills/wicket-usage/SKILL.md) | The usage skill: how an agent should orient, filter, write, post and present results |
| [`docs/`](docs/) | Entra ID setup for the connection, and the single-file edition of the skill |

The repository root is also the plugin's marketplace.

## Requirements

> **The Wicket Business Central extension is required.** Every `wicket_*` tool calls the Wicket
> endpoint inside Business Central; without the extension installed in your environment the plugin
> installs but cannot connect. Get it from the
> [wicket-bc releases](https://github.com/davesmith7403/wicket-bc/releases), and set it up with the
> [Product Guide](https://davesmith7403.github.io/wicket-bc/).

- Business Central online (BC 26 or later) with the Wicket extension installed
- A user account with a Wicket permission set, or an Entra ID app registration (service principal) —
  see [docs/setup-entra.md](docs/setup-entra.md)
- Claude Code or the Claude desktop app, on Windows (x64 or arm64) or an Apple-silicon Mac. Nothing
  else to install: on its first start Wicket downloads its server for your platform from this
  repository's release and checks it against the checksums it carries.

## Install

```
/plugin marketplace add davesmith7403/wicket
/plugin install wicket@wicket
```

To get new versions without asking, turn on auto-update once: run `/plugin`, open **Marketplaces**, choose
**wicket** and **Enable auto-update**. Claude Code leaves it off for marketplaces outside Anthropic's own; without
it, update with **Update now** on the plugin under `/plugin` → **Installed**, or `claude plugin update wicket@wicket`
in your shell. A new version loads with the next session, or at once with `/reload-plugins`.

Then run **`/wicket:setup`**. It asks how you sign in (in the browser, with a device code, or as an
app with a client secret), works out the tenant from a pasted Business Central address or your work
email, and lets you pick the environment and company from lists: no IDs to look up. It saves the
connection, tests it, and the tools work at once. Run it again to see what is configured
(`/wicket:setup view`), add another tenant or company, fix a connection that fails, or change the default. Connections stay on your machine in `~/.config/wicket/`;
a client secret goes into your computer's own secret store (the Keychain on a Mac, protected for your
Windows account on Windows) through a one-time page in your browser, never through the
chat. To write the file by hand instead, see [mcp/README.md](mcp/README.md#connections).

### In the Claude desktop app

Download `wicket-<version>.mcpb` from the
[latest release](https://github.com/davesmith7403/wicket/releases/latest) and open it: the desktop app
shows the extension and installs it with one click. Then say **"set up Wicket"** in a chat ([quick start, desktop steps](https://davesmith7403.github.io/wicket-bc/quick-start.html#desktop)); the
same guided setup runs there, and connections are shared with Claude Code on the same machine.
Pages Claude builds in the desktop app (dashboards, reports) can query Wicket live while you have them open.

### Claude Code or the desktop app?

Both run the same server with the same tools and the same usage skill, and on one machine they share
the connections, the saved sign-ins and any client secret: set up in one, and the other is connected
too. What differs is the app around Wicket.

| | Claude Code (the plugin) | Claude desktop app (the `.mcpb` extension) |
|---|---|---|
| Install | `/plugin marketplace add`, then `/plugin install` | Open the `.mcpb` and confirm |
| Setup and helpers | `/wicket:setup`, `/wicket:orient` and `/wicket:inventory` | No commands: say "set up Wicket", and the same guided setup runs through the tool |
| Updates | Automatic once you turn on auto-update for the `wicket` marketplace (`/plugin` → **Marketplaces**); otherwise **Update now** on the plugin under `/plugin` → **Installed** | Open the `.mcpb` from the new release |
| Dashboards and reports | Builds them; their pages query Business Central live only when opened in the desktop app | Pages query Business Central live while they are open |
| Files and automation | Works on your disk: writes Excel and CSV exports to a folder, runs scripts, works next to your code | Chat first: answers, documents and pages, and an export comes as a file to download |

The desktop app suits people who mainly ask questions and want dashboards; Claude Code suits whoever
also exports data, automates or works on Business Central code. Installing both is fine.

### Other hosts

Other MCP hosts can run the server directly — see [mcp/README.md](mcp/README.md) for Claude Desktop
and standalone setup, and for installing the skill without the plugin.

## Using it

Start a session with `/wicket:orient`: it reads who you are connected as, what the endpoint allows,
and what earlier sessions learned about the tenant. `/wicket:inventory` records what people can ask for in your
tenant, through which objects, and what would unlock the rest. After that, ask in plain language — "open sales orders
over 10,000 for customers in Germany", "post this invoice, preview first" — and the skill guides the
agent through the tools.

## Development

```bash
cd mcp
bun install
bun run typecheck
bun test
```

The skill's source is `skills/wicket-usage/`; after editing it run `bun run skill:sync`, and after
changing the server or the skill run `bun run plugin:build`. The test suite fails while the
generated copies are out of date. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Report security issues as described in [SECURITY.md](SECURITY.md).
