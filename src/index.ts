interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * FMCSA MCP — US motor-carrier (trucking/bus) registry & safety.
 *
 * Registration/authority/search are KEYLESS via the data.transportation.gov
 * Socrata datasets (census az4n-8mr2 ~4.5M carriers + operating-authority
 * 6eyk-hxee). The safety snapshot (SMS BASIC scores, OOS/crash detail) stays
 * on the FMCSA QCMobile API, which needs a free webKey — the gateway injects
 * PLATFORM_FMCSA_KEY, or the caller BYOs via _apiKey.
 *
 * History: this pack was QCMobile-only and required the webKey for EVERY call;
 * with the platform key unset the whole pack was dead. Moving lookup/search/
 * authority to keyless Socrata makes those work regardless, and adds name
 * search + operating-authority (broker status) the QCMobile version lacked.
 *
 * DOT# format differs across Socrata datasets: census stores it unpadded
 * ("54283"), authority zero-pads to 8 ("00054283") — normalized on lookup.
 *
 * Tools:
 * - fmcsa_carrier_lookup    : carrier by USDOT#, MC/docket#, or name (keyless)
 * - fmcsa_search_carriers   : search carriers by name, ranked by fleet (keyless)
 * - fmcsa_operating_authority: MC docket + common/contract/broker status (keyless)
 * - fmcsa_safety_snapshot   : SMS BASIC scores / OOS / crashes (QCMobile, webKey)
 */


const QC_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
const CENSUS = 'https://data.transportation.gov/resource/az4n-8mr2.json';
const AUTHORITY = 'https://data.transportation.gov/resource/6eyk-hxee.json';
const UA = 'pipeworx.io admin@pipeworx.io';

// ── Socrata (keyless) helpers ────────────────────────────────────────────

async function soda(url: string, params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${url}?${qs}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`upstream_down: FMCSA Socrata ${res.status} ${(await res.text()).slice(0, 150)}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

function digits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

function num(r: Record<string, unknown>, k: string): number | null {
  const n = Number(r[k]);
  return Number.isFinite(n) ? n : null;
}

const OPERATION: Record<string, string> = { A: 'Interstate', B: 'Intrastate Hazmat', C: 'Intrastate Non-Hazmat' };
const AUTH_STATUS: Record<string, string> = { A: 'Active', I: 'Inactive', N: 'None', P: 'Pending', R: 'Revoked' };

const CARGO_LABELS: Record<string, string> = {
  crgo_genfreight: 'General Freight', crgo_household: 'Household Goods', crgo_metalsheet: 'Metal: sheets/coils/rolls',
  crgo_motveh: 'Motor Vehicles', crgo_drivetow: 'Driveaway/Towaway', crgo_logpole: 'Logs/Poles/Beams',
  crgo_bldgmat: 'Building Materials', crgo_mobilehome: 'Mobile Homes', crgo_machlrg: 'Machinery, Large Objects',
  crgo_produce: 'Fresh Produce', crgo_liqgas: 'Liquids/Gases', crgo_intermodal: 'Intermodal Containers',
  crgo_passengers: 'Passengers', crgo_oilfield: 'Oilfield Equipment', crgo_livestock: 'Livestock',
  crgo_grainfeed: 'Grain/Feed/Hay', crgo_coalcoke: 'Coal/Coke', crgo_meat: 'Meat', crgo_garbage: 'Garbage/Refuse',
  crgo_usmail: 'US Mail', crgo_chem: 'Chemicals', crgo_drybulk: 'Commodities Dry Bulk', crgo_coldfood: 'Refrigerated Food',
  crgo_beverages: 'Beverages', crgo_paperprod: 'Paper Products', crgo_utility: 'Utility', crgo_farmsupp: 'Farm Supplies',
  crgo_construct: 'Construction', crgo_waterwell: 'Water Well',
};

function shapeCensus(r: Record<string, unknown>): Record<string, unknown> {
  const cargo = Object.entries(CARGO_LABELS)
    .filter(([col]) => String(r[col] ?? '').toUpperCase() === 'X')
    .map(([, label]) => label);
  return {
    dot_number: digits(r.dot_number) || null,
    legal_name: r.legal_name ?? null,
    dba_name: r.dba_name || null,
    status: String(r.status_code ?? '').toUpperCase() === 'A' ? 'Active' : 'Inactive',
    operation: OPERATION[String(r.carrier_operation ?? '').toUpperCase()] ?? (r.carrier_operation ?? null),
    hazmat: String(r.hm_ind ?? '').toUpperCase() === 'Y',
    address: {
      street: r.phy_street ?? null, city: r.phy_city ?? null, state: r.phy_state ?? null,
      zip: r.phy_zip ?? null, country: r.phy_country ?? null,
    },
    phone: r.phone ?? null,
    email: r.email_address || null,
    power_units: num(r, 'power_units'),
    trucks: num(r, 'truck_units'),
    buses: num(r, 'bus_units'),
    total_drivers: num(r, 'total_drivers'),
    cdl_drivers: num(r, 'total_cdl'),
    mcs150_mileage: num(r, 'mcs150_mileage'),
    mcs150_date: r.mcs150_date ?? null,
    cargo_carried: cargo,
  };
}

async function censusByDot(dot: string): Promise<Record<string, unknown> | null> {
  const rows = await soda(CENSUS, { dot_number: String(Number(dot)), $limit: '1' });
  return rows[0] ?? null;
}

// MC/docket → DOT via the authority dataset, then census. Docket numbers are
// stored like "MC136818"; accept a bare number or the MC-prefixed form.
async function dotFromDocket(mc: string): Promise<string | null> {
  const n = digits(mc);
  if (!n) return null;
  const padded = `MC${n.padStart(6, '0')}`;
  const rows = await soda(AUTHORITY, {
    $where: `docket_number='${padded}' OR docket_number='MC${n}'`,
    $select: 'dot_number,docket_number',
    $limit: '1',
  });
  return rows[0] ? digits(rows[0].dot_number) : null;
}

// ── QCMobile (keyed) helpers — safety snapshot only ──────────────────────

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return null;
}

async function qcFetch(tool: string, path: string, key: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${QC_BASE}${path}${sep}webKey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (res.status === 401 || res.status === 403) throw new Error(`FMCSA ${tool}: check the webKey (HTTP ${res.status})`);
  if (res.status === 404) throw new Error(`FMCSA ${tool}: no carrier found (HTTP 404)`);
  if (res.status === 429) throw new Error(`upstream_throttled: FMCSA ${tool} rate-limited (HTTP 429)`);
  if (!res.ok) throw new Error(`FMCSA ${tool}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error(`FMCSA ${tool}: empty response`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`FMCSA ${tool}: non-JSON response`);
  }
}

