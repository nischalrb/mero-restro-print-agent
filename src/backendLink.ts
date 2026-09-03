import { loadOrCreateConfig, setHostCredentials, normalizeBackendUrl, AgentConfig } from "./config";
import { printRemoteJobPayload } from "./jobs/queue";
import { logger } from "./logger";
import type { PrintRequestBody } from "./types";

/**
 * The agent's half of automatic enrollment — see the multi-printer host
 * redesign report for the full picture. This file now runs TWO independent
 * poll loops side by side:
 *
 *  1. The LEGACY single-station loop (legacyPollLoop* below) — completely
 *     unchanged from the original single-printer design. A computer that
 *     enrolled before this redesign shipped keeps working exactly as it did
 *     the moment it upgrades to this build, no customer action required.
 *
 *  2. The NEW host loop (hostPollLoop* below) — one token covers EVERY
 *     station/printer on this computer at once. `enroll()` (called from
 *     POST /enroll, i.e. Settings > Printers' "Connect this computer" step)
 *     now always performs HOST-level enrollment; the legacy loop is only
 *     ever entered by resumeIfEnrolled() finding an old stationToken saved
 *     from before this build was installed. Both loops can run
 *     simultaneously (a computer that enrolled the old way and later also
 *     ran "Connect this computer" to add a second printer) — they're
 *     entirely independent, keyed by different station ids.
 *
 * Neither loop touches the standalone pairingToken + direct /print /
 * /test-print path at all — that keeps working exactly as it always has,
 * regardless of enrollment state.
 */

const POLL_INTERVAL_MS = 3000;
/** Legacy loop only — see its own docblock below for why this cadence is fine for a single, rarely-reassigned printer. */
const LEGACY_STATION_INFO_REFRESH_EVERY_N_POLLS = 20;
/** Host loop refreshes its station list more often than the legacy loop refreshed its one printer — a customer adding a second/third printer from Settings expects it to start receiving jobs within seconds, not up to a minute later. */
const HOST_STATIONS_REFRESH_EVERY_N_POLLS = 5;

interface StationPrinterInfo {
  target: string;
  connectionType: "usb" | "network";
  paperWidth: "80mm" | "58mm";
  copies: number;
}

/** Shape of every backend JSON response — the same {success, message, data} envelope ResponseMessage (rms-backend) always returns. Typed loosely since this agent only reads a handful of specific fields out of `data` per call site. */
interface BackendEnvelope {
  success?: boolean;
  message?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

// ── Legacy single-station loop state — unchanged in behavior from before this file was split in two. ──
let legacyPollTimer: ReturnType<typeof setInterval> | null = null;
let legacyCachedPrinter: StationPrinterInfo | null = null;
let legacyPollCount = 0;

// ── Host loop state — one entry per station this host owns, keyed by the backend's station id. ──
let hostPollTimer: ReturnType<typeof setInterval> | null = null;
let hostPollCount = 0;
let hostStationPrinters = new Map<number, StationPrinterInfo>();
let hostStationTypes = new Map<number, string>();
let currentHostToken: string | null = null;
let currentHostBackendUrl: string | null = null;

export interface EnrollResult {
  hostName: string;
  organizationName?: string;
  branchName?: string;
}

/**
 * Called from POST /enroll — the entire agent-side surface of "Connect this
 * computer." Trades a short-lived, one-time HOST pairing code for a
 * persistent host token, saves it, and starts the host poll loop, which
 * from this point on serves every station subsequently added to this
 * computer without needing to be told about each one individually (see
 * hostPollOnce()'s periodic GET /print-agent/me below).
 */
export async function enroll(pairingCode: string, backendUrl: string): Promise<EnrollResult> {
  const base = backendUrl.replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/print-agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code: pairingCode }),
    });
  } catch (err) {
    throw new Error(`Could not reach Mero Restro (${(err as Error).message}). Check this computer's internet connection and try again.`);
  }

  const body = (await res.json().catch(() => ({}))) as BackendEnvelope;

  if (!res.ok || !body?.success) {
    throw new Error(body?.message || "That setup code is invalid or has expired — go back to Settings > Printers and try again.");
  }

  const hostToken: string = body.data.host_token;
  const host = body.data.host as { id: number; name: string; organization_name?: string; branch_name?: string };

  // Saves this environment's credential into hostProfiles (every OTHER
  // environment's saved profile, if any, is left untouched) and marks it
  // active — this is what makes switching backends explicit and safe: the
  // computer starts polling `base` from this point on, but a previously
  // connected environment's token isn't lost, just no longer in use. See
  // setHostCredentials()'s docblock and the multi-environment enrollment
  // redesign report for the bug this fixes (a single flat hostToken slot
  // being silently overwritten across environments).
  setHostCredentials(loadOrCreateConfig(), base, hostToken, host.id);
  logger.info(`Connected as "${host.name}" for ${host.organization_name ?? "this organization"} (${base}).`);

  startHostPollLoop(hostToken, base);

  return { hostName: host.name, organizationName: host.organization_name, branchName: host.branch_name };
}

