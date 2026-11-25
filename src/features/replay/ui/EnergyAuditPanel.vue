<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowDown, ArrowUp, Check, CircleAlert } from '@lucide/vue'
import type { EnergyLedgerEntry, SimulationRun } from '@/shared/document'
import {
  balanceRows, describeEntry, energyEvents, formatJ, pieceRows, runningBalance, sourceRows,
  stageStyles, traceChain,
} from '../lib/energyAudit'

const props = defineProps<{
  run: SimulationRun
  time: number
  currentEventId: string | null
}>()
const emit = defineEmits<{ event: [string]; piece: [string] }>()
const mode = ref<'ledger' | 'pieces'>('ledger')
const expanded = ref<string | null>(null)
const tracing = ref<string | null>(null)

const atEnd = computed(() => props.time >= props.run.duration - 1e-9)
const running = computed(() => runningBalance(props.run.energy.ledger, props.time))
const finalRows = computed(() => balanceRows(props.run.energy.totals))
const rows = computed(() => atEnd.value ? finalRows.value : { input: running.value.input, accounted: running.value.accounted })
const inputTotalJ = computed(() => atEnd.value ? props.run.energy.totals.inputJ : running.value.inputTotalJ)
const accountedTotalJ = computed(() => atEnd.value ? props.run.energy.totals.accountedJ : running.value.accountedTotalJ)
const balanced = computed(() => atEnd.value ? props.run.energy.totals.balanced : running.value.closed)
const balanceDelta = computed(() => atEnd.value ? props.run.energy.totals.balanceJ : running.value.inputTotalJ - running.value.accountedTotalJ)
const groupedEvents = computed(() => energyEvents(props.run))
const totals = computed(() => props.run.energy.totals)
const pieces = computed(() => pieceRows(props.run))
const ledger = computed(() => props.run.energy.ledger)

function isVisible(entry: EnergyLedgerEntry) {
  return entry.time <= props.time + 1e-9
}

function eventLedger(entries: EnergyLedgerEntry[]) {
  return entries.filter(entry => entry.stage !== 'check')
}

function deltaFor(stage: string, entry: EnergyLedgerEntry) {
  switch (stage) {
    case 'input':
    case 'gravity':
    case 'transfer':
    case 'release':
      return `+${entry.amountJ.toFixed(2)}`
    case 'loss':
    case 'residual':
      return `−${entry.amountJ.toFixed(2)}`
    case 'storage':
      return `⇒${entry.amountJ.toFixed(2)}`
    case 'held':
      return `⏸${entry.amountJ.toFixed(2)}`
    default:
      return entry.amountJ.toFixed(2)
  }
}

function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
  tracing.value = null
}

function trace(entry: EnergyLedgerEntry) {
  tracing.value = tracing.value === entry.id ? null : entry.id
}

function chainFor(entry: EnergyLedgerEntry) {
  return traceChain(entry, ledger.value, props.run.pieceLabels)
}

function originTone(origin: string) {
  return origin === 'pendulum' ? 'gold' : origin === 'gravity' ? 'iris' : origin === 'slope' ? 'mint' : 'quiet'
}

function barWidth(amountJ: number, pool: number) {
  if (!pool) return '0%'
  return `${Math.max(2, Math.min(100, amountJ / pool * 100))}%`
}
</script>

