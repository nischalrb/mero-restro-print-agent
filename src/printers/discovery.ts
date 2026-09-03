import { execFile } from "child_process";
import { DiscoveredPrinter } from "../types";
import { logger } from "../logger";

/**
 * Lists printers already installed at the OS level (Windows' "Devices and
 * Printers" / macOS's CUPS queues) — this is exactly why the restaurant
 * user doesn't need to type a driver path or IP: whatever they can already
 * print a test page to from their OS printer settings shows up here by
 * its real, already-detected name (see this file's docblock in the spec:
 * "Do not assume the OS printer name will always literally be
 * 'ZKP8018'"). Deliberately implemented via shelling out to OS tools
 * (PowerShell's Get-Printer, macOS's lpstat) rather than a native Node
 * addon — keeps this file dependency-free and trivially packageable with
 * `pkg` for both platforms. Raw byte printing itself (printers/rawPrint.ts)
 * is a separate concern from discovery and does use a native module on
 * Windows, but discovery never needs to.
 */
export async function discoverPrinters(): Promise<DiscoveredPrinter[]> {
  if (process.platform === "win32") {
    return discoverWindows();
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    return discoverCups();
  }

  logger.warn(`Printer discovery not implemented for platform "${process.platform}".`);
  return [];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function discoverWindows(): Promise<DiscoveredPrinter[]> {
  try {
    const stdout = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Printer | Select-Object Name, PrinterStatus | ConvertTo-Json -Compress",
    ]);

    const parsed = JSON.parse(stdout || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];

    return list
      .filter((p) => p && typeof p.Name === "string")
      .map((p) => toDiscoveredPrinter(p.Name, mapWindowsStatus(p.PrinterStatus)));
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`Windows printer discovery (Get-Printer) failed: ${message}`);
    // Re-thrown rather than swallowed to [] — a genuine "PowerShell isn't
    // reachable" / "Get-Printer failed" failure must never look identical
    // to "this computer really has zero printers installed" on the
    // frontend; index.ts's /printers route turns this into a specific
    // error message instead of a silent empty list.
    throw new Error(`Could not list Windows printers (Get-Printer failed): ${message}`);
  }
}

/** PrinterStatus: 0/normal = ready; anything else (paper jam, offline, error, ...) reported as offline rather than guessed at. */
function mapWindowsStatus(status: unknown): DiscoveredPrinter["status"] {
  if (status === 0 || status === "0" || status === "Normal") return "ready";
  if (status === undefined || status === null) return "unknown";
  return "offline";
}

async function discoverCups(): Promise<DiscoveredPrinter[]> {
  try {
    const stdout = await run("lpstat", ["-p"]);
    const printers: DiscoveredPrinter[] = [];

    // Typical lpstat -p line: "printer ZKP8018 is idle.  enabled since ..."
    // or "printer ZKP8018 disabled since ... -\n\treason unknown"
    for (const line of stdout.split("\n")) {
      const match = line.match(/^printer\s+(\S+)\s+is\s+(\w+)/);
      if (!match) continue;

      const [, name, state] = match;
      const status: DiscoveredPrinter["status"] = state === "idle" || state === "printing" ? "ready" : "offline";
      printers.push(toDiscoveredPrinter(name, status));
    }

    return printers;
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`CUPS printer discovery (lpstat -p) failed: ${message}`);
    // See discoverWindows()'s comment — same reasoning: surface the real
    // failure (e.g. "lpstat: command not found", a permissions error, or
    // the CUPS scheduler being unreachable) instead of returning an empty
    // list that's indistinguishable from "genuinely zero printers".
    throw new Error(`Could not list printers (lpstat -p failed): ${message}`);
  }
}

/**
 * Looks up ONE printer by its exact OS name, rather than filtering the full
 * discoverPrinters() list — lets Settings > Printers (or a future
 * "check this printer's status" refresh) confirm a single already-selected
 * printer is still there and ready without re-running discovery on
 * everything. Returns null (not an error) when no printer by that name
 * exists right now — that's a normal, expected outcome (e.g. the printer
 * was unplugged, or the restaurant renamed/removed the CUPS queue), not a
 * failure of the status check itself.
 */
export async function getPrinterStatus(name: string): Promise<DiscoveredPrinter | null> {
  if (process.platform === "win32") {
    return getPrinterStatusWindows(name);
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    return getPrinterStatusCups(name);
  }

  logger.warn(`Printer status check not implemented for platform "${process.platform}".`);
  return null;
}

async function getPrinterStatusCups(name: string): Promise<DiscoveredPrinter | null> {
  try {
    const stdout = await run("lpstat", ["-p", name]);
    for (const line of stdout.split("\n")) {
      const match = line.match(/^printer\s+(\S+)\s+is\s+(\w+)/);
      if (match && match[1] === name) {
        const status: DiscoveredPrinter["status"] = match[2] === "idle" || match[2] === "printing" ? "ready" : "offline";
        return toDiscoveredPrinter(match[1], status);
      }
    }
    return null;
  } catch (err) {
    const message = (err as Error).message;
    if (/unknown (destination|printer)/i.test(message)) {
      // Not a real failure — lpstat -p <name> exits non-zero specifically
      // because no such queue exists, which is exactly what "printer not
      // found" means here.
      return null;
    }
    logger.error(`CUPS single-printer status check ("${name}") failed: ${message}`);
    throw new Error(`Could not check status of printer "${name}" (lpstat -p failed): ${message}`);
  }
}

async function getPrinterStatusWindows(name: string): Promise<DiscoveredPrinter | null> {
  try {
    const escaped = name.replace(/'/g, "''");
    const stdout = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-Printer -Name '${escaped}' | Select-Object Name, PrinterStatus | ConvertTo-Json -Compress`,
    ]);

    const parsed = JSON.parse(stdout || "null");
    if (!parsed || typeof parsed.Name !== "string") return null;
    return toDiscoveredPrinter(parsed.Name, mapWindowsStatus(parsed.PrinterStatus));
  } catch (err) {
    const message = (err as Error).message;
    if (/cannot find any printer/i.test(message)) {
      return null;
    }
    logger.error(`Windows single-printer status check ("${name}") failed: ${message}`);
    throw new Error(`Could not check status of printer "${name}" (Get-Printer failed): ${message}`);
  }
}

function toDiscoveredPrinter(name: string, status: DiscoveredPrinter["status"]): DiscoveredPrinter {
  // Heuristic only, for display — the restaurant still explicitly picks
  // their printer by its real detected name in Settings > Printers, this
  // never silently guesses which one to actually use.
  const looksThermal = /(zkp|zk|thermal|pos|receipt|epson tm|star tsp)/i.test(name);

  return {
    name,
    type: looksThermal ? "thermal" : "unknown",
    paperWidth: looksThermal ? "80mm" : "unknown",
    status,
  };
}
