import { Context, Layer } from "effect";

// The window's, the agents' and the phones' procedures being answered now: an
// update waits for them (ADR 045), since an import, an export or an open panel
// lasts as long as its call.

export class GoingOnActions extends Context.Service<
  GoingOnActions,
  {
    /** Counts `promise` until it settles, and returns it. */
    readonly track: <A>(promise: Promise<A>) => Promise<A>;
    readonly any: () => boolean;
  }
>()("sondine/core/GoingOnActions") {}

export const goingOnActionsLayer = Layer.sync(GoingOnActions, () => {
  let count = 0;
  return GoingOnActions.of({
    track: (promise) => {
      count += 1;
      return promise.finally(() => {
        count -= 1;
      });
    },
    any: () => count > 0,
  });
});
