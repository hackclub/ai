export function formatPrice(price: string | number): string {
  const str = String(price).trim();
  const num = parseFloat(str);
  if (!str || Number.isNaN(num)) return "N/A";
  if (num === 0) return "Free";

  const [rawWhole = "0", rawFraction = ""] = str.split(".");
  const whole = rawWhole.replace(/^0+/, "") || "0";
  const fraction = rawFraction
    .slice(0, 6)         // cap at 6 decimals (truncate, not round)
    .replace(/0+$/, "")  // drop trailing zeros
    .padEnd(2, "0");     // ...but keep at least 2

  return `$${whole}.${fraction}`;
}
