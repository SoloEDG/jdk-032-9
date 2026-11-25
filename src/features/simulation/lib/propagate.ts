import type {
  DominoDocument, EnergyLedgerEntry, EnergyRoute, EnergySource,
  Piece, PieceEnergySummary, SimulationEvent,
} from '@/shared/document'
import { nextContact } from '@/features/layout'
import {
  RAMP_RELEASE_DELAY, contactLossFactor, frictionRatio, gravityEnergy,
  mergeSources, pendulumReservoir, routeLabel, scaleSources, toppleRequirement, totalSources,
} from './energy'

const EPSILON = 1e-9

interface Arrival {
  kind: 'arrival'
  pieceId: string
  time: number
  causeId: string | null
  detail: string
  route: EnergyRoute | null
  sources: EnergySource[]
  seq: number
}

interface Release {
  kind: 'release'
  pieceId: string
  time: number
  causeId: string | null
  detail: string
  route: EnergyRoute
  sources: EnergySource[]
  seq: number
  storedKey: string
  targetId: string
}

type QueueItem = Arrival | Release

interface HeldEnergy {
  sources: EnergySource[]
  total: number
  time: number
  causeId: string | null
  /** One rolling ledger entry per part; updated as more contacts arrive. */
  entryId: string | null
}

interface StoredEnergy {
  sources: EnergySource[]
  total: number
  targetId: string
  availableAt: number
  entryId: string
}

interface RoutePlan {
  route: EnergyRoute
  targetId: string
  delay: number
  detail: string
  physical: boolean
}

function emptySummary(pieceId: string): PieceEnergySummary {
  return {
    pieceId, receivedJ: 0, gravityJ: 0, contactLossJ: 0, frictionLossJ: 0,
    storedJ: 0, releasedJ: 0, heldJ: 0, residualJ: 0, toppled: false,
  }
}

function emptyTotals() {
  return {
    pendulumInputJ: 0, manualInputJ: 0, gravityJ: 0, inputJ: 0, transferJ: 0,
    contactLossJ: 0, frictionLossJ: 0, residualJ: 0, storedAtEndJ: 0, heldAtEndJ: 0,
    inFlightJ: 0, releasedJ: 0, accountedJ: 0, balanceJ: 0, balanced: true,
  }
}

