export type PieceKind = 'domino' | 'ramp' | 'splitter' | 'trigger' | 'pendulum'
export type Axis = 'north' | 'east' | 'south' | 'west'

export interface Vec2 { x: number; y: number }

export interface Piece {
  id: string
  kind: PieceKind
  x: number
  y: number
  angle: number
  facing: Axis
  label: string
  height: number
  width: number
  fallThreshold: number
  friction: number
  /** Pendulum reservoir in joules. The reservoir is the run's external energy input. */
  energyJ?: number
  /** Pendulum start deflection from vertical, in degrees; feeds the start-up energy. */
  startAngleDeg?: number
}

export interface MechanismConnection {
  id: string
  from: string
  to: string
  delay: number
  enabled: boolean
}

export interface SceneSettings {
  gravity: number
  friction: number
  width: number
  height: number
  showGrid: boolean
}

export interface DominoDocument {
  id: string
  title: string
  revision: number
  updatedAt: number
  pieces: Piece[]
  connections: MechanismConnection[]
  scene: SceneSettings
  startPieceId: string
}

export interface SimulationEvent {
  id: string
  pieceId: string
  time: number
  causeId: string | null
  kind: 'trigger' | 'fall' | 'mechanism' | 'input' | 'absorbed' | 'interrupted'
  detail: string
}

export type EnergyStage = 'input' | 'gravity' | 'check' | 'transfer' | 'loss' | 'storage' | 'release' | 'held' | 'residual'

export type EnergyRoute = 'pendulum' | 'impact' | 'link' | 'release'

export type EnergyOrigin = 'pendulum' | 'manual' | 'gravity' | 'slope'

/** A slice of energy still carrying the identity of the component that supplied it. */
export interface EnergySource {
  entryId: string
  pieceId: string
  origin: EnergyOrigin
  amountJ: number
  /** Immediate upstream ledger entry, used to walk the chain back to the source. */
  viaEntryId?: string | null
}

export interface EnergyLedgerEntry {
  id: string
  eventId: string | null
  time: number
  stage: EnergyStage
  pieceId: string | null
  counterpartId: string | null
  route: EnergyRoute | null
  amountJ: number
  sources: EnergySource[]
  /** Share of the source's available energy allocated to this route, 0–1. */
  shareRatio: number | null
  routeIndex: number | null
  routeCount: number | null
  /** All routes emitted together by one activation share this id. */
  groupId: string | null
  /** When energy booked here lands on its destination (transfer/release/storage). */
  deliversAt: number | null
  /** Held energy is consumed once a later contact tops the part up. */
  resolved: boolean
  contactLossJ: number
  thresholdJ: number | null
  sufficient: boolean | null
  heldBeforeJ: number | null
  heldAfterJ: number | null
  note: string
}

export interface PieceEnergySummary {
  pieceId: string
  receivedJ: number
  gravityJ: number
  contactLossJ: number
  frictionLossJ: number
  storedJ: number
  releasedJ: number
  heldJ: number
  residualJ: number
  toppled: boolean
}

export interface EnergyTotals {
  pendulumInputJ: number
  manualInputJ: number
  gravityJ: number
  inputJ: number
  transferJ: number
  contactLossJ: number
  frictionLossJ: number
  residualJ: number
  storedAtEndJ: number
  heldAtEndJ: number
  releasedJ: number
  /** Energy still in flight, stored on ramps or held at a part, at end of run. */
  inFlightJ: number
  /** Contact loss + friction + residual + in-flight. */
  accountedJ: number
  /** inputJ − accountedJ; the conservation check for the whole run. */
  balanceJ: number
  balanced: boolean
}

export interface EnergyReport {
  ledger: EnergyLedgerEntry[]
  totals: EnergyTotals
  pieces: PieceEnergySummary[]
}

export interface SimulationRun {
  id: string
  documentId: string
  revision: number
  startedAt: number
  startPieceId: string
  status: 'complete' | 'interrupted' | 'empty'
  events: SimulationEvent[]
  interruptedPieceId: string | null
  interruptionReason: string | null
  duration: number
  pieceLabels: Record<string, string>
  energy: EnergyReport
}
