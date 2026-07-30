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
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
}
