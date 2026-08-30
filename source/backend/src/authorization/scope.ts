import type { ResourceDescriptor } from "./types.js";

/**
 * Scope matching. A scope answers "where does a capability apply?" — the dimension
 * plain RBAC is missing and the reason `Manager + ASSET_TRANSFER` can be simultaneously
 * legitimate for a Finance asset and illegitimate for an HR asset.
 *
 * Matching is deliberately *closed*: an unrecognised scope type matches nothing. A
 * typo in a selector must shrink access, never widen it.
 */

export type ScopeType = "ORGANIZATION" | "DEPARTMENT" | "COLLECTION" | "RESOURCE" | "VENDOR";

export interface ScopeRecord {
  id: string;
  organizationId: string;
  name: string;
  scopeType: ScopeType | string;
  selector: ScopeSelector;
  constraints: ScopeConstraints;
}

export interface ScopeSelector {
  organizationId?: string;
  departmentIds?: string[];
  collectionIds?: string[];
  resourceIds?: string[];
  resourceTypes?: string[];
  vendors?: string[];
}

export interface ScopeConstraints {
  maxAmount?: number;
  timeWindow?: { from: string; to: string }; // "HH:MM" local 24h
}

export interface ScopeMatch {
  matched: boolean;
  scope: ScopeRecord | null;
  reason: string;
}

function includesIgnoreCase(list: string[] | undefined, value: string | null | undefined): boolean {
  if (!list || list.length === 0) return false;
  if (!value) return false;
  return list.some((v) => v.toLowerCase() === value.toLowerCase());
}

export function scopeMatches(scope: ScopeRecord, resource: ResourceDescriptor): boolean {
  // A resource in another tenant never matches, whatever the selector says.
  if (resource.organizationId && resource.organizationId !== scope.organizationId) return false;

  // resourceTypes, when present, is an additional filter applied to every scope type.
  const sel = scope.selector ?? {};
  if (sel.resourceTypes && sel.resourceTypes.length > 0) {
    if (!includesIgnoreCase(sel.resourceTypes, resource.type)) return false;
  }

  switch (scope.scopeType) {
    case "ORGANIZATION":
      return !sel.organizationId || sel.organizationId === scope.organizationId;
    case "DEPARTMENT":
      return includesIgnoreCase(sel.departmentIds, resource.departmentId ?? null);
    case "COLLECTION":
      return includesIgnoreCase(sel.collectionIds, resource.collectionId ?? null);
    case "RESOURCE":
      return includesIgnoreCase(sel.resourceIds, resource.id ?? null);
    case "VENDOR":
      return includesIgnoreCase(sel.vendors, resource.vendor ?? null);
    default:
      return false; // fail closed on an unknown scope type
  }
}

/** Returns the first scope that admits this resource, or a structured miss. */
export function findMatchingScope(scopes: ScopeRecord[], resource: ResourceDescriptor): ScopeMatch {
  if (scopes.length === 0) {
    return { matched: false, scope: null, reason: "No resource scopes are assigned to this actor." };
  }
  for (const scope of scopes) {
    if (scopeMatches(scope, resource)) {
      return { matched: true, scope, reason: `Matched scope "${scope.name}" (${scope.scopeType}).` };
    }
  }
  const names = scopes.map((s) => s.name).join(", ");
  return {
    matched: false,
    scope: null,
    reason: `Resource is outside every assigned scope (${names}).`,
  };
}

/**
 * Minute-of-day comparison that tolerates windows crossing midnight (22:00 → 06:00).
 *
 * A malformed window returns false rather than throwing. Throwing from inside the
 * authorization engine would surface as a 500, and a 500 is the worst possible outcome
 * here: the caller cannot tell whether they were denied or whether the check simply
 * never ran. Failing closed keeps the answer honest — no window, no access — and the
 * misconfiguration is caught at write time by normalizeConstraints instead.
 */
export function withinTimeWindow(
  window: { from?: string; to?: string; timezoneOffsetMinutes?: number } | null | undefined,
  at: Date,
): boolean {
  const toMinutes = (hhmm: unknown): number | null => {
    if (typeof hhmm !== "string") return null;
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  };

  const from = toMinutes(window?.from);
  const to = toMinutes(window?.to);
  if (from === null || to === null) return false;

  // A business-hours rule means business hours *where the business is*. Without
  // honouring the declared offset, a window written as 09:00–18:00 IST would silently
  // mean 09:00–18:00 in whatever timezone the server happens to run in — which is how
  // a policy that looks correct in review locks people out in production.
  const offset = window?.timezoneOffsetMinutes;
  const now = Number.isFinite(offset)
    ? (() => {
        const shifted = new Date(at.getTime() + (offset as number) * 60_000);
        return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
      })()
    : at.getHours() * 60 + at.getMinutes();

  return from <= to ? now >= from && now <= to : now >= from || now <= to;
}
