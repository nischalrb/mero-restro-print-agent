/**
 * Minimal ESC/POS byte-sequence builder — deliberately not a full external
 * library dependency. A thermal receipt only needs a handful of commands
 * (init, bold, align, size, cut, feed, plain text), and hand-rolling them
 * keeps this file auditable and dependency-free for `pkg` packaging. Byte
 * values are per Epson's ESC/POS reference, which ZKTeco's ZKP8018 (like
 * virtually every 80mm thermal POS printer) implements compatibly.
 */
export class EscPosBuilder {
  private chunks: Buffer[] = [];

  private push(bytes: number[]): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  /**
   * ESC @ — resets the printer to its power-on defaults; always the first
   * thing sent. Sent 16 times in a row (32 throwaway bytes) rather than
   * once, as a deliberate leading "wake-up" preamble.
   *
   * Field-confirmed bug this works around: on a cold/idle USB connection,
   * the printer/CUPS/USB path can silently drop a handful of bytes from
   * the very START of a raw job — not truncate the end, DROP THE START.
   * This was confirmed exactly once by a real symptom report: a receipt's
   * organization name and address printed as blank paper, and the next
   * line — meant to read "VAT/PAN: ..." — printed as "EVAT/PAN: ...".
   * That's not a random glitch: bold(false) sends ESC E 0x00 (bytes
   * 0x1b 0x45 0x00) immediately before the VAT/PAN line; if only the
   * leading ESC (0x1b) byte of that one command is lost, the remaining
   * bytes are 0x45 (the literal printable character 'E') and 0x00 (a
   * no-op NUL), which is exactly "E" printed right before "VAT/PAN" —
   * with everything before it (org name, address, phone) also gone
   * because it came even earlier in the same dropped window.
   *
   * ESC @ has no visible output and is fully idempotent (each repetition
   * just re-applies "reset to defaults"), so repeating it costs nothing
   * if every byte arrives intact, and guarantees that ONLY throwaway
   * reset bytes — never real header text — are at risk if the front of
   * the transmission gets eaten again.
   *
   * Second layer, added after a follow-up report: even with the above
   * preamble and rawPrint.ts's unconditional pre-send delay, a checkout
   * receipt's organization name could still go missing on a cold print
   * while the exact same data reprinted fine from Billing History. The
   * difference traced back to Billing History's reprint payload always
   * carrying `isDuplicate: true`, which makes receiptBuilder.ts print a
   * "*** DUPLICATE COPY ***" line BEFORE the organization name — that
   * line was accidentally absorbing whatever residual leading-byte loss
   * the preamble above didn't fully cover, leaving the org name (the
   * true first line on a fresh checkout receipt) exposed. Rather than
   * rely on that side effect of an unrelated flag, a few blank lines are
   * added here — after the reset bytes, before ANY real content — on
   * every single ticket (receipt or kitchen), duplicate or not. A lost
   * newline byte (0x0a) is invisible on paper (very slightly shorter top
   * margin), so this is a strictly safe thing to put at risk in place of
   * an organization name or a KOT title.
   */
  init(): this {
    for (let i = 0; i < 16; i += 1) this.push([0x1b, 0x40]);
    for (let i = 0; i < 4; i += 1) this.push([0x0a]);
    return this;
  }

  bold(on: boolean): this {
    return this.push([0x1b, 0x45, on ? 1 : 0]);
  }

  underline(on: boolean): this {
    return this.push([0x1b, 0x2d, on ? 1 : 0]);
  }

  align(mode: "left" | "center" | "right"): this {
    const n = mode === "center" ? 1 : mode === "right" ? 2 : 0;
    return this.push([0x1b, 0x61, n]);
  }

  /** Double-height/width text — used for the total line and headline emphasis. */
  size(doubleHeight: boolean, doubleWidth: boolean): this {
    const n = (doubleHeight ? 0x01 : 0) | (doubleWidth ? 0x10 : 0);
    return this.push([0x1d, 0x21, n]);
  }

  /**
   * Text is encoded latin1 (single-byte) rather than UTF-8 — ESC/POS
   * thermal printers default to a single-byte codepage (CP437/CP1252-ish),
   * not UTF-8, so multi-byte characters would print as garbage. Anything
   * outside the printable latin1 range is swapped for "?" so the print job
   * never sends bytes the printer's codepage can't represent. Currency
   * labels should be passed as ASCII (e.g. "Rs." not "₨") for the same
   * reason — see ReceiptPrintPayload's currencySymbol docs.
   */
  text(value: string): this {
    // Defensive against undefined/null/non-string reaching here — a receipt
    // is built from real order data with plenty of optional fields, and a
    // single bad value throwing mid-build (Array.from(undefined) throws)
    // used to abort the ENTIRE print job with no bytes ever sent and no
    // error surfaced to the caller. Coercing to "" instead means a missing
    // field just prints as a blank line, never silently kills the whole job.
    const str = value == null ? "" : String(value);
    const safe = Array.from(str)
      .map((ch) => (ch.charCodeAt(0) <= 0xff ? ch : "?"))
      .join("");
    this.chunks.push(Buffer.from(safe, "latin1"));
    return this;
  }

  line(value = ""): this {
    return this.text(value).newline();
  }

  newline(): this {
    return this.push([0x0a]);
  }

  feed(lines: number): this {
    return this.push([0x1b, 0x64, Math.max(0, Math.min(255, lines))]);
  }

  /** A dashed divider spanning the given column width — see columns.ts for width-per-paper-size. */
  divider(width: number, char = "-"): this {
    return this.line(char.repeat(width));
  }

  /** Full cut, after feeding a few blank lines so the cut lands below the last printed line. */
  cut(): this {
    return this.feed(4).push([0x1d, 0x56, 0x00]);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