/**
 * Called once at agent startup. Resumes whichever enrollment(s) this
 * computer's config.json already has — see this file's docblock for why
 * both can be present and both are resumed independently. Only the ONE
 * host profile marked active (config.activeHostBackendUrl) is resumed for
 * the host loop — any other saved environment's profile stays on disk,
 * untouched and unused, until a fresh "Connect this computer" from THAT
 * environment makes it active again.
 */
export function resumeIfEnrolled(config: AgentConfig): void {
  const activeProfile = config.activeHostBackendUrl ? config.hostProfiles?.[config.activeHostBackendUrl] : undefined;
  if (activeProfile && config.activeHostBackendUrl) {
    logger.info(`Resuming host poll loop from saved enrollment (${config.activeHostBackendUrl}).`);
    startHostPollLoop(activeProfile.hostToken, config.activeHostBackendUrl);
  }
  if (config.stationToken && config.backendUrl) {
    logger.info("Resuming legacy single-station poll loop from saved enrollment.");
    startLegacyPollLoop(config.stationToken, config.backendUrl);
  }
}

export interface HostProfileStatus {
  /** Whether the QUERIED backend (or, if none was specified, whichever one is currently active) has a saved profile on this computer. */
  enrolled: boolean;
  hostId: number | null;
  /**
   * Whether that profile is ALSO the one currently being polled. False
   * means "this computer has connected to that backend before, but is
   * currently serving a different one instead" — distinct from never
   * having connected at all, and the reason /health must never collapse
   * "enrolled" down to a single global boolean (see this file's docblock
   * and getHostProfileStatus()'s docblock below).
   */
  active: boolean;
  /** The backend currently being polled by the host loop, regardless of what was queried — null if this computer has never completed host enrollment against anything. */
  activeBackendUrl: string | null;
}

/**
 * Used by GET /health to report host-enrollment status SCOPED to whichever
 * backend the caller is actually asking about, rather than a single global
 * "hostEnrolled" boolean. This is the fix for the exact bug the
 * multi-environment enrollment redesign was written to close: with a
 * global boolean, a computer connected to backend A would make backend B's
 * Settings > Printers page ALSO read "Connected" — because it only ever
 * asked "is anything enrolled", never "is MY backend enrolled" — silently
 * hiding the fact that "Connect this computer" still needed to be clicked
 * from B, and leaving B's print_agent_hosts row at host_enrolled=false /
 * last_seen_at=null indefinitely while B's Settings page showed green.
 */
export function getHostProfileStatus(config: AgentConfig, queryBackendUrl?: string): HostProfileStatus {
  const activeKey = config.activeHostBackendUrl ?? null;
  const lookupKey = queryBackendUrl ? normalizeBackendUrl(queryBackendUrl) : activeKey;
  const profile = lookupKey ? config.hostProfiles?.[lookupKey] : undefined;

  return {
    enrolled: Boolean(profile),
    hostId: profile?.hostId ?? null,
    active: Boolean(profile) && lookupKey === activeKey,
    activeBackendUrl: activeKey,
  };
}

