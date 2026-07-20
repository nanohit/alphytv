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
        label: "  Новый   сезон  ",
        rating: { kp: "8.4", imdb: 8.8 },
        externalId: { imdb: "tt3398228", tmdb: 61222 },
        people: {
          directors: [{ id: 123, name: "Рафаэль Боб-Ваксберг" }],
          cast: [{ id: 456, name: "Уилл Арнетт" }],
        },
        isSeries: true,
        target: { kind: "zen", zenithId: 2097 },
      }],
    }],
  });

  assert.equal(catalog.revision, 7);
  assert.equal(catalog.lists[0].title, "Выбор редакции");
  assert.deepEqual(catalog.lists[0].items[0].target, { kind: "zen", zenithId: "2097" });
  assert.equal(catalog.lists[0].items[0].label, "Новый сезон");
  assert.deepEqual(catalog.lists[0].items[0].rating, { kp: 8.4, imdb: 8.8 });
  assert.deepEqual(catalog.lists[0].items[0].externalId, { imdb: "tt3398228", tmdb: "61222" });
  assert.deepEqual(catalog.lists[0].items[0].people, {
    directors: [{ id: "123", name: "Рафаэль Боб-Ваксберг" }],
    cast: [{ id: "456", name: "Уилл Арнетт" }],
  });
});

test("normalizes persistent soap and Collaps targets", () => {
  const catalog = normalizeCatalog({
    lists: [{
      id: "players",
      title: "Players",
      items: [
        {
          key: "soap:123",
          title: "Soap Movie",
          target: { kind: "soap", soapId: 123 },
        },
        {
          key: "clps:404900",
          title: "Breaking Bad",
          isSeries: true,
          target: { kind: "clps", kpId: 404900, season: "1", episode: "1" },
        },
      ],
    }],
  });

  assert.deepEqual(catalog.lists[0].items[0].target, { kind: "soap", soapId: "123" });
  assert.deepEqual(catalog.lists[0].items[1].target, { kind: "clps", kpId: "404900", season: 1, episode: 1 });
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

test("forYou mode survives normalization and defaults to on", () => {
  assert.equal(normalizeCatalog({ lists: [] }).forYou, "on");
  assert.equal(normalizeCatalog({ forYou: "frozen", lists: [] }).forYou, "frozen");
  assert.equal(normalizeCatalog({ forYou: "off", lists: [] }).forYou, "off");
  assert.equal(normalizeCatalog({ forYou: "junk", lists: [] }).forYou, "on");
});

test("bookmark banner is an explicit catalog boolean", () => {
  const defaults = normalizeCatalog({ lists: [] });
  assert.equal(defaults.bookmarkBanner, false);
  assert.equal(defaults.bookmarkBannerText, "Добавьте сайт в закладки");
  const enabled = normalizeCatalog({
    bookmarkBanner: true,
    bookmarkBannerText: "  Важное объявление  ",
    lists: [],
  });
  assert.equal(enabled.bookmarkBanner, true);
  assert.equal(enabled.bookmarkBannerText, "Важное объявление");
  assert.equal(normalizeCatalog({ bookmarkBanner: "true", lists: [] }).bookmarkBanner, false);
});
