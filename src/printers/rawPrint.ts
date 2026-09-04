import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import { execFile } from "child_process";
import { logger } from "../logger";

export interface RawPrintTarget {
  connectionType: "usb" | "network";
  /** USB: the exact OS printer name from discovery. Network: "host:port". */
  target: string;
  copies: number;
}

/**
 * Sends already-built ESC/POS bytes straight to the printer, bypassing any
 * OS print-processing that would otherwise try to interpret them as a
 * document (which mangles raw control codes). Three paths, chosen by
 * connectionType + platform:
 *
 *  - network: a raw TCP socket to host:port (almost always :9100 —
 *    "JetDirect"/RAW printing, the de facto standard nearly every
 *    network/LAN thermal printer and USB-to-Ethernet print server
 *    supports). No OS involvement at all, works identically on every
 *    platform.
 *  - usb + macOS/Linux: CUPS's own raw passthrough (`lp -o raw`) — every
 *    printer visible to discovery.ts on these platforms is already a CUPS
 *    queue, and `-o raw` tells CUPS to hand the bytes through untouched
 *    instead of running them through a filter/driver.
 *  - usb + Windows: Windows has no CUPS equivalent reachable from the
 *    shell, so this goes through the `printer` npm package (a thin,
 *    widely-used wrapper around the Win32 spooler's raw `WritePrinter`
 *    call). Loaded lazily and guarded — see the comment below — so a
 *    machine where this optional native module didn't install still runs
 *    the agent fine for network printing and discovery; only raw USB
 *    printing on Windows needs it.
 */
export async function sendRaw(buffer: Buffer, opts: RawPrintTarget): Promise<void> {
  for (let i = 0; i < Math.max(1, opts.copies); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sendOnce(buffer, opts);
  }
}

async function sendOnce(buffer: Buffer, opts: RawPrintTarget): Promise<void> {
  if (opts.connectionType === "network") {
    return sendOverTcp(buffer, opts.target);
  }

  if (process.platform === "win32") {
    return sendViaWindowsSpooler(buffer, opts.target);
  }

  return sendViaCupsRaw(buffer, opts.target);
}

