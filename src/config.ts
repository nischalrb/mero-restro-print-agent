import fs from "fs";
import path from "path";
import crypto from "crypto";
import net from "net";
import { configFilePath } from "./paths";
import { logger } from "./logger";

/**
 * Single source of truth for the agent's version — read from package.json
 * rather than a separate hardcoded constant, so /health's `version` field,
 * the Electron tray app's `app.getVersion()`, and the installer's file name
 * (electron-builder reads package.json too) can never drift out of sync.
 * Falls back to "0.0.0" if package.json can't be read for some reason
 * (e.g. a packaging layout issue) rather than crashing the whole agent over
 * a version string.
 */
export const VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * The agent doesn't hard-code a single port — a restaurant's computer may
 * already have something else bound to any given number. Instead it tries
 * a small, deliberately uncommon range in order and binds the first free
 * one, then remembers that choice on disk so restarts stay on the same
 * port when possible (nicer for the frontend's probing — see
 * printerService.ts's discoverAgent()). The range starts at 38111, an
 * unassigned/unregistered port with IANA, chosen specifically to avoid
 * common dev-server collisions (3000/5173/8080/etc.).
 */
export const CANDIDATE_PORTS = [38111, 38112, 38113, 38114, 38115];

/**
 * The one production origin allowed to talk to this agent. Checked with an
 * exact string match — see isAllowedOrigin() below for the full policy
 * (this plus a loopback-only dev-port pattern).
 */
export const PRODUCTION_ORIGIN = "https://app.merorestroapp.com";

/**
 * Vite's dev server does NOT reliably run on port 5173 — if that port is
 * already taken (e.g. a previous `npm run dev` still running from an
 * earlier debugging session, exactly what happened here), Vite silently
 * picks the next free port (5174, 5175, ...) with no `strictPort` set in
 * vite.config.ts. Hard-coding "http://localhost:5173" as the only allowed
 * dev origin means the agent starts silently 403-ing every request the
 * instant Vite lands on a different port — indistinguishable, from the
 * frontend's perspective, from "no agent running at all" (see
 * printerService.ts's pingHealth(), which treats any non-ok response,
 * including a 403, as "nothing here").
 *
 * So: any loopback origin (localhost or 127.0.0.1) on any port is allowed
 * in dev. This is deliberately scoped to loopback hosts only — it does NOT
 * open the agent to the public internet or LAN, since a request still has
 * to originate from the same machine to have this Origin at all. Actual
 * print-triggering routes (/print, /test-print) still require the pairing
 * token from requireToken() regardless of origin, so this only widens who
 * can call the read-only /health and /printers routes.
 */
const LOOPBACK_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;

/** @deprecated kept for anything that still imports the old name; prefer isAllowedOrigin(). */
export const ALLOWED_ORIGINS = [PRODUCTION_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * Origin allowlisting is centralized here (this one function is the only
 * place origin-trust decisions get made — security.ts just calls it) so it
 * is genuinely "configurable in one place" rather than scattered
 * conditionals: the built-in production + loopback-dev rules always apply,
 * PLUS whatever a restaurant's own config.json adds via extraAllowedOrigins
 * (e.g. a white-labeled/staging frontend domain some deployments may need)
 * without editing agent source at all.
 */
export function isAllowedOrigin(origin: string, extra: string[] = []): boolean {
  return origin === PRODUCTION_ORIGIN || LOOPBACK_ORIGIN_PATTERN.test(origin) || extra.includes(origin);
}

export interface AgentConfig {
  /** The port this agent last successfully bound to. */
  port: number;
  /**
   * A random token generated on first run and required (via the
   * X-Print-Agent-Token header) on every print-triggering request. Origin
   * checking alone only stops *browser* JS from an untrusted site; this
   * token is the second layer that also covers non-browser callers on the
   * same machine. The frontend learns this token the same way it learns
   * the port: it's shown once in Settings > Printers when the user clicks
   * "Connect printer agent", copy-pasted in, and then remembered.
   */
  pairingToken: string;
  /**
   * Extra origins to trust beyond the built-in production+loopback-dev
   * rules, e.g. a white-labeled frontend domain — empty by default. Not
   * exposed through any UI yet; an advanced restaurant/integrator can add
   * entries to this array directly in config.json (see paths.ts for its
   * location) and restart the agent. Kept as a real, validated array
   * rather than a free-text field specifically so it can't silently
   * become `["*"]` or similar — isAllowedOrigin() above only ever does
   * exact string matches against it, same as the built-in rules.
   */
  extraAllowedOrigins?: string[];
  /**
   * Set once this agent has completed the ORIGINAL, single-printer
   * automatic enrollment as a Print Station (see backendLink.ts's
   * legacy*PollLoop functions) — a persistent, backend-issued,
   * tenant-scoped credential, entirely separate from `pairingToken` above.
   * Kept working forever, unmodified, for any computer that enrolled this
   * way before the multi-printer host redesign — see hostToken below for
   * what every NEW enrollment uses instead. A computer can have both set at
   * once (e.g. it enrolled the old way, then later also ran "Connect this
   * computer" to add a second printer) — both poll loops just run
   * independently, each serving its own station(s).
   */
  stationToken?: string;
  /**
   * @deprecated Superseded by `hostProfiles`/`activeHostBackendUrl` below —
   * see the multi-environment enrollment redesign report. A pre-existing
   * config.json from an earlier 1.2.0 build may still have this (paired
   * with `hostId`/`backendUrl`) on disk; `loadOrCreateConfig()` migrates it
   * into `hostProfiles` once, then clears it. Never written going forward —
   * kept typed here only so that one-time migration read compiles.
   */
  hostToken?: string;
  /** @deprecated see `hostToken` above — migrated into `hostProfiles` alongside it. */
  hostId?: number;
  /**
   * Still actively used, but ONLY as half of the legacy single-station
   * pair (`stationToken` + `backendUrl` together) — see stationToken above.
   * The host loop's per-environment equivalent lives in `hostProfiles`
   * below instead, precisely because a single flat field here was the bug:
   * one computer running both a local dev backend and production at
   * different times had nowhere to keep both sets of host credentials
   * without one silently overwriting the other.
   */
  backendUrl?: string;
  /**
   * One saved host-loop credential per backend environment this computer
   * has ever completed "Connect this computer" against, keyed by that
   * backend's normalized origin (see normalizeBackendUrl()) — e.g.
   * "https://api.merorestroapp.com" and "http://localhost:8000" each get
   * their own entry, and connecting to one never touches the other's saved
   * token. Only ONE profile is ever actively polled at a time (see
   * activeHostBackendUrl) — multiple entries exist so switching BACK to a
   * previously-connected environment doesn't require re-pairing, not to
   * enable simultaneous multi-backend polling, which is deliberately not
   * supported (see the multi-environment enrollment redesign report's
   * explicit "one active backend connection at a time" requirement).
   */
  hostProfiles?: Record<string, HostProfile>;
  /**
   * Which key in `hostProfiles` the host poll loop is currently serving —
   * undefined if this computer has never completed host enrollment against
   * any backend. Every successful "Connect this computer" (see
   * backendLink.ts's enroll()) overwrites this to the backend just
   * connected to and stops polling whatever was active before, which is
   * the entire "switching is explicit" behavior: the OLD profile's
   * hostToken stays saved in hostProfiles, untouched, but the agent simply
   * stops using it until that environment is reconnected to again.
   */
  activeHostBackendUrl?: string;
}

/** One backend environment's saved host-loop credential — see AgentConfig.hostProfiles. */
export interface HostProfile {
  hostToken: string;
  hostId: number;
}

function generateToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Consistent key for `hostProfiles` — applied identically whenever a
 * backend origin is stored (enroll()) or looked up (getHostProfileStatus(),
 * resumeIfEnrolled()) so "https://api.merorestroapp.com" and
 * "https://api.merorestroapp.com/" (a stray trailing slash, e.g. from a
 * differently-configured VITE_API_BASE_URL) always resolve to the exact
 * same profile entry instead of silently creating two.
 */
export function normalizeBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function loadOrCreateConfig(): AgentConfig {
  const file = configFilePath();

  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (raw && typeof raw.port === "number" && typeof raw.pairingToken === "string") {
        return migrateHostProfiles(raw as AgentConfig);
      }
    } catch (err) {
      logger.warn(`Could not parse existing config.json, regenerating: ${(err as Error).message}`);
    }
  }

  const fresh: AgentConfig = { port: CANDIDATE_PORTS[0], pairingToken: generateToken() };
  saveConfig(fresh);
  return fresh;
}

