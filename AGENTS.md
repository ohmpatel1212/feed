<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Architecture

Ripple Feed is a Bluesky custom-feed curator. The user chats with a Claude agent about what they want to read; the resulting feed config is stored in Postgres. When the user views a feed, we query Vertex Vector Search for matching posts.

This is a **monorepo** with two services that deploy independently:

```
feed/
├── apps/
│   ├── web/                  ← Next.js app (curator + landing + API). On Cloud Run as feed-web.
│   └── jetstream-indexer/    ← Node worker. Consumes Bluesky Jetstream, embeds posts via Vertex
│                               Gemini, upserts into Vertex Vector Search. On Cloud Run as
│                               jetstream-indexer.
```

Each app is a self-contained pnpm project with its own `package.json` and `pnpm-lock.yaml`. There are no workspace packages — they share no code.

## Stack at a glance

| Concern | Choice |
|---|---|
| Web framework | Next.js 16 (App Router) on Node 22 — `pnpm dev` from `apps/web/` |
| Worker runtime | Node 22 + tsx — `pnpm start` from `apps/jetstream-indexer/` |
| Package manager | pnpm 11 (each app has its own lockfile) |
| Database | Cloud SQL Postgres 15 in GCP project `timelines-492720`, instance `feed-db` |
| Auth | Firebase Auth (Google sign-in). Token verified on the server in `apps/web/src/lib/auth.ts`. No user-managed admin SA key (org policy blocks creation), so prod uses insecure-decode fallback for the demo. |
| Chat LLM | Anthropic Claude (`claude-sonnet-4`) via `@anthropic-ai/sdk` — `/api/chat`, `/api/import-memory` |
| Post search | Vertex AI Vector Search — called directly from `apps/web/src/lib/vector-search.ts` |
| Hosting | Both services on Cloud Run in `timelines-492720` |

## Tables

- `users` — Firebase UID → internal Postgres UUID
- `feeds` — per-user feed configs (`name`, `mechanical_filters`, `semantic_config`, `description`)
- `chat_messages` — per-feed chat transcripts
- `subscribers` — landing-page mailing list
- `published_rkey` column on `feeds` is unused (publish flow is on hold)

# Vector search

Both services talk to the **same** Vertex Vector Search index in `timelines-492720` / `us-central1`:

- **Read side** (`apps/web/src/lib/vector-search.ts`): embeds the user query with Gemini (`gemini-embedding-001`, 768d, `RETRIEVAL_QUERY`), then `MatchServiceClient.findNeighbors` with `returnFullDatapoint: true`. Post text + metadata are stored as Vertex datapoint **restricts** so a single round-trip hydrates the result without a separate KV lookup.
- **Write side** (`apps/jetstream-indexer/`): consumes Bluesky Jetstream, embeds with `RETRIEVAL_DOCUMENT` task type, calls `IndexServiceClient.upsertDatapoints`. Maintains a cursor in `gs://happy-feed-data-timelines/state/jetstream-cursor.json` so it resumes after restarts. Also archives raw posts + embeddings as parquet under `gs://happy-feed-data-timelines/{posts,embeddings}/`.

Both processes run as the default compute SA `777152549518-compute@developer.gserviceaccount.com`, which has `roles/aiplatform.user` on `timelines-492720`.

## Vertex env vars

| Var | Default | Notes |
|---|---|---|
| `VERTEX_PROJECT` | `timelines-492720` | |
| `VERTEX_LOCATION` | `us-central1` | |
| `VERTEX_INDEX_ID` | `2186420653274431488` | (worker only — needed for upsert) |
| `VERTEX_INDEX_ENDPOINT_ID` | `5941683870687559680` | |
| `VERTEX_INDEX_ENDPOINT_HOST` | `1238902659.us-central1-777152549518.vdb.vertexai.goog` | The match-service public endpoint |
| `VERTEX_DEPLOYED_INDEX_ID` | `happy_feed_v2` | |
| `GCS_BUCKET` | `happy-feed-data-timelines` | (worker only — parquet + cursor) |

These are **public resource IDs**, not secrets — plain env vars, not Secret Manager.

## Local dev

Auth via your local ADC: `gcloud auth application-default login`. Smoke test for the reader:

```bash
cd apps/web
pnpm exec tsx -e "import { searchPosts } from './src/lib/vector-search'; (async () => console.log(await searchPosts({ query: 'climate', k: 3 })))()"
```

Should return ~3 hits in 1–2 seconds. If it 403s, set `GOOGLE_CLOUD_QUOTA_PROJECT=timelines-492720`.

Worker locally:

```bash
cd apps/jetstream-indexer
pnpm start    # writes to gs://happy-feed-data-timelines and the prod Vertex index
```

# Jetstream indexer

`apps/jetstream-indexer/src/worker.ts` is a long-lived process that:

