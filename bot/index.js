import 'dotenv/config'
import pino from 'pino'
import { useSupabaseAuthState } from './supabaseAuth.js'
import qrcode from 'qrcode-terminal'
import { createClient } from '@supabase/supabase-js'
import makeWASocket, { downloadMediaMessage, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys'

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

// WhatsApp now uses two kinds of ids (phone number and "lid"). Compare against every id we know.
const idsOf = p => [p.id, p.phoneNumber, p.lid, p.jid].filter(Boolean).map(num)
const myIds = () => [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid].filter(Boolean).map(num)

async function syncGroups() {
  const all = await sock.groupFetchAllParticipating()
  const mine = myIds()
  const rows = Object.values(all).map(g => ({
    id: g.id, name: g.subject,
    bot_is_admin: g.participants.some(p => p.admin && idsOf(p).some(i => mine.includes(i)))
  }))
  console.log(`Group sync: ${rows.length} groups, bot is admin in ${rows.filter(r => r.bot_is_admin).length} (my ids: ${mine.join(', ')})`)
  if (rows.length) await db.from('groups').upsert(rows, { onConflict: 'id' })
  await refresh()
}
let syncTimer, lastSync = 0
// Never sync more than once a minute: a sync itself fires group events, which used to trigger another sync (loop).
const syncSoon = () => {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    if (Date.now() - lastSync < 60000) return
    lastSync = Date.now(); syncGroups().catch(() => {})
  }, 3000)
}

async function admins(jid) {
  const c = adminCache.get(jid)
  if (c && Date.now() - c.t < 300000) return c.set
  const m = await sock.groupMetadata(jid)
  const set = new Set(m.participants.filter(p => p.admin).flatMap(idsOf))
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

const history = new Map() // jid -> [{ role, parts, t }], conversation memory per contact
const HISTORY_TURNS = 14, HISTORY_TTL = 24 * 3600e3
const MAX_AI_PER_HOUR = +process.env.AI_MAX_PER_HOUR || 15, MAX_AI_PER_DAY = +process.env.AI_MAX_PER_DAY || 40 // per contact
const aiCount = new Map()

async function aiReply(parts, jid, voice = false) {
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
    const base = (settings.system_prompt || '').trim() || process.env.AI_PERSONA ||
      `You chat on behalf of the owner. Keep replies brief and natural, continue the conversation using the earlier messages, ask a clarifying question when needed, never promise anything you cannot do and never share private info. If you cannot help, say the owner will follow up personally. Reply in the same language the contact used. If they sent a voice note or an image, respond to what is in it.`
    const intro = base + (settings.ai_style ? `\nStyle: ${settings.ai_style}.` : '') +
      (voice ? '\nYour reply will be spoken aloud: keep it under 3 short sentences, plain spoken words, no emojis, no markdown, no lists.' : '')
    const past = (history.get(jid) || []).filter(h => Date.now() - h.t < HISTORY_TTL).slice(-HISTORY_TURNS)
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: intro }] },
        contents: [...past.map(({ role, parts }) => ({ role, parts })), { role: 'user', parts }]
      }) })
    return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  } catch { return null }
}

function remember(jid, userText, botText) {
  const h = (history.get(jid) || []).filter(x => Date.now() - x.t < HISTORY_TTL)
  const t = Date.now()
  h.push({ role: 'user', parts: [{ text: userText }], t }, { role: 'model', parts: [{ text: botText }], t })
  history.set(jid, h.slice(-HISTORY_TURNS))
}

async function mediaParts(m) {
  const msg = m.message
  const media = msg.audioMessage || msg.imageMessage
  if (!media) return []
  const size = media.fileLength?.toNumber?.() ?? Number(media.fileLength || 0)
  if (size > 15e6) return []
  const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: process.env.LOG_LEVEL || 'warn' }), reuploadRequest: sock.updateMediaMessage })
  const mime = (media.mimetype || (msg.audioMessage ? 'audio/ogg' : 'image/jpeg')).split(';')[0]
  return [{ inline_data: { mime_type: mime, data: buf.toString('base64') } }]
}

globalThis.botInfo = { state: 'starting', lastClose: null, lastMsgAt: null, lastMsgType: null, lastSkip: null, lastReplyAt: null }
const skip = why => { globalThis.botInfo.lastSkip = why + ' @ ' + new Date().toISOString(); console.log('skip:', why) }

