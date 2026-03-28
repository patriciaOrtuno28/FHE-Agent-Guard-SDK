import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/sdk/src/test/**/*.test.ts"],
    environment: "node",
  },
});
