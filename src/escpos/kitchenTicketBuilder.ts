import { EscPosBuilder } from "./commands";
import { widthFor, wrapText } from "./columns";
import { KitchenTicketPrintPayload } from "../types";

/**
 * The kitchen/bar ticket — deliberately carries NO price, tax, discount, or
 * payment information (per spec: "Do not print unnecessary payment
 * information on kitchen tickets"). Only what a line cook or bartender
 * actually needs: what to make, how many, any modifiers/special
 * instructions, and which table/order it's for.
 *
 * Format, top to bottom:
 *          KOT                 (Kitchen Order Ticket — the standard title
 *                                a line cook expects on this slip, distinct
 *                                from a customer-facing "Receipt"/"Invoice")
 *   *** NEW ORDER ***          (or *** ORDER UPDATED *** on a reprint)
 *          #1042               (large, bold, at-a-glance order number)
 *   ================================
 *   TABLE: Table 4
 *   WAITER: Ram Bahadur        (omitted for a guest QR order — see below)
 *   SOURCE: WAITER              (WAITER or QR ORDER)
 *   TIME: 27 Aug 2026, 7:42 PM
 *   ================================
 *   2 x Chicken Momo
 *      Spicy, Extra chutney
 *      >> No onion
 *   --------------------------------
 *   ... (one block per item, divider between)
 *   ================================
 *   Order note: ...             (only if present)
 *          END OF ORDER
 *
 * No page-height concept anywhere in this file or the CUPS raw pipeline it
 * feeds — this is just however many newline-terminated lines get appended
 * to a Buffer, so a 100+ line order prints in full with no truncation risk
 * (same guarantee the customer receipt already has — see rawPrint.ts).
 */
export function buildKitchenTicket(data: KitchenTicketPrintPayload, paperWidth: "80mm" | "58mm"): Buffer {
  const w = widthFor(paperWidth);
  const b = new EscPosBuilder().init();

  const banner = data.ticketType === "update" ? "*** ORDER UPDATED ***" : "*** NEW ORDER ***";
  b.align("center").bold(true).size(true, true).line("KOT").size(false, true).line(banner).size(false, false);
  b.size(true, true).line(`#${data.orderNumber}`).size(false, false).bold(false);

  b.align("left").divider(w, "=");
  b.line(`TABLE: ${data.tableLabel}`);
  if (data.waiterName) b.line(`WAITER: ${data.waiterName}`);
  b.line(`SOURCE: ${data.source === "qr" ? "QR ORDER" : "WAITER"}`);
  b.line(`TIME: ${data.placedAt}`);
  b.divider(w, "=");

  for (const item of data.items) {
    const qty = `${item.quantity}${item.unit ? item.unit : ""}`;
    b.bold(true).size(true, false);
    wrapText(`${qty} x ${item.name}`, Math.max(1, Math.floor(w / 2))).forEach((l) => b.line(l));
    b.size(false, false).bold(false);

    if (item.options && item.options.length > 0) {
      wrapText(`  ${item.options.join(", ")}`, w).forEach((l) => b.line(l));
    }
    if (item.fulfillmentLabel) b.line(`  (${item.fulfillmentLabel})`);
    if (item.notes) {
      b.bold(true);
      wrapText(`  >> ${item.notes}`, w).forEach((l) => b.line(l));
      b.bold(false);
    }
    b.divider(w);
  }

  if (data.notes) {
    b.bold(true);
    wrapText(`Order note: ${data.notes}`, w).forEach((l) => b.line(l));
    b.bold(false);
  }

  b.divider(w, "=");
  b.align("center").bold(true).line("END OF ORDER").bold(false).align("left");

  b.cut();

  return b.build();
}
