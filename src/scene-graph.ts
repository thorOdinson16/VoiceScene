export type PrimitiveType = 'box' | 'sphere' | 'cylinder'
export type Vector3 = [number, number, number]

export interface SceneObject {
  id: string
  type: PrimitiveType
  position: Vector3
  color: string
  scale: Vector3
}

export interface CameraState {
  position: Vector3
  target: Vector3
  fov: number
}

export interface LightingState {
  ambient: { color: string; intensity: number }
  directional: { color: string; intensity: number; position: Vector3 }
}

export interface AnimationState {
  id: string
  type: 'orbit' | 'spin'
  speed: number
}

export type SceneToolCall =
  | { name: 'add_object'; arguments: SceneObject }
  | { name: 'modify_object'; arguments: { id: string; type?: PrimitiveType; position?: Vector3; color?: string; scale?: Vector3 } }
  | { name: 'remove_object'; arguments: { id: string } }
  | { name: 'set_camera'; arguments: CameraState }
  | { name: 'animate'; arguments: AnimationState }
  | { name: 'stop_animate'; arguments: { id: string } }

export interface SceneGraph {
  objects: SceneObject[]
  camera: CameraState
  lighting: LightingState
  animations?: AnimationState[]
}

export const exampleScene: SceneGraph = {
  objects: [
    { id: 'blue-box', type: 'box', position: [-1.2, 0, 0], color: '#3b82f6', scale: [1, 1, 1] },
    { id: 'orange-sphere', type: 'sphere', position: [1.2, 0, 0], color: '#f97316', scale: [0.8, 0.8, 0.8] },
  ],
  camera: { position: [0, 2.5, 6], target: [0, 0, 0], fov: 50 },
  lighting: {
    ambient: { color: '#ffffff', intensity: 1.2 },
    directional: { color: '#ffffff', intensity: 2, position: [3, 4, 5] },
  },
}

function isVector3(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every((number) => typeof number === 'number' && Number.isFinite(number))
}

/** Validates unknown parsed JSON before it is given to the renderer. */
export function parseSceneGraph(value: unknown): SceneGraph {
  if (!value || typeof value !== 'object') throw new Error('Scene must be a JSON object.')
  const scene = value as Partial<SceneGraph>
  if (!Array.isArray(scene.objects)) throw new Error('"objects" must be an array.')
  if (!scene.camera || !scene.lighting) throw new Error('Scene requires "camera" and "lighting".')
  const ids = new Set<string>()
  for (const object of scene.objects) {
    if (!object || typeof object !== 'object') throw new Error('Each object must be an object.')
    const item = object as Partial<SceneObject>
    if (typeof item.id !== 'string' || !item.id) throw new Error('Each object needs a non-empty string id.')
    if (ids.has(item.id)) throw new Error(`Duplicate object id: ${item.id}`)
    ids.add(item.id)
    if (item.type !== 'box' && item.type !== 'sphere' && item.type !== 'cylinder') throw new Error(`Invalid type for ${item.id}.`)
    if (!isVector3(item.position) || !isVector3(item.scale)) throw new Error(`"position" and "scale" for ${item.id} must be [x, y, z].`)
    if (typeof item.color !== 'string') throw new Error(`"color" for ${item.id} must be a string.`)
  }
  const { camera, lighting } = scene
  if (!isVector3(camera.position) || !isVector3(camera.target) || typeof camera.fov !== 'number') throw new Error('Camera needs position, target, and fov.')
  if (!lighting.ambient || !lighting.directional || typeof lighting.ambient.color !== 'string' || typeof lighting.ambient.intensity !== 'number' || typeof lighting.directional.color !== 'string' || typeof lighting.directional.intensity !== 'number' || !isVector3(lighting.directional.position)) throw new Error('Lighting is invalid.')
  return value as SceneGraph
}

/** Applies the scene-operation calls returned by the agent without mutating the current scene. */
export function applyToolCalls(current: SceneGraph, toolCalls: SceneToolCall[]): SceneGraph {
  const next: SceneGraph = structuredClone(current)
  next.animations ??= []
  for (const call of toolCalls) {
    switch (call.name) {
      case 'add_object':
        if (!next.objects.some((object) => object.id === call.arguments.id)) next.objects.push(call.arguments)
        break
      case 'modify_object': {
        const object = next.objects.find((item) => item.id === call.arguments.id)
        if (object) Object.assign(object, call.arguments)
        break
      }
      case 'remove_object':
        next.objects = next.objects.filter((object) => object.id !== call.arguments.id)
        next.animations = next.animations.filter((animation) => animation.id !== call.arguments.id)
        break
      case 'set_camera': next.camera = call.arguments; break
      case 'animate':
        if (next.objects.some((object) => object.id === call.arguments.id)) {
          next.animations = next.animations.filter((animation) => animation.id !== call.arguments.id)
          next.animations.push(call.arguments)
        }
        break
      case 'stop_animate': next.animations = next.animations.filter((animation) => animation.id !== call.arguments.id); break
    }
  }
  return next
}
