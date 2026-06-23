import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalog } from "../api/_catalog-store.js";

test("normalizes direct player targets and metadata", () => {
  const catalog = normalizeCatalog({
    revision: 7,
    lists: [{
      id: "featured",
      title: "  Выбор редакции ",
      items: [{
        id: "bojack",
        key: "zen:2097",
        title: " Конь БоДжек ",
        year: 2014,
        poster: "https://example.com/poster.jpg",
        rating: { kp: "8.4", imdb: 8.8 },
        isSeries: true,
        target: { kind: "zen", zenithId: 2097 },
      }],
    }],
  });

  assert.equal(catalog.revision, 7);
  assert.equal(catalog.lists[0].title, "Выбор редакции");
  assert.deepEqual(catalog.lists[0].items[0].target, { kind: "zen", zenithId: "2097" });
  assert.deepEqual(catalog.lists[0].items[0].rating, { kp: 8.4, imdb: 8.8 });
});

test("rejects invalid targets, duplicate keys and non-https artwork", () => {
  const catalog = normalizeCatalog({
    lists: [{
      id: "one",
      title: "One",
      items: [
        { key: "x", title: "Bad", target: { kind: "zen", zenithId: "nope" } },
        { key: "same", title: "First", poster: "http://example.com/a.jpg", target: { kind: "kp", kpId: "42" } },
        { key: "same", title: "Duplicate", target: { kind: "kp", kpId: "42" } },
      ],
    }],
  });

  assert.equal(catalog.lists[0].items.length, 1);
  assert.equal(catalog.lists[0].items[0].title, "First");
  assert.equal("poster" in catalog.lists[0].items[0], false);
});

test("caps list and item counts", () => {
  const rawLists = Array.from({ length: 30 }, (_, listIndex) => ({
    id: `list-${listIndex}`,
    title: `List ${listIndex}`,
    items: Array.from({ length: 70 }, (_, itemIndex) => ({
      key: `kp:${listIndex}:${itemIndex}`,
      title: `Item ${itemIndex}`,
      target: { kind: "kp", kpId: String(1000 + itemIndex) },
    })),
  }));
  const catalog = normalizeCatalog({ lists: rawLists });
  assert.equal(catalog.lists.length, 24);
  assert.equal(catalog.lists[0].items.length, 60);
});
