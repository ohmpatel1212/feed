// Author + handle persistence.
// - profileConsumer: upsert into bsky.authors on app.bsky.actor.profile create/update.
// - identity events: upsert handle into bsky.authors, append to handles_history if changed.

import { withClient } from '../pg.js'
import type { IdentityRecord, ProfileRecord } from '../jetstream-extract.js'

export const upsertProfiles = async (rows: ProfileRecord[]): Promise<void> => {
  if (rows.length === 0) return
  await withClient(async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO bsky.authors (did, display_name, description, avatar_cid, banner_cid, profile_rev, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (did) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description  = EXCLUDED.description,
           avatar_cid   = EXCLUDED.avatar_cid,
           banner_cid   = EXCLUDED.banner_cid,
           profile_rev  = EXCLUDED.profile_rev,
           updated_at   = now()`,
        [r.did, r.display_name, r.description, r.avatar_cid, r.banner_cid, r.profile_rev],
      )
    }
  })
}

export const applyIdentityEvents = async (rows: IdentityRecord[]): Promise<void> => {
  if (rows.length === 0) return
  await withClient(async (c) => {
    for (const r of rows) {
      if (!r.handle) continue
      const prev = await c.query<{ handle: string | null }>(
        'SELECT handle FROM bsky.authors WHERE did = $1',
        [r.did],
      )
      const existing = prev.rows[0]?.handle ?? null
      if (existing === r.handle) continue

      await c.query(
        `INSERT INTO bsky.authors (did, handle, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (did) DO UPDATE SET handle = EXCLUDED.handle, updated_at = now()`,
        [r.did, r.handle],
      )
      await c.query(
        `INSERT INTO bsky.handles_history (did, handle)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [r.did, r.handle],
      )
    }
  })
}
