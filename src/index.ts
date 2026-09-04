import express, { Request, Response } from "express";
import type { Server } from "http";
import { loadOrCreateConfig, saveConfig, selectPort, VERSION } from "./config";
import { originGuard, requireToken } from "./security";
import { discoverPrinters, getPrinterStatus } from "./printers/discovery";
import { submitPrintJob, submitTestPrintJob, getJob } from "./jobs/queue";
import { enroll, resumeIfEnrolled, refreshHostStationsNow, getHostProfileStatus } from "./backendLink";
import { PrintRequestBody } from "./types";
import { logger } from "./logger";
import { logFilePath } from "./paths";

export interface AgentServerHandle {
  port: number;
  /**
   * Handed back so a caller (the Electron tray wrapper's "Copy Pairing
   * Token" menu item, or this file's own headless console.log below) can
   * show it to the user — never written to agent.log, never sent anywhere
   * except in that one console line / this in-memory return value.
   */
  pairingToken: string;
  server: Server;
  /** Closes the HTTP server — used by the tray app's "Restart Agent" action to cleanly stop before starting a fresh one. */
  stop: () => Promise<void>;
}

/**
 * Builds and starts the Express agent. This is the ENTIRE original
 * standalone-process implementation (routes, middleware, job queue,
 * discovery, ESC/POS pipeline) — nothing about how printing works has
 * changed here. What changed is that "start the server" is now a callable,
 * awaitable operation instead of something that only happens as a side
 * effect of running this file directly. That's what lets the Electron tray
 * wrapper (electron/main.js) call this in-process — same Node runtime,
 * same printer/CUPS/child_process code, nothing duplicated or
 * reimplemented for packaging's sake.
 *
 * Headless execution (`node dist/index.js`, `npm run dev`,
 * `npm run print-agent`) still works completely unchanged — see the
 * `require.main === module` block at the bottom of this file, which is the
 * ONLY thing that calls this function when the file is run directly rather
 * than imported.
 */
