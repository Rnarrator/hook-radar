/* Starts the one request every plain Discover visit makes, as soon as this small
 * file runs, before the application bundle has downloaded. The application takes
 * the response over (src/early-discovery.ts) when it wants exactly this page and
 * asks again for anything else, so nothing shown or measured changes. */
(function () {
  try {
    if (location.pathname !== "/") return;
    var params = new URLSearchParams(location.search);
    var keys = [];
    params.forEach(function (_, key) {
      keys.push(key);
    });
    // The bare address, or the explicit Discover view: no filter, search,
    // project or other view in it.
    var plain =
      keys.length === 0 ||
      (keys.length === 1 && keys[0] === "view" && params.get("view") === "overview");
    if (!plain) return;
    var url =
      "/api/discovery?search=&chain=all&category=all&property=all&market=projects&sort=volume&direction=desc&window=h24&offset=0&limit=25";
    var response = fetch(url);
    response.catch(function () {});
    window.__radarEarlyDiscovery = { url: url, at: Date.now(), response: response };
  } catch (error) {
    /* The application asks for itself. */
  }
})();
