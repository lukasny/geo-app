// Shared currency formatting. Replaces the duplicated formatters on the
// dashboard and the AI Revenue page. Safe to import from anywhere.

/** Format an amount in a currency, falling back to a plain join when the
 *  currency code is unknown to Intl (custom or legacy codes). */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
