---
description: Build or refresh the capability inventory for the current Wicket connection - what users can ask for in this Business Central tenant, through which objects and route, and what would unlock what is not usable yet.
argument-hint: "[business area or app to focus on]"
disable-model-invocation: true
allowed-tools: mcp__plugin_wicket_wicket__wicket_connections, mcp__plugin_wicket_wicket__wicket_whoami, mcp__plugin_wicket_wicket__wicket_capabilities, mcp__plugin_wicket_wicket__wicket_map, mcp__plugin_wicket_wicket__wicket_discover, mcp__plugin_wicket_wicket__wicket_describe, mcp__plugin_wicket_wicket__wicket_query, mcp__plugin_wicket_wicket__wicket_apis, mcp__plugin_wicket_wicket__wicket_skill
---

Build or refresh the capability inventory for this Wicket connection. Focus: $ARGUMENTS (when empty, the whole tenant; for a large tenant ask which business areas matter before going wide).

1. Fetch the method with `wicket_skill` (`mode: "section"`, `section: "solutions"`) and follow it: the inventory recipe, how to read the evidence, the routes, the capability entry format and the map rules.
2. Orient first if this session has not: `wicket_whoami`, `wicket_capabilities`, `wicket_map read`, in parallel. When the map already has `Capability:` and solution sections, compare installed apps and versions with it and re-check only what changed.
3. Read only. Never insert, modify, delete, invoke or run an action while building the inventory; the only writes are `wicket_map` upserts and removals.
4. Verify every object id, field and route live before writing an entry. Record structure only: ids, names, fields and routes, never record values or anything that came back masked.
5. Write one `Capability: <what the user asks for>` section per capability, in the user's own terms, and fix or remove entries that no longer hold. Never invent capabilities from examples the user gave in conversation; only what the tenant shows.
6. Finish with a short summary: what is usable now, and for the rest the step that would unlock it and who takes it.
