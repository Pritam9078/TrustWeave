export function nowIso(): string {
  return new Date().toISOString();
}

export function plusMinutes(minutes: number, from = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

export function isExpired(iso: string | null | undefined, at = new Date()): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() <= at.getTime();
}

/** Start of the rolling window used by velocity rules, as an ISO string. */
export function windowStart(window: "1h" | "1d" | "7d" | "30d", at = new Date()): string {
  const ms = { "1h": 3_600_000, "1d": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[window];
  return new Date(at.getTime() - ms).toISOString();
}
