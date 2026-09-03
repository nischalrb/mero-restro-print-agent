import { EscPosBuilder } from "./commands";
import { widthFor } from "./columns";

/**
 * A self-contained test slip the agent builds itself (never trusts the
 * caller to supply "test" content) — exercises every ESC/POS primitive
 * this agent uses in real receipts (bold, sizing, alignment, dividers,
 * cut) so a successful test print genuinely proves the whole pipeline
 * works, not just that bytes reached the printer.
 *
 * `label` — e.g. "Front Counter — Kitchen printer" — is the station's own
 * name + role from Settings > Printers, sent by the caller. This exists
 * specifically for the case of one physical printer configured under two
 * different station rows (e.g. testing with a single printer serving both
 * the receipt and kitchen roles before a second unit arrives): printing
 * the station's name and role in large, bold text is the only way to tell,
 * from the paper alone, WHICH station configuration actually fired —
 * without it, every test slip looks identical regardless of which "Test
 * print" button was clicked.
 */
export function buildTestPrint(paperWidth: "80mm" | "58mm", label?: string): Buffer {
  const w = widthFor(paperWidth);
  const now = new Date().toLocaleString();

  const b = new EscPosBuilder()
    .init()
    .align("center")
    .bold(true)
    .size(true, true)
    .line("Mero Restro")
    .size(false, false)
    .line("Print Agent Test")
    .bold(false)
    .divider(w, "=");

  if (label) {
    b.align("center").bold(true).size(false, true).line("Testing station:").line(label).size(false, false).bold(false).divider(w, "=");
  }

  return b
    .align("left")
    .line(`Paper width: ${paperWidth}`)
    .line(`Columns: ${w}`)
    .line(`Printed: ${now}`)
    .divider(w)
    .bold(true)
    .line("Bold text OK")
    .bold(false)
    .underline(true)
    .line("Underline OK")
    .underline(false)
    .align("center")
    .line("Centered text OK")
    .align("right")
    .line("Right-aligned OK")
    .align("left")
    .divider(w, "=")
    .align("center")
    .line("If you can read this clearly,")
    .line("ESC/POS printing is working.")
    .cut()
    .build();
}
