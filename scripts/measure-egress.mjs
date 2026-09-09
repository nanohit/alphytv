// How many distinct addresses do we actually have to work with?
//
// Reads supabase/functions/egress on every project we run and reports the set of
// outbound IPs, grouped by project and by region. The point is a decision, not a
// number: if every project answers with the same address, moving the HDRezka
// relay onto "the Supabase cluster" buys redundancy of hostnames and nothing at
// all in addresses, and should be argued for on that basis instead.
//
//   node scripts/measure-egress.mjs [--rounds=8] [--deno]
//
// --deno also probes the Deno resolver's health endpoint, so the run records
// which host the comparison was made against.

const args = new Map(process.argv.slice(2)
  .filter((a) => a.startsWith("--"))
  .map((a) => a.replace(/^--/, "").split("=")));

// Every project the site talks to today. Shards live on the first; the rest
// carry the liftw and Letterboxd relays.
const PROJECTS = [
  "xoathqkggcuyoyutxwri",
  "icmjgvlsyfqwyewvsuje",
  "gzwynsvcydynqidwxjru",
  "cuyofxgofmhdugauoqzt",
  "hrtnvhafwzimjstvegno",
];

// Cold isolates are where a different NAT address would show up, if it ever
// does. A handful of back-to-back calls mostly reuses one warm instance, so the
// rounds are spaced and the isolate id is recorded to keep the two apart.
const ROUNDS = Number(args.get("rounds") || 8);
const SPACING_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(ref) {
  const url = `https://${ref}.supabase.co/functions/v1/egress?t=${Date.now()}${Math.random()}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return { error: `http ${response.status}` };
    return await response.json();
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 80) };
  }
}

const seen = new Map();   // ref -> { ips:Set, isolates:Set, region, errors:[] }
for (const ref of PROJECTS) seen.set(ref, { ips: new Set(), isolates: new Set(), region: "", errors: [] });

for (let round = 0; round < ROUNDS; round += 1) {
  const results = await Promise.all(PROJECTS.map(probe));
  results.forEach((result, index) => {
    const entry = seen.get(PROJECTS[index]);
    if (result.error) { entry.errors.push(result.error); return; }
    entry.region ||= result.region || "";
    if (result.isolate) entry.isolates.add(result.isolate);
    for (const value of Object.values(result.ip || {})) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(":")) entry.ips.add(value);
      else entry.errors.push(value);
    }
  });
  process.stdout.write(`round ${round + 1}/${ROUNDS}\r`);
  if (round + 1 < ROUNDS) await sleep(SPACING_MS);
}

console.log("\n");
const everything = new Set();
for (const [ref, entry] of seen) {
  for (const ip of entry.ips) everything.add(ip);
  const ips = [...entry.ips];
  console.log(`${ref}  region=${entry.region || "?"}  isolates=${entry.isolates.size}`);
  console.log(`   ips (${ips.length}): ${ips.join(", ") || "(none)"}`);
  if (entry.errors.length) {
    const unique = [...new Set(entry.errors)];
    console.log(`   problems: ${unique.slice(0, 3).join(" | ")}${unique.length > 3 ? ` (+${unique.length - 3})` : ""}`);
  }
}

console.log(`\ndistinct addresses across all ${PROJECTS.length} projects: ${everything.size}`);
console.log([...everything].map((ip) => `  ${ip}`).join("\n"));

// The verdict this run exists to produce.
if (everything.size === 0) {
  // Nothing answered. Almost always the function is not deployed yet — say so
  // rather than reporting "one address", which is what an all-404 run looks like
  // if you only count the set.
  console.log("\n=> No address observed at all. Deploy the probe first:");
  console.log("   for r in " + PROJECTS.join(" ") + "; do \\");
  console.log("     supabase functions deploy egress --project-ref $r --no-verify-jwt; done");
} else if (everything.size === 1) {
  console.log("\n=> One address for the whole cluster. Moving the relay here changes the");
  console.log("   hostname, not the address the source sees. Argue it as redundancy only.");
} else if (everything.size < PROJECTS.length) {
  console.log(`\n=> ${everything.size} addresses for ${PROJECTS.length} projects: they share a NAT, probably`);
  console.log("   per region. Extra projects in an existing region add nothing; a project");
  console.log("   in a NEW region is what adds an address.");
} else {
  console.log("\n=> One address per project. Spreading the relay genuinely spreads the load.");
}

if (args.has("deno")) {
  const response = await fetch("https://alphytv.alphy.deno.net/health").catch(() => null);
  console.log(`\ncompared against the current relay: alphytv.alphy.deno.net (${response?.status ?? "unreachable"})`);
  console.log("Its own egress address is not observable from outside — that would need the");
  console.log("same probe deployed there, or a look at what a destination logs.");
}
