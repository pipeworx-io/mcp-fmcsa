# FMCSA — US Motor Carrier Registry & Safety

Look up any US trucking or bus company by USDOT number, MC/docket number, or name, and pull its safety record: safety rating, out-of-service rates vs national averages, crash counts, and operating authority (including broker status).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1879+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | What it answers |
|------|-----------------|
| `fmcsa_carrier_lookup` | Who is this carrier? Legal/DBA name, address, status, fleet size, drivers, cargo types — by USDOT number, MC number, or name. |
| `fmcsa_search_carriers` | Find carriers by name (partial match), ranked by fleet size, optional state filter. |
| `fmcsa_operating_authority` | Is this carrier authorized to operate or broker freight? MC docket + common/contract/broker authority status. |
| `fmcsa_safety_snapshot` | How safe is this carrier? Safety rating, driver/vehicle/hazmat out-of-service rates vs national averages, 24-month crash counts — plus SMS BASIC percentiles with a webKey. |

## Auth

Every tool works keyless. `fmcsa_safety_snapshot` uses the public SAFER Company Snapshot by default; pass a free FMCSA QCMobile webKey via `_apiKey` to add SMS BASIC category percentiles (Unsafe Driving, HOS Compliance, Vehicle Maintenance, ...). webKey signup (https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess) requires a login.gov account.

Note: a carrier whose biennial MCS-150 update lapsed shows as `record_inactive` — FMCSA publishes no safety snapshot for inactive USDOT numbers. That's an upstream data gap, not an outage; `fmcsa_carrier_lookup` still returns the last filed census record.

## Data sources

- FMCSA Motor Carrier Census — https://data.transportation.gov/resource/az4n-8mr2 (Socrata, keyless)
- FMCSA Operating Authority — https://data.transportation.gov/resource/6eyk-hxee (Socrata, keyless)
- FMCSA SAFER Company Snapshot — https://safer.fmcsa.dot.gov/query.asp (keyless)
- FMCSA QCMobile API — https://mobile.fmcsa.dot.gov/qc/services (webKey, optional)

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fmcsa": {
      "url": "https://gateway.pipeworx.io/fmcsa/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fmcsa/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1879+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fmcsa_carrier_lookup \
  -H 'Content-Type: application/json' \
  -d '{"dot_number":"54283"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fmcsa_carrier_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "fmcsa": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fmcsa"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-fmcsa
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fmcsa data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
