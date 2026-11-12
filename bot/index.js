import 'dotenv/config'
import pino from 'pino'
import { useSupabaseAuthState } from './supabaseAuth.js'
import qrcode from 'qrcode-terminal'
import { createClient } from '@supabase/supabase-js'
import makeWASocket, { downloadMediaMessage, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const OWNER = process.env.OWNER_NUMBER
let sock, settings = {}, groups = new Map()
const spam = new Map(), replied = new Map(), adminCache = new Map()
const num = j => (j || '').split('@')[0].split(':')[0]
const list = s => (s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const textOf = m => m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || ''

async function event(type, group_jid, detail) {
  await db.from('events').insert({ type, group_jid, detail }).then(() => {}, () => {})
  if (OWNER && ['removed', 'error'].includes(type)) sock?.sendMessage(OWNER + '@s.whatsapp.net', { text: `[${type}] ${detail}` }).catch(() => {})
}
const setState = state => db.from('status').update({ state, updated_at: new Date() }).eq('id', 1).then(() => {}, () => {})

async function refresh() {
  const s = await db.from('settings').select('*').eq('id', 1).single()
  if (s.data) settings = s.data
  const g = await db.from('groups').select('*')
  if (g.data) groups = new Map(g.data.map(x => [x.id, x]))
}

async function syncGroups() {
  const all = await sock.groupFetchAllParticipating()
  const me = num(sock.user.id)
  const rows = Object.values(all).map(g => ({
    id: g.id, name: g.subject,
    bot_is_admin: g.participants.some(p => num(p.id) === me && p.admin)
  }))
  if (rows.length) await db.from('groups').upsert(rows, { onConflict: 'id' })
  await refresh()
}

async function admins(jid) {
  const c = adminCache.get(jid)
  if (c && Date.now() - c.t < 300000) return c.set
  const m = await sock.groupMetadata(jid)
  const set = new Set(m.participants.filter(p => p.admin).map(p => num(p.id)))
  adminCache.set(jid, { t: Date.now(), set })
  return set
}

async function warn(jid, who, reason, g) {
  const user = num(who)
  const { data } = await db.from('warns').select('count').eq('group_jid', jid).eq('user_jid', user).maybeSingle()
  const count = (data?.count || 0) + 1
  if (count >= g.warn_limit) {
    await sock.groupParticipantsUpdate(jid, [who], 'remove')
    await db.from('warns').delete().eq('group_jid', jid).eq('user_jid', user)
    await event('removed', jid, `${user} removed from ${g.name} (${reason})`)
  } else {
    await db.from('warns').upsert({ group_jid: jid, user_jid: user, count })
    await sock.sendMessage(jid, { text: `@${user} warning ${count}/${g.warn_limit}: ${reason}`, mentions: [who] })
    await event('warn', jid, `${user} warned in ${g.name} (${reason}) ${count}/${g.warn_limit}`)
  }
}

async function handleGroup(m, g) {
  const jid = m.key.remoteJid, who = m.key.participant, text = textOf(m)
  if (!who) return
  db.from('messages').insert({ group_jid: jid, sender: num(who), text: text.slice(0, 500) }).then(() => {}, () => {})
  const hit = list(g.keywords).find(k => text.toLowerCase().includes(k))
  if (hit) await event('keyword', jid, `"${hit}" said by ${num(who)} in ${g.name}`)
  if (!g.bot_is_admin) return
  if ((await admins(jid)).has(num(who))) return
  if (g.anti_link && /(https?:\/\/|chat\.whatsapp\.com|www\.)/i.test(text)) {
    await sock.sendMessage(jid, { delete: m.key })
    return warn(jid, who, 'links are not allowed', g)
  }
  const k = jid + who, now = Date.now()
  const arr = (spam.get(k) || []).filter(t => now - t < 10000); arr.push(now); spam.set(k, arr)
  if (arr.length > g.spam_limit) { spam.set(k, []); return warn(jid, who, 'spamming', g) }
}

async function aiReply(parts) {
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
    const intro = `You reply on behalf of the owner, who is away. Style: ${settings.ai_style || 'friendly, short'}. Be brief, say they will get back soon, never promise anything or share private info. Reply in the same language the contact used. If they sent a voice note or an image, respond to what is in it.`
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: intro }, ...parts] }] }) })
    return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  } catch { return null }
}

async function mediaParts(m) {
  const msg = m.message
  const media = msg.audioMessage || msg.imageMessage
  if (!media) return []
  const size = media.fileLength?.toNumber?.() ?? Number(media.fileLength || 0)
  if (size > 15e6) return []
  const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
  const mime = (media.mimetype || (msg.audioMessage ? 'audio/ogg' : 'image/jpeg')).split(';')[0]
  return [{ inline_data: { mime_type: mime, data: buf.toString('base64') } }]
}

async function handleDM(m) {
  if (!settings.away_mode) return
  const jid = m.key.remoteJid, n = num(jid)
  if (list(settings.blacklist).includes(n)) return
  const only = list(settings.allow_only)
  if (only.length && !only.includes(n)) return
  if (Date.now() - (replied.get(jid) || 0) < 6 * 3600e3) return // one reply per contact per 6h
  replied.set(jid, Date.now())
  let reply = settings.away_message
  if (settings.use_ai && process.env.GEMINI_API_KEY) {
    const parts = []
    if (textOf(m)) parts.push({ text: 'Message from the contact: ' + textOf(m) })
    try { parts.push(...(await mediaParts(m))) } catch (e) { event('error', null, 'Media download failed: ' + String(e).slice(0, 150)) }
    if (parts.length) reply = (await aiReply(parts)) || reply
  }
  await sock.presenceSubscribe(jid)
  await sock.sendPresenceUpdate('composing', jid)
  await sleep(2000 + Math.random() * 3000)
  await sock.sendMessage(jid, { text: reply })
  await event('auto_reply', null, `Auto-replied to ${n}`)
}

