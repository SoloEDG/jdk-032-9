import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SimulationRun } from '@/shared/document'
import { createEnergyVerificationDocument } from '@/shared/defaults'
import { propagate } from '@/features/simulation/lib/propagate'
import EnergyAuditPanel from './EnergyAuditPanel.vue'

function buildRun(): SimulationRun {
  const document = createEnergyVerificationDocument()
  const result = propagate(document)
  return {
    id: 'run-test', documentId: document.id, revision: document.revision, startedAt: 0,
    startPieceId: document.startPieceId, status: result.status, events: result.events,
    interruptedPieceId: result.interruptedPieceId, interruptionReason: result.interruptionReason,
    duration: result.duration, pieceLabels: result.pieceLabels,
    energy: { ledger: result.ledger, totals: result.totals, pieces: result.summaries },
  }
}

describe('EnergyAuditPanel', () => {
  it('renders the balance, ledger and source traces', async () => {
    const run = buildRun()
    const wrapper = mount(EnergyAuditPanel, {
      props: { run, time: run.duration, currentEventId: run.events[0]?.id ?? null },
    })

    expect(wrapper.get('.balance-badge').text()).toContain('收支平衡')
    expect(wrapper.text()).toContain('摆锤输入')
    expect(wrapper.text()).toContain('接触损耗')

    const rows = wrapper.findAll('.energy-row-main')
    expect(rows.length).toBeGreaterThan(5)

    // Expand a transfer row and check the provenance / trace controls appear.
    const transferRow = wrapper.findAll('.energy-row.mint .energy-row-main')[0]
    expect(transferRow).toBeTruthy()
    await transferRow.trigger('click')
    expect(wrapper.text()).toContain('能量来源')

    const traceButton = wrapper.findAll('.trace-button').find(button => button.text().includes('追溯来源链'))
    expect(traceButton).toBeTruthy()
    await traceButton!.trigger('click')
    expect(wrapper.findAll('.trace-chain li').length).toBeGreaterThan(0)

    // The piece tab lists per-part accounting and toggles.
    const tabs = wrapper.findAll('.energy-tabs button')
    await tabs[1].trigger('click')
    expect(wrapper.findAll('.piece-energy-row').length).toBe(run.energy.pieces.length)
    expect(wrapper.text()).toContain('摆锤')
  })

  it('keeps rows hidden until the replay clock reaches them', () => {
    const run = buildRun()
    const early = mount(EnergyAuditPanel, { props: { run, time: 0, currentEventId: null } })
    expect(early.findAll('.energy-row.muted').length).toBeGreaterThan(5)
    const late = mount(EnergyAuditPanel, { props: { run, time: run.duration, currentEventId: null } })
    expect(late.findAll('.energy-row.muted').length).toBe(0)
  })
})