/**
 * Lets index.ts's POST /refresh-stations give the browser instant feedback
 * right after "+Add Printer" creates a new station, instead of waiting up
 * to HOST_STATIONS_REFRESH_EVERY_N_POLLS polls for it to be discovered on
 * the normal cadence. A no-op (not an error) if the host loop isn't running
 * — e.g. this computer hasn't completed "Connect this computer" yet.
 */
export function refreshHostStationsNow(): void {
  if (currentHostToken && currentHostBackendUrl) {
    hostPollCount = 0; // forces the next poll to re-fetch /print-agent/me
    void hostPollOnce(currentHostToken, currentHostBackendUrl);
  }
}

// ── Host loop (multi-station) ──────────────────────────────────────────

function startHostPollLoop(hostToken: string, backendUrl: string): void {
  if (hostPollTimer) clearInterval(hostPollTimer);
  hostStationPrinters = new Map();
  hostStationTypes = new Map();
  hostPollCount = 0;
  currentHostToken = hostToken;
  currentHostBackendUrl = backendUrl;
  hostPollTimer = setInterval(() => {
    void hostPollOnce(hostToken, backendUrl);
  }, POLL_INTERVAL_MS);
  void hostPollOnce(hostToken, backendUrl);
}

async function hostPollOnce(hostToken: string, backendUrl: string): Promise<void> {
  const headers = { Authorization: `Bearer ${hostToken}` };

  if (hostStationPrinters.size === 0 || hostPollCount % HOST_STATIONS_REFRESH_EVERY_N_POLLS === 0) {
    try {
      const res = await fetch(`${backendUrl}/api/v1/print-agent/me`, { headers });
      const body = (await res.json().catch(() => ({}))) as BackendEnvelope;
      if (res.ok && body?.success) {
        const stations = (body.data.stations ?? []) as {
          id: number;
          type: string;
          printer: { target: string; connection_type: "usb" | "network"; paper_width: "80mm" | "58mm"; copies?: number } | null;
        }[];

        const nextPrinters = new Map<number, StationPrinterInfo>();
        const nextTypes = new Map<number, string>();
        for (const station of stations) {
          nextTypes.set(station.id, station.type);
          if (station.printer) {
            nextPrinters.set(station.id, {
              target: station.printer.target,
              connectionType: station.printer.connection_type,
              paperWidth: station.printer.paper_width,
              copies: station.printer.copies ?? 1,
            });
          }
        }
        hostStationPrinters = nextPrinters;
        hostStationTypes = nextTypes;
      }
    } catch (err) {
      logger.warn(`Print agent host: could not refresh station list: ${(err as Error).message}`);
    }
  }
  hostPollCount += 1;

  let jobsRes: Response;
  try {
    jobsRes = await fetch(`${backendUrl}/api/v1/print-agent/me/jobs`, { headers });
  } catch {
    // Transient network blip — normal and expected occasionally, next tick
    // tries again. Not logged at warn/error level to avoid spamming the
    // log file if a restaurant's internet is flaky.
    return;
  }

  const jobsBody = (await jobsRes.json().catch(() => ({}))) as BackendEnvelope;
  if (!jobsRes.ok || !jobsBody?.success) return;

  const jobs = (jobsBody.data.jobs ?? []) as {
    id: number;
    station_id: number;
    station_type: string;
    type: string;
    payload: PrintRequestBody["payload"];
    idempotency_key: string;
  }[];

  for (const job of jobs) {
    // eslint-disable-next-line no-await-in-loop
    await handleHostJob(job, backendUrl, headers);
  }
}

async function handleHostJob(
  job: { id: number; station_id: number; station_type: string; type: string; payload: PrintRequestBody["payload"] },
  backendUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  const printer = hostStationPrinters.get(job.station_id);

  if (!printer) {
    await reportHostJob(job.id, backendUrl, headers, "failed", `No printer is assigned to the ${job.station_type} station yet — set one from Settings > Printers.`);
    return;
  }

  const result = await printRemoteJobPayload(job.payload, printer.paperWidth, {
    connectionType: printer.connectionType,
    target: printer.target,
    copies: printer.copies,
  });

  await reportHostJob(job.id, backendUrl, headers, result.ok ? "printed" : "failed", result.ok ? undefined : result.error);
}