function extractCarriers(payload: unknown): Record<string, unknown>[] {
  const content = pick(payload, 'content') ?? payload;
  const items = Array.isArray(content) ? content : [content];
  const carriers: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const carrier = rec.carrier && typeof rec.carrier === 'object' ? rec.carrier : rec;
    if (carrier && typeof carrier === 'object' && Object.keys(carrier).length) carriers.push(carrier as Record<string, unknown>);
  }
  return carriers;
}

function mapBasics(payload: unknown) {
  const content = pick(payload, 'content') ?? payload;
  const items = Array.isArray(content) ? content : content ? [content] : [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const rec = item as Record<string, unknown>;
      const b = (rec.basic && typeof rec.basic === 'object' ? rec.basic : rec) as Record<string, unknown>;
      return {
        category: pick(b, 'basicShortDesc', 'basicDesc'),
        basic_id: pick(b, 'basicId'),
        percentile: pick(b, 'percentile'),
        inspections_with_violation: pick(b, 'totalInspectionWithViolation'),
        total_violations: pick(b, 'totalViolation'),
        snapshot_date: pick(b, 'snapShotDate'),
      };
    })
    .filter(Boolean);
}

// ── Tools ────────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'fmcsa_carrier_lookup',
    description:
      'Look up a US motor carrier (trucking/bus company) in the FMCSA census by USDOT number, MC/docket number, or company name. Keyless. Returns legal & DBA name, physical address, active/inactive status, interstate/intrastate operation, hazmat flag, fleet size (power units, trucks), driver counts, and cargo types carried. Set `by` to "dot", "mc", or "name" with the value in `value`. For carrier authority (broker status) use fmcsa_operating_authority; for safety scores use fmcsa_safety_snapshot.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        by: { type: 'string', enum: ['dot', 'mc', 'name'], description: '"dot" = USDOT number, "mc" = MC/docket number, "name" = company name.' },
        value: { type: 'string', description: 'The lookup value: a USDOT number (e.g. "54283"), MC/docket number (e.g. "136818"), or carrier name (e.g. "swift transportation").' },
      },
      required: ['by', 'value'],
    },
  },
  {
    name: 'fmcsa_search_carriers',
    description:
      'Search US motor carriers by company name (partial, case-insensitive) in the FMCSA census, ranked by fleet size. Keyless. Returns USDOT number, legal/DBA name, city/state, power units, drivers, and status. Optionally filter by 2-letter state. Use fmcsa_carrier_lookup for full detail on a returned USDOT number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Company name or fragment, e.g. "swift transport".' },
        state: { type: 'string', description: 'Optional 2-letter physical state filter, e.g. "TX".' },
        limit: { type: ['number', 'string'], description: 'Max results (1-50, default 15).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'fmcsa_operating_authority',
    description:
      'Get a carrier\'s FMCSA operating authority by USDOT number: the MC docket number and the status of its common-carrier, contract-carrier, and broker authority (Active / Inactive / Pending / Revoked). Keyless. Answers "is this carrier authorized to operate / broker freight" — the legal authority to haul, complementing the census (fmcsa_carrier_lookup) and safety (fmcsa_safety_snapshot).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dot_number: { type: ['number', 'string'], description: 'USDOT number, e.g. 54283.' },
      },
      required: ['dot_number'],
    },
  },
  {
    name: 'fmcsa_safety_snapshot',
    description:
      'Get the FMCSA safety profile for a carrier by USDOT number: safety rating, out-of-service status, driver/vehicle inspection & OOS rates, crash counts, and SMS BASIC categories (Unsafe Driving, HOS, Vehicle Maintenance, ...) with violation counts and percentiles. Requires an FMCSA webKey (free at mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess) — the gateway supplies a platform key, or pass your own via _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dot_number: { type: 'string', description: 'The carrier USDOT number, e.g. "76830".' },
        _apiKey: { type: 'string', description: 'FMCSA webKey (injected by the gateway).' },
      },
      required: ['dot_number'],
    },
  },
];

