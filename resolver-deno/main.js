// Deno Deploy entrypoint for the AlphyTV resolver.
//
// Why this exists: the same resolver logic runs on Cloudflare Workers
// (worker/src/index.js), but a Worker executes on the Cloudflare PoP nearest
// the user, and the PoP serving Russian users gets EMPTY responses from
// mzona.net/getVideoSources (its egress IP is filtered). A non-Cloudflare host
// resolves fine (verified from a US datacenter IP). This wrapper reuses the
// exact same handler so there is a single source of truth — only the
// environment plumbing differs (Deno.env instead of a passed `env` object).
//
// Deploy: link this repo on Deno Deploy with entrypoint `resolver-deno/main.js`
// (or `deployctl deploy --entrypoint=resolver-deno/main.js`). Set the
// POISKKINO_TOKEN env var in the project settings. Then point the frontend at
// the deployment URL via ?resolver=... or the Worker field.

import worker from "../worker/src/index.js";

const env = {
  POISKKINO_TOKEN: Deno.env.get("POISKKINO_TOKEN"),
  POISKKINO_BASE_URL: Deno.env.get("POISKKINO_BASE_URL") || "https://api.poiskkino.dev",
  ALLOWED_ORIGIN:
    Deno.env.get("ALLOWED_ORIGIN") ||
    "https://alphytv.vercel.app,https://alphy.tv,https://www.alphy.tv,http://127.0.0.1:5177,http://localhost:5177",
};

Deno.serve((request) => worker.fetch(request, env));
