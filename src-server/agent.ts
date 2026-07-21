import OpenAI from 'openai'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { PrimitiveType, SceneGraph, SceneObject, SceneToolCall } from '../src/scene-graph.js'

export interface AgentTurn {
  toolCalls: SceneToolCall[]
  clarification?: string
}

export interface AgentContext {
  lastFocusedId?: string
}

type Resolution = { transcript: string } | { clarification: string }
type Intent = 'add_object' | 'existing_object'

const vector3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const
const toolNames = new Set<SceneToolCall['name']>(['add_object', 'modify_object', 'remove_object', 'set_camera', 'animate', 'stop_animate'])
const objectToolNames = new Set<SceneToolCall['name']>(['modify_object', 'remove_object', 'animate', 'stop_animate'])
const primitiveWords: Record<PrimitiveType, string[]> = {
  box: ['box', 'cube'],
  sphere: ['sphere', 'ball'],
  cylinder: ['cylinder'],
}

function detectIntent(transcript: string): Intent {
  const match = transcript.match(/^\s*(?:please\s+)?(?:add|create|spawn|make|generate|insert|place|put)\b\s*(.*)$/i)
  if (!match) return 'existing_object'
  // "Make it larger" and "put the box left" operate on existing objects despite their leading verbs.
  return /^(?:it|that one|this one|the\b|object\b)/i.test(match[1]) ? 'existing_object' : 'add_object'
}

function toolsForScene(currentScene: SceneGraph): ChatCompletionTool[] {
  // Object-taking tools expose only IDs that exist in this request's scene.
  const objectId = { type: 'string', enum: currentScene.objects.map((object) => object.id) } as const
  return [
    { type: 'function', function: { name: 'add_object', description: 'Add a new primitive to the scene.', parameters: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['box', 'sphere', 'cylinder'] }, position: vector3, color: { type: 'string' }, scale: vector3 }, required: ['id', 'type', 'position', 'color', 'scale'] } } },
    { type: 'function', function: { name: 'modify_object', description: 'Change fields on an existing object. Only include fields to change.', parameters: { type: 'object', properties: { id: objectId, type: { type: 'string', enum: ['box', 'sphere', 'cylinder'] }, position: vector3, color: { type: 'string' }, scale: vector3 }, required: ['id'] } } },
    { type: 'function', function: { name: 'remove_object', description: 'Delete an existing object.', parameters: { type: 'object', properties: { id: objectId }, required: ['id'] } } },
    { type: 'function', function: { name: 'set_camera', description: 'Set the scene camera.', parameters: { type: 'object', properties: { position: vector3, target: vector3, fov: { type: 'number' } }, required: ['position', 'target', 'fov'] } } },
    { type: 'function', function: { name: 'animate', description: 'Start an orbit or spin animation on an existing object.', parameters: { type: 'object', properties: { id: objectId, type: { type: 'string', enum: ['orbit', 'spin'] }, speed: { type: 'number' } }, required: ['id', 'type', 'speed'] } } },
    { type: 'function', function: { name: 'stop_animate', description: 'Stop an object animation.', parameters: { type: 'object', properties: { id: objectId }, required: ['id'] } } },
  ]
}

