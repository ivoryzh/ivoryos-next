import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // The Node-side files here are CommonJS deliberately, not by omission. `daemon.js` runs as a
  // plain `node daemon.js` with no build step, and the shared modules under src/lib (the DAG
  // scheduler and the storage backends) have to be require-able from it while staying importable
  // by the Next app — `require()` is the only form that serves both, so the TypeScript-oriented
  // rule against it does not apply to them.
  {
    files: ["daemon.js", "publish_test.js", "src/lib/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