// ── Implementations ──────────────────────────────────────────────────────

async function carrierLookup(args: Record<string, unknown>): Promise<unknown> {
  const by = String(args.by ?? '').toLowerCase();
  const value = String(args.value ?? '').trim();
  if (!value) return { error: 'user_error', message: 'Pass a non-empty `value`.' };

  if (by === 'dot') {
    const dot = digits(value);
    if (!dot) return { error: 'user_error', message: 'For by="dot", value must be a USDOT number.' };
    const row = await censusByDot(dot);
    return row ? { found: true, ...shapeCensus(row) } : { found: false, by, value, message: 'No FMCSA census record for that USDOT number.' };
  }

  if (by === 'mc') {
    const dot = await dotFromDocket(value);
    if (!dot) return { found: false, by, value, message: 'No carrier found for that MC/docket number.' };
    const row = await censusByDot(dot);
    return row ? { found: true, resolved_from_mc: value, ...shapeCensus(row) } : { found: false, by, value, message: `Docket resolved to DOT ${dot} but no census record.` };
  }

  if (by === 'name') {
    const safe = value.toUpperCase().replace(/'/g, "''");
    const rows = await soda(CENSUS, {
      $where: `upper(legal_name) like '%${safe}%'`,
      $order: 'power_units DESC',
      $limit: '10',
    });
    return { by, value, count: rows.length, carriers: rows.map(shapeCensus) };
  }

  return { error: 'user_error', message: '`by` must be one of "dot", "mc", "name".' };
}

async function searchCarriers(args: Record<string, unknown>): Promise<unknown> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (name.length < 2) return { error: 'user_error', message: 'Pass a company name of at least 2 characters.' };
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
  const safe = name.toUpperCase().replace(/'/g, "''");
  const clauses = [`upper(legal_name) like '%${safe}%'`];
  const state = typeof args.state === 'string' && /^[A-Za-z]{2}$/.test(args.state.trim()) ? args.state.trim().toUpperCase() : null;
  if (state) clauses.push(`phy_state='${state}'`);
  const rows = await soda(CENSUS, {
    $where: clauses.join(' AND '),
    $select: 'dot_number,legal_name,dba_name,phy_city,phy_state,power_units,total_drivers,status_code,carrier_operation',
    $order: 'power_units DESC',
    $limit: String(limit),
  });
  return {
    query: name,
    state: state ?? null,
    count: rows.length,
    carriers: rows.map((r) => ({
      dot_number: digits(r.dot_number) || null,
      legal_name: r.legal_name ?? null,
      dba_name: r.dba_name || null,
      city: r.phy_city ?? null,
      state: r.phy_state ?? null,
      power_units: num(r, 'power_units'),
      total_drivers: num(r, 'total_drivers'),
      status: String(r.status_code ?? '').toUpperCase() === 'A' ? 'Active' : 'Inactive',
      operation: OPERATION[String(r.carrier_operation ?? '').toUpperCase()] ?? (r.carrier_operation ?? null),
    })),
  };
}

async function operatingAuthority(args: Record<string, unknown>): Promise<unknown> {
  const dot = digits(args.dot_number);
  if (!dot) return { error: 'user_error', message: 'Pass a numeric USDOT number, e.g. {"dot_number": 54283}.' };
  const rows = await soda(AUTHORITY, { dot_number: dot.padStart(8, '0'), $limit: '1' });
  if (rows.length === 0) return { found: false, dot_number: dot, message: 'No operating-authority record (carrier may be exempt/private or unregistered for authority).' };
  const r = rows[0];
  const st = (k: string) => AUTH_STATUS[String(r[k] ?? '').toUpperCase()] ?? (r[k] ?? null);
  const active = (k: string) => String(r[k] ?? '').toUpperCase() === 'A';
  return {
    found: true,
    dot_number: dot,
    mc_docket_number: r.docket_number ?? null,
    common_carrier_authority: st('common_stat'),
    contract_carrier_authority: st('contract_stat'),
    broker_authority: st('broker_stat'),
    authorized_to_operate: active('common_stat') || active('contract_stat'),
    authorized_to_broker: active('broker_stat'),
  };
}

async function safetySnapshot(args: Record<string, unknown>): Promise<unknown> {
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  if (!key) {
    return {
      error: 'auth_required',
      message: 'fmcsa_safety_snapshot needs an FMCSA webKey (free at https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess); pass it via _apiKey. Registration/authority/search tools are keyless — try fmcsa_carrier_lookup or fmcsa_operating_authority.',
    };
  }
  const dot = String(args.dot_number ?? '').trim();
  if (!dot) return { error: 'user_error', message: 'Pass a `dot_number`.' };

  const carrierRaw = await qcFetch('safety_snapshot', `/carriers/${encodeURIComponent(dot)}`, key);
  const carriers = extractCarriers(carrierRaw);
  if (carriers.length === 0) return { found: false, dot_number: dot, message: 'No carrier found.' };
  const c = carriers[0];

  let basics: unknown[] = [];
  try {
    basics = mapBasics(await qcFetch('safety_snapshot', `/carriers/${encodeURIComponent(dot)}/basics`, key));
  } catch {
    basics = [];
  }

  return {
    found: true,
    dot_number: pick(c, 'dotNumber') ?? dot,
    legal_name: pick(c, 'legalName'),
    dba_name: pick(c, 'dbaName'),
    safety_rating: pick(c, 'safetyRating'),
    safety_rating_date: pick(c, 'safetyRatingDate'),
    review_date: pick(c, 'reviewDate'),
    allowed_to_operate: pick(c, 'allowedToOperate', 'allowToOperate'),
    out_of_service: pick(c, 'oosDate', 'outOfServiceDate') ? true : pick(c, 'outOfService'),
    oos_date: pick(c, 'oosDate', 'outOfServiceDate'),
    driver_inspections: pick(c, 'driverInsp'),
    driver_oos_rate: pick(c, 'driverOosRate'),
    vehicle_inspections: pick(c, 'vehicleInsp'),
    vehicle_oos_rate: pick(c, 'vehicleOosRate'),
    crash_total: pick(c, 'crashTotal'),
    fatal_crash: pick(c, 'fatalCrash'),
    injury_crash: pick(c, 'injCrash'),
    basics,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'fmcsa_carrier_lookup':
        return await carrierLookup(args);
      case 'fmcsa_search_carriers':
        return await searchCarriers(args);
      case 'fmcsa_operating_authority':
        return await operatingAuthority(args);
      case 'fmcsa_safety_snapshot':
        return await safetySnapshot(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
