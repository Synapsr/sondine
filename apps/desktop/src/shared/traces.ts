/**
 * Traces waiting for a compute server go together once there are this many,
 * without waiting for a conversation (Téo, 2026-11-25): the server has the
 * model loaded once for all of them.
 */
export const TRACE_BATCH = 30;
