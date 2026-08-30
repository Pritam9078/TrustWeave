/** Presentation helpers. Amounts are stored as major units (rupees), not paise. */

export function inr(amount) {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount);
}

export function money(amount, currency = "INR") {
  if (amount === null || amount === undefined) return "—";
  if (currency === "INR") return inr(amount);
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amount);
}

export function dateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function relative(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return dateTime(iso);
}

/** Shortens a DID for display while keeping enough on both ends to be recognisable. */
export function shortDid(did) {
  if (!did) return "—";
  return did.length <= 26 ? did : `${did.slice(0, 16)}…${did.slice(-6)}`;
}

export function shortHash(hash) {
  if (!hash) return "—";
  const clean = hash.replace(/^sha256:/, "");
  return clean.length <= 18 ? clean : `${clean.slice(0, 10)}…${clean.slice(-6)}`;
}

export function titleCase(value) {
  if (!value) return "";
  return String(value).replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
