interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * FMCSA MCP — US motor-carrier (trucking/bus) registry & safety.
 *
 * Registration/authority/search are KEYLESS via the data.transportation.gov
 * Socrata datasets (census az4n-8mr2 ~4.5M carriers + operating-authority
 * 6eyk-hxee). The safety snapshot is keyless too via the SAFER Company
 * Snapshot HTML (safety rating, OOS rates, crashes); with a free QCMobile
 * webKey (_apiKey or PLATFORM_FMCSA_KEY) it upgrades to the QCMobile API and
 * adds SMS BASIC percentiles. The webKey signup sits behind a login.gov
 * account (interactive MFA), which is why the platform key stayed uncollected.
 *
 * History: this pack was QCMobile-only and required the webKey for EVERY call;
 * with the platform key unset the whole pack was dead. Moving lookup/search/
 * authority to keyless Socrata makes those work regardless, and adds name
 * search + operating-authority (broker status) the QCMobile version lacked.
 * SAFER keyless safety fallback added 2026-08-14 (fleet #352).
 *
 * SAFER gotchas: the page is windows-1252 HTML with help prose that repeats
 * the data labels WITHOUT colons — parse only `Label:|value` shapes from the
 * tag-stripped pipe text. An unfiled biennial MCS-150 makes a DOT "Record
 * Inactive" (e.g. 80321): SAFER publishes NO safety data for it — that is an
 * FMCSA gap, not an empty result of ours; we return found:false with
 * reason:"record_inactive".
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


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'FMCSA');
}

const QC_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
const CENSUS = 'https://data.transportation.gov/resource/az4n-8mr2.json';
const AUTHORITY = 'https://data.transportation.gov/resource/6eyk-hxee.json';
const UA = 'pipeworx.io admin@pipeworx.io';

// ── Socrata (keyless) helpers ────────────────────────────────────────────

