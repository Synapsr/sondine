import { handle, type Env } from "./report";

// The Worker's entry: workerd takes every export of this module for a handler,
// so there is only this one. What it does is in report.ts.

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
