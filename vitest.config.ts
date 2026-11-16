import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    // Servers spawned by tests never read the user's own ~/.autosketch/config.toml (core/config.ts).
    env: { AUTOSKETCH_HOME: join(tmpdir(), "autosketch-test-home") },
  },
});