async function soda(url: string, params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams(params);
  const res = await pwFetch(`${url}?${qs}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
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

// ── SAFER (keyless) safety-snapshot fallback ─────────────────────────────

const SAFER = 'https://safer.fmcsa.dot.gov/query.asp';
// SAFER's WAF is happier with a browser UA than a bot-identifying one.
const SAFER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Strip tags/entities and collapse every run of pipes+whitespace to one "|",
// so table cells become `Label:|value|` regardless of markup nesting.
function saferText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8226;|&#160;/g, ' ')
    .replace(/\s*\|[\s|]*/g, '|');
}

function saferNum(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v.replace(/[,%*]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

async function saferSnapshot(dot: string): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({
    searchtype: 'ANY', query_type: 'queryCarrierSnapshot', query_param: 'USDOT', query_string: dot,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let res: Response;
  try {
    res = await fetch(`${SAFER}?${qs}`, {
      headers: { Accept: 'text/html', 'User-Agent': SAFER_UA },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`upstream_down: FMCSA SAFER ${res.status}`);
  const text = saferText(await res.text());

  if (/INACTIVE in the SAFER database|Record Inactive/i.test(text)) {
    return {
      found: false,
      dot_number: dot,
      reason: 'record_inactive',
      message:
        `FMCSA lists USDOT ${dot} as INACTIVE (49 CFR 390.19(b)(4) — biennial MCS-150 update not filed). SAFER publishes no safety snapshot for inactive records; this is an FMCSA data gap for the carrier, not a lookup failure.`,
      hint: 'fmcsa_carrier_lookup returns the last filed census record (name, address, fleet size) for this USDOT number.',
    };
  }

  // An empty table cell collapses away entirely, so the "value" after a label
  // can be the NEXT label — treat a colon-terminated capture as empty.
  const grab = (re: RegExp): string | null => {
    const m = text.match(re);
    const v = m?.[1]?.trim() ?? '';
    return v && v !== 'None' && !v.endsWith(':') ? v : null;
  };

  // "Operating Authority Status:|AUTHORIZED FOR:|Motor Carrier of Property|
  // Broker of Property|For Licensing..." — collect the authority list up to
  // the boilerplate link.
  const authority = (() => {
    const m = text.match(/Operating Authority Status:\|((?:[^|]+\|)*?)(?:For Licensing|MC\/MX\/FF|$)/);
    if (!m) return null;
    const parts = m[1].split('|').map((s) => s.trim()).filter(Boolean);
    if (parts[0] === 'AUTHORIZED FOR:') return parts.length > 1 ? `AUTHORIZED FOR: ${parts.slice(1).join('; ')}` : null;
    return parts.join('; ') || null;
  })();

  const legalName = grab(/Legal Name:\|([^|]+)/);
  if (!legalName) {
    return {
      found: false,
      dot_number: dot,
      reason: 'not_found',
      message: `SAFER has no company snapshot for USDOT ${dot}.`,
      hint: 'Check the number with fmcsa_carrier_lookup or fmcsa_search_carriers.',
    };
  }

  const insp = text.match(
    /Inspection Type\|Vehicle\|Driver\|Hazmat\|IEP\|Inspections\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|Out of Service\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|Out of Service %\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|Nat'l Average %\|[^|]*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)/,
  );
  const lane = (i: number) =>
    insp
      ? {
          inspections: saferNum(insp[1 + i]),
          out_of_service: saferNum(insp[5 + i]),
          oos_rate_pct: saferNum(insp[9 + i]),
          national_avg_pct: saferNum(insp[13 + i]),
        }
      : null;
  const crashes = text.match(/Type\|Fatal\|Injury\|Tow\|Total\|Crashes\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)/);

  return {
    found: true,
    source: 'FMCSA SAFER Company Snapshot (keyless)',
    as_of: grab(/information systems as of\|([0-9/]+)/),
    dot_number: dot,
    legal_name: legalName,
    dba_name: grab(/DBA Name:\|([^|]+)/),
    entity_type: grab(/Entity Type:\|([^|]+)/),
    usdot_status: grab(/USDOT Status:\|([^|]+)/),
    oos_date: grab(/Out of Service Date:\|([^|]+)/),
    operating_authority_status: authority,
    safety_rating: grab(/\|Rating:\|([^|]+)/),
    safety_rating_type: grab(/\|Type:\|([^|]+)/),
    safety_rating_date: grab(/Rating Date:\|([^|]+)/),
    safety_review_date: grab(/Review Date:\|([^|]+)/),
    power_units: saferNum(grab(/Power Units:\|([^|]+)/)),
    drivers: saferNum(grab(/\|Drivers:\|([^|]+)/)),
    us_inspections_24mo: insp
      ? { vehicle: lane(0), driver: lane(1), hazmat: lane(2), iep: lane(3) }
      : null,
    us_crashes_24mo: crashes
      ? { fatal: saferNum(crashes[1]), injury: saferNum(crashes[2]), tow: saferNum(crashes[3]), total: saferNum(crashes[4]) }
      : null,
    basics: [],
    basics_note:
      'SMS BASIC category percentiles require an FMCSA QCMobile webKey (free at https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess) — pass it via _apiKey to include them.',
  };
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
  const res = await pwFetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
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
      'Look up a US motor carrier (trucking/bus company) in the FMCSA census by USDOT number, MC/docket number, or company name. Keyless. Returns legal & DBA name, physical address, active/inactive status, interstate/intrastate operation, hazmat flag, fleet size (power units, trucks), driver counts, and cargo types carried. Pass `dot_number` (or `mc_number`, or `name`) directly, or the generic `by` + `value` pair. For carrier authority (broker status) use fmcsa_operating_authority; for safety scores use fmcsa_safety_snapshot.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dot_number: { type: ['number', 'string'], description: 'USDOT number to look up, e.g. 54283. The simplest way to call this tool.' },
        mc_number: { type: ['number', 'string'], description: 'MC/docket number to look up, e.g. "136818" or "MC136818".' },
        name: { type: 'string', description: 'Carrier company name to look up, e.g. "swift transportation".' },
        by: { type: 'string', enum: ['dot', 'mc', 'name'], description: 'Alternative calling shape: "dot" = USDOT number, "mc" = MC/docket number, "name" = company name; value goes in `value`.' },
        value: { type: 'string', description: 'The lookup value when using `by`: a USDOT number (e.g. "54283"), MC/docket number (e.g. "136818"), or carrier name.' },
      },
      required: [],
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
      'Get the FMCSA safety profile for a US motor carrier by USDOT number: safety rating (Satisfactory/Conditional/Unsatisfactory) with rating and review dates, USDOT operating status, driver/vehicle/hazmat inspection counts and out-of-service (OOS) rates vs national averages, and 24-month crash counts (fatal/injury/tow). Keyless via the FMCSA SAFER Company Snapshot. Pass an FMCSA QCMobile webKey via _apiKey to also get SMS BASIC categories (Unsafe Driving, HOS, Vehicle Maintenance, ...) with violation counts and percentiles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        // _apiKey deliberately NOT declared: a declared _apiKey (with no
        // platform key) key-blocks the whole pack out of ask_pipeworx menus
        // (gateway keyBlockedTools, fleet #259/#352). The impl still reads
        // args._apiKey — a BYO webKey upgrades to QCMobile SMS BASICs.
        dot_number: { type: ['number', 'string'], description: 'The carrier USDOT number, e.g. "76830".' },
      },
      required: ['dot_number'],
    },
  },
];

// ── Implementations ──────────────────────────────────────────────────────

async function carrierLookup(args: Record<string, unknown>): Promise<unknown> {
  let by = String(args.by ?? '').toLowerCase();
  let value = String(args.value ?? '').trim();
  // Forgiving aliases: routers naturally fill dot_number/mc_number/name
  // instead of the by/value pair — accept both shapes (fleet #352).
  if (!value) {
    const alias = (k: string) => String(args[k] ?? '').trim();
    if (alias('dot_number')) [by, value] = ['dot', alias('dot_number')];
    else if (alias('mc_number')) [by, value] = ['mc', alias('mc_number')];
    else if (alias('name')) [by, value] = ['name', alias('name')];
  }
  if (!by && value) by = /^mc/i.test(value) ? 'mc' : /^[\d\s-]+$/.test(value) ? 'dot' : 'name';
  if (!value) return { error: 'user_error', message: 'Pass a `dot_number`, `mc_number`, or `name` (or the `by` + `value` pair).' };

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
  const dot = digits(args.dot_number);
  if (!dot) return { error: 'user_error', message: 'Pass a numeric `dot_number`, e.g. {"dot_number": 54283}.' };
  // Keyless path: SAFER Company Snapshot (rating, OOS rates, crashes). The
  // QCMobile webKey only adds SMS BASIC percentiles on top.
  if (!key) return await saferSnapshot(dot);

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
