// Composes the text we send to the Gemini embedding model.
// Per the plan: post text + image alt + external link card title/description.
// Quote post text is skipped (would require a second hop to resolve).

import type { PostRecord } from './jetstream-extract.js'

const MAX_BYTES = 9000

const truncateUtf8 = (s: string): string => {
  const buf = Buffer.from(s, 'utf8')
  if (buf.byteLength <= MAX_BYTES) return s
  return new TextDecoder('utf-8').decode(buf.subarray(0, MAX_BYTES))
}

export const composeEmbedInput = (p: Pick<PostRecord,
  'text' | 'image_alts' | 'video_alt' | 'external_title' | 'external_desc'
>): string => {
  const parts: string[] = []
  if (p.text) parts.push(p.text)

  const alts = p.image_alts.filter((s) => s.length > 0).join(' — ')
  if (alts) parts.push(`Images: ${alts}`)

  if (p.video_alt) parts.push(`Video: ${p.video_alt}`)

  const card = [p.external_title, p.external_desc].filter((s): s is string => !!s).join(' — ')
  if (card) parts.push(`Link: ${card}`)

  return truncateUtf8(parts.join('\n\n'))
}
