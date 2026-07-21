import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import OpenAI, { toFile } from 'openai'
import { runAgent } from './agent.js'
import { applyToolCalls, parseSceneGraph } from '../src/scene-graph.js'

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
app.use(express.json({ limit: '1mb' }))

app.post('/api/transcribe', upload.single('audio'), async (request, response) => {
  if (!process.env.OPENAI_API_KEY) return response.status(500).json({ error: 'OPENAI_API_KEY is not configured.' })
  if (!request.file) return response.status(400).json({ error: 'An audio file is required in the "audio" field.' })
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const extension = request.file.mimetype.includes('ogg') ? 'ogg' : 'webm'
    const file = await toFile(request.file.buffer, `recording.${extension}`, { type: request.file.mimetype })
    const result = await client.audio.transcriptions.create({ file, model: 'whisper-1' })
    response.json({ transcript: result.text })
  } catch (error) {
    console.error('Transcription failed:', error)
    response.status(502).json({ error: 'The transcription service could not process this recording.' })
  }
})

app.post('/api/agent-turn', async (request, response) => {
  if (!process.env.OPENAI_API_KEY) return response.status(500).json({ error: 'OPENAI_API_KEY is not configured.' })
  if (typeof request.body?.transcript !== 'string' || !request.body.transcript.trim()) return response.status(400).json({ error: 'A transcript is required.' })
  try {
    const currentScene = parseSceneGraph(request.body.currentScene)
    const agentTurn = await runAgent(request.body.transcript, currentScene, request.body.context)
    response.json({ scene: applyToolCalls(currentScene, agentTurn.toolCalls), ...agentTurn })
  } catch (error) {
    console.error('Agent turn failed:', error)
    response.status(502).json({ error: 'The scene agent could not process this request.' })
  }
})

app.listen(3001, () => console.log('Transcription API listening on http://localhost:3001'))
