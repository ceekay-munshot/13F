// functions/data/[[path]].js
//
// Serve the artifact tree from R2 through the Pages origin.
//
// WHY THIS EXISTS
// ---------------
// The dashboard fetches `/data/...`. Once the artifacts move to R2 to keep them
// out of git, something has to bridge the Pages origin to the bucket. A custom
// R2 domain would do it but needs a new hostname; this Function serves R2 on the
// EXISTING pages.dev origin, so the frontend URL never changes and there is no
// cross-origin request to configure.
//
// It is a pure passthrough — `env.F13F_R2.get(key)` and stream the body back —
// so the 10 ms CPU budget is irrelevant (this is I/O, not compute). It is the
// one Worker in the read path, and it does nothing but forward bytes.
//
// PRECEDENCE — VERIFIED AGAINST THE LIVE SITE, NOT ASSUMED
// --------------------------------------------------------
// This Function WINS over the committed static tree. A `[[path]]` catch-all
// under functions/data/ claims /data/* outright, so every request goes to R2
// and the deployed copies of public/data/* are never reached.
//
// That is the opposite of what this comment used to claim, and the wrong belief
// was expensive: after the first successful upload the site had ALREADY cut over
// to R2 without anyone deciding to, so when a publish failed before writing the
// manifest there was no static copy to fall back to and the dashboard went down.
// Proof, in case anyone is tempted to assume again: CIK 0000807985 has never
// been committed to git, and /data/fund/0000807985/summary.json returns 200.
//
// Two consequences worth stating plainly:
//   - Deploying this Function IS the cutover. There is no separate switch.
//   - `public/data/*` in git is not a fallback. The single exception is
//     manifest.json, which is explicitly fallen back to below.
//
// SETUP (see DEPLOY.md): bind the bucket to the Pages project as `F13F_R2`
// (Pages → Settings → Functions → R2 bindings), and have the ingest workflow
// upload with scripts/publish-r2.mjs.

// ---------------------------------------------------------------------------
// EDGE CACHE
//
// Every request here was a Worker invocation plus an R2 origin GET, in every
// PoP, for every visitor — for files that are `immutable` and already keyed by
// ?b={buildId}. The measurement recorded in src/lib/data.ts is 740 ms for the
// manifest against 8 ms for each artifact behind it; that 90x gap is the
// un-cached origin fetch, not the payload, since the manifest is the smallest
// file in the tree.
//
// Responses produced by a Function are NOT put in the CDN cache automatically —
// `caches.default` has to be asked. So ask, with three exclusions that are
// correctness rather than tuning:
//
//   1. NEVER a 404. "No artifact" is the ANSWER to "did this manager file?",
//      and pinning that for a year would freeze a manager as non-filing across
//      a re-ingest that added them.
//   2. NEVER the static fallback. It is deliberately a degraded older build,
//      served only when R2 has lost the manifest; caching it would outlive the
//      emergency it exists for.
//   3. Only what R2 itself served, at the TTL its own Cache-Control declares —
//      a year for artifacts, sixty seconds for the manifest. Nothing here
//      invents a freshness policy; it honours the one already published.
//
// Every cache interaction is wrapped so that a miss, a throw, or a runtime with
// no Cache API lands on exactly the behaviour this file had before. The cache
// can only make it faster; it cannot make it wrong.
// ---------------------------------------------------------------------------
const edgeCache = () => {
  try {
    return caches?.default ?? null;
  } catch {
    return null;
  }
};

export async function onRequestGet({ params, env, request, next, waitUntil }) {
  // Binding absent (e.g. a preview deploy without the R2 binding). Since this
  // Function outranks the static tree, returning an error here would 501 every
  // artifact on a deploy that has perfectly good files sitting in it — so hand
  // the request back to the asset server instead.
  //
  // The comment here used to promise exactly this and the code returned 501
  // anyway, which is the same class of mistake as the precedence comment above:
  // a stated intention that nothing enforced.
  if (!env || !env.F13F_R2) {
    return next();
  }

  const key = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");
  if (!key || key.includes("..")) {
    return new Response("bad path", { status: 400 });
  }

  // Served from the edge if it is there. A hit skips the R2 round trip entirely
  // and never reaches the code below.
  const cache = edgeCache();
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) return hit;
    } catch { /* treat any cache failure as a miss */ }
  }

  const object = await env.F13F_R2.get(key);
  if (object === null) {
    // The manifest is the one file whose absence is FATAL rather than
    // informative: the dashboard fetches it before anything else and renders a
    // dead page without it. That state is not hypothetical — a publish that
    // uploaded 35,628 artifacts and then died before the manifest took the
    // production site down for a day.
    //
    // So for the manifest, and ONLY the manifest, fall back to the copy baked
    // into the deployed build. It describes an older, smaller coverage set, but
    // it carries its own `generatedAt` and coverage counts which the UI shows —
    // so the user sees an honestly-labelled older build instead of an error
    // card. The next successful publish supersedes it automatically.
    //
    // Deliberately NOT extended to artifact paths: there, 404 is the correct
    // and meaningful answer ("this manager has not filed that quarter"), and a
    // fallback could resurrect a fund-quarter that retention removed on purpose.
    if (key === "manifest.json" && env.ASSETS) {
      const fallback = await env.ASSETS.fetch(request);
      if (fallback.ok) {
        const headers = new Headers(fallback.headers);
        headers.set("cache-control", "public, max-age=60, must-revalidate");
        headers.set("x-13f-source", "static-fallback");
        return new Response(fallback.body, { status: 200, headers });
      }
    }

    // A missing artifact is a NORMAL state — most managers have not filed the
    // newest quarter. The frontend treats a 404 as "not filed", not an error.
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers); // content-type + cache-control set at upload
  headers.set("etag", object.httpEtag);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("cache-control")) {
    // Defensive default matching the artifact policy: the manifest is the only
    // mutable file, everything else is immutable and busted via ?b=.
    headers.set(
      "cache-control",
      key === "manifest.json" ? "public, max-age=60, must-revalidate" : "public, max-age=31536000, immutable",
    );
  }

  // Honour conditional requests so a returning visitor revalidates cheaply.
  // Not cached: a 304 carries no body, and storing one would poison the entry
  // for every visitor who did not send that etag.
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  const response = new Response(object.body, { headers });

  // Populate the edge for the next visitor, at the TTL this response already
  // declares. `clone()` before the body is streamed to the client, because a
  // body can only be read once — and off the response path via waitUntil, so a
  // slow cache write never delays the bytes the user is waiting for.
  if (cache) {
    try {
      const store = cache.put(request, response.clone()).catch(() => {});
      if (typeof waitUntil === "function") waitUntil(store);
    } catch { /* the response is already on its way; caching is best-effort */ }
  }

  return response;
}
