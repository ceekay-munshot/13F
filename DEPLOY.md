# Deploying

Cloudflare Pages, Git-integrated. Free tier throughout.

## Pages project settings

| Setting | Value |
|---|---|
| Project name | `13f` |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | *(leave empty)* |

Environment variables → add one:

| Name | Value |
|---|---|
| `NODE_VERSION` | `20` |

`.node-version` also pins Node 20, but setting the variable explicitly is cheap
insurance: Pages occasionally defaults to an older Node, and `tsc -b` fails there.

## There is deliberately no `wrangler.toml`

It is checked in as `wrangler.toml.example` instead.

A Git-integrated Pages build reads `wrangler.toml` and validates it. Ours carried
`[observability]`, a **Workers-only** key that Pages does not recognise, so the
config was rejected and the build failed. With no successful deployment the
`*.pages.dev` hostname resolves but has nothing behind it, and Cloudflare answers
with **Error 522 Connection timed out** — which looks like an origin problem and is
really "there is no deployment".

It was also earning nothing: zero bindings were declared, and its only live keys
(`name`, `pages_build_output_dir`) duplicate the dashboard settings above. A file
that can only break the deploy and cannot help it does not belong in the build path.

Bring it back only when R2 or D1 bindings are actually needed, and then:

- `name` must equal the Pages project name exactly (`13f`)
- do **not** re-add `[observability]`
- paste real resource UUIDs — placeholders make Pages silently skip the file and
  freeze production on the last good build

## Why the site works the moment it deploys

The artifact tree is committed to the repo, and Vite copies `public/` into `dist/`:

```
dist/
├── _headers      cache + gzip rules
├── index.html
├── assets/       61 KB gz first paint; charts load on demand
└── data/         127 artifacts + manifest.json
```

`public/_headers` is load-bearing. It sets `Content-Encoding: gzip` on
`/data/*.json.gz`; without it the browser receives raw gzip bytes, tries to parse
them as JSON, and every widget fails.

The cron only *refreshes* that data — it is not required for a first deploy.

## Turning on the automated pipeline

Repository variable (Settings → Secrets and variables → Actions → Variables):

```bash
gh variable set SEC_USER_AGENT --body "Munshot 13F Pipeline ceekay@muns.io"
```

The workflow fails fast with an explanatory error if it is missing. The SEC rejects
undeclared automated access, and the header must be
`<App or Company Name> <contact email>`.

Trigger the first run manually:

```bash
gh workflow run ingest.yml
```

After that it runs on three daily slots. `keepalive.yml` must stay enabled —
GitHub disables scheduled workflows after 60 idle days, and 13F legitimately idles
for about ten weeks between filing seasons.

## Moving data to R2 (removes the 279 MB from git)

The artifacts are committed to git today, which works but grows history on every
refresh. R2 is the production home: 10 GB free, egress free, and a Pages Function
serves it on the **same `pages.dev` origin** so the frontend URL never changes.

Measured: all 9,396 filers × 4 quarters of holdings is ~900 MB / ~35,000 objects —
well inside the free tier (10 GB storage, 1M Class-A writes/month).

**One-time setup:**

1. **Create the bucket** — R2 → Create bucket → name it `13f`.
2. **Create an API token** — R2 → *Manage R2 API Tokens* → Create, *Object Read &
   Write*. Note the Access Key ID and Secret.
3. **Bind the bucket to Pages** — Pages project → Settings → Functions → R2 bucket
   bindings → add **`F13F_R2`** → bucket `13f`. (This is what the
   `functions/data/[[path]].js` passthrough reads; no `wrangler.toml` needed.)
4. **Add GitHub secrets** (Settings → Secrets and variables → Actions):
   - `R2_ACCOUNT_ID` = `489675fbe898cd94904c654de83ade00`
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` = from step 2
   - variable `R2_BUCKET` = `13f`
5. **Run the ingest** — `gh workflow run ingest-universe.yml`. It downloads the SEC
   data set, builds artifacts, and uploads to R2 (with `--prune`, so R2 stays at
   ~4 quarters).
6. **Flip the switch** — only after step 5 confirms R2 is populated:
   ```bash
   git rm -r --cached public/data && echo "public/data/" >> .gitignore
   git commit -m "chore: serve data from R2, drop committed tree"
   git push
   ```
   Until this commit lands, Pages serves the committed static files and the
   Function stays dormant (static assets take precedence). After it lands, the
   Function serves every `/data/*` request from R2. **Do not flip before R2 is
   populated** — the site would have nothing to serve.

**How it stays on one origin:** `functions/data/[[path]].js` is a pure passthrough
(`env.F13F_R2.get(key)` → stream). It is I/O only, so the 10 ms CPU budget is
irrelevant, and it means no custom domain and no CORS.

## Munshot embed

CORS-allowlist the deployed domain (`13f-eo2.pages.dev`, or the custom domain) on
the Munshot APIs, or the SDK session will not resolve inside the iframe. Until then
the dashboard renders fine from public SEC data and shows "No session" in the header.

## Troubleshooting

| Symptom | Cause |
|---|---|
| **522 Connection timed out** | No successful deployment. Check the build log; historically a rejected `wrangler.toml`. |
| Widgets show gzip parse errors | `dist/_headers` missing, so `Content-Encoding` is unset. |
| Every widget empty, "No session" | Expected outside the Munshot host. Not an error. |
| `tsc -b` fails in CI | Node too old — set `NODE_VERSION=20`. |
