import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { AnimationState, SceneGraph, SceneObject } from './scene-graph'

type RenderedObject = { mesh: THREE.Mesh; type: SceneObject['type'] }

function createGeometry(type: SceneObject['type']): THREE.BufferGeometry {
  switch (type) {
    case 'box': return new THREE.BoxGeometry(1, 1, 1)
    case 'sphere': return new THREE.SphereGeometry(0.5, 32, 20)
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 32)
  }
}

function applyObject(mesh: THREE.Mesh, object: SceneObject): void {
  mesh.position.set(...object.position)
  mesh.scale.set(...object.scale)
  ;(mesh.material as THREE.MeshStandardMaterial).color.set(object.color)
}

/** Keeps three.js objects in sync with JSON, touching only added, changed, or deleted entries. */
export class SceneDiffRenderer {
  private readonly rendered = new Map<string, RenderedObject>()
  private animations: AnimationState[] = []
  private readonly orbitRadii = new Map<string, number>()
  private previous?: SceneGraph
  private orbitControls?: OrbitControls

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly ambientLight: THREE.AmbientLight,
    private readonly directionalLight: THREE.DirectionalLight,
  ) {}

  setOrbitControls(controls: OrbitControls): void {
    this.orbitControls = controls
  }

  render(next: SceneGraph): void {
    const previousById = new Map(this.previous?.objects.map((object) => [object.id, object]))
    const nextById = new Map(next.objects.map((object) => [object.id, object]))

    for (const [id, rendered] of this.rendered) {
      if (!nextById.has(id)) {
        this.scene.remove(rendered.mesh)
        rendered.mesh.geometry.dispose()
        ;(rendered.mesh.material as THREE.Material).dispose()
        this.rendered.delete(id)
      }
    }

    for (const object of next.objects) {
      const oldObject = previousById.get(object.id)
      const current = this.rendered.get(object.id)
      if (!current) {
        const mesh = new THREE.Mesh(createGeometry(object.type), new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.55 }))
        mesh.castShadow = true
        mesh.receiveShadow = true
        applyObject(mesh, object)
        this.scene.add(mesh)
        this.rendered.set(object.id, { mesh, type: object.type })
      } else if (!oldObject || oldObject.type !== object.type) {
        this.scene.remove(current.mesh)
        current.mesh.geometry.dispose()
        ;(current.mesh.material as THREE.Material).dispose()
        const mesh = new THREE.Mesh(createGeometry(object.type), new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.55 }))
        applyObject(mesh, object)
        this.scene.add(mesh)
        this.rendered.set(object.id, { mesh, type: object.type })
      } else if (JSON.stringify(oldObject) !== JSON.stringify(object)) {
        applyObject(current.mesh, object)
      }
    }

    this.camera.position.set(...next.camera.position)
    this.camera.fov = next.camera.fov
    this.camera.updateProjectionMatrix()
    this.camera.lookAt(...next.camera.target)
    if (this.orbitControls) {
      this.orbitControls.target.set(...next.camera.target)
      this.orbitControls.update()
    }
    this.ambientLight.color.set(next.lighting.ambient.color)
    this.ambientLight.intensity = next.lighting.ambient.intensity
    this.directionalLight.color.set(next.lighting.directional.color)
    this.directionalLight.intensity = next.lighting.directional.intensity
    this.directionalLight.position.set(...next.lighting.directional.position)
    this.animations = next.animations ?? []
    const orbitIds = new Set(this.animations.filter((animation) => animation.type === 'orbit').map((animation) => animation.id))
    for (const id of this.orbitRadii.keys()) {
      if (!orbitIds.has(id)) this.orbitRadii.delete(id)
    }
    for (const animation of this.animations) {
      if (animation.type !== 'orbit' || this.orbitRadii.has(animation.id)) continue
      const rendered = this.rendered.get(animation.id)
      if (rendered) this.orbitRadii.set(animation.id, rendered.mesh.position.length())
    }
    this.previous = next
  }

  update(elapsed: number): void {
    for (const animation of this.animations) {
      const rendered = this.rendered.get(animation.id)
      if (!rendered) continue
      if (animation.type === 'spin') {
        rendered.mesh.rotation.y = elapsed * animation.speed
      } else {
        const radius = this.orbitRadii.get(animation.id)
        if (radius === undefined) continue
        rendered.mesh.position.x = Math.cos(elapsed * animation.speed) * radius
        rendered.mesh.position.z = Math.sin(elapsed * animation.speed) * radius
      }
    }
  }
}
