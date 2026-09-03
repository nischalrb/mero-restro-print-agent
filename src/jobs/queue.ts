import { v4 as uuidv4 } from "uuid";
import { PrintJob, PrintRequestBody } from "../types";
import { buildReceipt } from "../escpos/receiptBuilder";
import { buildKitchenTicket } from "../escpos/kitchenTicketBuilder";
import { buildTestPrint } from "../escpos/testPrintBuilder";
import { sendRaw, RawPrintTarget } from "../printers/rawPrint";
import { logger } from "../logger";

/**
 * A deliberately simple in-process queue — this agent only ever serves one
 * restaurant's one computer, so there's no need for persistence across
 * restarts or a real message broker. What it DOES need, per the spec:
 *
 *  - A job record with id/printer/type/status/error the frontend can poll
 *    or just read from the initial response (jobs finish in well under a
 *    second for a single receipt, so callers don't strictly need to poll,
 *    but the shape is here for when/if that changes).
 *  - Idempotency: if the POS calls /print twice with the same
 *    idempotencyKey (e.g. a double-click, or a retry after a slow
 *    response that actually succeeded), the second call returns the FIRST
 *    call's job instead of printing again. Keys are remembered for 2
 *    minutes — long enough to catch a real accidental double-submit,
 *    short enough that a deliberate legitimate reprint minutes later
 *    isn't blocked.
 */
const jobs = new Map<string, PrintJob>();
const idempotencyIndex = new Map<string, { jobId: string; expiresAt: number }>();

const IDEMPOTENCY_WINDOW_MS = 2 * 60 * 1000;

function pruneExpiredIdempotencyKeys(): void {
  const now = Date.now();
  for (const [key, entry] of idempotencyIndex) {
    if (entry.expiresAt < now) idempotencyIndex.delete(key);
  }
}

export function getJob(id: string): PrintJob | undefined {
  return jobs.get(id);
}

export async function submitPrintJob(body: PrintRequestBody, jobType: "receipt" | "kitchen" | "test"): Promise<PrintJob> {
  pruneExpiredIdempotencyKeys();

  if (body.idempotencyKey) {
    const existing = idempotencyIndex.get(body.idempotencyKey);
    if (existing) {
      const existingJob = jobs.get(existing.jobId);
      if (existingJob) {
        logger.info(`Duplicate print request suppressed (idempotencyKey=${body.idempotencyKey}) — returning existing job ${existingJob.id}.`);
        return existingJob;
      }
    }
  }

  const job: PrintJob = {
    id: uuidv4(),
    printer: body.printerTarget,
    jobType,
    createdAt: new Date().toISOString(),
    status: "queued",
    error: null,
  };
  jobs.set(job.id, job);

  if (body.idempotencyKey) {
    idempotencyIndex.set(body.idempotencyKey, { jobId: job.id, expiresAt: Date.now() + IDEMPOTENCY_WINDOW_MS });
  }

  // Diagnostic logging (see rawPrint.ts's matching log for the transmission
  // side) — confirms the DATA the agent received from the frontend was
  // already complete/incomplete BEFORE any ESC/POS building or CUPS
  // transmission happens, so a truncation can be localized to "the RMS
  // never sent it", "the agent built it wrong", or "CUPS/USB dropped it"
  // rather than guessed at.
  const itemCount = "items" in body.payload && Array.isArray(body.payload.items) ? body.payload.items.length : 0;
  logger.info(
    `Job ${job.id} (${jobType}) received: printer="${body.printerTarget}" items=${itemCount} payloadBytes=${JSON.stringify(body.payload).length} idempotencyKey=${body.idempotencyKey ?? "none"}`,
  );

  // Fire-and-await here rather than a background worker — a single
  // receipt/ticket prints in well under a second, and the caller (POS
  // checkout) wants to know success/failure right away to show "Receipt
  // printed" or "Retry print" without an extra polling round-trip.
  //
  // Building the buffer is passed in as a function rather than built here
  // and handed to runJob — that puts the build step INSIDE runJob's
  // try/catch alongside the actual send. Previously buildReceipt() ran out
  // here, unprotected: any bad field in the order data (e.g. a
  // non-numeric custom charge amount) threw, which aborted this whole
  // async function with no job ever reaching "failed" and no bytes ever
  // sent — from the frontend's perspective the request just hung until it
  // timed out, and the printer produced nothing. Now every failure mode
  // (bad data OR a real printer/OS failure) ends the same way: job.status
  // = "failed", job.error = the real message, surfaced to the caller.
  await runJob(
    job,
    () => (body.payload.type === "receipt" ? buildReceipt(body.payload, body.paperWidth) : buildKitchenTicket(body.payload, body.paperWidth)),
    { connectionType: body.connectionType, target: body.printerTarget, copies: body.copies ?? 1 },
  );

  return job;
}

export interface TestPrintRequest {
  idempotencyKey?: string;
  printerTarget: string;
  connectionType: "usb" | "network";
  paperWidth: "80mm" | "58mm";
  copies?: number;
  /** Station name + role from Settings > Printers — see buildTestPrint()'s docblock. */
  label?: string;
}

export async function submitTestPrintJob(req: TestPrintRequest): Promise<PrintJob> {
  const job: PrintJob = {
    id: uuidv4(),
    printer: req.printerTarget,
    jobType: "test",
    createdAt: new Date().toISOString(),
    status: "queued",
    error: null,
  };
  jobs.set(job.id, job);

  await runJob(job, () => buildTestPrint(req.paperWidth, req.label), { connectionType: req.connectionType, target: req.printerTarget, copies: req.copies ?? 1 });

  return job;
}

/**
 * Used by backendLink.ts's poll loop — a station-delivered job's payload
 * carries its own `type` discriminant (same PrintPayload union /print
 * already accepts), so unlike submitPrintJob() this doesn't need a
 * separate jobType argument. The backend, not this agent, tracks
 * status/attempts/error via /print-jobs/{id}/report, so there's no local
 * PrintJob record to create here — just build and print using the EXACT
 * same builders/sendRaw as the direct-from-browser path above; only the
 * bookkeeping differs, never the print pipeline itself.
 */
export async function printRemoteJobPayload(
  payload: PrintRequestBody["payload"],
  paperWidth: "80mm" | "58mm",
  target: RawPrintTarget,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const buffer = payload.type === "receipt" ? buildReceipt(payload, paperWidth) : buildKitchenTicket(payload, paperWidth);
    await sendRaw(buffer, target);
    logger.info(`Station job (${payload.type}) printed to "${target.target}" (${buffer.length} bytes).`);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`Station job (${payload.type}) failed on "${target.target}": ${message}`);
    return { ok: false, error: message };
  }
}

async function runJob(job: PrintJob, buildBuffer: () => Buffer, target: RawPrintTarget): Promise<void> {
  job.status = "printing";

  try {
    const buffer = buildBuffer();
    await sendRaw(buffer, target);
    job.status = "printed";
    // Byte length logged on purpose — a real receipt is always several
    // hundred bytes at minimum; a suspiciously small number here (a few
    // dozen bytes) is a strong sign the payload was near-empty even though
    // the job "succeeded" (bytes reached the printer fine, there just
    // wasn't much in them), which otherwise looks identical to a genuine
    // success in this log.
    logger.info(`Job ${job.id} (${job.jobType}) printed to "${job.printer}" (${buffer.length} bytes).`);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    logger.error(`Job ${job.id} (${job.jobType}) failed on "${job.printer}": ${job.error}`);
  }
}
