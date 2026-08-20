import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Collaps re-signs its MP4 every few minutes. That refresh is entirely our
// business, not the viewer's: it must not pause them, must not drop them out of
// fullscreen, and must not be something they can see or switch off.

const source = () => readFile(new URL("../app.js", import.meta.url), "utf8");

test("fullscreen is never bound to a <video> that a refresh can replace", async () => {
  const app = await source();
  // The whole bug: fullscreen sat on the element the swap hides, so the browser
  // stayed formally fullscreen on a hidden, paused video.
  assert.doesNotMatch(app, /v\.requestFullscreen/);
  assert.match(app, /function fullscreenTarget\(\)/);
  assert.match(app, /return el\.playerHost \|\| activeVideoEl\(\)/);

  // The native controls' own fullscreen button targets the video element, so
  // that case is migrated to the host instead of being left to break later.
  const migrate = app.slice(app.indexOf("function armFullscreenMigration"));
  assert.match(migrate.slice(0, 700), /fullscreenchange/);
  assert.match(migrate.slice(0, 700), /active\.tagName !== "VIDEO"/);
  assert.match(migrate.slice(0, 700), /host\.contains\(active\)/);
  assert.match(app, /armFullscreenMigration\(\);/);
});

test("a failed swap leaves the viewer playing, never on a paused frame", async () => {
  const app = await source();
  const swap = app.slice(app.indexOf("function swapCollapsVideo"), app.indexOf("function hardReloadCollapsVideo"));

  // If the incoming element cannot be started, the outgoing one keeps going.
  assert.match(swap, /if \(wasPlaying && cur\.paused\) cur\.play\(\)/);
  // play() rejecting must abandon the swap rather than reveal a dead element.
  assert.match(swap, /await next\.play\(\);\s*\}\s*catch\s*\{\s*finish\(false\);/);
  // And the spare is put back to sleep so it cannot buffer in the background.
  assert.match(swap, /next\.pause\(\); next\.removeAttribute\("src"\)/);
});

test("the incoming element is revealed only once it is really playing", async () => {
  const app = await source();
  const swap = app.slice(app.indexOf("function swapCollapsVideo"), app.indexOf("function hardReloadCollapsVideo"));
  // canplay/play() resolving is not a painted frame; progress is the signal.
  assert.match(swap, /addEventListener\("timeupdate", started\)/);
  // The outgoing element keeps advancing while the new one loads, so the seek
  // is redone at the moment of the swap — a stale one is a jump backwards.
  assert.match(swap, /const drift = cur\.currentTime - next\.currentTime/);
  // A paused viewer stays paused, on the same frame.
  assert.match(swap, /if \(!wasPlaying\)[\s\S]{0,140}reveal\(\)/);
});

test("a still-playing picture is never torn down by the fallback", async () => {
  const app = await source();
  const refresh = app.slice(app.indexOf("async function refreshCollapsNow"), app.indexOf("function swapCollapsVideo"));
  // hardReloadCollapsVideo reloads the element the viewer is watching, so it is
  // only reached when they have already lost the picture — or when they asked
  // for a different quality and a visible reload is expected.
  assert.match(refresh, /const stalled =/);
  assert.match(refresh, /if \(stalled\) hardReloadCollapsVideo\(url\)/);
  assert.match(refresh, /\|\| qualityKey/);
});

test("the session controls are gone from the viewer's UI", async () => {
  const app = await source();
  // Refreshing is machinery, not a feature: there is nothing here for a viewer
  // to decide, and a toggle only invites them to break their own playback.
  assert.doesNotMatch(app, /addTrackGroup\("Сессия"/);
  assert.doesNotMatch(app, /авто вкл|авто выкл/);
  assert.doesNotMatch(app, /refreshCollapsNow\("вручную"\)/);
  // The mechanism itself stays, and stays on.
  assert.match(app, /refreshCollapsNow\("таймер"\)/);
  assert.match(app, /refreshCollapsNow\("зависание"\)/);
});
