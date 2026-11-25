import type {
  EnergyLedgerEntry, EnergyReport, EnergySource, EnergyStage, EnergyTotals,
  PieceEnergySummary, SimulationEvent, SimulationRun,
} from '@/shared/document'
import { stageLabel, routeLabel, originLabel } from '@/features/simulation/lib/energy'

export interface StageStyle {
  label: string
  tone: 'gold' | 'mint' | 'terracotta' | 'sky' | 'quiet' | 'iris'
}

export const stageStyles: Record<EnergyStage, StageStyle> = {
  input: { label: stageLabel('input'), tone: 'gold' },
  gravity: { label: stageLabel('gravity'), tone: 'iris' },
  check: { label: '触发判定', tone: 'quiet' },
  transfer: { label: stageLabel('transfer'), tone: 'mint' },
  loss: { label: stageLabel('loss'), tone: 'terracotta' },
  storage: { label: stageLabel('storage'), tone: 'gold' },
  release: { label: stageLabel('release'), tone: 'mint' },
  held: { label: stageLabel('held'), tone: 'sky' },
  residual: { label: stageLabel('residual'), tone: 'quiet' },
}

export interface BalanceRow {
  key: string
  label: string
  amountJ: number
  tone: StageStyle['tone']
}

export interface RunningBalance {
  input: BalanceRow[]
  accounted: BalanceRow[]
  /** Energy sent but not yet landed at the replay time (transfers + storage). */
  inFlightJ: number
  /** Row sums on each side — equal whenever the books for this instant close. */
  inputTotalJ: number
  accountedTotalJ: number
  closed: boolean
}

/**
 * The whole-run closing figures shown in the report header. They are only
 * complete once the replay is at its end; for earlier clock positions use
 * runningBalance() so a half-played ledger never claims a closed book.
 */
export function balanceRows(totals: EnergyTotals) {
  const input = ([
    { key: 'pendulum', label: '摆锤输入', amountJ: totals.pendulumInputJ, tone: 'gold' },
    { key: 'manual', label: '手动推动', amountJ: totals.manualInputJ, tone: 'gold' },
    { key: 'gravity', label: '重力补充', amountJ: totals.gravityJ, tone: 'iris' },
  ] as BalanceRow[]).filter(row => row.amountJ > 0)
  const accounted = ([
    { key: 'contact', label: '接触损耗', amountJ: totals.contactLossJ, tone: 'terracotta' },
    { key: 'friction', label: '摩擦耗散', amountJ: totals.frictionLossJ, tone: 'terracotta' },
    { key: 'residual', label: '未再传递', amountJ: totals.residualJ, tone: 'quiet' },
    { key: 'inflight', label: '滞留/在途', amountJ: totals.inFlightJ, tone: 'sky' },
  ] as BalanceRow[]).filter(row => row.amountJ > 0)
  return { input, accounted }
}

/**
 * Re-derive the input / destination split from the ledger rows visible at a
 * replay time. Each row carries its own provenance, so the running totals are
 * the same numbers the audit trail shows — nothing is invented for the figure.
 */