// ---------- ElevenLabs text-to-speech ----------
async function tts(text) {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key || !text) return null
  const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'
  const call = async fmt => {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=${fmt}`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 700), model_id: model }) })
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 120)}`)
    return Buffer.from(await r.arrayBuffer())
  }
  try { return { buf: await call('opus_48000_64'), mimetype: 'audio/ogg; codecs=opus', ptt: true } }
  catch (e1) {
    try { return { buf: await call('mp3_44100_128'), mimetype: 'audio/mpeg', ptt: false } }
    catch (e2) { event('error', null, String(e2).slice(0, 250)); return null }
  }
}
async function sendVoice(jid, text) {
  const v = await tts(text)
  if (!v) return false
  await sock.sendMessage(jid, { audio: v.buf, mimetype: v.mimetype, ptt: v.ptt })
  return true
}

const dmChains = new Map() // one message at a time per contact, so quick messages do not overlap

function handleDM(m) {
  const jid = m.key.remoteJid
  const next = (dmChains.get(jid) || Promise.resolve()).then(() => handleDMNow(m)).catch(e => event('error', null, String(e).slice(0, 300)))
  dmChains.set(jid, next)
  return next
}

async function handleDMNow(m) {
  if (!settings.away_mode) return skip('away mode is OFF in settings')
  const jid = m.key.remoteJid, n = num(jid)
  if (list(settings.blacklist).includes(n)) return skip(n + ' is in Never reply to')
  const only = list(settings.allow_only)
  if (only.length && !only.includes(n)) return skip(n + ' not in Only reply to')

  const aiOn = settings.use_ai && process.env.GEMINI_API_KEY
  // Plain away message: once per contact per 6h. AI chat mode: keeps replying to every message.
  if (!aiOn && Date.now() - (replied.get(jid) || 0) < 6 * 3600e3) return skip('6h limit (AI off) for ' + n)
  if (aiOn) { // loop / abuse guard: max AI replies per contact per hour
    const c = (aiCount.get(jid) || []).filter(t => Date.now() - t < 864e5)
    if (c.length >= MAX_AI_PER_DAY) return skip('daily AI cap for ' + n)
    if (c.filter(t => Date.now() - t < 3600e3).length >= MAX_AI_PER_HOUR) return skip('hourly AI cap for ' + n)
    c.push(Date.now()); aiCount.set(jid, c)
  }

  const wantVoice = !!(settings.voice_reply && process.env.ELEVENLABS_API_KEY && m.message?.audioMessage)
  let reply = null, userText = textOf(m)
  if (aiOn) {
    const parts = []
    if (userText) parts.push({ text: userText.slice(0, 800) })
    try {
      const media = await mediaParts(m)
      if (media.length) { parts.push(...media); userText = userText || '[sent a voice note or image]' }
    } catch (e) { event('error', null, 'Media download failed: ' + String(e).slice(0, 150)) }
    if (parts.length) reply = await aiReply(parts, jid, wantVoice)
    if (reply) remember(jid, userText, reply)
  }
  if (!reply) { // AI off, failed, or unsupported message: fall back to the away message, at most once per 6h
    if (Date.now() - (replied.get(jid) || 0) < 6 * 3600e3) return skip('AI gave no reply and fallback already sent <6h ago to ' + n)
    reply = settings.away_message
  }
  replied.set(jid, Date.now())
  if (!reply) return
  await sock.presenceSubscribe(jid)
  await sock.sendPresenceUpdate('composing', jid)
  await sleep(1500 + Math.random() * 2500)
  if (!(wantVoice && await sendVoice(jid, reply).catch(() => false))) await sock.sendMessage(jid, { text: reply })
  globalThis.botInfo.lastReplyAt = new Date().toISOString()
  await event('auto_reply', null, `Replied to ${n}`)
}

let pairAttempts = 0
async function wipeAuth() {
  await sleep(1500) // let any last credential write finish first
  if (process.env.AUTH_STORE === 'supabase') await db.from('wa_auth').delete().neq('key', '')
  else await (await import('fs')).promises.rm('auth', { recursive: true, force: true })
}
const MAX_PAIR_ATTEMPTS = 4 // stop hammering WhatsApp, repeated codes trigger the "too many attempts" block