/**
 * One-time, idempotent migration from the original flat
 * hostToken/hostId/backendUrl fields (every 1.2.0 install prior to the
 * multi-environment redesign) into `hostProfiles`/`activeHostBackendUrl`.
 * Existing pairings are never lost: the new structure is written to disk
 * FIRST, and the old flat fields are only cleared in a second write after
 * that succeeds — if anything throws in between (disk full, permissions),
 * this logs a warning and hands back the ORIGINAL, untouched config so the
 * computer keeps working exactly as it did before this build, and migration
 * is simply retried on the next restart.
 */
function migrateHostProfiles(config: AgentConfig): AgentConfig {
  const hasLegacyFlatHost = typeof config.hostToken === "string" && typeof config.hostId === "number" && typeof config.backendUrl === "string";
  if (!hasLegacyFlatHost) {
    return config;
  }

  const key = normalizeBackendUrl(config.backendUrl as string);
  const alreadyMigrated = config.hostProfiles?.[key]?.hostToken === config.hostToken && config.hostProfiles?.[key]?.hostId === config.hostId;

  try {
    const withProfile: AgentConfig = alreadyMigrated
      ? config
      : {
          ...config,
          hostProfiles: { ...(config.hostProfiles ?? {}), [key]: { hostToken: config.hostToken as string, hostId: config.hostId as number } },
          activeHostBackendUrl: config.activeHostBackendUrl ?? key,
        };
    if (!alreadyMigrated) {
      saveConfig(withProfile); // new structure persisted first
    }

    const cleaned: AgentConfig = { ...withProfile };
    delete cleaned.hostToken;
    delete cleaned.hostId;
    saveConfig(cleaned); // old flat fields removed only now that the above succeeded

    if (!alreadyMigrated) {
      logger.info(`Migrated this computer's existing host enrollment (${key}) into the new multi-environment profile structure — no reconfiguration needed.`);
    }
    return cleaned;
  } catch (err) {
    logger.warn(`Could not migrate host enrollment to the new profile structure (will retry next start): ${(err as Error).message}`);
    return config;
  }
}

