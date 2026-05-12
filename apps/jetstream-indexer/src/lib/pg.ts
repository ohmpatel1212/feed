// Postgres pool for the bsky database in Cloud SQL feed-db.
// Uses @google-cloud/cloud-sql-connector — same pattern as apps/web/src/lib/pg.ts.
// The DSN in Secret Manager (bsky-database-url) carries user/password/database;
// the connector handles the network tunnel via SQL Admin API.

import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector'
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { getSecret } from './secrets.js'

const INSTANCE_CONNECTION_NAME =
  process.env.CLOUDSQL_CONNECTION_NAME ?? 'timelines-492720:us-central1:feed-db'

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
    const database = u.pathname.replace(/^\//, '') || 'bsky'

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
      // feed-db is db-f1-micro with max_connections=50 total. Web app feed pool
      // takes 20, web app bsky pool takes 5, indexer leaves headroom for spikes.
      max: 15,
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
