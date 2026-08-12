import { join } from 'node:path'
import { obj, optional, str } from '../decode'
import { readSnapshot } from '../snapshot'

// /export/site.json — the box's identity. The client-visible half already
// arrives as VITE_ env (src/lib/site.ts); this reader is for the server-only
// facts a page renders, of which mail is currently the only consumer.

export type MailIdentity = { sender: string; alertTo: string }

const shape = obj({
  mail: optional(obj({ sender: optional(str, ''), alertTo: optional(str, '') }), {
    sender: '',
    alertTo: '',
  }),
})

/** The one mail identity every sender on the box uses. Null = export missing. */
export async function siteMail(): Promise<MailIdentity | null> {
  const r = await readSnapshot({
    path: join(process.env.EXPORT_DIR ?? '/export', 'site.json'),
    decoder: shape,
    fallback: { mail: { sender: '', alertTo: '' } },
    acceptVersions: [1],
  })
  if (!r.available || r.data.mail.sender === '') return null
  return r.data.mail
}
