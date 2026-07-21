import OpenAI from 'openai'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { SceneGraph, SceneToolCall } from '../src/scene-graph.js'

export interface AgentTurn {
  toolCalls: SceneToolCall[]
  clarification?: string
}

const vector3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const
const tools: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'add_object', description: 'Add a new primitive to the scene.', parameters: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['box', 'sphere', 'cylinder'] }, position: vector3, color: { type: 'string' }, scale: vector3 }, required: ['id', 'type', 'position', 'color', 'scale'] } } },
  { type: 'function', function: { name: 'modify_object', description: 'Change fields on an existing object. Only include fields to change.', parameters: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['box', 'sphere', 'cylinder'] }, position: vector3, color: { type: 'string' }, scale: vector3 }, required: ['id'] } } },
  { type: 'function', function: { name: 'remove_object', description: 'Delete an existing object.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'set_camera', description: 'Set the scene camera.', parameters: { type: 'object', properties: { position: vector3, target: vector3, fov: { type: 'number' } }, required: ['position', 'target', 'fov'] } } },
  { type: 'function', function: { name: 'animate', description: 'Start an orbit or spin animation on an existing object.', parameters: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['orbit', 'spin'] }, speed: { type: 'number' } }, required: ['id', 'type', 'speed'] } } },
  { type: 'function', function: { name: 'stop_animate', description: 'Stop an object animation.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
]
const toolNames = new Set<SceneToolCall['name']>(['add_object', 'modify_object', 'remove_object', 'set_camera', 'animate', 'stop_animate'])

/** Converts one natural-language command into safe scene operation calls. */
export async function runAgent(transcript: string, currentScene: SceneGraph): Promise<AgentTurn> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const completion = await client.chat.completions.create({
    model: 'gpt-5.6-luna', reasoning_effort: 'none', tools, tool_choice: 'auto',
    messages: [
      { role: 'system', content: 'You control a simple 3D scene through tools. Use tools only when the user request is clear and can be carried out using the provided operations. Never modify or remove an object unless its id exists in the supplied scene. If the request is ambiguous, unsupported, or you are not confident, make no tool calls and give one short clarification question.' },
      { role: 'user', content: `Current scene:\n${JSON.stringify(currentScene)}\n\nTranscript:\n${transcript}` },
    ],
  })
  const message = completion.choices[0]?.message
  const toolCalls: SceneToolCall[] = []
  for (const call of message?.tool_calls ?? []) {
    if (call.type !== 'function' || !toolNames.has(call.function.name as SceneToolCall['name'])) continue
    try { toolCalls.push({ name: call.function.name as SceneToolCall['name'], arguments: JSON.parse(call.function.arguments) } as SceneToolCall) } catch { /* Ignore malformed calls. */ }
  }
  return { toolCalls, clarification: toolCalls.length === 0 ? message?.content?.trim() || 'What would you like to change in the scene?' : undefined }
}
