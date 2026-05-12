// Runs SQL migrations from ../../sql/*.sql in lexical order at boot.
// Tracks applied files in bsky._migrations to make reruns no-ops.

import { readdir, readFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { withClient } from './pg.js'

const here = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = resolve(here, '../../sql')

const BOOTSTRAP = `
  CREATE SCHEMA IF NOT EXISTS bsky;
  CREATE TABLE IF NOT EXISTS bsky._migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`

export const runMigrations = async (): Promise<void> => {
  const files = (await readdir(SQL_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    console.log('[migrator] no .sql files in', SQL_DIR)
    return
  }

  await withClient(async (c) => {
    await c.query(BOOTSTRAP)
    const applied = new Set(
      (await c.query<{ filename: string }>('SELECT filename FROM bsky._migrations')).rows.map(
        (r) => r.filename,
      ),
    )
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(resolve(SQL_DIR, file), 'utf8')
      console.log(`[migrator] applying ${file}`)
      await c.query('BEGIN')
      try {
        await c.query(sql)
        await c.query('INSERT INTO bsky._migrations (filename) VALUES ($1)', [file])
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${String(err)}`)
      }
    }
  })
  console.log('[migrator] done')
}
