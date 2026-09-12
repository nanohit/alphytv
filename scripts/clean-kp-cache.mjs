#!/usr/bin/env node
// Keeps the current and previous immutable slots. No catalogues, identities,
// admin documents or legacy v1 rollback objects are ever deletion candidates.
import { pathToFileURL } from "node:url";
import { objectSlot, OBJECT_HOSTS } from "../supabase/functions/kp/index.ts";

export function expiredObject(name, now = Date.now()) {
  const match = /^v2\/(film|staff|similars|search)\/([1-9]\d{0,14})\/(\d+)\.json$/.exec(name);
  return !!match && Number(match[3]) < objectSlot(match[1], match[2], now) - 1;
}

async function main() {
  const keys = JSON.parse(process.env.KP_STORAGE_KEYS || "{}");
  const dryRun = process.argv.includes("--dry-run");
  const deadline = Date.now() + 12 * 60e3;
  for (const ref of OBJECT_HOSTS) {
    if (!keys[ref]) throw new Error(`Missing service key for ${ref}`);
    const call = async (path, body, method = "POST") => {
      const r = await fetch(`https://${ref}.supabase.co${path}`, {
        method, headers: { apikey: keys[ref], Authorization: `Bearer ${keys[ref]}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`maintenance ${ref}: HTTP ${r.status}`);
      return r.json();
    };
    let after = "", scanned = 0, expired = 0;
    while (true) {
      if (Date.now() >= deadline) throw new Error("maintenance time budget exceeded; resume next run");
      const page = await call("/rest/v1/rpc/kp_object_page", { p_after: after, p_limit: 500 });
      if (!Array.isArray(page)) throw new Error("invalid object page");
      if (!page.length) break;
      const prefixes = page.map((row) => row.name).filter((name) => expiredObject(name));
      if (prefixes.length && !dryRun) await call("/storage/v1/object/kp", { prefixes }, "DELETE");
      scanned += page.length; expired += prefixes.length;
      after = page.at(-1).name;
    }
    console.log(`${ref}: scanned ${scanned}, ${dryRun ? "would delete" : "deleted"} ${expired}`);
    if (!dryRun && ref === OBJECT_HOSTS[0]) console.log("state:", await call("/rest/v1/rpc/kp_prune_state", {}));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
