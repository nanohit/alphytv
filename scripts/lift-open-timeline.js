// Paste into the browser console on https://alphy.tv to time one Lift open end
// to end, on the viewer's own network: the /info relay, the player page, the
// manifest, every media request (host, status, time) and the video events.
// Opens /l/<id> of the current page (or X-Men 3, 314) with its cached parse
// dropped, so every stage is paid again. Prints a table and a JSON line to send.
(async () => {
  const id = (location.pathname.match(/^\/l\/(\d+)/) || [])[1] || "314";
  for (const key of Object.keys(localStorage)) {
    if (new RegExp(`liftw(title|ladder)[^:]*:${id}$|curatedmeta:lift:${id}$`).test(key)) localStorage.removeItem(key);
  }
  history.pushState({}, "", "/");
  dispatchEvent(new PopStateEvent("popstate"));
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const rows = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const host = (url) => { try { return new URL(url).host; } catch { return ""; } };
  const file = (url) => { try { return new URL(url).pathname.split("/").pop(); } catch { return ""; } };
  const mark = (step, detail = "") => rows.push({ ms: at(), step, detail });

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = String(input?.url || input);
    const started = at();
    try {
      const response = await originalFetch.call(this, input, init);
      mark(`fetch ${response.status}`, `${host(url)} ${file(url)} (${at() - started} ms)`);
      return response;
    } catch (error) {
      mark("fetch FAILED", `${host(url)} ${file(url)} ${error.name} (${at() - started} ms)`);
      throw error;
    }
  };
  const media = new Map();
  const onMessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.alphyFetch) mark(`player page ${data.ok ? data.status : "FAILED"}`, `${(data.text || "").length} chars`);
    if (!data.alphyLiftwMedia) return;
    const entry = media.get(data.id) || { started: at() };
    media.set(data.id, entry);
    if (data.responseUrl) entry.url = data.responseUrl;
    if (data.phase === "headers") entry.headers = at();
    if (data.ok === true || data.ok === false) {
      mark(`media ${data.ok ? data.status : "FAILED"}`,
        `${host(entry.url || "")} ${file(entry.url || "")} ${data.error || ""} headers@${entry.headers ?? "-"} done@${at()}`);
    }
  };
  addEventListener("message", onMessage);
  const videoEvents = ["loadedmetadata", "canplay", "waiting", "stalled", "error"];
  const onVideo = (event) => { if (event.target.tagName === "VIDEO") mark(`video ${event.type}`); };
  videoEvents.forEach((type) => document.addEventListener(type, onVideo, true));

  mark("open", `/l/${id}`);
  history.pushState({}, "", `/l/${id}`);
  dispatchEvent(new PopStateEvent("popstate"));
  const deadline = performance.now() + 40000;
  while (performance.now() < deadline && !rows.some((row) => row.step === "video canplay")) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  window.fetch = originalFetch;
  removeEventListener("message", onMessage);
  videoEvents.forEach((type) => document.removeEventListener(type, onVideo, true));
  const ready = rows.find((row) => row.step === "video canplay");
  mark(ready ? "READY" : "NOT READY after 40 s");
  console.table(rows);
  console.log("ALPHY_LIFT_TIMELINE " + JSON.stringify({ id, ua: navigator.userAgent, readyMs: ready?.ms ?? null, rows }));
})();
