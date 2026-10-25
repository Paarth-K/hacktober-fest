import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.ts"], exclude: ["**/node_modules/**", "src/ai/tests/**"], environment: "node", testTimeout: 20000 },
});