<template>
  <section class="energy-panel" aria-labelledby="energy-title">
    <div class="energy-heading">
      <div class="section-kicker"><span>06 / ENERGY</span><h2 id="energy-title">能量收支</h2></div>
      <span class="balance-badge" :class="{ unbalanced: !balanced }">
        <Check v-if="balanced" :size="12" /><CircleAlert v-else :size="12" />
        {{ balanced ? (atEnd ? '收支平衡' : '此刻收支平衡') : `差额 ${balanceDelta.toFixed(2)} J` }}
      </span>
    </div>

    <div class="balance-figure">
      <div class="balance-side">
        <span class="balance-caption"><ArrowDown :size="12" /> 输入</span>
        <strong class="mono">{{ formatJ(inputTotalJ) }}</strong>
        <div class="balance-bar">
          <i v-for="row in rows.input" :key="row.key" :class="row.tone" :style="{ width: barWidth(row.amountJ, inputTotalJ) }" :title="`${row.label} ${formatJ(row.amountJ)}`"></i>
        </div>
        <ul class="balance-legend">
          <li v-for="row in rows.input" :key="row.key"><span :class="['legend-dot', row.tone]"></span>{{ row.label }}<b class="mono">{{ formatJ(row.amountJ) }}</b></li>
        </ul>
      </div>
      <div class="balance-equals">＝</div>
      <div class="balance-side">
        <span class="balance-caption"><ArrowUp :size="12" /> 去向</span>
        <strong class="mono">{{ formatJ(accountedTotalJ) }}</strong>
        <div class="balance-bar">
          <i v-for="row in rows.accounted" :key="row.key" :class="row.tone" :style="{ width: barWidth(row.amountJ, inputTotalJ) }" :title="`${row.label} ${formatJ(row.amountJ)}`"></i>
        </div>
        <ul class="balance-legend">
          <li v-for="row in rows.accounted" :key="row.key"><span :class="['legend-dot', row.tone]"></span>{{ row.label }}<b class="mono">{{ formatJ(row.amountJ) }}</b></li>
        </ul>
      </div>
    </div>
    <p class="balance-note">
      {{ atEnd
        ? '总量守恒是整场回放的账；单次接触是否足以触发另见“触发判定”，二者分开核算。'
        : `当前回放 ${time.toFixed(2)} s：在途 ${formatJ(running.inFlightJ)} 尚未送达，账目按此刻可见的记录结算。` }}
    </p>

    <div class="energy-tabs" role="tablist">
      <button role="tab" :aria-selected="mode === 'ledger'" :class="{ active: mode === 'ledger' }" @click="mode = 'ledger'">能量流水</button>
      <button role="tab" :aria-selected="mode === 'pieces'" :class="{ active: mode === 'pieces' }" @click="mode = 'pieces'">按部件</button>
    </div>

    <template v-if="mode === 'ledger'">
      <ol class="energy-timeline">
        <li v-for="{ event, entries } in groupedEvents" :key="event.id">
          <div class="energy-event-heading" :class="{ current: event.id === currentEventId }">
            <button class="energy-event-jump" @click="emit('event', event.id)">
              <span class="mono">{{ event.time.toFixed(2) }}s</span>
              <strong>{{ describeEntry(entries[0], run.pieceLabels) }}</strong>
            </button>
            <span v-if="event.kind === 'input'" class="energy-chip input">外部输入</span>
            <span v-else-if="event.kind === 'absorbed'" class="energy-chip held">滞留</span>
            <span v-else-if="event.kind === 'interrupted'" class="energy-chip halt">中断</span>
          </div>
          <ul class="energy-rows">
            <li v-for="entry in eventLedger(entries)" :key="entry.id" :class="['energy-row', stageStyles[entry.stage].tone, { muted: !isVisible(entry) }]">
              <button class="energy-row-main" :aria-expanded="expanded === entry.id" @click="toggle(entry.id)">
                <span class="energy-route">{{ describeEntry(entry, run.pieceLabels) }}</span>
                <span class="energy-stage">{{ stageStyles[entry.stage].label }}</span>
                <span class="energy-amount mono">{{ deltaFor(entry.stage, entry) }} J</span>
              </button>              <div v-if="expanded === entry.id" class="energy-detail">
                <div v-if="entry.shareRatio !== null && entry.routeCount && entry.routeCount > 1" class="share-note">
                  支路 {{ (entry.routeIndex ?? 0) + 1 }}/{{ entry.routeCount }} · 份额 {{ (entry.shareRatio * 100).toFixed(0) }}%
                  <template v-if="entry.route === 'link' || entry.route === 'impact'">（同一份输入不会完整记在两条支路上）</template>
                </div>
                <div v-if="entry.thresholdJ !== null" class="threshold-note">
                  触发门槛 <b class="mono">{{ formatJ(entry.thresholdJ) }}</b>
                  <span v-if="entry.sufficient === true" class="verdict pass">本次足够</span>
                  <span v-else-if="entry.sufficient === false" class="verdict fail">本次不足</span>
                </div>
                <div v-if="entry.contactLossJ > 0 && entry.stage === 'transfer'" class="sub-loss">
                  该支路另有接触损耗 <b class="mono">{{ formatJ(entry.contactLossJ) }}</b>
                </div>
                <div v-if="entry.deliversAt !== null" class="threshold-note">
                  送达时刻 <b class="mono">{{ entry.deliversAt.toFixed(2) }} s</b>
                  <span v-if="time + 1e-9 < entry.deliversAt" class="verdict hold">此时尚未送达</span>
                  <span v-else class="verdict pass">已送达</span>
                </div>
                <p class="energy-note">{{ entry.note }}</p>
                <div class="source-list">
                  <span class="source-caption">能量来源</span>
                  <div v-for="(source, index) in sourceRows(entry, run.pieceLabels, ledger)" :key="index" class="source-row">
                    <span :class="['legend-dot', originTone(source.origin)]"></span>
                    <span>{{ source.originLabel }} · {{ source.pieceLabel }}</span>
                    <b class="mono">{{ source.amountJ.toFixed(2) }} J</b>
                    <button v-if="source.upstreamId" class="trace-button" @click="emit('event', ledger.find(item => item.id === source.upstreamId)?.eventId ?? '')">追到上游</button>
                  </div>
                </div>
                <div class="detail-actions">
                  <button class="trace-button" @click="trace(entry)">{{ tracing === entry.id ? '收起来源链' : '追溯来源链' }}</button>
                  <button v-if="entry.counterpartId" class="trace-button" @click="emit('piece', entry.counterpartId)">定位接收元件</button>
                </div>
                <ol v-if="tracing === entry.id" class="trace-chain">
                  <li v-for="(link, index) in chainFor(entry)" :key="link.entry.id">
                    <span class="chain-index mono">{{ index + 1 }}</span>
                    <span class="chain-label">{{ link.entry.stage === 'input' || link.entry.stage === 'gravity' ? '源头 · ' : '' }}{{ link.label }}</span>
                    <b class="mono">{{ link.entry.amountJ.toFixed(2) }} J</b>
                  </li>
                </ol>
                <button class="source-jump" @click="emit('event', entry.eventId ?? '')">在事件轨迹中定位</button>
              </div>
            </li>
          </ul>
        </li>
      </ol>
    </template>

    <template v-else>
      <ul class="piece-energy-list">
        <li v-for="row in pieces" :key="row.pieceId">
          <button class="piece-energy-row" @click="emit('piece', row.pieceId)">
            <span class="piece-energy-name">{{ row.label }}<small class="mono">{{ row.pieceId }}</small></span>
            <span class="piece-energy-time mono">{{ row.toppledAt === null ? '未触发' : `${row.toppledAt.toFixed(2)}s` }}</span>
            <span class="piece-energy-flow">
              <span class="flow-chip receive">收 {{ row.summary.receivedJ.toFixed(1) }}</span>
              <span class="flow-chip gravity">重 {{ row.gravityJ.toFixed(1) }}</span>
              <span class="flow-chip loss">损 {{ (row.summary.contactLossJ + row.summary.frictionLossJ).toFixed(1) }}</span>
              <span v-if="row.summary.storedJ > 0.001" class="flow-chip store">储 {{ row.summary.storedJ.toFixed(1) }}</span>
            </span>
          </button>
        </li>
      </ul>
      <p class="piece-energy-foot">“收”包含所有支路汇入；坡道“储”在释能前不计入下游。</p>
    </template>
  </section>
</template>
