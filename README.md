# mcp-fmcsa

FMCSA MCP — US motor-carrier (trucking/bus) registry & safety.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `fmcsa_carrier_lookup` | Look up a US motor carrier (trucking/bus company) in the FMCSA census by USDOT number, MC/docket number, or company name. Keyless. Returns legal & DBA name, physical address, active/inactive status, interstate/intrastate operation, hazmat flag, fleet size (power units, trucks), driver counts, and cargo types carried. Set `by` to "dot", "mc", or "name" with the value in `value`. For carrier authority (broker status) use fmcsa_operating_authority; for safety scores use fmcsa_safety_snapshot. |
| `fmcsa_search_carriers` | Search US motor carriers by company name (partial, case-insensitive) in the FMCSA census, ranked by fleet size. Keyless. Returns USDOT number, legal/DBA name, city/state, power units, drivers, and status. Optionally filter by 2-letter state. Use fmcsa_carrier_lookup for full detail on a returned USDOT number. |
| `fmcsa_operating_authority` | Get a carrier's FMCSA operating authority by USDOT number: the MC docket number and the status of its common-carrier, contract-carrier, and broker authority (Active / Inactive / Pending / Revoked). Keyless. Answers "is this carrier authorized to operate / broker freight" — the legal authority to haul, complementing the census (fmcsa_carrier_lookup) and safety (fmcsa_safety_snapshot). |
| `fmcsa_safety_snapshot` | Get the FMCSA safety profile for a carrier by USDOT number: safety rating, out-of-service status, driver/vehicle inspection & OOS rates, crash counts, and SMS BASIC categories (Unsafe Driving, HOS, Vehicle Maintenance, ...) with violation counts and percentiles. Requires an FMCSA webKey (free at mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess) — the gateway supplies a platform key, or pass your own via _apiKey. |

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Fmcsa data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