export function saveConfig(config: AgentConfig): void {
  fs.writeFileSync(configFilePath(), JSON.stringify(config, null, 2), "utf-8");
}

/** Persists the outcome of a successful legacy (single-station) enrollment — see backendLink.ts. Untouched by the multi-environment redesign; a legacy station was always single-backend by design. */
export function setStationCredentials(config: AgentConfig, stationToken: string, backendUrl: string): AgentConfig {
  const next: AgentConfig = { ...config, stationToken, backendUrl };
  saveConfig(next);
  return next;
}

/**
 * Persists the outcome of a successful "Connect this computer" host
 * enrollment for ONE specific backend environment — merges into
 * `hostProfiles` (every other environment's saved profile, if any, is left
 * completely untouched) and marks this one as the active/polling profile.
 * This is the fix for the original bug: enrolling against a second backend
 * used to silently overwrite the only saved hostToken/hostId/backendUrl
 * slot, so a computer could hold credentials for exactly one environment at
 * a time and had no way to tell which one without cross-checking
 * `backendUrl` by eye.
 */
export function setHostCredentials(config: AgentConfig, backendUrl: string, hostToken: string, hostId: number): AgentConfig {
  const key = normalizeBackendUrl(backendUrl);
  const next: AgentConfig = {
    ...config,
    hostProfiles: { ...(config.hostProfiles ?? {}), [key]: { hostToken, hostId } },
    activeHostBackendUrl: key,
  };
  saveConfig(next);
  return next;
}

/** Checks a single port is actually free right now (not just "was free last run"). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

/** Picks the previously-used port if it's still free, otherwise the first free candidate. */
export async function selectPort(preferred: number): Promise<number> {
  const ordered = [preferred, ...CANDIDATE_PORTS.filter((p) => p !== preferred)];

  for (const port of ordered) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) {
      return port;
    }
  }

  throw new Error(
    `All candidate ports (${CANDIDATE_PORTS.join(", ")}) are in use. Close whatever else is using them, or edit ${configFilePath()} to pick a different port.`,
  );
}