function colorName(color: string): string {
  const named = color.toLowerCase()
  if (/^[a-z]+$/.test(named)) return named
  const hex = named.match(/^#?([\da-f])([\da-f])([\da-f])$/i)
    ? named.replace(/^#?([\da-f])([\da-f])([\da-f])$/i, '#$1$1$2$2$3$3')
    : named
  const match = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (!match) return color
  const [red, green, blue] = match.slice(1).map((part) => Number.parseInt(part, 16) / 255)
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  if (max - min < 0.15) return max < 0.2 ? 'black' : max > 0.85 ? 'white' : 'gray'
  const hue = ((Math.atan2(Math.sqrt(3) * (green - blue), 2 * red - green - blue) * 180 / Math.PI) + 360) % 360
  if (hue < 15 || hue >= 345) return 'red'
  if (hue < 45) return 'orange'
  if (hue < 70) return 'yellow'
  if (hue < 170) return 'green'
  if (hue < 260) return 'blue'
  if (hue < 300) return 'purple'
  return 'pink'
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`, 'i').test(text)
}

function rewriteReference(transcript: string, object: SceneObject, matchedColor?: string, matchedType?: PrimitiveType): string {
  const canonical = `object "${object.id}"`
  if (hasWord(transcript, object.id)) return transcript.replace(new RegExp(object.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), canonical)
  if (/\b(?:it|that one|this one)\b/i.test(transcript)) return transcript.replace(/\b(?:it|that one|this one)\b/i, canonical)
  const typeWords = matchedType ? primitiveWords[matchedType].join('|') : ''
  if (matchedColor && typeWords) {
    const expression = new RegExp(`\\b(?:the\\s+)?${matchedColor}\\s+(?:${typeWords})\\b|\\b(?:the\\s+)?(?:${typeWords})\\s+${matchedColor}\\b`, 'i')
    return transcript.replace(expression, canonical)
  }
  if (matchedColor) return transcript.replace(new RegExp(`\\b${matchedColor}\\b`, 'i'), canonical)
  if (matchedType) return transcript.replace(new RegExp(`\\b(?:${typeWords})\\b`, 'i'), canonical)
  return transcript
}

/** Resolves exact IDs, focused pronouns, and unique color/type descriptions before the model sees a command. */
function resolveEntityReference(transcript: string, currentScene: SceneGraph, context?: AgentContext): Resolution {
  const exactMatches = currentScene.objects.filter((object) => hasWord(transcript, object.id))
  if (exactMatches.length === 1) return { transcript: rewriteReference(transcript, exactMatches[0]) }
  if (exactMatches.length > 1) return { clarification: 'Which object do you mean?' }

  if (/\b(?:it|that one|this one)\b/i.test(transcript)) {
    const focused = currentScene.objects.find((object) => object.id === context?.lastFocusedId)
    return focused
      ? { transcript: rewriteReference(transcript, focused) }
      : { clarification: 'Which object do you mean?' }
  }

  const colors = [...new Set(currentScene.objects.map((object) => colorName(object.color)))].filter((color) => hasWord(transcript, color))
  const types = (Object.keys(primitiveWords) as PrimitiveType[]).filter((type) => primitiveWords[type].some((word) => hasWord(transcript, word)))
  if (colors.length === 0 && types.length === 0) return { transcript }
  const matches = currentScene.objects.filter((object) =>
    (colors.length === 0 || colors.includes(colorName(object.color))) &&
    (types.length === 0 || types.includes(object.type)),
  )
  if (matches.length !== 1) return { clarification: 'Which object do you mean?' }
  return { transcript: rewriteReference(transcript, matches[0], colors[0], types[0]) }
}

function objectList(currentScene: SceneGraph): string {
  return currentScene.objects.map((object) =>
    `- ${object.id}\n  type: ${object.type}\n  color: ${colorName(object.color)}\n  position: (${object.position.join(',')})`,
  ).join('\n\n') || '(none)'
}

function parseToolCalls(toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined, currentScene: SceneGraph): AgentTurn | undefined {
  // Treat one malformed or unknown object reference as a failed turn, never a partial update.
  const validIds = new Set(currentScene.objects.map((object) => object.id))
  const parsed: SceneToolCall[] = []
  for (const call of toolCalls ?? []) {
    if (call.type !== 'function' || !toolNames.has(call.function.name as SceneToolCall['name'])) {
      return { toolCalls: [], clarification: 'I could not identify a valid object for that action. Which object do you mean?' }
    }
    try {
      const name = call.function.name as SceneToolCall['name']
      const arguments_ = JSON.parse(call.function.arguments) as { id?: unknown }
      if (objectToolNames.has(name) && (typeof arguments_.id !== 'string' || !validIds.has(arguments_.id))) {
        return { toolCalls: [], clarification: 'I could not identify a valid object for that action. Which object do you mean?' }
      }
      parsed.push({ name, arguments: arguments_ } as SceneToolCall)
    } catch {
      return { toolCalls: [], clarification: 'I could not understand that action. Which object do you mean?' }
    }
  }
  return parsed.length > 0 ? { toolCalls: parsed } : undefined
}

/** Converts one natural-language command into safe scene operation calls. */
export async function runAgent(transcript: string, currentScene: SceneGraph, context?: AgentContext): Promise<AgentTurn> {
  // Creation has no existing target. All other intents pass through deterministic target resolution first.
  const intent = detectIntent(transcript)
  const resolution: Resolution = intent === 'add_object'
    ? { transcript }
    : resolveEntityReference(transcript, currentScene, context)
  if ('clarification' in resolution) return { toolCalls: [], clarification: resolution.clarification }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const completion = await client.chat.completions.create({
    model: 'gpt-5.6-luna', reasoning_effort: 'none', tools: toolsForScene(currentScene), tool_choice: 'auto',
    messages: [
      { role: 'system', content: 'You control a simple 3D scene through tools. For an explicit object-creation request, use add_object. Otherwise, never invent object IDs, never invent objects, and never approximate object names. Never perform an action on an existing object unless exactly one object matches. If multiple objects could match, ask one short clarification question. If no object matches, ask one short clarification question. If you are not 100% certain, return NO tool calls.' },
      { role: 'user', content: `Objects currently in the scene:\n\n${objectList(currentScene)}\n\nThese are the ONLY valid objects.\n\nCurrent scene JSON:\n${JSON.stringify(currentScene)}\n\nTranscript:\n${resolution.transcript}` },
    ],
  })
  const message = completion.choices[0]?.message
  return parseToolCalls(message?.tool_calls, currentScene)
    ?? { toolCalls: [], clarification: message?.content?.trim() || 'What would you like to change in the scene?' }
}
