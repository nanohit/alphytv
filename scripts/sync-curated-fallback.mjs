import { mkdir, writeFile } from "node:fs/promises";

const blobUrl =
  process.env.ALPHY_CATALOG_BLOB_URL ||
  "https://nvpuetq65dds3gtx.public.blob.vercel-storage.com/catalog/curated.json";

const response = await fetch(`${blobUrl}?snapshot=${Date.now()}`, {
  cache: "no-store",
});
if (!response.ok) throw new Error(`Catalog download failed: ${response.status}`);

const catalog = await response.json();
if (!Array.isArray(catalog?.lists) || !Number.isInteger(Number(catalog?.revision))) {
  throw new Error("Catalog response is invalid");
}

const body = `${JSON.stringify(catalog, null, 2)}\n`;
const revision = Number(catalog.revision);
const stamp = new Date().toISOString().slice(0, 10);
const backupDir = new URL("../docs/catalog-backups/", import.meta.url);

await mkdir(backupDir, { recursive: true });
await writeFile(new URL("../curated-fallback.json", import.meta.url), body);
await writeFile(new URL(`curated-${stamp}-r${revision}.json`, backupDir), body);

const itemCount = catalog.lists.reduce(
  (total, list) => total + (Array.isArray(list?.items) ? list.items.length : 0),
  0,
);
console.log(`Saved catalog revision ${revision}: ${catalog.lists.length} lists, ${itemCount} items`);
