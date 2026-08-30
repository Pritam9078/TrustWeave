import type { z } from "zod";
import { badRequest } from "../core/errors.js";

/** Validate a request body, converting Zod issues into a structured 400 the frontend
 *  can render field-by-field rather than as an opaque error string. */
export function validate<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw badRequest("VALIDATION_FAILED", "The request body is invalid.", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export function intParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
