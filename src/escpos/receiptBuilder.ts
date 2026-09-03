import { EscPosBuilder } from "./commands";
import { twoColumn, widthFor, wrapText } from "./columns";
import { ReceiptPrintPayload } from "../types";

/**
 * Coerces before formatting rather than trusting the declared `number`
 * type — most fields here ARE genuinely numeric by the time they leave
 * Laravel (TableSessionController explicitly casts subtotal/tax/total/
 * unit_price/line_total to float), but a few paths (e.g. an item's
 * ad-hoc custom_charges, which lives in a raw JSON column with no
 * server-side cast) can still arrive as a numeric STRING. `n.toFixed(2)`
 * on a string throws — and previously that exception aborted buildReceipt
 * entirely with zero bytes ever sent to the printer and no error surfaced
 * past a hung HTTP request, which is exactly what "blank paper, nothing
 * printed" looks like from the restaurant's side. Falls back to 0 rather
 * than throwing for anything genuinely unparseable.
 */
const fmt = (n: number) => {
  const v = typeof n === "number" ? n : Number(n);
  return (Number.isFinite(v) ? v : 0).toFixed(2);
};

/**
 * The customer-facing receipt — full pricing/payment detail. Deliberately
 * mirrors BillReceipt.tsx (rms-frontend) section-for-section (header,
 * items, subtotal/discount/tax/total, payment summary, footer) so a
 * restaurant that's used to the on-screen/browser-print receipt sees the
 * same information in the same order on the thermal copy. See
 * kitchenTicketBuilder.ts for the deliberately payment-free ticket printed
 * to the kitchen instead of this.
 */
export function buildReceipt(data: ReceiptPrintPayload, paperWidth: "80mm" | "58mm"): Buffer {
  const w = widthFor(paperWidth);
  const currency = data.currencySymbol ?? "Rs.";
  const money = (n: number) => `${currency} ${fmt(n)}`;
  const b = new EscPosBuilder().init();

  if (data.isDuplicate) {
    b.align("center").bold(true).line("*** DUPLICATE COPY ***").bold(false);
  }

  // ── Header ────────────────────────────────────────────────────────
  b.align("center").bold(true).size(true, false).line(data.organizationName).size(false, false).bold(false);
  if (data.organizationAddress) wrapText(data.organizationAddress, w).forEach((l) => b.line(l));
  if (data.organizationPhone) b.line(`Tel: ${data.organizationPhone}`);
  if (data.taxRegistrationNumber) b.line(`VAT/PAN: ${data.taxRegistrationNumber}`);
  b.line(data.taxRate > 0 ? "TAX INVOICE" : "BILL");
  b.line(data.billNumber);
  b.line(data.subtitle);
  if (data.staffName) b.line(`Staff: ${data.staffName}`);
  if (data.customerName || data.customerPhone) {
    b.line([data.customerName, data.customerPhone].filter(Boolean).join(" - "));
  }
  b.align("left").divider(w);

  // ── Items ─────────────────────────────────────────────────────────
  for (const item of data.items) {
    const qty = `${item.quantity}${item.unit ? item.unit : ""}`;
    const nameLine = `${qty} x ${item.name}`;
    wrapText(nameLine, w).forEach((l) => b.line(l));
    b.line(twoColumn(`  @ ${money(item.unitPrice)}${item.unit ? `/${item.unit}` : ""}`, money(item.lineTotal), w));

    if (item.options && item.options.length > 0) {
      wrapText(`  ${item.options.join(", ")}`, w).forEach((l) => b.line(l));
    }
    for (const charge of item.customCharges ?? []) {
      b.line(twoColumn(`  + ${charge.name} (Custom)`, money(charge.amount), w));
    }
    if (item.fulfillmentLabel) b.line(`  (${item.fulfillmentLabel})`);
    if (item.notes) wrapText(`  Note: ${item.notes}`, w).forEach((l) => b.line(l));
  }

  b.divider(w);

  // ── Totals ────────────────────────────────────────────────────────
  b.line(twoColumn("Subtotal", money(data.subtotal), w));
  if (data.discountAmount > 0) b.line(twoColumn("Discount", `-${money(data.discountAmount)}`, w));
  b.line(twoColumn(`${data.taxLabel} (${data.taxRate}%)`, money(data.taxAmount), w));
  if (data.serviceChargeAmount && data.serviceChargeAmount > 0) {
    b.line(twoColumn(data.serviceChargeLabel ?? "Service charge", money(data.serviceChargeAmount), w));
  }
  b.divider(w, "=");
  b.bold(true).size(false, true).line(twoColumn("TOTAL", money(data.total), w)).size(false, false).bold(false);
  b.divider(w, "=");

  // ── Payment summary ──────────────────────────────────────────────
  if (data.payments && data.payments.length > 0) {
    b.align("center").line("Payment Summary").align("left");
    for (const p of data.payments) {
      b.line(twoColumn(p.methodLabel, money(p.amount), w));
    }
    if (data.cashReceived != null) b.line(twoColumn("Cash received", money(data.cashReceived), w));
    if (data.changeDue != null && data.changeDue > 0) b.line(twoColumn("Change", money(data.changeDue), w));
    if (data.remainingAmount != null && data.remainingAmount > 0.01) {
      b.bold(true).line(twoColumn("Due", money(data.remainingAmount), w)).bold(false);
    }
    if (data.paymentStatusLabel) b.align("center").bold(true).line(data.paymentStatusLabel).bold(false).align("left");
  } else if (data.paymentMethodLabel) {
    b.align("center").line(`Paid by ${data.paymentMethodLabel}`).align("left");
  }

  // ── Footer ────────────────────────────────────────────────────────
  b.align("center");
  b.line(data.isDuplicate ? "Reprinted copy - not a new transaction." : data.footerMessage ?? "Thank you!");
  b.line("This is a computer-generated bill.");
  b.cut();

  return b.build();
}