async function start() {
  const { state, saveCreds } = process.env.AUTH_STORE === 'supabase' ? await useSupabaseAuthState(db) : await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}))
  const s = sock = makeWASocket({
    ...(version && { version }), auth: state, logger: pino({ level: process.env.LOG_LEVEL || 'warn' }),
    browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false
  })
  s.ev.on('creds.update', saveCreds)

  const wantsPair = () => !!process.env.PAIR_NUMBER && !s.authState.creds.registered && !s.authState.creds.me
  let pairAsked = false

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== sock) return // ignore events from an old socket

    // A "qr" event means the socket is ready to register. Ask for ONE pairing code per socket here.
    if (qr) {
      if (wantsPair()) {
        if (pairAsked) return
        pairAsked = true
        pairAttempts++
        try {
          const code = await s.requestPairingCode(process.env.PAIR_NUMBER.replace(/\D/g, ''))
          globalThis.pairCode = code
          console.log('Pairing code:', code, `(attempt ${pairAttempts}/${MAX_PAIR_ATTEMPTS})`)
          await setState('pair_code:' + code)
        } catch (e) { globalThis.pairCode = 'error: ' + String(e).slice(0, 100) }
      } else if (!process.env.PAIR_NUMBER) {
        console.log('Scan this QR with WhatsApp > Linked devices:'); qrcode.generate(qr, { small: true }); setState('waiting_qr')
      }
    }

    if (connection === 'open') {
      console.log('Connected'); globalThis.botInfo.state = 'connected'; pairAttempts = 0; globalThis.pairCode = null
      setState('connected'); await syncGroups().catch(e => event('error', null, String(e)))
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('Connection closed, status code:', code, String(lastDisconnect?.error?.message || ''))
      globalThis.botInfo.state = 'closed'; globalThis.botInfo.lastClose = code + ' @ ' + new Date().toISOString()
      setState('offline')
      // The pairing window ended without anyone entering the code (408), or WhatsApp rejected the half-made
      // login (401). Wipe it so the next try starts clean, wait a bit (do not hammer WhatsApp), then ask again.
      const pairingTimeout = code === DisconnectReason.timedOut && /QR refs/i.test(String(lastDisconnect?.error?.message || ''))
      if (code === DisconnectReason.loggedOut || pairingTimeout) {
        console.log(pairingTimeout ? 'Pairing window ended without a link. Starting clean.' : 'Logged out / rejected (401). Starting clean.')
        await wipeAuth()
        if (!process.env.PAIR_NUMBER || pairAttempts >= MAX_PAIR_ATTEMPTS) {
          globalThis.pairCode = 'paused: too many pairing attempts. Wait 1-2 hours, then redeploy.'; setState('pair_paused'); return
        }
        setTimeout(() => start().catch(e => console.error('restart failed', e)), pairingTimeout ? 30000 : 5000)
        return
      }
      // Still not linked and already tried several codes: pause instead of spamming WhatsApp.
      if (wantsPair() && pairAttempts >= MAX_PAIR_ATTEMPTS) {
        globalThis.pairCode = 'paused: too many attempts. Wait 1-2 hours, then redeploy.'
        setState('pair_paused'); console.log(globalThis.pairCode); return
      }
      // 515 restartRequired is NORMAL right after you enter the code: just reconnect fast with the saved login.
      setTimeout(() => start().catch(e => console.error('restart failed', e)), code === DisconnectReason.restartRequired ? 500 : wantsPair() ? 5000 : 3000)
    }
  })

  // Calls: WhatsApp calls cannot be answered by a bot, so reject politely and send a voice/text message instead.
  const calledAt = new Map()
  s.ev.on('call', async calls => {
    for (const c of calls) {
      if (c.status !== 'offer') continue
      try {
        if (!settings.call_reply) continue
        const n = num(c.from)
        if (list(settings.blacklist).includes(n)) continue
        await s.rejectCall(c.id, c.from)
        if (Date.now() - (calledAt.get(c.from) || 0) < 10 * 60e3) continue
        calledAt.set(c.from, Date.now())
        const msg = (settings.call_message || '').trim() || "Hi, I can't take calls right now, but you can send me a message or voice note here and I'll reply."
        await sleep(1500)
        if (!(settings.voice_reply && await sendVoice(c.from, msg).catch(() => false))) await s.sendMessage(c.from, { text: msg })
        await event('call_rejected', null, `Call from ${n}`)
      } catch (e) { event('error', null, 'call handler: ' + String(e).slice(0, 200)) }
    }
  })

  s.ev.on('messages.upsert', async ({ messages, type }) => {
    globalThis.botInfo.lastMsgAt = new Date().toISOString(); globalThis.botInfo.lastMsgType = type
    console.log('messages.upsert', type, messages.map(x => x.key.remoteJid + (x.key.fromMe ? ' (me)' : '')).join(', '))
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

  s.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'promote' || action === 'demote') { adminCache.delete(id); syncSoon() }
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
setInterval(() => syncGroups().catch(() => {}), 120000)
setInterval(() => runScheduled().catch(() => {}), 30000)
setInterval(() => runSummaries().catch(() => {}), 15000)
setInterval(prune, 3600e3)
start().catch(e => { console.error('start failed:', e); setTimeout(() => start().catch(() => {}), 10000) })