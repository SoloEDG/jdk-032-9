import type { EnergyRoute, EnergySource, EnergyStage, Piece, SceneSettings } from '@/shared/document'

/**
 * Energy is normalised to joules on a unit-mass model: m = 1 kg for every part.
 * These helpers are the single source of truth for every joule that appears in
 * the ledger, so the replay can be audited against the physics formulas.
 */

export const MASS_KG = 1
/** A toppling part releases its centre-of-mass potential: m·g·h/2. */
export function gravityEnergy(piece: Piece, gravity: number) {
  if (piece.kind === 'trigger' || piece.kind === 'pendulum') return 0
  return MASS_KG * gravity * piece.height / 2
}

/**
 * Energy a part must receive before it tips. This is a *comparison* value used
 * for contact sufficiency; it is never added to or subtracted from the ledger.
 */
export function toppleRequirement(piece: Piece, gravity: number) {
  if (piece.kind === 'trigger' || piece.kind === 'pendulum') return 0.2
  const base = MASS_KG * gravity * piece.height / 2
  return base * 0.35 * piece.fallThreshold / 0.8
}

/** Fraction of a part's available energy lost at its pivot / ground contact. */
export function frictionRatio(piece: Piece, scene: SceneSettings) {
  const grip = (scene.friction + piece.friction) / 2
  return 0.06 + 0.12 * grip
}

/** Fraction lost in the interface when energy moves along a route. */
export function contactLossFactor(route: EnergyRoute, scene: SceneSettings) {
  const grip = Math.max(0, Math.min(1.5, scene.friction))
  switch (route) {
    case 'link': return 0.05 + 0.05 * grip
    case 'pendulum': return 0.08 + 0.10 * grip
    case 'release': return 0.10 + 0.15 * grip
    case 'impact':
    default: return 0.12 + 0.18 * grip
  }
}

export const DEFAULT_PENDULUM_ENERGY_J = 40
export const RAMP_RELEASE_DELAY = 0.45

export function pendulumReservoir(piece: Piece) {
  return Math.max(0, piece.energyJ ?? DEFAULT_PENDULUM_ENERGY_J)
}

export function routeForSource(piece: Piece): EnergyRoute {
  return piece.kind === 'pendulum' ? 'pendulum' : piece.kind === 'ramp' ? 'release' : 'impact'
}

/** Scale a provenance bundle, putting any floating-point remainder on the last slice. */
export function scaleSources(sources: readonly EnergySource[], fraction: number): EnergySource[] {
  if (!sources.length || fraction <= 0) return []
  const result: EnergySource[] = []
  let allocated = 0
  sources.forEach((source, index) => {
    const amountJ = index === sources.length - 1
      ? sources.reduce((sum, item) => sum + item.amountJ, 0) * fraction - allocated
      : source.amountJ * fraction
    allocated += amountJ
    if (amountJ > 1e-12) result.push({ ...source, amountJ })
  })
  return result
}

export function totalSources(sources: readonly EnergySource[]) {
  return sources.reduce((sum, source) => sum + source.amountJ, 0)
}

export function mergeSources(into: EnergySource[], incoming: readonly EnergySource[]) {
  for (const source of incoming) {
    if (source.amountJ <= 0) continue
    const existing = into.find(item => item.entryId === source.entryId && item.origin === source.origin && item.pieceId === source.pieceId)
    if (existing) existing.amountJ += source.amountJ
    else into.push({ ...source })
  }
}

export function stageLabel(stage: EnergyStage) {
  switch (stage) {
    case 'input': return '摆锤输入'
    case 'gravity': return '重力释放'
    case 'check': return '触发判定'
    case 'transfer': return '接触传递'
    case 'loss': return '能量损耗'
    case 'storage': return '坡道储能'
    case 'release': return '坡道释能'
    case 'held': return '待触发滞留'
    case 'residual': return '未再传递'
    default: return '能量记录'
  }
}

export function routeLabel(route: EnergyRoute | null) {
  switch (route) {
    case 'pendulum': return '摆锤冲击'
    case 'impact': return '相邻接触'
    case 'link': return '机关连线'
    case 'release': return '坡面释放'
    default: return '地面摩擦'
  }
}

export function originLabel(origin: EnergySource['origin']) {
  switch (origin) {
    case 'pendulum': return '摆锤'
    case 'manual': return '手动'
    case 'gravity': return '重力'
    case 'slope': return '坡道'
    default: return '未知'
  }
}
