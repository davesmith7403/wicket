# Security policy

Wicket sits in front of business data, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub's
private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability**.

Include what you found, the steps or request that reproduce it, and the plugin / MCP server version
(`plugin/.claude-plugin/plugin.json`). You will get an acknowledgement, and
the fix and its disclosure will be coordinated with you.

## Supported versions

Fixes are made on the latest release; update the plugin to get them.

## Scope

In scope: the MCP server (`mcp/`), the plugin and the skill — for example credential handling, the
local connection and token stores, or a tool that bypasses a read-only connection. Issues in
Business Central itself, or in a tenant's own configuration (for example an over-broad exposure or
permission assignment), should go to the respective owner.
