import * as THREE from 'three'
import './style.css'
import { SceneDiffRenderer } from './diff-renderer'
import { exampleScene, parseSceneGraph, type SceneGraph } from './scene-graph'

const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas')!
const input = document.querySelector<HTMLTextAreaElement>('#scene-json')!
const button = document.querySelector<HTMLButtonElement>('#apply-scene')!
const status = document.querySelector<HTMLParagraphElement>('#status')!

const scene = new THREE.Scene()
scene.background = new THREE.Color('#111827')
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
const ambientLight = new THREE.AmbientLight()
const directionalLight = new THREE.DirectionalLight()
scene.add(ambientLight, directionalLight)

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
const diffRenderer = new SceneDiffRenderer(scene, camera, ambientLight, directionalLight)
let currentScene: SceneGraph = exampleScene

function resize(): void {
  const { width, height } = canvas.getBoundingClientRect()
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function draw(): void {
  resize()
  renderer.render(scene, camera)
}

function applyInput(): void {
  try {
    const nextScene = parseSceneGraph(JSON.parse(input.value))
    currentScene = nextScene
    diffRenderer.render(nextScene)
    draw()
    status.textContent = `Applied ${nextScene.objects.length} object${nextScene.objects.length === 1 ? '' : 's'}.`
    status.className = 'success'
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Invalid scene JSON.'
    status.className = 'error'
  }
}

input.value = JSON.stringify(exampleScene, null, 2)
button.addEventListener('click', applyInput)
window.addEventListener('resize', draw)
applyInput()

let recorder: MediaRecorder | undefined
let recordingStream: MediaStream | undefined
const pushToTalk = document.querySelector<HTMLButtonElement>('#push-to-talk')!
const voiceStatus = document.querySelector<HTMLParagraphElement>('#voice-status')!
const transcript = document.querySelector<HTMLTextAreaElement>('#transcript')!

function recordingMimeType(): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type))
}

async function startRecording(): Promise<void> {
  if (recorder?.state === 'recording') return
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const chunks: BlobPart[] = []
    const mimeType = recordingMimeType()
    recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined)
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) chunks.push(event.data) })
    recorder.addEventListener('stop', async () => {
      recordingStream?.getTracks().forEach((track) => track.stop())
      recordingStream = undefined
      await transcribe(new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }))
    }, { once: true })
    recorder.start()
    pushToTalk.classList.add('recording')
    voiceStatus.textContent = 'Recording… release to transcribe.'
  } catch (error) {
    voiceStatus.textContent = error instanceof Error ? `Microphone unavailable: ${error.message}` : 'Microphone unavailable.'
  }
}

function stopRecording(): void {
  if (recorder?.state === 'recording') recorder.stop()
  pushToTalk.classList.remove('recording')
}

async function transcribe(audio: Blob): Promise<void> {
  if (audio.size === 0) return
  voiceStatus.textContent = 'Transcribing…'
  try {
    const formData = new FormData()
    formData.append('audio', audio, 'recording.webm')
    const response = await fetch('/api/transcribe', { method: 'POST', body: formData })
    const payload = await response.json() as { transcript?: string; error?: string }
    if (!response.ok) throw new Error(payload.error || 'Transcription failed.')
    transcript.value = payload.transcript || ''
    await sendAgentTurn(payload.transcript || '')
  } catch (error) {
    voiceStatus.textContent = error instanceof Error ? error.message : 'Transcription failed.'
  }
}

pushToTalk.addEventListener('mousedown', (event) => { event.preventDefault(); void startRecording() })
pushToTalk.addEventListener('touchstart', (event) => { event.preventDefault(); void startRecording() }, { passive: false })
document.addEventListener('mouseup', stopRecording)
document.addEventListener('touchend', stopRecording)


async function sendAgentTurn(transcriptText: string): Promise<void> {
  voiceStatus.textContent = 'Updating scene…'
  try {
    const response = await fetch('/api/agent-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: transcriptText, currentScene }),
    })
    const payload = await response.json() as { scene?: SceneGraph; clarification?: string; error?: string }
    if (!response.ok) throw new Error(payload.error || 'Scene update failed.')
    if (!payload.scene) throw new Error('The agent did not return a scene.')
    currentScene = parseSceneGraph(payload.scene)
    diffRenderer.render(currentScene)
    input.value = JSON.stringify(currentScene, null, 2)
    draw()
    voiceStatus.textContent = payload.clarification || 'Scene updated.'
  } catch (error) {
    voiceStatus.textContent = error instanceof Error ? error.message : 'Scene update failed.'
  }
}
