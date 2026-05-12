// Per-consumer cursor persistence in Postgres (bsky.consumer_state).
// One row per consumer key. Read on boot, write on flush.

import { query } from './pg.js'

export type CursorState = {
  cursor_us: number
  host: string
  updated_at: Date
}

export const readCursor = async (consumer: string): Promise<CursorState | null> => {
  const res = await query<{ cursor_us: string; host: string; updated_at: Date }>(
    'SELECT cursor_us, host, updated_at FROM bsky.consumer_state WHERE consumer = $1',
    [consumer],
  )
  const row = res.rows[0]
  if (!row) return null
  return { cursor_us: Number(row.cursor_us), host: row.host, updated_at: row.updated_at }
}

export const writeCursor = async (
  consumer: string,
  cursor_us: number,
  host: string,
): Promise<void> => {
  await query(
    `INSERT INTO bsky.consumer_state (consumer, cursor_us, host)
     VALUES ($1, $2, $3)
     ON CONFLICT (consumer) DO UPDATE SET
       cursor_us  = GREATEST(bsky.consumer_state.cursor_us, EXCLUDED.cursor_us),
       host       = EXCLUDED.host,
       updated_at = now()`,
    [consumer, cursor_us, host],
  )
}
