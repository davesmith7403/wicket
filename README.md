# Wicket

**Business Central for AI agents, through one governed endpoint.**

Wicket lets an agent work with Microsoft Dynamics 365 Business Central: discover the tenant's
tables and APIs, read and aggregate data, write records with optimistic concurrency and idempotency
keys, and run named business actions such as posting a document — with a real posting preview
first. Everything goes through a deny-by-default endpoint inside Business Central: an administrator
decides which tables are exposed, which fields are masked or hidden, and which actions may run.

This repository is the **agent side** of Wicket:

| Folder | What it is |
|---|---|
| [`plugin/`](plugin/) | The plugin: the bundled MCP server, the usage skill, and the `/wicket:orient` and `/wicket:inventory` commands |
| [`mcp/`](mcp/README.md) | The MCP server source (TypeScript on Bun): 23 `wicket_*` tools, multi-connection, OAuth2 service principal or device-code sign-in |
| [`skills/wicket-usage/`](skills/wicket-usage/SKILL.md) | The usage skill: how an agent should orient, filter, write, post and present results |
| [`docs/`](docs/) | Entra ID setup for the connection, and the single-file edition of the skill |

The repository root is also the plugin's marketplace.

## Requirements

> **The Wicket Business Central extension is required and is not published yet.** Every `wicket_*`
> tool calls the Wicket endpoint inside Business Central; without the extension installed in your
> environment the plugin installs but cannot connect. The extension will be published in its own
> repository.

- Business Central online (BC 26 or later) with the Wicket extension installed
- An Entra ID app registration (service principal) or a user account with a Wicket permission set —
  see [docs/setup-entra.md](docs/setup-entra.md)
- [Bun](https://bun.sh) 1.x

## Install

```
/plugin marketplace add davesmith7403/wicket
/plugin install wicket@wicket
```

Then configure a connection (tenant, environment, company, credentials) as described in
[mcp/README.md](mcp/README.md#connections). Connections and credentials stay on your machine in
`~/.config/wicket/`; client secrets can live in the system keychain.

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