function sendOverTcp(buffer: Buffer, hostPort: string): Promise<void> {
  const [host, portStr] = hostPort.split(":");
  const port = Number(portStr) || 9100;

  if (!host) {
    return Promise.reject(new Error(`Invalid network printer target "${hostPort}" — expected "host:port", e.g. "192.168.1.50:9100".`));
  }

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port} — check the printer is on and reachable on the network.`));
    }, 5000);

    socket.connect(port, host, () => {
      socket.write(buffer, (err) => {
        clearTimeout(timeout);
        if (err) {
          socket.destroy();
          reject(err);
          return;
        }
        socket.end();
      });
    });

    socket.on("close", () => resolve());
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Timestamp of the last time a CUPS raw job was confirmed complete, per
 * printer — used only for the cold-start warm-up heuristic below. Module
 * scope is fine (one agent process, one small number of configured
 * printers); doesn't need to survive a restart.
 */
const lastCupsJobFinishedAt = new Map<string, number>();

/**
 * `lp -d printer -o raw file`'s callback firing only means CUPS' scheduler
 * ACCEPTED the job into its queue — it does NOT mean the printer has
 * actually finished (or even started) physically printing it. The real
 * transmission to the USB device happens afterward, asynchronously, inside
 * CUPS' own `usb` backend process, which this code previously had zero
 * visibility into. That gap explains two real symptoms reported in the
 * field:
 *
 *  - Large receipts sometimes stopping partway through (often right around
 *    a long unbroken "====" divider line) — a cheap thermal print head
 *    drawing a full-width dark line draws more current and can introduce a
 *    brief mechanical/thermal stall; if something on the CUPS/USB side
 *    doesn't wait through that stall properly, remaining bytes can be lost
 *    even though `lp` already reported success.
 *  - The very first lines (organization name) sometimes missing on a job
 *    right after the printer has been idle — cheap ESC/POS printers can
 *    take a brief moment to "wake up" fully after idling, and the very
 *    first burst of a new job can arrive before it's ready to buffer it.
 *
 * Two concrete mitigations, both cheap and safe regardless of whether they
 * turn out to be THE cause for a given printer:
 *
 *  1. If this printer hasn't printed anything in a while (idle → likely
 *     "asleep"), wait briefly before sending, giving it a moment to be
 *     fully ready for the very first bytes.
 *  2. Actually poll CUPS' own job-status until this specific job leaves
 *     the "not completed" list, instead of trusting `lp`'s immediate
 *     return — this is what lets the temp file cleanup and the NEXT job
 *     (e.g. a receipt right after a kitchen ticket, or multiple `copies`)
 *     wait for the printer to genuinely finish, rather than potentially
 *     overlapping two jobs on a printer whose firmware doesn't queue them
 *     cleanly back-to-back.
 */
/**
 * Renders a buffer slice as space-separated hex bytes, e.g. "1b 40 1b 61
 * 01" — used only for diagnostic logging below, never for anything
 * functional. Deliberately short (a few dozen bytes) since this goes into
 * a plain-text log file a restaurant might paste into a support ticket.
 */
function hexPreview(buffer: Buffer, start: number, end: number): string {
  return Array.from(buffer.subarray(Math.max(0, start), Math.min(buffer.length, end)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

async function sendViaCupsRaw(buffer: Buffer, printerName: string): Promise<void> {
  const idleMs = Date.now() - (lastCupsJobFinishedAt.get(printerName) ?? 0);

  // Diagnostic logging (per the "sometimes full, sometimes not / long
  // receipts cut off" investigation) — cheap, always-on, and specifically
  // meant to answer "did the COMPLETE buffer reach this point, and did the
  // complete buffer reach the temp file" independent of whether CUPS/USB
  // later manages to transmit all of it. First/last-16-bytes previews let
  // you visually confirm the job starts with ESC @ (1b 40, the init
  // command) and ends with the cut sequence (1d 56 00) rather than being
  // truncated at either end.
  logger.info(
    `CUPS raw print starting: printer="${printerName}" bufferBytes=${buffer.length} idleMs=${idleMs} ` +
      `firstBytes=[${hexPreview(buffer, 0, 16)}] lastBytes=[${hexPreview(buffer, buffer.length - 16, buffer.length)}]`,
  );

  // Unconditional warm-up delay — a field report confirmed real leading
  // bytes get dropped (see EscPosBuilder.init()'s docblock for the exact
  // "EVAT/PAN" mechanism), and it was NOT confirmed to only happen after a
  // long idle gap, so this no longer gates on idleMs the way an earlier
  // version did. A fixed 250ms on every job is a small, acceptable cost
  // for a receipt printer given the alternative is losing the receipt
  // header. idleMs is still logged above since it remains useful context
  // for correlating failures.
  await sleep(250);

  const tmpFile = path.join(os.tmpdir(), `mero-restro-print-${Date.now()}.bin`);
  fs.writeFileSync(tmpFile, buffer);

  // Paranoia check: re-stat the file we just wrote and confirm its size on
  // disk actually matches the buffer we intended to write. A mismatch here
  // would mean the truncation happened before `lp` was ever invoked (e.g.
  // a full /tmp disk) — logged as an ERROR because it's a strong, distinct
  // signal from a CUPS/USB transmission problem.
  const writtenSize = fs.statSync(tmpFile).size;
  if (writtenSize !== buffer.length) {
    logger.error(`CUPS raw print: temp file size mismatch for "${printerName}" — expected ${buffer.length} bytes, wrote ${writtenSize} bytes (${tmpFile}).`);
  }

  const lpArgs = ["-d", printerName, "-o", "raw", tmpFile];
  logger.info(`CUPS raw print: running lp ${lpArgs.join(" ")} (tempFileBytes=${writtenSize})`);

  let jobId: string | null = null;
  try {
    jobId = await new Promise<string | null>((resolve, reject) => {
      execFile("lp", lpArgs, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`CUPS raw print to "${printerName}" failed: ${stderr || err.message}`));
          return;
        }
        // Typical success output: `request id is PRINTERNAME-123 (1 file(s))`.
        // If this doesn't match for some reason, we still proceed — we
        // just fall back to a fixed settle delay instead of polling a
        // specific job id (see below).
        const match = /request id is (\S+)/.exec(stdout);
        resolve(match ? match[1] : null);
      });
    });

    if (jobId) {
      logger.info(`CUPS raw print: job "${jobId}" accepted by scheduler for "${printerName}" (${buffer.length} bytes) — polling for real completion.`);
      await waitForCupsJobToFinish(jobId, printerName);
    } else {
      logger.warn(`CUPS raw print to "${printerName}": couldn't parse a job id from lp's output — falling back to a fixed settle delay instead of polling job status.`);
      await sleep(1500);
    }
  } finally {
    fs.unlink(tmpFile, () => undefined);
  }

  lastCupsJobFinishedAt.set(printerName, Date.now());
}

/**
 * Polls `lpstat` until the given job id no longer shows up as
 * pending/processing, i.e. CUPS' own backend has actually finished
 * transmitting it — not just accepted it. Bounded to a few seconds — both
 * so a genuinely stuck job (printer offline mid-print, paper jam, etc.)
 * doesn't hang a print request forever, AND to stay safely under the
 * frontend's own fetch timeout for /print and /test-print (see
 * printer-agent.ts's PRINT_REQUEST_TIMEOUT_MS) so a slow-but-succeeding
 * print never gets reported to the user as failed just because the HTTP
 * round trip took too long. If it times out we just proceed rather than
 * fail the whole job over a status-check limitation, since the bytes
 * likely did reach the printer by then regardless.
 */
async function waitForCupsJobToFinish(jobId: string, printerName: string): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + 6_000;
  let polls = 0;

  while (Date.now() < deadline) {
    polls += 1;
    const stillPending = await new Promise<boolean>((resolve) => {
      execFile("lpstat", ["-W", "not-completed", "-o", jobId], { timeout: 5000 }, (err, stdout) => {
        // A non-zero exit / empty output both mean "not in the pending
        // list anymore" as far as we're concerned here.
        resolve(!err && stdout.trim().length > 0);
      });
    });

    if (!stillPending) {
      logger.info(`CUPS job ${jobId} on "${printerName}" confirmed complete after ${Date.now() - startedAt}ms (${polls} poll${polls === 1 ? "" : "s"}).`);
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }

  logger.warn(`CUPS job ${jobId} on "${printerName}" was still pending after 6s of polling (${polls} polls) — proceeding anyway rather than failing the print request.`);
}

/**
 * Strips absolute Windows filesystem paths (which can embed the Windows
 * username, e.g. C:\\Users\\<name>\\AppData\\...) out of a string before it
 * is allowed anywhere near an HTTP response. The FULL, unredacted detail
 * still goes to the local log file via logDetailedPrinterLoadFailure()
 * below — this redaction only applies to what /print and /test-print may
 * return to the browser.
 */
function redactPathsForHttp(message: string): string {
  return message.replace(/[A-Za-z]:\\[^\s"'()]+/g, "<path>");
}

/**
 * Full, unredacted diagnostic dump for a failed `require("printer")` on
 * Windows — written to the local agent.log ONLY, never returned over
 * HTTP. This exists because until now, the generic user-facing message
 * below ("This installation... is missing its Windows printing
 * component") was the ONLY thing recorded anywhere: the real require()
 * exception (a NODE_MODULE_VERSION mismatch, a missing .node file, "not a
 * valid Win32 application", etc.) was logged as one line (message only)
 * and then discarded — see the comment at this function's call site.
 */
function logDetailedPrinterLoadFailure(err: Error & { code?: string }): void {
  // Only set inside a packaged Electron app (undefined under
  // `npm run dev` / `ts-node-dev`, which don't apply here anyway).
  // `resourcesPath` is an Electron-only addition to `process` that
  // @types/node doesn't declare, hence the cast rather than a direct
  // property access.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  const candidatePaths = resourcesPath
    ? {
        "resources/app.asar": path.join(resourcesPath, "app.asar"),
        "resources/app.asar.unpacked": path.join(resourcesPath, "app.asar.unpacked"),
        "resources/app.asar.unpacked/node_modules/printer": path.join(resourcesPath, "app.asar.unpacked", "node_modules", "printer"),
        "resources/app.asar.unpacked/node_modules/printer/lib/node_printer.node": path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "printer",
          "lib",
          "node_printer.node",
        ),
        "resources/app.asar.unpacked/node_modules/printer/build/Release/node_printer.node": path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "printer",
          "build",
          "Release",
          "node_printer.node",
        ),
      }
    : null;

  const packagedPathReport = candidatePaths
    ? Object.fromEntries(Object.entries(candidatePaths).map(([label, p]) => [label, { path: p, exists: fs.existsSync(p) }]))
    : "process.resourcesPath is undefined -- not running inside a packaged Electron app, so these paths do not apply.";

  logger.error(
    "Windows printer native module failed to load -- full diagnostic dump (local log only, never sent over HTTP):\n" +
      JSON.stringify(
        {
          error: {
            name: err.name,
            message: err.message,
            code: err.code ?? null,
            stack: err.stack,
          },
          runtime: {
            platform: process.platform,
            arch: process.arch,
            electronVersion: process.versions.electron ?? null,
            nodeVersion: process.versions.node,
            modulesVersion: process.versions.modules,
            resourcesPath: resourcesPath ?? null,
            dirname: __dirname,
          },
          expectedPackagedPaths: packagedPathReport,
        },
        null,
        2,
      ),
  );
}

/**
 * Lazily requires the optional `printer` native module only when actually
 * needed (Windows + USB) — this keeps the agent runnable on machines where
 * that module failed to install, for every other feature (discovery,
 * network printing, health, settings sync).
 */
function sendViaWindowsSpooler(buffer: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let printerModule: {
      printDirect: (opts: {
        data: Buffer;
        printer: string;
        type: string;
        success?: () => void;
        error?: (err: Error) => void;
      }) => void;
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      printerModule = require("printer");
    } catch (err) {
      const originalError = err as Error & { code?: string };

      // Full detail (name/message/code/stack/runtime versions/on-disk
      // path existence) — local log file only. This is the fix for "the
      // real error is being swallowed": previously only
      // originalError.message reached the log, and nothing at all
      // reached the HTTP caller beyond the generic sentence below.
      logDetailedPrinterLoadFailure(originalError);

      const safeDetail = redactPathsForHttp(
        `${originalError.name}${originalError.code ? ` (${originalError.code})` : ""}: ${originalError.message}`,
      );

      const publicError = new Error(
        "This installation of the Print Agent is missing its Windows printing component. Reinstall the Print Agent, or use a network (LAN) printer instead of USB.",
      ) as Error & { errorCode?: string; nativePrinterError?: string };
      // A short, redacted classifier + detail string — deliberately NOT
      // the raw stack/paths — carried up through sendRaw() -> runJob()'s
      // catch -> the job record -> the /print and /test-print JSON
      // responses (see index.ts), as small ADDITIVE fields alongside the
      // existing success/message/job contract, not a replacement for it.
      publicError.errorCode = "PRINTER_NATIVE_MODULE_LOAD_FAILED";
      publicError.nativePrinterError = safeDetail;

      reject(publicError);
      return;
    }

    printerModule.printDirect({
      data: buffer,
      printer: printerName,
      type: "RAW",
      success: () => resolve(),
      error: (err) => reject(new Error(`Windows print to "${printerName}" failed: ${err.message}`)),
    });
  });
}
