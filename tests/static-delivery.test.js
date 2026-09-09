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

test("the meta panel has a fixed set of children, each owning one grid cell", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const start = app.indexOf("// Three children, and always three");
  const render = app.slice(start, app.indexOf("el.metaPanel.dataset.watchToken", start));
  // Poster, body, credits — in that order and always all three slots, even when
  // a title has no credits. Ratings, description and credits are each optional,
  // and a grid row-span over a variable number of implicit rows does not survive
  // that: it is how the two columns used to overlap on phones.
  assert.match(render, /\$\{posterHtml\}<div class="meta-body">\$\{body\}<\/div>\$\{factsHtml\}/);
  assert.match(render, /const factsHtml = facts \? `<dl class="meta-facts">/);
  // Nothing may put the credits back inside the body.
  assert.doesNotMatch(render, /body \+= `<dl class="meta-facts"/);
  // The credits span the panel, which is what lets them run under the poster on
  // a phone instead of being squeezed into the text column beside it.
  assert.match(styles, /\.meta-facts \{\s*\n\s*grid-column: 1 \/ -1;/);
});

test("the synopsis is measured only after the panel is visible", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = app.indexOf("// Revealed before the synopsis is measured");
  assert.ok(start > 0, "the ordering must stay deliberate and explained");
  const block = app.slice(start, app.indexOf("fillLetterboxdBadge", start));
  // `.hidden` is `display: none`, and a display:none element reports both
  // scrollHeight and clientHeight as 0 — so measuring first compared 0 > 2 and
  // the "ещё" toggle never appeared on a cold load.
  const reveal = block.indexOf('el.metaPanel.classList.remove("hidden")');
  const measure = block.indexOf("descNode.scrollHeight > descNode.clientHeight");
  assert.ok(reveal >= 0 && measure > reveal, "reveal has to come before the measurement");
});

test("on a phone the text column cannot outgrow the poster", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const mobile = styles.slice(styles.indexOf("@media (max-width: 560px)"));
  // The poster's height has to be computable from its width, or the column
  // beside it has nothing to size itself against.
  assert.match(mobile, /\.meta-poster \{ width: 100%; aspect-ratio: 2 \/ 3; \}/);
  assert.match(mobile, /--meta-poster-w: clamp\(/);
  assert.match(mobile, /\.meta-body \{ max-height: calc\(var\(--meta-poster-w\) \* 1\.5\); overflow: hidden; \}/);
  // Expanding the synopsis has to escape that cap, or "ещё" would open into a
  // clipped box and read as broken.
  assert.match(mobile, /\.meta-body:has\(\.meta-desc\.open\) \{ max-height: none/);
  // Only the synopsis gives; the toggle must never be the thing that shrinks.
  assert.match(mobile, /\.meta-desc \{[^}]*flex: 1 1 auto/);
  assert.match(mobile, /\.meta-desc-toggle \{[^}]*flex: none/);
  // Three figures — a film with a Letterboxd score — stay on one line.
  assert.match(mobile, /\.meta-ratings \{[^}]*flex-wrap: nowrap/);
});
