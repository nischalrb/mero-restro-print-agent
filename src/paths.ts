import os from "os";
import path from "path";
import fs from "fs";

/**
 * Where this agent keeps its own local state — config.json (chosen port +
 * pairing token) and agent.log (print errors, for a restaurant's IT support
 * to inspect without needing developer tools). Cross-platform convention:
 * %APPDATA%\MeroRestroPrintAgent on Windows, ~/Library/Application
 * Support/MeroRestroPrintAgent on macOS, ~/.mero-restro-print-agent
 * elsewhere (Linux).
 */
export function dataDir(): string {
  const platform = process.platform;
  let base: string;

  if (platform === "win32") {
    base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    base = path.join(base, "MeroRestroPrintAgent");
  } else if (platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "MeroRestroPrintAgent");
  } else {
    base = path.join(os.homedir(), ".mero-restro-print-agent");
  }

  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }

  return base;
}

export function configFilePath(): string {
  return path.join(dataDir(), "config.json");
}

export function logFilePath(): string {
  return path.join(dataDir(), "agent.log");
}
