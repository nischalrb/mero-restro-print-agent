import fs from "fs";
import { logFilePath } from "./paths";

/**
 * Deliberately not a logging framework — a restaurant's own IT support (or
 * the owner themselves) needs to be able to open agent.log in Notepad/
 * TextEdit and read it, not parse structured JSON. Every print failure is
 * logged here even though the HTTP response also carries the error, so a
 * failure is still diagnosable after the fact (e.g. "why did nothing print
 * at 8:15pm last night") without the browser console.
 */
function write(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
  // eslint-disable-next-line no-console
  console.log(line.trim());
  try {
    fs.appendFileSync(logFilePath(), line);
  } catch {
    // If we can't write the log file, there's nowhere useful to report
    // that failure to — swallow rather than crash the agent over logging.
  }
}

export const logger = {
  info: (message: string) => write("INFO", message),
  warn: (message: string) => write("WARN", message),
  error: (message: string) => write("ERROR", message),
};
