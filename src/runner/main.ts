/**
 * src/runner/main.ts
 *
 * Entry point for the `hive-runner` PM2 process. Kept tiny and free of
 * exports so module-load semantics are unambiguous: this file's job is
 * literally just to call `main()`.
 *
 * Why this is split from `index.ts`:
 *   - `index.ts` is imported by tests for `processOneTask` / `handleSpawnEvent`.
 *     If it auto-ran `main()` on import, every test file that imports
 *     anything from it would launch the polling daemon at test time.
 *   - The previous "if (isDirectInvocation) { main() }" guard was brittle
 *     under PM2 — under some launch paths it evaluated false and main()
 *     never ran, which is exactly the silent-runner bug we hit on
 *     2026-04-29. Replacing the guard with a separate entry file is
 *     deterministic regardless of how the script is invoked.
 *
 * To run: `node dist/runner/main.js` (PM2 ecosystem config does this).
 */

import "dotenv/config";
import { main } from "./index.js";

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
