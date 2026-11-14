import express from 'express'
let botError = null
const app = express()
app.use(express.json())
app.get('/hello', (req, res) => res.json({ message: 'Hello from my server!' }))
app.get('/health', (req, res) => res.json({ ok: true, botError, pairCode: globalThis.pairCode || null, bot: globalThis.botInfo || null, time: new Date().toISOString() }))
app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Server up'))
try {
  await import('./index.js')
} catch (e) {
  botError = String(e)
  console.error('Bot failed to start:', e)
}