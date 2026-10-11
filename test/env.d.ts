// Gives `env` from "cloudflare:workers" the Worker's binding types inside tests.
import type { Env as AppEnv } from "../src/env";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
export {};
