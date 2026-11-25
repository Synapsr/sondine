import { registerHooks } from "node:module";

// Workspace packages such as @sondine/protocol use extensionless relative
// imports (bundler resolution), folders included; Node's type stripping needs
// the `.ts` file. Register
// this before importing them, with a dynamic import, as protocol's
// scripts/gen-schemas.ts does.

let registered = false;

export function allowExtensionlessTs(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts") === true) {
          // A folder import (`./schema`) means its index.
          try {
            return nextResolve(`${specifier}.ts`, context);
          } catch {
            return nextResolve(`${specifier}/index.ts`, context);
          }
        }
        throw error;
      }
    },
  });
}
