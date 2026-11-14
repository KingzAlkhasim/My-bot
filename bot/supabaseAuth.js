import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'

export async function useSupabaseAuthState(db) {
  // Fail loudly if the table is missing / key is wrong, otherwise the login is never saved and pairing loops forever.
  const probe = await db.from('wa_auth').select('key').limit(1)
  if (probe.error) {
    const msg = 'wa_auth table problem: ' + probe.error.message
    console.error(msg); globalThis.pairCode = 'error: ' + msg.slice(0, 100)
    throw new Error(msg)
  }
  const read = async key => {
    const { data, error } = await db.from('wa_auth').select('value').eq('key', key).maybeSingle()
    if (error) console.error('wa_auth read error:', error.message)
    return data ? JSON.parse(data.value, BufferJSON.reviver) : null
  }
  const write = async (key, value) => {
    const { error } = await db.from('wa_auth').upsert({ key, value: JSON.stringify(value, BufferJSON.replacer) })
    if (error) console.error('wa_auth write error:', error.message)
  }
  const del = async key => { const { error } = await db.from('wa_auth').delete().eq('key', key); if (error) console.error('wa_auth delete error:', error.message) }
  const creds = (await read('creds')) || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {}
          await Promise.all(ids.map(async id => {
            let v = await read(`${type}-${id}`)
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v)
            out[id] = v
          }))
          return out
        },
        set: async data => {
          const jobs = []
          for (const type in data) for (const id in data[type]) {
            const v = data[type][id], key = `${type}-${id}`
            jobs.push(v ? write(key, v) : del(key))
          }
          await Promise.all(jobs)
        }
      }
    },
    saveCreds: () => write('creds', creds)
  }
}