export function runningBalance(ledger: readonly EnergyLedgerEntry[], time: number): RunningBalance {
  const visible = ledger.filter(entry => entry.time <= time + 1e-9)
  const pendulumJ = visible
    .filter(entry => entry.stage === 'input')
    .reduce((sum, entry) => sum + entry.sources.filter(source => source.origin === 'pendulum').reduce((inner, source) => inner + source.amountJ, 0), 0)
  const manualJ = visible
    .filter(entry => entry.stage === 'input')
    .reduce((sum, entry) => sum + entry.sources.filter(source => source.origin === 'manual').reduce((inner, source) => inner + source.amountJ, 0), 0)
  const gravityJ = visible
    .filter(entry => entry.stage === 'gravity')
    .reduce((sum, entry) => sum + entry.amountJ, 0)
  const lossJ = visible.filter(entry => entry.stage === 'loss').reduce((sum, entry) => sum + entry.amountJ, 0)
  const residualJ = visible.filter(entry => entry.stage === 'residual').reduce((sum, entry) => sum + entry.amountJ, 0)
  const heldJ = visible
    .filter(entry => entry.stage === 'held' && !entry.resolved)
    .reduce((sum, entry) => sum + entry.amountJ, 0)
  const inFlightJ = visible
    .filter(entry => (entry.stage === 'transfer' || entry.stage === 'storage') && entry.deliversAt !== null && entry.deliversAt > time + 1e-9)
    .reduce((sum, entry) => sum + entry.amountJ, 0)

  const input = ([
    { key: 'pendulum', label: '摆锤输入', amountJ: pendulumJ, tone: 'gold' },
    { key: 'manual', label: '手动推动', amountJ: manualJ, tone: 'gold' },
    { key: 'gravity', label: '重力补充', amountJ: gravityJ, tone: 'iris' },
  ] as BalanceRow[]).filter(row => row.amountJ > 1e-9)
  const accounted = ([
    { key: 'loss', label: '已发生损耗', amountJ: lossJ, tone: 'terracotta' },
    { key: 'residual', label: '未再传递', amountJ: residualJ, tone: 'quiet' },
    { key: 'held', label: '滞留', amountJ: heldJ, tone: 'sky' },
    { key: 'inflight', label: '在途', amountJ: inFlightJ, tone: 'sky' },
  ] as BalanceRow[]).filter(row => row.amountJ > 1e-9)
  const inputTotalJ = input.reduce((sum, row) => sum + row.amountJ, 0)
  const accountedTotalJ = accounted.reduce((sum, row) => sum + row.amountJ, 0)
  return {
    input, accounted, inFlightJ, inputTotalJ, accountedTotalJ,
    closed: Math.abs(inputTotalJ - accountedTotalJ) <= 1e-6,
  }
}

export function ledgerByEvent(ledger: readonly EnergyLedgerEntry[]) {
  const grouped = new Map<string, EnergyLedgerEntry[]>()
  for (const entry of ledger) {
    if (!entry.eventId) continue
    const list = grouped.get(entry.eventId) ?? []
    list.push(entry)
    grouped.set(entry.eventId, list)
  }
  return grouped
}

export function entriesForEvent(ledger: readonly EnergyLedgerEntry[], eventId: string | null) {
  if (!eventId) return []
  return ledger.filter(entry => entry.eventId === eventId)
}

export interface SourceRow {
  origin: EnergySource['origin']
  originLabel: string
  pieceId: string
  pieceLabel: string
  amountJ: number
  upstreamId: string | null
}

export function sourceRows(
  entry: EnergyLedgerEntry,
  labels: Record<string, string>,
  ledger: readonly EnergyLedgerEntry[],
): SourceRow[] {
  return entry.sources
    .filter(source => source.amountJ > 1e-9)
    .map(source => {
      let upstreamId = source.viaEntryId ?? null
      if (!upstreamId) {
        if (source.origin === 'gravity') {
          upstreamId = ledger.find(item => item.stage === 'gravity' && item.pieceId === source.pieceId)?.id ?? null
        } else {
          upstreamId = ledger.find(item => item.id === source.entryId)?.id ?? null
        }
      }
      return {
        origin: source.origin,
        originLabel: originLabel(source.origin),
        pieceId: source.pieceId,
        pieceLabel: labels[source.pieceId] ?? source.pieceId,
        amountJ: source.amountJ,
        upstreamId,
      }
    })
    .sort((a, b) => b.amountJ - a.amountJ)
}

/** Follow the largest remaining source backwards until an input / gravity row. */
export function traceChain(
  entry: EnergyLedgerEntry,
  ledger: readonly EnergyLedgerEntry[],
  labels: Record<string, string>,
): { entry: EnergyLedgerEntry; amountJ: number; label: string }[] {
  const chain: { entry: EnergyLedgerEntry; amountJ: number; label: string }[] = []
  let current: EnergyLedgerEntry | undefined = entry
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push({ entry: current, amountJ: current.amountJ, label: describeEntry(current, labels) })
    const next = largestUpstream(current, ledger)
    if (!next) break
    current = next
  }
  return chain.reverse()
}

