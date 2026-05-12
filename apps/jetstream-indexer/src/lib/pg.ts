// Postgres pool for the bsky database in Cloud SQL feed-db.
// Uses @google-cloud/cloud-sql-connector — same pattern as apps/web/src/lib/pg.ts.
// The DSN in Secret Manager (bsky-database-url) carries user/password/database;
// the connector handles the network tunnel via SQL Admin API.

import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector'
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { getSecret } from './secrets.js'

// Dedicated instance for the indexer — separate from the web app's feed-db so
// firehose-rate writes don't contend with curator queries.
const INSTANCE_CONNECTION_NAME =
  process.env.BSKY_CLOUDSQL_CONNECTION_NAME ?? 'timelines-492720:us-central1:bsky-db'

const SECRET_NAME = process.env.BSKY_DATABASE_SECRET ?? 'bsky-database-url'

let _pool: Pool | null = null
let _poolInit: Promise<Pool> | null = null
let _connector: Connector | null = null

export const getPool = async (): Promise<Pool> => {
  if (_pool) return _pool
  if (_poolInit) return _poolInit
  const init = (async () => {
    const dsn = await getSecret(SECRET_NAME)
    const u = new URL(dsn)
    const user = decodeURIComponent(u.username)
    const password = decodeURIComponent(u.password)
    const database = u.pathname.replace(/^\//, '') || 'bsky_posts'

    _connector = new Connector()
    const clientOpts = await _connector.getOptions({
      instanceConnectionName: INSTANCE_CONNECTION_NAME,
      ipType: IpAddressTypes.PUBLIC,
    })

    const pool = new Pool({
      ...clientOpts,
      user,
      password,
      database,
      // bsky-db is db-custom-1-3840 (dedicated CPU, ~200 max_connections).
      // Indexer owns the instance — no need to share with the web app.
      max: 30,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
    pool.on('error', (err) => {
      console.error('[pg] pool error:', err.message)
    })
    _pool = pool
    return pool
  })()
  _poolInit = init
  init.catch((err) => {
    console.error('[pg] pool init failed:', err?.code, err?.message ?? err)
    if (_poolInit === init) _poolInit = null
  })
  return init
}

export const query = async <R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<R>> => {
  const pool = await getPool()
  return pool.query<R>(text, params)
}

export const withClient = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const pool = await getPool()
  const c = await pool.connect()
  try {
    return await fn(c)
  } finally {
    c.release()
  }
}

export const closePool = async (): Promise<void> => {
  if (_pool) {
    await _pool.end()
    _pool = null
    _poolInit = null
  }
  if (_connector) {
    _connector.close()
    _connector = null
  }
}