export async function startAgentServer(): Promise<AgentServerHandle> {
  const config = loadOrCreateConfig();
  const port = await selectPort(config.port);
  if (port !== config.port) {
    saveConfig({ ...config, port });
  }

  // Picks whichever poll loop(s) back up from a previous run's saved
  // enrollment — see backendLink.ts's docblock for why a computer can have
  // both a legacy station enrollment and a host enrollment at once. A
  // no-op for every agent that hasn't been through either setup flow, so
  // this changes nothing for existing installs that haven't paired at all.
  resumeIfEnrolled(config);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(originGuard(config.extraAllowedOrigins ?? []));

  // ── GET /health — no token required so the frontend's discovery probe
  // (trying each candidate port in turn) can tell "agent is here" before
  // it has a pairing token to offer. Reveals nothing sensitive.
  //
  // `pairingToken` IS included, deliberately — the whole point of the
  // automatic-enrollment redesign is that a customer should never have to
  // manually find/copy/paste it. /health is already gated by the exact
  // same origin allowlist (originGuard, applied globally above) that
  // /printers, /print, and /test-print always relied on as their FIRST
  // layer of trust; this doesn't weaken that boundary, it just lets a
  // trusted origin's own JS pick up the token itself the moment it detects
  // this agent, instead of asking a human to type it. See
  // rms-frontend's printer-agent.ts pingHealth() for the other half.
  app.get("/health", (req: Request, res: Response) => {
    // Re-read from disk rather than closing over the startup-time `config`
    // — host profiles are written later, at runtime, by a successful
    // POST /enroll (see backendLink.ts's enroll()), and Settings needs to
    // see that change reflected here immediately, without requiring an
    // agent restart.
    const current = loadOrCreateConfig();

    // ?backendUrl=<origin> lets the caller ask "is enrollment for MY
    // backend active" rather than a single global yes/no — see
    // getHostProfileStatus()'s docblock for the exact cross-environment bug
    // this closes (a computer connected to backend A silently reading as
    // "Connected" from backend B's Settings page too). Omitted entirely
    // falls back to reporting whichever profile is currently active, which
    // is also exactly what an older frontend build (pre multi-environment
    // support) that doesn't send this param yet already expected.
    const queryBackendUrl = typeof req.query.backendUrl === "string" ? req.query.backendUrl : undefined;
    const hostStatus = getHostProfileStatus(current, queryBackendUrl);

    res.json({
      success: true,
      status: "ok",
      version: VERSION,
      port,
      pairingToken: current.pairingToken,
      // Lets Settings > Printers tell "Connect this computer" (not done
      // yet, or done for a DIFFERENT environment) apart from "already
      // connected to ME, show +Add Printer" without a separate backend
      // round trip — see PrintAgentHost's docblock. hostId is the backend's
      // own id for this host, needed so the browser can attach a NEW
      // station to it directly (POST /print-stations with host_id set)
      // without any further pairing.
      hostEnrolled: hostStatus.enrolled,
      hostId: hostStatus.hostId,
      // True only when the queried backend is ALSO the one currently being
      // polled — never secrets (hostToken/stationToken/pairing hashes are
      // never included in this response).
      hostActive: hostStatus.active,
      // The backend the host loop is ACTUALLY polling right now, regardless
      // of what was queried — null if never enrolled against anything.
      backendUrl: hostStatus.activeBackendUrl,
      profile: hostStatus.activeBackendUrl,
    });
  });

  // ── GET /printers — read-only, no physical action, so also token-free;
  // lets Settings > Printers populate its dropdown as soon as the agent is
  // detected, before the user has pasted in a pairing token yet.
  app.get("/printers", async (_req: Request, res: Response) => {
    try {
      const printers = await discoverPrinters();
      res.json({ success: true, printers });
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`GET /printers failed: ${message}`);
      // The real reason (e.g. "lpstat: command not found") is included
      // here on purpose — without it, this looks identical on the
      // frontend to "the agent works fine, this computer just has zero
      // printers", which is a much harder thing for a restaurant to debug.
      res.status(500).json({ success: false, message: `Could not list printers on this computer: ${message}` });
    }
  });

  // ── GET /printers/:id/status — read-only single-printer check, also
  // token-free for the same reason as /printers. `:id` is the exact OS
  // printer name (URL-encoded by the caller); Express decodes it into
  // req.params.id automatically. 404 (not 500) when no such printer
  // exists right now — that's an expected, common outcome (unplugged,
  // renamed, never installed), not an agent failure.
  app.get("/printers/:id/status", async (req: Request, res: Response) => {
    const name = req.params.id;
    try {
      const printer = await getPrinterStatus(name);
      if (!printer) {
        res.status(404).json({ success: false, message: `No printer named "${name}" was found on this computer.` });
        return;
      }
      res.json({ success: true, printer });
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`GET /printers/${name}/status failed: ${message}`);
      res.status(500).json({ success: false, message: `Could not check status of printer "${name}": ${message}` });
    }
  });

  const tokenGuard = requireToken(config.pairingToken);

  // ── POST /print — the real thing: a receipt or kitchen ticket built
  // from data the POS already has (see printer-agent.ts on the frontend
  // for how BillReceiptData maps into this body).
  app.post("/print", tokenGuard, async (req: Request, res: Response) => {
    const body = req.body as PrintRequestBody;

    if (!body || !body.payload || !body.printerTarget || !body.connectionType || !body.paperWidth) {
      res.status(400).json({ success: false, message: "Missing required print fields (printerTarget, connectionType, paperWidth, payload)." });
      return;
    }

    const jobType = body.payload.type === "kitchen" ? "kitchen" : "receipt";
    const job = await submitPrintJob(body, jobType);

    if (job.status === "printed") {
      res.json({ success: true, message: "Printed.", job });
    } else {
      res.status(502).json({
        success: false,
        message: describePrintFailure(job.error),
        job,
        // Additive-only diagnostic fields for the Windows native-module
        // loading failure (see rawPrint.ts) — omitted entirely (not even
        // as null keys) when absent, so existing consumers that only
        // check success/message/job see no shape change at all.
        ...(job.errorCode ? { errorCode: job.errorCode } : {}),
        ...(job.nativePrinterError ? { nativePrinterError: job.nativePrinterError } : {}),
      });
    }
  });

  // ── POST /test-print — see escpos/testPrintBuilder.ts; the agent builds
  // the content itself, the caller only picks which printer/paper width.
  app.post("/test-print", tokenGuard, async (req: Request, res: Response) => {
    const { printerTarget, connectionType, paperWidth, copies, idempotencyKey, label } = req.body ?? {};

    if (!printerTarget || !connectionType || !paperWidth) {
      res.status(400).json({ success: false, message: "Missing required fields (printerTarget, connectionType, paperWidth)." });
      return;
    }

    const job = await submitTestPrintJob({ printerTarget, connectionType, paperWidth, copies, idempotencyKey, label });

    if (job.status === "printed") {
      res.json({ success: true, message: "Test Print Successful", job });
    } else {
      res.status(502).json({
        success: false,
        message: describePrintFailure(job.error),
        job,
        // Additive-only diagnostic fields for the Windows native-module
        // loading failure (see rawPrint.ts) — omitted entirely (not even
        // as null keys) when absent, so existing consumers that only
        // check success/message/job see no shape change at all.
        ...(job.errorCode ? { errorCode: job.errorCode } : {}),
        ...(job.nativePrinterError ? { nativePrinterError: job.nativePrinterError } : {}),
      });
    }
  });

  // ── POST /enroll — the automatic-enrollment redesign's entire agent-side
  // surface. Called by the Settings > Printers "Set Up Printer" wizard,
  // running on THIS SAME computer, right after it generates a one-time
  // setup code from the backend on the customer's behalf — the customer
  // never sees this request or the code. Token-gated like /print/
  // /test-print (the frontend now gets this token for free from /health
  // above, so this adds no friction) purely as defense-in-depth against a
  // non-browser local process; the code itself is also short-lived and
  // single-use on the backend regardless.
  //
  // What happens here is entirely backendLink.ts's job: exchange the code
  // for a persistent station token directly with Laravel, save it to
  // config.json, and start polling for print jobs. Nothing about the
  // agent's own printing pipeline is touched by any of this.
  app.post("/enroll", tokenGuard, async (req: Request, res: Response) => {
    const { pairingCode, backendUrl } = req.body ?? {};

    if (!pairingCode || !backendUrl) {
      res.status(400).json({ success: false, message: "Missing required fields (pairingCode, backendUrl)." });
      return;
    }

    try {
      const result = await enroll(pairingCode, backendUrl);
      res.json({ success: true, message: "Connected.", host: result });
    } catch (err) {
      res.status(422).json({ success: false, message: (err as Error).message });
    }
  });

  // ── POST /refresh-stations — lets Settings > Printers give the browser
  // instant feedback right after "+Add Printer" creates a new station,
  // instead of waiting for the host loop's normal periodic refresh (see
  // backendLink.ts's HOST_STATIONS_REFRESH_EVERY_N_POLLS). Purely a nudge —
  // a no-op if this computer hasn't completed "Connect this computer" yet,
  // never an error either way, since the new station will be picked up on
  // the next scheduled poll regardless.
  app.post("/refresh-stations", tokenGuard, (_req: Request, res: Response) => {
    refreshHostStationsNow();
    res.json({ success: true, message: "Refreshing." });
  });

  app.get("/jobs/:id", tokenGuard, (req: Request, res: Response) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ success: false, message: "No such print job." });
      return;
    }
    res.json({ success: true, job });
  });

  return new Promise<AgentServerHandle>((resolve, reject) => {
    const server = app
      .listen(port, "127.0.0.1", () => {
        logger.info(`Mero Restro Print Agent v${VERSION} listening on http://127.0.0.1:${port}`);
        logger.info(`Log file: ${logFilePath()}`);
        resolve({
          port,
          pairingToken: config.pairingToken,
          server,
          stop: () => new Promise<void>((res) => server.close(() => res())),
        });
      })
      .on("error", reject);
  });
}

