import * as THREE from 'three'
import type { SceneGraph, SceneObject } from './scene-graph'

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
  private previous?: SceneGraph

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly ambientLight: THREE.AmbientLight,
    private readonly directionalLight: THREE.DirectionalLight,
  ) {}

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
    this.ambientLight.color.set(next.lighting.ambient.color)
    this.ambientLight.intensity = next.lighting.ambient.intensity
    this.directionalLight.color.set(next.lighting.directional.color)
    this.directionalLight.intensity = next.lighting.directional.intensity
    this.directionalLight.position.set(...next.lighting.directional.position)
    this.previous = next
  }
}
