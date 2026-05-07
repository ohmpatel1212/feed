# Ripple Feed

A Bluesky custom-feed curator. Talk to a Claude agent about what you want to read; the resulting feed config is stored in Postgres and used to query a separate vector-search service for matching posts.

This repo is the web app (Next.js 16 + React 19). Architecture details live in `AGENTS.md`.

## Setup

```bash
npm install
gcloud auth application-default login
```

That's it — there is no `.env.local`. The two real secrets (`DATABASE_URL`, `ANTHROPIC_API_KEY`) are fetched at runtime from Google Secret Manager in project `timelines-492720` (see `src/lib/secrets.ts`). The Vertex Vector Search resource IDs are hardcoded in `src/lib/vector-search.ts`.

You need access to `timelines-492720`:
- `roles/secretmanager.secretAccessor` on `database-url` and `anthropic-api-key`
- `roles/aiplatform.user` on `amir-experimental` (for the vector index)

If you'd rather not use Secret Manager, set `DATABASE_URL` and/or `ANTHROPIC_API_KEY` as plain env vars — `getSecret()` checks `process.env` first.

Apply the schema once:

```bash
npx tsx scripts/setup-postgres.ts
```

## Run

```bash
npm run dev
```

Open <http://localhost:3000>. Sign in with Google, click **Try demo (feed curation)**, chat with the agent.

## Where posts come from

This repo doesn't ingest Bluesky's firehose. The vector index is maintained by [`happy-feed`](file:///Users/amir/code/happy-feed)'s Jetstream worker (running in `amir-experimental`). We call Vertex AI Vector Search directly from `src/lib/vector-search.ts` — no local happy-feed server needed.

See `AGENTS.md` for the full architecture and the list of things this repo intentionally does **not** do.
