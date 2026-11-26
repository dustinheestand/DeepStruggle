// The phone page's service worker (play.html): shows the relay's "your move" pushes
// (web/play_worker/src/index.ts notify) and opens that game's seat when one is tapped. It caches
// nothing: the page always loads from the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil((async () => {
    let error = "";
    try {
      await self.registration.showNotification(d.title || "Twilight Struggle", {
        body: d.body || "Your move",
        tag: d.tag || "ts-move",
        renotify: true,
        icon: "icon-192.png",
        badge: "icon-192.png",
        data: { url: d.url || "play.html" },
      });
    } catch (err) {
      error = String(err);
    }
    // Open pages hear of it too (a diagnostic, and a page may redraw).
    for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      c.postMessage({ t: "push", body: d.body || "", error });
    }
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "play.html", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url === url && "focus" in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