function largestUpstream(entry: EnergyLedgerEntry, ledger: readonly EnergyLedgerEntry[]) {
  const sources = [...entry.sources].sort((a, b) => b.amountJ - a.amountJ)
  for (const source of sources) {
    const resolved = source.viaEntryId
      ? ledger.find(item => item.id === source.viaEntryId)
      : source.origin === 'gravity'
        ? ledger.find(item => item.stage === 'gravity' && item.pieceId === source.pieceId)
        : ledger.find(item => item.id === source.entryId)
    if (resolved && resolved.id !== entry.id) return resolved
  }
  return undefined
}

export function describeEntry(entry: EnergyLedgerEntry, labels: Record<string, string>) {
  const from = entry.pieceId ? labels[entry.pieceId] ?? entry.pieceId : '—'
  const to = entry.counterpartId ? labels[entry.counterpartId] ?? entry.counterpartId : null
  const route = entry.route ? routeLabel(entry.route) : null
  switch (entry.stage) {
    case 'input': return `${from} · 外部输入`
    case 'gravity': return `${from} · 自身重力`
    case 'check': return `${from} · 触发判定`
    case 'transfer': return to ? `${from} → ${to}${route ? ` · ${route}` : ''}` : `${from} → 下一件`
    case 'loss': return to ? `${from} → ${to} · ${route}损耗` : `${from} · 摩擦损耗`
    case 'storage': return to ? `${from} → ${to} · 坡面储存` : `${from} · 坡面储存`
    case 'release': return to ? `${from} → ${to} · 坡面释放` : `${from} · 坡面释放`
    case 'held': return `${from} · 滞留`
    case 'residual': return to ? `${from} → ${to} · 未再传递` : `${from} · 未再传递`
  }
}

export interface PieceEnergyRow {
  pieceId: string
  label: string
  summary: PieceEnergySummary
  pendulumJ: number
  gravityJ: number
  toppledAt: number | null
}

export function pieceRows(run: SimulationRun): PieceEnergyRow[] {
  const report: EnergyReport = run.energy
  const deliveredPendulum = new Map<string, number>()
  for (const entry of report.ledger) {
    if ((entry.stage === 'transfer' || entry.stage === 'release') && entry.counterpartId) {
      const pendulumJ = entry.sources
        .filter(source => source.origin === 'pendulum')
        .reduce((sum, source) => sum + source.amountJ, 0)
      deliveredPendulum.set(entry.counterpartId, (deliveredPendulum.get(entry.counterpartId) ?? 0) + pendulumJ)
    }
  }
  return report.pieces
    .map(summary => ({
      pieceId: summary.pieceId,
      label: run.pieceLabels[summary.pieceId] ?? summary.pieceId,
      summary,
      pendulumJ: deliveredPendulum.get(summary.pieceId) ?? 0,
      gravityJ: summary.gravityJ,
      toppledAt: run.events.find(event => event.pieceId === summary.pieceId && (event.kind === 'fall' || event.kind === 'mechanism'))?.time ?? null,
    }))
    .sort((a, b) => b.summary.receivedJ - a.summary.receivedJ || a.label.localeCompare(b.label))
}

export function energyEvents(run: SimulationRun) {
  const grouped = ledgerByEvent(run.energy.ledger)
  return run.events
    .filter(event => grouped.has(event.id))
    .map(event => ({ event, entries: grouped.get(event.id) ?? [] }))
}

export function eventPieceLabel(event: SimulationEvent, labels: Record<string, string>) {
  return labels[event.pieceId] ?? event.pieceId
}

export function formatJ(value: number) {
  return `${value.toFixed(2)} J`
}