async function start() {
  const { state, saveCreds } = process.env.AUTH_STORE === 'supabase' ? await useSupabaseAuthState(db) : await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false })
  sock.ev.on('creds.update', saveCreds)

  // Link with a pairing code (no QR needed): set PAIR_NUMBER, then read the code from /health
  if (!sock.authState.creds.registered && process.env.PAIR_NUMBER) {
    const ask = async () => {
      if (sock.authState.creds.registered) return clearInterval(globalThis.pairTimer)
      try {
        const code = await sock.requestPairingCode(process.env.PAIR_NUMBER.replace(/\D/g, ''))
        globalThis.pairCode = code
        await setState('pair_code:' + code)
      } catch (e) { globalThis.pairCode = 'error: ' + String(e).slice(0, 100) }
    }
    clearInterval(globalThis.pairTimer)
    setTimeout(ask, 3000)
    globalThis.pairTimer = setInterval(ask, 90000)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !process.env.PAIR_NUMBER) { console.log('Scan this QR with WhatsApp > Linked devices:'); qrcode.generate(qr, { small: true }); setState('waiting_qr') }
    if (connection === 'open') { console.log('Connected'); globalThis.pairCode = null; clearInterval(globalThis.pairTimer); setState('connected'); await syncGroups().catch(e => event('error', null, String(e))) }
    if (connection === 'close') {
      setState('offline')
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(start, 3000)
      else {
        console.log('Logged out. Clearing saved login, restart to scan a new QR.')
        if (process.env.AUTH_STORE === 'supabase') await db.from('wa_auth').delete().neq('key', '')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      if (m.key.fromMe || !m.message) continue
      try {
        const jid = m.key.remoteJid
        if (jid.endsWith('@g.us')) { const g = groups.get(jid); if (g?.managed) await handleGroup(m, g) }
        else if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) await handleDM(m)
      } catch (e) { event('error', null, String(e).slice(0, 300)) }
    }
  })

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    const g = groups.get(id)
    if (!g?.managed || action !== 'add' || !g.welcome) return
    for (const p of participants) {
      const pid = typeof p === 'string' ? p : p.id
      await sock.sendMessage(id, { text: g.welcome.replace('{name}', '@' + num(pid)), mentions: [pid] }).catch(() => {})
    }
  })
}

async function gemini(prompt) {
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) })
    return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  } catch { return null }
}

async function runScheduled() {
  if (!sock?.user) return
  const { data } = await db.from('scheduled').select('*').eq('status', 'pending').lte('send_at', new Date().toISOString()).limit(10)
  for (const s of data || []) {
    try {
      const jid = s.target.includes('@') ? s.target : s.target.replace(/\D/g, '') + '@s.whatsapp.net'
      await sleep(1500 + Math.random() * 2500)
      await sock.sendMessage(jid, { text: s.text })
      const days = s.repeat === 'daily' ? 1 : s.repeat === 'weekly' ? 7 : 0
      if (days) {
        let t = new Date(s.send_at).getTime()
        while (t <= Date.now()) t += days * 864e5
        await db.from('scheduled').update({ send_at: new Date(t).toISOString() }).eq('id', s.id)
      } else await db.from('scheduled').update({ status: 'sent' }).eq('id', s.id)
      await event('scheduled', null, `Sent scheduled message to ${s.target_name || s.target}`)
    } catch (e) {
      await db.from('scheduled').update({ status: 'failed' }).eq('id', s.id)
      await event('error', null, 'Scheduled send failed: ' + String(e).slice(0, 200))
    }
  }
}

async function runSummaries() {
  const { data } = await db.from('summary_jobs').select('*').eq('status', 'pending').limit(3)
  for (const j of data || []) {
    const since = new Date(Date.now() - (j.hours || 24) * 3600e3).toISOString()
    const { data: ms } = await db.from('messages').select('sender,text').eq('group_jid', j.group_jid).gte('created_at', since).order('created_at').limit(400)
    const convo = (ms || []).filter(m => m.text).map(m => `${m.sender.slice(-4)}: ${m.text}`).join('\n')
    let result = 'No messages in that period.'
    if (convo) result = await gemini(`Summarize this WhatsApp group chat in short bullet points: key topics, decisions, open questions, anything important. Senders are the last 4 digits of their numbers.\n\n${convo.slice(-12000)}`)
    await db.from('summary_jobs').update({ status: result ? 'done' : 'failed', result: result || 'Summary failed. Check GEMINI_API_KEY on the bot.' }).eq('id', j.id)
  }
}

const prune = () => db.from('messages').delete().lt('created_at', new Date(Date.now() - 7 * 864e5).toISOString()).then(() => {}, () => {})

await refresh()
setInterval(() => refresh().catch(() => {}), 15000) // picks up dashboard changes
setInterval(() => syncGroups().catch(() => {}), 600000)
setInterval(() => runScheduled().catch(() => {}), 30000)
setInterval(() => runSummaries().catch(() => {}), 15000)
setInterval(prune, 3600e3)
start()