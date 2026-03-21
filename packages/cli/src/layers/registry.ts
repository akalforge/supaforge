import type { LayerName } from '../types/drift'
import type { Layer } from './base'

export class LayerRegistry {
  private layers = new Map<LayerName, Layer>()

  register(layer: Layer): void {
    this.layers.set(layer.name, layer)
  }

  get(name: LayerName): Layer | undefined {
    return this.layers.get(name)
  }

  all(): Layer[] {
    return [...this.layers.values()]
  }

  has(name: LayerName): boolean {
    return this.layers.has(name)
  }
}
