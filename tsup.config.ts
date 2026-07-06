import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "packages/core/src/index.ts",
    cli: "packages/core/src/cli.ts",
    opencode: "packages/opencode/src/plugin.ts",
    "claude-hook": "packages/claude-code/src/hook.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  clean: true,
  splitting: false,
})
