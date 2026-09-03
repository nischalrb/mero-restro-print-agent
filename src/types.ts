/**
 * Shared shapes between the agent's HTTP surface and rms-frontend's
 * printerService.ts. Deliberately mirrors BillReceiptData
 * (rms-frontend/src/components/BillReceipt.tsx) field-for-field where
 * possible so the POS can build one receipt object and hand it to either
 * the existing browser-print BillReceipt component OR this agent, instead
 * of maintaining two divergent data shapes.
 */

export interface ReceiptPaymentLine {
  methodLabel: string;
  amount: number;
  paidAt?: string | null;
}

export interface ReceiptItem {
  quantity: number;
  /** e.g. "kg" for a weighed item. */
  unit?: string | null;
  name: string;
  unitPrice: number;
  /** Selected option labels, e.g. ["Size: Large", "Spice: Medium"]. */
  options?: string[];
  lineTotal: number;
  customCharges?: { name: string; amount: number }[];
  notes?: string | null;
  fulfillmentLabel?: string | null;
}

export interface ReceiptPrintPayload {
  type: "receipt";
  organizationName: string;
  organizationAddress?: string | null;
  organizationPhone?: string | null;
  taxRegistrationNumber?: string | null;
  billNumber: string;
  /** e.g. "Table 4 · 27 Aug 2026, 7:42 PM" or "Takeaway · 27 Aug 2026, 7:42 PM". */
  subtitle: string;
  customerName?: string | null;
  customerPhone?: string | null;
  staffName?: string | null;
  items: ReceiptItem[];
  subtotal: number;
  discountAmount: number;
  taxLabel: string;
  taxRate: number;
  taxAmount: number;
  serviceChargeLabel?: string | null;
  serviceChargeAmount?: number;
  total: number;
  /** Fallback single-method label — used only when `payments` is absent. */
  paymentMethodLabel?: string | null;
  /** Split Payment / Partial Payment breakdown — see PaymentRecord in the main app. */
  payments?: ReceiptPaymentLine[];
  paidAmount?: number;
  remainingAmount?: number;
  paymentStatusLabel?: string | null;
  /** Only meaningful when a cash payment line is present. */
  cashReceived?: number | null;
  changeDue?: number | null;
  currencySymbol?: string;
  footerMessage?: string | null;
  isDuplicate?: boolean;
}

export interface KitchenTicketItem {
  quantity: number;
  unit?: string | null;
  name: string;
  options?: string[];
  notes?: string | null;
  fulfillmentLabel?: string | null;
}

/**
 * Deliberately excludes every payment/pricing field — see receiptBuilder vs
 * kitchenTicketBuilder. Mirrors rms-frontend's KitchenTicketData
 * (services/printer-agent.ts) field-for-field.
 */
export interface KitchenTicketPrintPayload {
  type: "kitchen";
  /**
   * "new" prints a "*** NEW ORDER ***" banner; "update" prints
   * "*** ORDER UPDATED ***" instead — sent when an already-printed order's
   * items changed (quantity edit, cancellation) and the kitchen needs a
   * fresh ticket. See Order.kitchen_ticket_version on the backend.
   */
  ticketType: "new" | "update";
  orderNumber: string;
  /** e.g. "Table 4" or "Takeaway" / "Delivery". */
  tableLabel: string;
  /** Staff member who placed the order — null for a guest QR order (no staff account placed it). */
  waiterName?: string | null;
  /** Distinguishes a staff-entered POS order from a guest's own QR order — printed so the kitchen knows which workflow it came from. */
  source: "waiter" | "qr";
  items: KitchenTicketItem[];
  placedAt: string;
  notes?: string | null;
}

export type PrintPayload = ReceiptPrintPayload | KitchenTicketPrintPayload;

export interface PrintRequestBody {
  /** Client-supplied dedupe key — see jobs/queue.ts. A retry with the same key never double-prints. */
  idempotencyKey?: string;
  /** OS printer name (connectionType "usb") or "host:port" (connectionType "network"). */
  printerTarget: string;
  connectionType: "usb" | "network";
  paperWidth: "80mm" | "58mm";
  copies?: number;
  payload: PrintPayload;
}

export type JobStatus = "queued" | "printing" | "printed" | "failed";

export interface PrintJob {
  id: string;
  printer: string;
  jobType: "receipt" | "kitchen" | "test";
  createdAt: string;
  status: JobStatus;
  error?: string | null;
}

export interface DiscoveredPrinter {
  name: string;
  /** Always "thermal" for now — a future release may detect driver hints to distinguish laser/inkjet. */
  type: "thermal" | "unknown";
  paperWidth: "80mm" | "unknown";
  status: "ready" | "offline" | "unknown";
}
