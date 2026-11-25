import { describe, expect, it } from 'vitest'
import type { DominoDocument, EnergyLedgerEntry, EnergySource, Piece } from '@/shared/document'
import { createDefaultDocument, createEnergyVerificationDocument } from '@/shared/defaults'
import { propagate } from './propagate'
import { runningBalance } from '@/features/replay/lib/energyAudit'
import {
  contactLossFactor, frictionRatio, gravityEnergy, toppleRequirement,
} from './energy'

const domino = (id: string, x: number, y: number, label = id): Piece => ({
  id, kind: 'domino', x, y, angle: 0, facing: 'east', label, height: 1.6, width: 0.42,
  fallThreshold: 0.8, friction: 0.55,
})

interface ScenarioOverrides {
  connections?: DominoDocument['connections']
  scene?: Partial<DominoDocument['scene']>
}

function scenario(pieces: Piece[], startPieceId: string, overrides: ScenarioOverrides = {}): DominoDocument {
  return {
    id: 'verify', title: 'verify', revision: 1, updatedAt: 0,
    pieces,
    connections: overrides.connections ?? [],
    scene: { gravity: 9.8, friction: 0.62, width: 24, height: 9, showGrid: true, ...overrides.scene },
    startPieceId,
  }
}

/** Input energy = pendulum reservoir + every part's own gravity contribution. */
function assertBalanced(document: DominoDocument) {
  const result = propagate(document)
  expect(result.totals.balanced).toBe(true)
  expect(Math.abs(result.totals.balanceJ)).toBeLessThan(1e-6)
  return result
}

function ledgerTotal(entries: EnergyLedgerEntry[], predicate: (entry: EnergyLedgerEntry) => boolean) {
  return entries.filter(predicate).reduce((sum, entry) => sum + entry.amountJ, 0)
}

function sumSources(sources: EnergySource[]) {
  return sources.reduce((sum, source) => sum + source.amountJ, 0)
}

