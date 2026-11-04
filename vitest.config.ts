import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { join } from "node:path";

const pluginUiRoot = join(process.cwd(), "src", "plugin-ui");

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      {
        find: /^@diver\/plugin-ui$/,
        replacement: join(pluginUiRoot, "index.ts"),
      },
      {
        find: /^@diver\/plugin-ui\//,
        replacement: `${pluginUiRoot}/`,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "cos-plugins/*/ui/**/*.test.ts"],
  },
});
