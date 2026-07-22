import test from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

async function privacyHelpers() {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge._test;
}

test("opaque fetch allowlist accepts only the intended HTTPS provider hosts", async () => {
  const helpers = await privacyHelpers();
  assert.equal(helpers.isOpaqueFetchUrl("https://plapi.cdnvideohub.com/api/v1/player/sv/video/1"), true);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.ortified.ws/embed/movie/1"), true);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.zenithjs.ws/embed/movie/1"), true);
  assert.equal(helpers.isOpaqueFetchUrl("https://22jul.newdeaf.co/search/test"), true);
  assert.equal(helpers.isOpaqueFetchUrl("http://api.ortified.ws/embed/movie/1"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.ortified.ws.evil.example/embed/movie/1"), false);
});

test("Collaps broker is limited to its control-plane path", async () => {
  const helpers = await privacyHelpers();
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com/api/v1/player/sv/playlist?id=301"), true);
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com/api/v1/player/sv/video/1"), true);
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com/other"), false);
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com.evil.example/api/v1/player/sv/video/1"), false);
});

test("Ortified cleanroom carries an internal no-referrer policy", async () => {
  const helpers = await privacyHelpers();
  const result = helpers.sanitizeOrtifiedHtml(
    "<!doctype html><html><head></head><body><script>makePlayer({})</script></body></html>",
    "https://api.ortified.ws/embed/movie/1",
    "test",
  );
  assert.equal(result.stats.ok, true);
  assert.match(result.html, /<meta name="referrer" content="no-referrer">/i);
  assert.match(result.html, /<base href="https:\/\/api\.ortified\.ws\/">/i);
});
