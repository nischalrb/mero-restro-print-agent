/**
 * Column-width text layout for a character-mode thermal printer (no pixel
 * graphics involved) — 48 characters/line is the standard column count for
 * an 80mm printer at the default (Font A, not condensed) size that ZKTeco's
 * ZKP8018 and virtually every other 80mm ESC/POS printer ships with; 32 is
 * the 58mm equivalent.
 */
export function widthFor(paperWidth: "80mm" | "58mm"): number {
  return paperWidth === "58mm" ? 32 : 48;
}

/** Label on the left, value right-aligned, e.g. "Subtotal" ................ "Rs. 1,450.00". */
export function twoColumn(label: string, value: string, width: number): string {
  const gap = width - label.length - value.length;
  if (gap <= 0) {
    // Column too narrow for both on one line (long label) — wrap the value to its own line instead of truncating either.
    return `${label}\n${value.padStart(width)}`;
  }
  return `${label}${" ".repeat(gap)}${value}`;
}

/** Simple greedy word-wrap — good enough for item names/notes, no hyphenation needed at this width. */
export function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) lines.push(current);
      current = word.length > width ? word.slice(0, width) : word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  return lines;
}
