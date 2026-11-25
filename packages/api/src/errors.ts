import * as z from "zod";

/** Typed errors every procedure may return; the app shows them, agents read them. */
export const apiErrors = {
  HELPER_UNAVAILABLE: {
    status: 503,
    message: "The capture helper is not connected.",
  },
  HELPER_REJECTED: {
    status: 502,
    message: "The capture helper refused the request.",
    data: z.strictObject({ code: z.string() }),
  },
  TIMEOUT: {
    status: 504,
    message: "The capture helper did not answer in time.",
  },
  NOT_FOUND: {
    status: 404,
    message: "Nothing matches this id; it may have been deleted.",
  },
  INVALID_INPUT: {
    status: 422,
    message: "The input is valid in form but not now, such as a pause ending in the past.",
  },
} as const;

export type ServiceFailureCode =
  | "helper-unavailable"
  | "helper-rejected"
  | "timeout"
  | "not-found"
  | "invalid-input";

/**
 * Thrown by service implementations; procedures turn it into the matching
 * typed oRPC error. Anything else becomes INTERNAL_SERVER_ERROR.
 */
export class ServiceFailure extends Error {
  override readonly name = "ServiceFailure";
  constructor(
    readonly code: ServiceFailureCode,
    message: string,
    /** Helper error code for `helper-rejected`. */
    readonly helperCode?: string,
  ) {
    super(message);
  }
}
