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
// PRECEDENCE, and why adding this is safe before R2 is populated
// -------------------------------------------------------------
// Cloudflare Pages serves a matching STATIC asset before running a Function. So
// while `public/data/*` is still committed, those files are served statically
// and this Function never runs. It only takes over once the committed tree is
// removed from git AND the R2 bucket is populated. Shipping it early is inert
// and lets the switch be a one-line change later.
//
// SETUP (see DEPLOY.md): bind the bucket to the Pages project as `F13F_R2`
// (Pages → Settings → Functions → R2 bindings), and have the ingest workflow
// upload with scripts/publish-r2.mjs.

export async function onRequestGet({ params, env, request }) {
  // Binding absent (e.g. before setup): fall through so a committed static file,
  // if any, can still answer. A hard error here would take down a working site.
  if (!env || !env.F13F_R2) {
    return new Response("R2 binding F13F_R2 not configured", { status: 501 });
  }

  const key = Array.isArray(params.path) ? params.path.join("/") : String(params.path ?? "");
  if (!key || key.includes("..")) {
    return new Response("bad path", { status: 400 });
  }

  const object = await env.F13F_R2.get(key);
  if (object === null) {
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
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
}
