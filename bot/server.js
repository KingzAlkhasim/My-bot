import express from 'express'
// The Signal library prints whole session objects (including private keys) with console.info.
// Drop those lines so secrets never land in the Render logs.
const NOISY = /^(Closing session|Opening session|Removing old closed session|Migrating session|Session already)/
for (const k of ['log', 'info', 'warn']) {
  const orig = console[k].bind(console)
  console[k] = (...a) => { if (typeof a[0] === 'string' && NOISY.test(a[0])) return; orig(...a) }
}

let botError = null
const app = express()
app.use(express.json())
app.get('/hello', (req, res) => res.json({ message: 'Hello from my server!' }))

// Public /health (for UptimeRobot): only says if the server is up and the bot state. No codes, numbers or errors.
// Full details (pairing code, last message, skip reason) only with ?key=<HEALTH_KEY>.
app.get('/health', (req, res) => {
  const info = globalThis.botInfo || {}
  const base = { ok: true, state: info.state || 'starting', time: new Date().toISOString() }
  const key = process.env.HEALTH_KEY
  if (key && req.query.key === key) {
    return res.json({ ...base, botError, pairCode: globalThis.pairCode || null, bot: info })
  }
  res.json({ ...base, botError: botError ? 'error (see logs)' : null })
})

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Server up'))
try {
  await import('./index.js')
} catch (e) {
  botError = String(e)
  console.error('Bot failed to start:', e)
}