describe('energy bookkeeping', () => {
  it('accounts for a single pendulum-driven hit and books gravity per part', () => {
    const document = scenario([
      { ...domino('p1', 0.8, 4, '摆锤'), kind: 'pendulum', energyJ: 30, startAngleDeg: 38 },
      domino('d1', 2.2, 4, 'A'),
      domino('d2', 3.8, 4, 'B'),
    ], 'p1')
    const result = assertBalanced(document)

    expect(result.totals.pendulumInputJ).toBeCloseTo(30, 9)
    expect(result.totals.gravityJ).toBeCloseTo(gravityEnergy(document.pieces[1], 9.8) * 2, 9)

    // The pendulum's provenance reaches both downstream parts.
    for (const entry of result.ledger) {
      if (entry.stage === 'transfer' || entry.stage === 'loss') {
        expect(sumSources(entry.sources)).toBeCloseTo(entry.amountJ, 9)
      }
    }
    const transfersIntoB = result.ledger.filter(entry => entry.stage === 'transfer' && entry.counterpartId === 'd2')
    expect(transfersIntoB.reduce((sum, entry) => sum + entry.amountJ, 0)).toBeGreaterThan(0)
  })

  it('never spends one input twice when a splitter feeds two branches simultaneously', () => {
    const document = scenario([
      { ...domino('p1', 0.8, 4, '摆锤'), kind: 'pendulum', energyJ: 80 },
      domino('d1', 2.2, 4, 'pre'),
      { ...domino('s1', 3.9, 4, '枢纽'), kind: 'splitter', width: 0.75 },
      domino('a1', 5.3, 2.4, 'A1'),
      domino('a2', 5.3, 5.6, 'A2'),
    ], 'p1', {
      connections: [
        { id: 'c1', from: 's1', to: 'a1', delay: 0.15, enabled: true },
        { id: 'c2', from: 's1', to: 'a2', delay: 0.15, enabled: true },
      ],
    })
    const result = assertBalanced(document)

    const splitEntries = result.ledger.filter(entry => entry.groupId && entry.stage === 'transfer')
    const groups = [...new Set(splitEntries.map(entry => entry.groupId))]
    expect(groups.length).toBeGreaterThan(0)
    const multiRoute = groups.filter(groupId =>
      result.ledger.filter(entry => entry.groupId === groupId && entry.stage === 'transfer').length === 2)
    expect(multiRoute.length).toBeGreaterThan(0)

    for (const groupId of multiRoute) {
      const group = result.ledger.filter(entry => entry.groupId === groupId)
      const transfers = group.filter(entry => entry.stage === 'transfer')
      const routeLosses = group.filter(entry => entry.stage === 'loss' && entry.counterpartId !== null)
      expect(transfers.length).toBe(2)
      // Each branch gets 1/2 of the available pool, not the whole pool.
      for (const transfer of transfers) expect(transfer.shareRatio).toBeCloseTo(0.5, 12)
      for (const loss of routeLosses) expect(loss.shareRatio).toBeCloseTo(0.5, 12)
      // Both branches are handed exactly the same share of the pool...
      const poolShares = transfers.map(entry => entry.amountJ + entry.contactLossJ)
      expect(poolShares[0]).toBeCloseTo(poolShares[1], 9)
      // ...and taken together they never exceed the pool. An input recorded
      // once cannot be spent in full twice.
      const pool = poolShares.reduce((sum, share) => sum + share, 0)
      expect(pool).toBeGreaterThan(0)
      expect(transfers.reduce((sum, entry) => sum + entry.amountJ, 0) + routeLosses.reduce((sum, entry) => sum + entry.amountJ, 0))
        .toBeCloseTo(pool, 9)
    }

    // Provenance of both branches is still traceable to the single input entry:
    // the pendulum-origin joules are labelled with the source part, and the
    // energy booked on each branch sums to its own amount.
    const inputEntries = result.ledger.filter(entry => entry.stage === 'input')
    const inputIds = new Set(inputEntries.map(entry => entry.id))
    const pendulumInputJ = result.totals.pendulumInputJ
    for (const entry of splitEntries) {
      expect(entry.sources.length).toBeGreaterThan(0)
      expect(sumSources(entry.sources)).toBeCloseTo(entry.amountJ, 9)
      const pendulumSources = entry.sources.filter(source => source.origin === 'pendulum')
      expect(pendulumSources.length).toBeGreaterThan(0)
      for (const source of pendulumSources) {
        expect(source.pieceId).toBe('p1')
        expect(inputIds.has(source.entryId)).toBe(true)
      }
    }
    // For the splitter activation itself: the two branches plus their contact
    // losses must add up to the one pool the hub actually had available.
    const s1 = document.pieces.find(piece => piece.id === 's1')!
    const intoSplitter = result.ledger
      .filter(entry => (entry.stage === 'transfer' || entry.stage === 'release') && entry.counterpartId === 's1')
      .reduce((sum, entry) => sum + entry.amountJ, 0)
    const splitterPool = intoSplitter + gravityEnergy(s1, document.scene.gravity)
    const splitterAvailable = splitterPool * (1 - frictionRatio(s1, document.scene))
    const hubGroup = result.ledger.filter(entry =>
      entry.groupId !== null && entry.pieceId === 's1'
      && (entry.stage === 'transfer' || entry.stage === 'loss' || entry.stage === 'storage'))
    const hubEmitted = hubGroup.reduce((sum, entry) => sum + entry.amountJ, 0)
    expect(hubEmitted).toBeCloseTo(splitterAvailable, 9)
    expect(hubGroup.filter(entry => entry.stage === 'transfer')).toHaveLength(2)
    // Both branches of the *same* activation carry half the pool each; the
    // input recorded once can never appear in full on both branches.
    const branchPools = hubGroup
      .filter(entry => entry.stage === 'transfer' || (entry.stage === 'loss' && entry.counterpartId !== null))
      .map(entry => entry.amountJ + (entry.stage === 'transfer' ? entry.contactLossJ : 0))
    const branchShares = hubGroup
      .filter(entry => entry.stage === 'transfer')
      .map(entry => entry.amountJ + entry.contactLossJ)
    expect(branchShares[0]).toBeLessThan(splitterAvailable)
    expect(branchShares[1]).toBeLessThan(splitterAvailable)
    expect(branchShares[0]).toBeCloseTo(branchShares[1], 9)
    expect(branchPools.length).toBeGreaterThanOrEqual(2)
  })

  it('lets a ramp bank energy, then release it later rather than at the hub instant', () => {
    const document = scenario([
      { ...domino('p1', 0.8, 4, '摆锤'), kind: 'pendulum', energyJ: 60 },
      domino('d1', 2.2, 4, 'pre'),
      { ...domino('r1', 3.9, 4, '坡道'), kind: 'ramp', width: 1.7, height: 0.45 },
      domino('d2', 5.9, 4, 'after-ramp'),
    ], 'p1')
    const result = assertBalanced(document)

    const storage = result.ledger.filter(entry => entry.stage === 'storage')
    const release = result.ledger.filter(entry => entry.stage === 'release')
    expect(storage.length).toBe(1)
    expect(release.length).toBe(1)
    expect(release[0].time).toBeGreaterThan(storage[0].time)
    expect(storage[0].deliversAt).toBeGreaterThan(storage[0].time)
    // Stored energy is *not* available at the hub instant; it must be re-booked.
    expect(result.totals.storedAtEndJ).toBeCloseTo(0, 9)
    expect(release[0].amountJ).toBeGreaterThan(0)
    expect(sumSources(release[0].sources)).toBeCloseTo(release[0].amountJ, 9)
  })

  it('separates total-input conservation from single-contact sufficiency', () => {
    const document = scenario([
      domino('d1', 1, 4, 'A'),
      domino('d2', 2.6, 4, 'B'),
      domino('d3', 4.2, 4, 'C'),
    ], 'd1')
    // A shared manual push is the input; the middle part must still clear its own threshold.
    const result = assertBalanced(document)
    const checks = result.ledger.filter(entry => entry.stage === 'check')
    expect(checks.length).toBeGreaterThan(0)
    for (const check of checks) {
      expect(check.thresholdJ).not.toBeNull()
      expect(typeof check.sufficient).toBe('boolean')
    }
    // The books balance even when a contact is too weak to topple the target.
    expect(result.totals.balanceJ).toBeCloseTo(0, 9)
  })

  it('keeps a weak contact that fails its threshold as held energy, not as loss', () => {
    const document = scenario([
      { ...domino('p1', 0.8, 4, '摆锤'), kind: 'pendulum', energyJ: 2.0 },
      { ...domino('d1', 2.2, 4, 'heavy'), fallThreshold: 1.6, height: 1.6 },
    ], 'p1')
    const result = assertBalanced(document)
    const absorbed = result.events.filter(event => event.kind === 'absorbed')
    expect(absorbed.length).toBeGreaterThan(0)
    const held = result.ledger.filter(entry => entry.stage === 'held')
    expect(held.length).toBeGreaterThan(0)
    // Held energy is closed into the balance, never double-counted: the
    // closing figure equals the single live (unresolved) row for that part.
    expect(result.totals.heldAtEndJ).toBeGreaterThan(0)
    const liveHeld = held.filter(entry => !entry.resolved)
    expect(liveHeld).toHaveLength(1)
    expect(result.totals.heldAtEndJ).toBeCloseTo(liveHeld[0].amountJ, 9)
    expect(result.interruptedPieceId).toBe('d1')
  })

  it('balances the shipped starter scene', () => {
    const document = createDefaultDocument()
    const result = assertBalanced(document)
    expect(result.ledger.length).toBeGreaterThan(0)
    // Every transfer carries exactly its own amount in provenance.
    for (const entry of result.ledger) {
      expect(sumSources(entry.sources)).toBeCloseTo(entry.amountJ, 6)
    }
    const expectedInput = result.totals.pendulumInputJ + result.totals.manualInputJ + result.totals.gravityJ
    expect(result.totals.inputJ).toBeCloseTo(expectedInput, 9)
  })
})