export function propagate(document: DominoDocument) {
  const queue: QueueItem[] = []
  const fallen = new Set<string>()
  const held = new Map<string, HeldEnergy>()
  const stored = new Map<string, StoredEnergy>()
  const events: SimulationEvent[] = []
  const ledger: EnergyLedgerEntry[] = []
  const summaries = new Map<string, PieceEnergySummary>()
  const pieceLabels: Record<string, string> = {}

  let eventSeq = 0
  let ledgerSeq = 0
  let queueSeq = 0
  let groupSeq = 0
  let interruptedPieceId: string | null = null
  let interruptionReason: string | null = null
  let interruptedAt = -Infinity
  let reachedTrigger = false

  let pendulumInputJ = 0
  let manualInputJ = 0
  let gravityTotalJ = 0
  let contactLossTotalJ = 0
  let frictionLossTotalJ = 0
  let residualTotalJ = 0
  let transferTotalJ = 0
  let releasedTotalJ = 0

  const gravity = document.scene.gravity
  const pieceById = (id: string) => document.pieces.find(piece => piece.id === id)
  for (const piece of document.pieces) pieceLabels[piece.id] = piece.label

  function summary(pieceId: string) {
    let entry = summaries.get(pieceId)
    if (!entry) { entry = emptySummary(pieceId); summaries.set(pieceId, entry) }
    return entry
  }

  function pushEvent(event: Omit<SimulationEvent, 'id'>) {
    const created: SimulationEvent = { id: `event-${++eventSeq}`, ...event }
    events.push(created)
    return created
  }

  function pushLedger(entry: Omit<EnergyLedgerEntry, 'id' | 'deliversAt' | 'resolved'> & Partial<Pick<EnergyLedgerEntry, 'deliversAt' | 'resolved'>>) {
    const created: EnergyLedgerEntry = {
      id: `energy-${String(++ledgerSeq).padStart(3, '0')}`,
      deliversAt: null,
      resolved: true,
      ...entry,
    }
    ledger.push(created)
    return created
  }

  function markInterrupted(pieceId: string, time: number, causeId: string | null, reason: string) {
    // "Final interruption" is the last break in the chain, not the first one.
    if (time >= interruptedAt) {
      interruptedAt = time
      interruptedPieceId = pieceId
      interruptionReason = reason
    }
  }

  /* ------------------------------------------------------------------ *
   * Start-up: the pendulum reservoir (or a manual push) is the only
   * external input. Everything downstream is attributed back to it.
   * ------------------------------------------------------------------ */
  const startPiece = pieceById(document.startPieceId) ?? document.pieces[0]
  if (!startPiece) {
    return {
      events, ledger, summaries: [] as PieceEnergySummary[], status: 'empty' as const,
      interruptedPieceId, interruptionReason, reachedTrigger, duration: 0,
      pieceLabels, totals: emptyTotals(),
    }
  }

  const isPendulum = startPiece.kind === 'pendulum'
  const startRequirement = toppleRequirement(startPiece, gravity)
  const reservoirJ = isPendulum ? pendulumReservoir(startPiece) : Math.max(startRequirement * 1.02, 0.2)
  if (isPendulum) pendulumInputJ += reservoirJ
  else manualInputJ += reservoirJ

  const startEvent = pushEvent({
    pieceId: startPiece.id, time: 0, causeId: null, kind: 'input',
    detail: isPendulum ? '摆锤释放 · 驱动起点' : '手动触发 · 驱动起点',
  })
  const inputEntry = pushLedger({
    eventId: startEvent.id, time: 0, stage: 'input', pieceId: startPiece.id, counterpartId: null,
    route: null, amountJ: reservoirJ, sources: [],
    shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
    contactLossJ: 0, thresholdJ: null, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
    note: isPendulum
      ? `摆锤势能 ${reservoirJ.toFixed(2)} J，作为外部输入全额计入`
      : '手动推动作为外部输入',
  })
  const startSources: EnergySource[] = [{
    entryId: inputEntry.id,
    pieceId: startPiece.id,
    origin: isPendulum ? 'pendulum' : 'manual',
    amountJ: reservoirJ,
  }]
  inputEntry.sources = startSources.map(source => ({ ...source }))
  fallen.add(startPiece.id)
  summary(startPiece.id).toppled = true
  release(startPiece, startEvent, 0, startSources, inputEntry.id)

  /* ------------------------------------------------------------------ *
   * Main loop: deterministic time-ordered arrival processing.
   * ------------------------------------------------------------------ */
  const limit = Math.max(400, document.pieces.length * 24)
  while (queue.length && events.length < limit) {
    queue.sort((a, b) => a.time - b.time || kindRank(a) - kindRank(b)
      || a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
    const next = queue.shift()!

    if (next.kind === 'release') {
      processRelease(next)
      continue
    }

    // Same part, same instant: merge every incoming branch into one pool.
    const companions: Arrival[] = []
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index]
      if (item.kind === 'arrival' && item.pieceId === next.pieceId && Math.abs(item.time - next.time) < 1e-9) {
        companions.push(item)
        queue.splice(index, 1)
      }
    }
    const sources = next.sources.map(source => ({ ...source }))
    for (const companion of companions) mergeSources(sources, companion.sources)
    const causeId = next.causeId ?? companions.map(item => item.causeId).find(Boolean) ?? null
    activate(next.pieceId, next.time, causeId, next.detail, sources, companions.length + 1)
  }

  /* ------------------------------------------------------------------ *
   * Leftover held / stored energy closes the books.
   * ------------------------------------------------------------------ */
  let heldAtEndJ = 0
  for (const [pieceId, entry] of held) {
    heldAtEndJ += entry.total
    summary(pieceId).heldJ = entry.total
    const thresholdJ = toppleRequirement(pieceById(pieceId) ?? startPiece, gravity)
    if (entry.entryId) {
      const heldEntry = ledger.find(item => item.id === entry.entryId)
      if (heldEntry) heldEntry.note = '回放结束时能量仍未达到触发门槛，滞留原地'
    }
    markInterrupted(pieceId, entry.time, entry.causeId,
      `到达能量 ${entry.total.toFixed(2)} J 低于 ${thresholdJ.toFixed(2)} J 触发门槛，链路在此中断。`)
  }

  let storedAtEndJ = 0
  for (const entry of stored.values()) storedAtEndJ += entry.total

  // Anything still queued (only possible when the safety limit was hit) is
  // energy in flight: it left one part but never landed.
  let inFlightJ = 0
  for (const item of queue) {
    if (item.kind === 'arrival') inFlightJ += totalSources(item.sources)
  }

  const gravityJ = gravityTotalJ
  const inFlight = storedAtEndJ + heldAtEndJ + inFlightJ
  const accountedJ = contactLossTotalJ + frictionLossTotalJ + residualTotalJ + inFlight
  const inputJ = pendulumInputJ + manualInputJ + gravityJ
  const balanceJ = inputJ - accountedJ
  const duration = Math.max(events.at(-1)?.time ?? 0, ledger.at(-1)?.time ?? 0)

  return {
    events: [...events].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)),
    ledger,
    summaries: [...summaries.values()],
    status: events.length === 0 ? 'empty' as const
      : interruptedPieceId !== null || !reachedTrigger ? 'interrupted' as const : 'complete' as const,
    interruptedPieceId,
    interruptionReason,
    reachedTrigger,
    duration,
    pieceLabels,
    totals: {
      pendulumInputJ, manualInputJ, gravityJ, inputJ,
      transferJ: transferTotalJ, contactLossJ: contactLossTotalJ, frictionLossJ: frictionLossTotalJ,
      residualJ: residualTotalJ, storedAtEndJ, heldAtEndJ, inFlightJ: inFlight,
      releasedJ: releasedTotalJ, accountedJ, balanceJ, balanced: Math.abs(balanceJ) <= 1e-6,
    },
  }

  /* ------------------------------------------------------------------ */

  function activate(
    pieceId: string, time: number, causeId: string | null, detail: string,
    incoming: EnergySource[], arrivalCount = 1,
  ) {
    const piece = pieceById(pieceId)
    if (!piece) return
    const arrivalJ = totalSources(incoming)
    const part = summary(pieceId)

    // Energy that lands on an already-fallen part slides off as heat.
    if (fallen.has(pieceId)) {
      if (arrivalJ > EPSILON) {
        part.residualJ += arrivalJ
        residualTotalJ += arrivalJ
        pushLedger({
          eventId: causeId, time, stage: 'residual', pieceId, counterpartId: null, route: null,
          amountJ: arrivalJ, sources: incoming.map(source => ({ ...source })),
          shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
          contactLossJ: 0, thresholdJ: null, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
          note: '目标已倒下，这部分能量未再参与传播',
        })
      }
      return
    }

    part.receivedJ += arrivalJ
    const previousHeld = held.get(pieceId) ?? null
    if (previousHeld) {
      mergeSources(incoming, previousHeld.sources)
      if (previousHeld.entryId) {
        const entry = ledger.find(item => item.id === previousHeld.entryId)
        if (entry) {
          entry.resolved = true
          entry.note = `${entry.note}；已在 t=${time.toFixed(2)} s 并入后续接触`
        }
      }
      held.delete(pieceId)
    }
    const poolJ = totalSources(incoming)
    const thresholdJ = toppleRequirement(piece, gravity)
    const sufficient = poolJ + EPSILON >= thresholdJ

    const checkEntry = pushLedger({
      eventId: causeId, time, stage: 'check', pieceId, counterpartId: null, route: null,
      amountJ: poolJ, sources: incoming.map(source => ({ ...source })),
      shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
      contactLossJ: 0, thresholdJ, sufficient,
      heldBeforeJ: previousHeld?.total ?? null, heldAfterJ: null,
      note: sufficient
        ? arrivalCount > 1
          ? `同一刻 ${arrivalCount} 路接触合并为 1 个能量池：本轮到达 ${arrivalJ.toFixed(2)} J，累计 ${poolJ.toFixed(2)} J ≥ 门槛 ${thresholdJ.toFixed(2)} J，足以触发`
          : `本轮到达 ${arrivalJ.toFixed(2)} J，累计可支配 ${poolJ.toFixed(2)} J ≥ 门槛 ${thresholdJ.toFixed(2)} J，足以触发`
        : arrivalCount > 1
          ? `同一刻 ${arrivalCount} 路接触合并为 1 个能量池：累计 ${poolJ.toFixed(2)} J < 门槛 ${thresholdJ.toFixed(2)} J，暂不触发`
          : `本轮到达 ${arrivalJ.toFixed(2)} J，累计可支配 ${poolJ.toFixed(2)} J < 门槛 ${thresholdJ.toFixed(2)} J，暂不触发`,
    })

    if (!sufficient) {
      let target = held.get(pieceId)
      if (!target) {
        target = { sources: [], total: 0, time, causeId, entryId: null }
        held.set(pieceId, target)
      }
      mergeSources(target.sources, incoming)
      target.total = totalSources(target.sources)
      target.time = time
      target.causeId = causeId
      const absorbed = pushEvent({
        pieceId, time, causeId, kind: 'absorbed',
        detail: `能量不足 · ${target.total.toFixed(2)} / ${thresholdJ.toFixed(2)} J`,
      })
      // One rolling entry holds all of this part's banked energy; later
      // contacts raise it instead of adding a second, overlapping row.
      const heldEntry = pushLedger({
        eventId: absorbed.id, time, stage: 'held', pieceId, counterpartId: null, route: null,
        amountJ: target.total, sources: target.sources.map(source => ({ ...source })),
        shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
        contactLossJ: 0, thresholdJ, sufficient: false,
        heldBeforeJ: target.total - arrivalJ, heldAfterJ: target.total,
        resolved: false,
        note: '能量暂存于元件根部，等待后续接触补足',
      })
      if (target.entryId) {
        const stale = ledger.find(item => item.id === target.entryId)
        if (stale) stale.note = `${stale.note}（已被 t=${time.toFixed(2)} s 的累积滞留记录取代）`
      }
      target.entryId = heldEntry.id
      checkEntry.eventId = heldEntry.id
      return
    }

    fallen.add(pieceId)
    part.toppled = true
    const event = pushEvent({
      pieceId, time, causeId,
      kind: piece.kind === 'splitter' || piece.kind === 'trigger' ? 'mechanism' : 'fall',
      detail: piece.kind === 'splitter' ? `分岔展开 · ${detail}`
        : piece.kind === 'trigger' ? `触发器响应 · ${detail}`
          : piece.kind === 'ramp' ? `坡道传递 · ${detail}` : `受力倒下 · ${detail}`,
    })
    checkEntry.eventId = event.id

    if (piece.kind === 'trigger') reachedTrigger = true
    release(piece, event, time, incoming, checkEntry.id)
  }

  /**
   * Distribute a part's energy pool into routes. Every joule leaving the pool
   * is booked exactly once: pivot friction, interface loss, storage, or delivery.
   */
  function release(piece: Piece, event: SimulationEvent, time: number, incoming: EnergySource[], viaEntryId: string | null) {
    const sources = incoming.map(source => ({ ...source, viaEntryId: viaEntryId ?? source.viaEntryId ?? null }))
    const gravityJ = gravityEnergy(piece, gravity)
    if (gravityJ > EPSILON) {
      const source: EnergySource = {
        entryId: `gravity-${piece.id}`, pieceId: piece.id, origin: 'gravity', amountJ: gravityJ,
      }
      mergeSources(sources, [source])
      gravityTotalJ += gravityJ
      summary(piece.id).gravityJ += gravityJ
      pushLedger({
        eventId: event.id, time, stage: 'gravity', pieceId: piece.id, counterpartId: null, route: null,
        amountJ: gravityJ, sources: [{ ...source }],
        shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
        contactLossJ: 0, thresholdJ: null, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
        note: `重心下降补充 ${gravityJ.toFixed(2)} J（m·g·h/2）`,
      })
    }
    const bundleJ = totalSources(sources)
    const lostToPivot = bundleJ * frictionRatio(piece, document.scene)
    const availableJ = bundleJ - lostToPivot
    const pivotLoss = scaleSources(sources, bundleJ ? lostToPivot / bundleJ : 0)
    const available = scaleSources(sources, bundleJ ? availableJ / bundleJ : 0)
    if (lostToPivot > EPSILON) {
      frictionLossTotalJ += lostToPivot
      summary(piece.id).frictionLossJ += lostToPivot
      pushLedger({
        eventId: event.id, time, stage: 'loss', pieceId: piece.id, counterpartId: null, route: null,
        amountJ: lostToPivot, sources: pivotLoss,
        shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
        contactLossJ: 0, thresholdJ: null, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
        note: '枢轴转动与底面摩擦耗散',
      })
    }

    const routes = planRoutes(piece)
    if (!routes.length) {
      if (availableJ > EPSILON) {
        residualTotalJ += availableJ
        summary(piece.id).residualJ += availableJ
        pushLedger({
          eventId: event.id, time, stage: 'residual', pieceId: piece.id, counterpartId: null, route: null,
          amountJ: availableJ, sources: available.map(source => ({ ...source })),
          shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
          contactLossJ: 0, thresholdJ: null, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
          note: '没有可接续的元件，剩余能量散失',
        })
      }
      if (piece.kind !== 'trigger') {
        markInterrupted(piece.id, time, event.id, '倒下方向内没有可触达的元件，链路在此停止。')
        pushEvent({
          pieceId: piece.id, time: time + 0.05, causeId: event.id, kind: 'interrupted',
          detail: '倒下方向内没有可触达的元件，链路在此停止。',
        })
      }
      return
    }

    const shareRatio = 1 / routes.length
    const groupId = `split-${++groupSeq}`
    routes.forEach((route, routeIndex) => {
      const shareJ = availableJ * shareRatio
      const target = pieceById(route.targetId)
      if (!target) return
      const targetThreshold = toppleRequirement(target, gravity)
      // The provenance of this branch is carved out of the *available* pool,
      // never out of the pre-friction bundle, so the shares add back exactly.
      const shareProvenance = scaleSources(available, shareRatio)

      if (route.route === 'release') {
        // A ramp banks potential energy and hands it on later.
        const key = `${piece.id}->${route.targetId}`
        const availableAt = time + RAMP_RELEASE_DELAY
        const storageEntry = pushLedger({
          eventId: event.id, time, stage: 'storage', pieceId: piece.id, counterpartId: route.targetId,
          route: 'release', amountJ: shareJ, sources: shareProvenance.map(source => ({ ...source })),
          shareRatio, routeIndex, routeCount: routes.length, groupId,
          contactLossJ: 0, thresholdJ: targetThreshold, sufficient: null,
          heldBeforeJ: null, heldAfterJ: null, deliversAt: availableAt, resolved: false,
          note: `坡面先储存 ${shareJ.toFixed(2)} J，${RAMP_RELEASE_DELAY.toFixed(2)} s 后才重新参与传播`,
        })
        stored.set(key, {
          sources: shareProvenance, total: shareJ, targetId: route.targetId,
          availableAt, entryId: storageEntry.id,
        })
        summary(piece.id).storedJ += shareJ
        queue.push({
          kind: 'release', pieceId: piece.id, targetId: route.targetId, time: availableAt,
          causeId: event.id, detail: route.detail, route: 'release', sources: [], seq: ++queueSeq,
          storedKey: key,
        })
        return
      }

      const lossFactor = contactLossFactor(route.route, document.scene)
      const contactLossJ = shareJ * lossFactor
      const deliveredJ = shareJ - contactLossJ
      const deliveredProvenance = scaleSources(available, shareRatio * (1 - lossFactor))

      if (contactLossJ > EPSILON) {
        contactLossTotalJ += contactLossJ
        summary(piece.id).contactLossJ += contactLossJ
        pushLedger({
          eventId: event.id, time, stage: 'loss', pieceId: piece.id, counterpartId: route.targetId,
          route: route.route, amountJ: contactLossJ,
          sources: scaleSources(available, shareRatio * lossFactor),
          shareRatio, routeIndex, routeCount: routes.length, groupId,
          contactLossJ, thresholdJ: targetThreshold, sufficient: null,
          heldBeforeJ: null, heldAfterJ: null,
          note: `${routeLabel(route.route)}界面损耗（${(lossFactor * 100).toFixed(0)}%）`,
        })
      }
      transferTotalJ += deliveredJ
      const transferEntry = pushLedger({
        eventId: event.id, time, stage: 'transfer', pieceId: piece.id, counterpartId: route.targetId,
        route: route.route, amountJ: deliveredJ, sources: deliveredProvenance,
        shareRatio, routeIndex, routeCount: routes.length, groupId,
        contactLossJ, thresholdJ: targetThreshold, sufficient: null,
        heldBeforeJ: null, heldAfterJ: null, deliversAt: time + route.delay,
        note: routes.length > 1
          ? `第 ${routeIndex + 1}/${routes.length} 条支路获得 ${(shareRatio * 100).toFixed(0)}% 份额（${deliveredJ.toFixed(2)} J）`
          : '全部可用能量送往下一件元件',
      })
      queue.push({
        kind: 'arrival', pieceId: route.targetId, time: time + route.delay, causeId: event.id,
        detail: route.detail, route: route.route,
        sources: deliveredProvenance.map(source => ({ ...source, viaEntryId: transferEntry.id })),
        seq: ++queueSeq,
      })
    })
  }

  function processRelease(task: Release) {
    const boss = pieceById(task.pieceId)
    const target = pieceById(task.targetId)
    const entry = stored.get(task.storedKey)
    if (!boss || !target || !entry) return
    stored.delete(task.storedKey)
    const storageLedgerEntry = ledger.find(item => item.id === entry.entryId)
    if (storageLedgerEntry) {
      storageLedgerEntry.resolved = true
      storageLedgerEntry.note = `${storageLedgerEntry.note}；已在 t=${task.time.toFixed(2)} s 释放`
    }
    const thresholdJ = toppleRequirement(target, gravity)
    const availableJ = entry.total

    if (fallen.has(target.id)) {
      residualTotalJ += availableJ
      summary(boss.id).residualJ += availableJ
      pushLedger({
        eventId: task.causeId, time: task.time, stage: 'residual', pieceId: boss.id, counterpartId: target.id,
        route: 'release', amountJ: availableJ, sources: entry.sources.map(source => ({ ...source })),
        shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
        contactLossJ: 0, thresholdJ, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
        note: '坡道释放时目标已倒下，储存能量散失',
      })
      return
    }

    const lossFactor = contactLossFactor('release', document.scene)
    const lossJ = availableJ * lossFactor
    const deliveredJ = availableJ - lossJ
    contactLossTotalJ += lossJ
    summary(boss.id).contactLossJ += lossJ
    summary(boss.id).releasedJ += deliveredJ
    pushLedger({
      eventId: task.causeId, time: task.time, stage: 'loss', pieceId: boss.id, counterpartId: target.id,
      route: 'release', amountJ: lossJ,
      sources: scaleSources(entry.sources, availableJ ? lossJ / availableJ : 0),
      shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
      contactLossJ: lossJ, thresholdJ, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
      note: `坡面释放界面损耗（${(lossFactor * 100).toFixed(0)}%）`,
    })
    const deliveredProvenance = scaleSources(entry.sources, availableJ ? deliveredJ / availableJ : 0)
    releasedTotalJ += availableJ
    transferTotalJ += deliveredJ
    pushLedger({
      eventId: task.causeId, time: task.time, stage: 'release', pieceId: boss.id, counterpartId: target.id,
      route: 'release', amountJ: deliveredJ, sources: deliveredProvenance,
      shareRatio: null, routeIndex: null, routeCount: null, groupId: null,
      contactLossJ: lossJ, thresholdJ, sufficient: null, heldBeforeJ: null, heldAfterJ: null,
      deliversAt: task.time + 1e-6,
      note: `储存势能解冻，${deliveredJ.toFixed(2)} J 重新送往下一件元件`,
    })
    queue.push({
      kind: 'arrival', pieceId: target.id, time: task.time + 1e-6, causeId: task.causeId,
      detail: task.detail, route: 'release', sources: deliveredProvenance, seq: ++queueSeq,
    })
  }

  function planRoutes(piece: Piece): RoutePlan[] {
    const routes: RoutePlan[] = []
    const links = document.connections.filter(link => link.from === piece.id && link.enabled)
    for (const link of links) {
      if (!pieceById(link.to) || link.to === piece.id) continue
      if (routes.some(route => route.targetId === link.to)) continue
      routes.push({ route: 'link', targetId: link.to, delay: link.delay, detail: '机关连线', physical: false })
    }
    if (piece.kind === 'trigger') return routes

    const available = document.pieces.filter(item => !fallen.has(item.id) && item.id !== piece.id)
    const surfaceGrip = (document.scene.friction + piece.friction) / 2
    const reachScale = (0.94 + surfaceGrip * 0.35) * (1.25 - piece.fallThreshold * 0.25)
    let target: Piece | null = null
    if (piece.kind === 'ramp') {
      target = available.filter(item => item.x > piece.x && Math.abs(item.y - piece.y) < 2.1)
        .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))[0] ?? null
    } else {
      target = nextContact(piece, available, reachScale)
    }
    if (!target) return routes
    // If the same part is already wired, keep the wire as the single route so
    // one pool of energy is never booked twice onto one branch.
    if (routes.some(route => route.targetId === target!.id)) return routes

    const separation = Math.hypot(piece.x - target.x, piece.y - target.y)
    const speed = Math.max(1.8, piece.height * document.scene.gravity / 2) * (0.75 + surfaceGrip * 0.5)
    const travel = Math.max(0.24, separation / speed)
    routes.push({
      route: piece.kind === 'pendulum' ? 'pendulum' : piece.kind === 'ramp' ? 'release' : 'impact',
      targetId: target.id,
      delay: piece.kind === 'ramp' ? RAMP_RELEASE_DELAY : travel,
      detail: piece.kind === 'splitter' ? '分岔臂接触' : piece.kind === 'ramp' ? '坡面末端接触' : '相邻接触',
      physical: true,
    })
    return routes
  }
}

function kindRank(item: QueueItem) {
  return item.kind === 'release' ? 0 : 1
}
