// Test-only module resolution: this package's source uses TypeScript's
// `.js` import specifiers (the extension is loaded by pi, which maps them to
// `.ts`), but Node's built-in type stripping does not. Register a resolve hook
// that falls back to the `.ts` file whenever a relative `./x.js` import has no
// `x.js` next to it, so `node --test` can import `src/search.ts` directly.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.endsWith(".js") && context.parentURL) {
        const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
      throw err;
    }
  },
});
