import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Dashboard logic tests: plain DOM (happy-dom), no Workers runtime needed.
// The browser modules import each other as "/core.js"; map those to the files in ./public.
const pub = (f: string) => fileURLToPath(new URL(`./public/${f}`, import.meta.url));

export default defineConfig({
  logLevel: "error",
  publicDir: false,
  resolve: { alias: [{ find: /^\/(core|i18n|views-main|views-auth)\.js$/, replacement: pub("$1.js") }] },
  test: { include: ["test-ui/**/*.test.ts"], environment: "happy-dom", testTimeout: 15000 },
});