async function reportHostJob(
  jobId: number,
  backendUrl: string,
  headers: Record<string, string>,
  status: "printed" | "failed",
  error?: string,
): Promise<void> {
  try {
    await fetch(`${backendUrl}/api/v1/print-agent/jobs/${jobId}/report`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status, error }),
    });
  } catch (err) {
    // Same reasoning as the legacy loop's report() — an unreported job just
    // stays "processing" and the backend's own stuck-job timeout recovers
    // it automatically. Logged, not thrown.
    logger.warn(`Print agent host: could not report job ${jobId}: ${(err as Error).message}`);
  }
}

// ── Legacy single-station loop — unchanged behavior, see this file's docblock. ──

function startLegacyPollLoop(stationToken: string, backendUrl: string): void {
  if (legacyPollTimer) clearInterval(legacyPollTimer);
  legacyCachedPrinter = null;
  legacyPollCount = 0;
  legacyPollTimer = setInterval(() => {
    void legacyPollOnce(stationToken, backendUrl);
  }, POLL_INTERVAL_MS);
  void legacyPollOnce(stationToken, backendUrl);
}

async function legacyPollOnce(stationToken: string, backendUrl: string): Promise<void> {
  const headers = { Authorization: `Bearer ${stationToken}` };

  if (!legacyCachedPrinter || legacyPollCount % LEGACY_STATION_INFO_REFRESH_EVERY_N_POLLS === 0) {
    try {
      const res = await fetch(`${backendUrl}/api/v1/print-stations/me`, { headers });
      const body = (await res.json().catch(() => ({}))) as BackendEnvelope;
      if (res.ok && body?.success && body.data.printer) {
        legacyCachedPrinter = {
          target: body.data.printer.target,
          connectionType: body.data.printer.connection_type,
          paperWidth: body.data.printer.paper_width,
          copies: body.data.printer.copies ?? 1,
        };
      } else if (res.ok && body?.success) {
        legacyCachedPrinter = null;
      }
    } catch (err) {
      logger.warn(`Print station: could not refresh station info: ${(err as Error).message}`);
    }
  }
  legacyPollCount += 1;

  let jobsRes: Response;
  try {
    jobsRes = await fetch(`${backendUrl}/api/v1/print-stations/me/jobs`, { headers });
  } catch {
    return;
  }

  const jobsBody = (await jobsRes.json().catch(() => ({}))) as BackendEnvelope;
  if (!jobsRes.ok || !jobsBody?.success) return;

  const jobs = (jobsBody.data.jobs ?? []) as { id: number; type: string; payload: PrintRequestBody["payload"]; idempotency_key: string }[];

  for (const job of jobs) {
    // eslint-disable-next-line no-await-in-loop
    await handleLegacyJob(job, backendUrl, headers);
  }
}

async function handleLegacyJob(
  job: { id: number; type: string; payload: PrintRequestBody["payload"] },
  backendUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  if (!legacyCachedPrinter) {
    await reportLegacyJob(job.id, backendUrl, headers, "failed", "No printer is assigned to this station yet — set one from Settings > Printers.");
    return;
  }

  const result = await printRemoteJobPayload(job.payload, legacyCachedPrinter.paperWidth, {
    connectionType: legacyCachedPrinter.connectionType,
    target: legacyCachedPrinter.target,
    copies: legacyCachedPrinter.copies,
  });

  await reportLegacyJob(job.id, backendUrl, headers, result.ok ? "printed" : "failed", result.ok ? undefined : result.error);
}

async function reportLegacyJob(
  jobId: number,
  backendUrl: string,
  headers: Record<string, string>,
  status: "printed" | "failed",
  error?: string,
): Promise<void> {
  try {
    await fetch(`${backendUrl}/api/v1/print-jobs/${jobId}/report`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status, error }),
    });
  } catch (err) {
    logger.warn(`Print station: could not report job ${jobId}: ${(err as Error).message}`);
  }
}
