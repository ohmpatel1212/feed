// Fetch named secrets from Google Secret Manager.
// process.env[UPPER_SNAKE] wins over Secret Manager so local dev can override.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

const PROJECT = process.env.GCP_SECRETS_PROJECT ?? 'timelines-492720'

const cache = new Map<string, string>()
let _client: SecretManagerServiceClient | null = null

const client = (): SecretManagerServiceClient => {
  if (!_client) _client = new SecretManagerServiceClient()
  return _client
}

const envFor = (name: string): string => name.toUpperCase().replace(/-/g, '_')

export const getSecret = async (name: string): Promise<string> => {
  const envName = envFor(name)
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv

  const cached = cache.get(name)
  if (cached) return cached

  const [version] = await client().accessSecretVersion({
    name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
  })
  const value = version.payload?.data?.toString()
  if (!value) throw new Error(`Secret ${name} returned an empty payload`)
  cache.set(name, value)
  return value
}
