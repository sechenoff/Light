export function formatMoneyRub(value: number | string | null | undefined | unknown) {
  if (value == null) return "0.00";
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "0.00";
  }
  const s = String(value).trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

