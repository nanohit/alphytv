import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const rootFile = (name) => new URL(`../${name}`, import.meta.url);

test("the Vercel document stays below the observed throttling window", async () => {
  const info = await stat(rootFile("index.html"));
  assert.ok(info.size < 10_000, `index.html is ${info.size} bytes`);

  const page = await readFile(rootFile("index.html"), "utf8");
  assert.match(page, /__ALPHY_ASSET_REV__/);
  assert.match(page, /cdn\.jsdelivr\.net\/gh\/nanohit\/alphytv@/);
  assert.doesNotMatch(page, /(?:src|href)="\/(?:app|styles|identity|catalog|foryou|keypool|shaka)/);
});

test("the shell is present before first-party scripts execute", async () => {
  const page = await readFile(rootFile("index.html"), "utf8");
  const shell = await readFile(rootFile("app-shell.html"), "utf8");
  const expectedOrder = [
    "identity.js",
    "foryou.js",
    "catalog-cache.js",
    "shaka-smooth.js",
    "app.js",
    "catalog.js",
    "keypool.js",
  ];

  assert.match(shell, /id="searchInput"/);
  assert.match(shell, /id="playerHost"/);
  assert.match(shell, /data-alphy-asset="Logo\.png"/);
  assert.match(page, /innerHTML = shellSource\.body/);

  let previous = -1;
  for (const script of expectedOrder) {
    const index = page.indexOf(`"${script}"`);
    assert.ok(index > previous, `${script} must preserve the original execution order`);
    previous = index;
  }
});

test("large lazy datasets resolve through the immutable asset base", async () => {
  const identity = await readFile(rootFile("identity.js"), "utf8");
  const app = await readFile(rootFile("app.js"), "utf8");
  const catalogCache = await readFile(rootFile("catalog-cache.js"), "utf8");

  assert.match(identity, /__alphyAssetUrl\?\.\("imdb-map\.json"\)/);
  assert.match(app, /__alphyAssetUrl\?\.\("soap-movies\.json"\)/);
  assert.match(app, /__alphyAssetUrl\?\.\("curated-fallback\.json"\)/);
  assert.match(catalogCache, /__alphyAssetUrl\?\.\("curated-fallback\.json"\)/);
});