/** Turns a raw error string into one of the spec's specific, actionable messages rather than a generic failure. */
function describePrintFailure(error?: string | null): string {
  if (!error) return "Print Failed";
  if (/ENOENT|not found|no such printer/i.test(error)) return "Printer Not Found";
  if (/offline|not reachable|ECONNREFUSED|timed out/i.test(error)) return "Printer Offline";
  return `Print Failed: ${error}`;
}

// ── Headless entrypoint ──────────────────────────────────────────────
// `require.main === module` is true ONLY when this file is executed
// directly (`node dist/index.js`, `ts-node-dev src/index.ts`, and
// therefore `npm run dev` / `npm run print-agent` / `npm start`) — it's
// false when another module (e.g. electron/main.js, or a future test
// file) does `require("./dist/index.js")` to get at startAgentServer()
// without also wanting this console-logging/process-exit-on-failure
// behavior. This is what keeps the plain "run it from a terminal, no
// Electron involved" developer workflow working exactly as before.
if (require.main === module) {
  startAgentServer()
    .then(({ pairingToken }) => {
      // eslint-disable-next-line no-console
      console.log(`\nPairing token (paste into Settings > Printers if asked): ${pairingToken}\n`);
    })
    .catch((err) => {
      logger.error(`Fatal startup error: ${(err as Error).message}`);
      // eslint-disable-next-line no-console
      console.error(err);
      process.exitCode = 1;
    });
}
