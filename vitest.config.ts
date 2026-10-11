import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  logLevel: "error",
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TOKEN_ENCRYPTION_KEY: "q83vEfH0kQ1pK7yKq3m0H0b3o1x0t0u3K1m8c0Qd2xY=",
          GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-client-secret",
          ADMIN_SETUP_SECRET: "test-setup-secret-0123456789abcdef0123456789",
          PUBLIC_ORIGIN: "https://nodi.example.workers.dev",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
});
