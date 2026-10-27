---
description: Orient on a Wicket connection - which Business Central tenant and company, read-only posture, limits, enabled actions, and what earlier sessions recorded in the tenant map, including its capability inventory.
argument-hint: "[connection name]"
disable-model-invocation: true
allowed-tools: mcp__plugin_wicket_wicket__wicket_connections, mcp__plugin_wicket_wicket__wicket_whoami, mcp__plugin_wicket_wicket__wicket_capabilities, mcp__plugin_wicket_wicket__wicket_map
---

Orient on Wicket for this session. Connection: $ARGUMENTS (when empty, use the selected or default connection).

1. When more than one connection is configured (`wicket_connections`), name the one you use and pass it as `connection` on every call.
2. In one turn, in parallel: `wicket_whoami`, `wicket_capabilities`, `wicket_map` with `action: "read"`. Read only; change nothing.
3. Report in a few lines: tenant, environment and company; read-only or not; field policy mode; API routing; whether async delivery is configured; the enabled actions (and how many are enrolled but disabled); the map's sections, how many are `Capability:` entries, and whether it is stale.
4. Then one sentence on what to do next:
   - no `Capability:` sections: offer to build the inventory with `/wicket:inventory`;
   - `stale: true`: offer `/wicket:inventory` to re-check what changed;
   - otherwise: say the inventory is current and ask what the user needs.

Keep the posture in mind for the rest of the session; do not repeat this unless the connection changes.