1. Subscribes to Bluesky Jetstream (`jetstream2.us-west.bsky.network`) for `app.bsky.feed.post` create events
2. Extracts post text + metadata, embeds each batch via Vertex Gemini
3. Upserts datapoints into Vertex (`STREAM_UPDATE` index) with restricts: `id`, `uri`, `text`, `did`, `lang`, `domain`, `has_images`, `has_video`, `has_quote`, `has_external_link`, plus numeric `created_at_us`
4. Archives raw posts + embeddings as parquet to GCS (partitioned by date)
5. Checkpoints the Jetstream cursor to GCS after each flush so restarts don't replay

Cloud Run config: `--no-cpu-throttling`, `--min-instances=1 --max-instances=1 --concurrency=1`, `--memory=1Gi`. Concurrency=1 prevents races on the cursor file.

Deploy:

```bash
cd apps/jetstream-indexer
gcloud builds submit --config=cloudbuild.yaml --project=timelines-492720 .
gcloud run deploy jetstream-indexer \
  --image=us-central1-docker.pkg.dev/timelines-492720/jetstream-indexer/worker:latest \
  --region=us-central1 --project=timelines-492720 \
  --no-cpu-throttling --min-instances=1 --max-instances=1 --concurrency=1 \
  --memory=1Gi \
  --service-account=777152549518-compute@developer.gserviceaccount.com
```

(Env vars are baked into the image's defaults via `src/config.ts`; override at deploy time with `--update-env-vars` if needed.)

Logs:

```bash
gcloud logging read 'resource.labels.service_name="jetstream-indexer"' --project=timelines-492720 --limit=20
```

Provisioning new Vertex resources from scratch lives in `apps/jetstream-indexer/scripts/setup-vertex.sh`. The Cloud Monitoring dashboard JSON is at `apps/jetstream-indexer/monitoring/dashboard.json` (import via `gcloud monitoring dashboards create --config-from-file=...`).

## What this repo does NOT do anymore

- **No OpenAI.** Embeddings come from Vertex Gemini; the chat is pure Claude.
- **No happy-feed external repo.** The worker source moved into `apps/jetstream-indexer/` (was `/Users/amir/code/happy-feed`).
- **No publish-to-Bluesky.** The `/api/publish-feed` route, the xrpc endpoints, and `/.well-known/did.json` are gone. The `published_rkey` column on `feeds` is left in place for future revival but is unused.
- **No synthetic onboarding card bank.** Removed along with `OnboardingFlow`/`TapCards`/`TasteReveal`/`ReversePrompting` and the `onboarding_cards` table. Onboarding is now plain chat with the Claude agent.

# Conventions

- All API routes under `apps/web/src/app/api/*` use `requireAuth(req)` from `apps/web/src/lib/auth.ts`.
- The curator UI loads sidebar feeds from Postgres (`/api/feeds`), filtered to feeds with non-empty topics/keywords. Postgres is the source of truth — there is no client-side cache (no localStorage, no Firestore).
- Feed switching in the curator is non-blocking: clicking a feed clears the panels synchronously and fires chat + posts fetches in parallel. There is no auto-polling — the user clicks **Refresh** to re-query.

# Secrets

Two real secrets live in **Google Secret Manager** in `timelines-492720`:

| Secret | What |
|---|---|
| `database-url` | Full Cloud SQL connection string (includes the postgres password) |
| `anthropic-api-key` | Anthropic Claude API key |

**The code fetches them at runtime** — see `apps/web/src/lib/secrets.ts`. There are no `--set-secrets` mounts on Cloud Run and no plaintext copies in `.env.local`. The pattern:

```ts
// pg.ts (lazy pool init)
const pool = await getPool();   // fetches DATABASE_URL from SM on first call
// chat/route.ts (lazy Anthropic client)
const c = await client();       // fetches ANTHROPIC_API_KEY from SM on first call
```

`getSecret(name)` checks `process.env` first (UPPER_SNAKE_CASE of the secret name) and falls back to Secret Manager. Override locally with an env var if needed.

**Auth**: locally, `gcloud auth application-default login` once. On Cloud Run, the runtime SA `777152549518-compute@developer.gserviceaccount.com` has `roles/secretmanager.secretAccessor` on each secret.

**Rotate**: `echo -n "<new>" | gcloud secrets versions add <name> --project=timelines-492720 --data-file=-`. The cache is per-process — restart Cloud Run revisions to pick up new versions.

# External resources

| What | Where |
|---|---|
| Cloud SQL `feed-db` | `gcloud sql instances describe feed-db --project=timelines-492720` |
| Firebase project | `timelines-492720` (display name "timelines"). Authorized domains list managed via Identity Toolkit Admin API. |
| Secret Manager | `gcloud secrets list --project=timelines-492720` |
| Vertex index + endpoint | project `timelines-492720`, region `us-central1`, index `2186420653274431488`, endpoint `5941683870687559680` |
| GCS data bucket | `gs://happy-feed-data-timelines` (parquet posts/embeddings + Jetstream cursor) |
| Artifact Registry (worker) | `us-central1-docker.pkg.dev/timelines-492720/jetstream-indexer/worker` |
