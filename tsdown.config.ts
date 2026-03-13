import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli/index.ts", "src/gateway/index.ts", "src/mcp/gateway-tools-server.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  outDir: "dist",
});