describe('built-in verification scenario', () => {
  it('runs pendulum → ramp → splitter → simultaneous branches → interrupt', () => {
    const document = createEnergyVerificationDocument()
    const result = assertBalanced(document)

    // Each requested ingredient of the scenario is present.
    const startEvent = result.events.find(event => event.kind === 'input')!
    expect(startEvent.pieceId).toBe('p1')
    expect(result.totals.pendulumInputJ).toBeCloseTo(96, 9)

    const storage = result.ledger.find(entry => entry.stage === 'storage')!
    const release = result.ledger.find(entry => entry.stage === 'release')!
    expect(storage.pieceId).toBe('r1')
    expect(release.time).toBeGreaterThan(storage.time)
    // The stored energy re-enters propagation only after the slope delay, and
    // that later arrival is what starts the splitter.
    const splitterEvent = result.events.find(event => event.pieceId === 's1' && event.kind === 'mechanism')!
    expect(splitterEvent.time).toBeGreaterThan(storage.time)
    expect(splitterEvent.time).toBeGreaterThanOrEqual(release.time)

    const branchTransfers = result.ledger.filter(entry => entry.pieceId === 's1' && entry.stage === 'transfer')
    expect(branchTransfers.map(entry => entry.counterpartId).sort()).toEqual(['a1', 'a2'])
    expect(branchTransfers[0].shareRatio).toBeCloseTo(0.5, 12)
    expect(branchTransfers[1].shareRatio).toBeCloseTo(0.5, 12)
    expect(branchTransfers[0].groupId).toBe(branchTransfers[1].groupId)

    // Both arms hit m1 at the same instant; a single merged pool is booked.
    const armEvents = result.events.filter(event => event.pieceId === 'a1' || event.pieceId === 'a2')
    expect(armEvents).toHaveLength(2)
    expect(armEvents[0].time).toBeCloseTo(armEvents[1].time, 9)
    const mergedCheck = result.ledger.find(entry => entry.stage === 'check' && entry.pieceId === 'm1')!
    expect(mergedCheck.note).toContain('2 路接触合并')
    // The merged pool is exactly the two arms' deliveries; each arm's own
    // gravity is already folded into what it hands over, and nothing is
    // counted twice.
    const armDeliveries = result.ledger
      .filter(entry => entry.stage === 'transfer' && entry.counterpartId === 'm1')
    expect(armDeliveries).toHaveLength(2)
    expect(mergedCheck.amountJ).toBeCloseTo(
      armDeliveries.reduce((sum, entry) => sum + entry.amountJ, 0), 9,
    )
    expect(mergedCheck.amountJ).toBeLessThan(
      result.ledger.find(entry => entry.stage === 'transfer' && entry.counterpartId === 'm1')!.amountJ * 4,
    )
    expect(mergedCheck.sources.length).toBeGreaterThan(2)

    // The run ends by genuinely running out of reach, and the books still close.
    expect(result.status).toBe('interrupted')
    expect(result.interruptedPieceId).toBe('m2')
    expect(result.totals.inputJ - result.totals.accountedJ).toBeCloseTo(0, 9)
    expect(result.events.at(-1)?.kind).toBe('interrupted')
  })

  it('closes the running ledger at every replay instant, with in-flight energy called out', () => {
    const document = createEnergyVerificationDocument()
    const result = propagate(document)
    const times = [0, 0.1, 0.24, 0.48, 0.7, 0.93, 1.0, 1.08, 1.32, 1.56, result.duration]
    for (const time of times) {
      const balance = runningBalance(result.ledger, time)
      expect(balance.closed).toBe(true)
      expect(balance.inputTotalJ).toBeCloseTo(balance.accountedTotalJ, 6)
    }
    // Right after the ramp starts pushing toward the splitter, the stored
    // energy is in flight and not yet double-counted downstream.
    const midRamp = runningBalance(result.ledger, 0.6)
    expect(midRamp.inFlightJ).toBeGreaterThan(0)
    // Stored energy is booked as storage, never as a delivered transfer.
    const storageRows = result.ledger.filter(entry => entry.stage === 'storage')
    expect(storageRows.every(entry => entry.deliversAt !== null && entry.deliversAt! > entry.time)).toBe(true)
  })

  it('labels every joule with its origin so the total can be traced to the source', () => {
    const document = createEnergyVerificationDocument()
    const result = propagate(document)
    const pendulumOrigin = result.ledger
      .filter(entry => entry.stage === 'loss' || entry.stage === 'residual' || entry.stage === 'transfer')
      .flatMap(entry => entry.sources)
      .filter(source => source.origin === 'pendulum')
    // The pendulum's joules actually reach the tail of the chain.
    const tailCheck = result.ledger.find(entry => entry.stage === 'check' && entry.pieceId === 'm2')!
    expect(tailCheck.sources.some(source => source.origin === 'pendulum')).toBe(true)
    expect(pendulumOrigin.length).toBeGreaterThan(0)
    const gravitySources = result.ledger.flatMap(entry => entry.sources).filter(source => source.origin === 'gravity')
    const gravityTotal = gravitySources.reduce((sum, source) => sum + source.amountJ, 0)
    expect(gravityTotal).toBeGreaterThan(0)
    expect(result.totals.gravityJ).toBeLessThan(result.totals.inputJ)
  })
})

describe('friction and loss helpers', () => {
  it('uses scene and part friction coherently', () => {
    const piece = domino('x', 0, 0)
    const scene = { gravity: 9.8, friction: 0.62, width: 10, height: 10, showGrid: true }
    expect(frictionRatio(piece, scene)).toBeGreaterThan(0)
    expect(frictionRatio(piece, scene)).toBeLessThan(0.3)
    expect(contactLossFactor('impact', scene)).toBeGreaterThan(contactLossFactor('link', scene))
    expect(toppleRequirement(piece, 9.8)).toBeLessThan(gravityEnergy(piece, 9.8))
  })
})
