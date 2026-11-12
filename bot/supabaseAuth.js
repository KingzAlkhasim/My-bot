import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'

export async function useSupabaseAuthState(db) {
  const read = async key => {
    const { data } = await db.from('wa_auth').select('value').eq('key', key).maybeSingle()
    return data ? JSON.parse(data.value, BufferJSON.reviver) : null
  }
  const write = (key, value) => db.from('wa_auth').upsert({ key, value: JSON.stringify(value, BufferJSON.replacer) })
  const del = key => db.from('wa_auth').delete().eq('key', key)
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