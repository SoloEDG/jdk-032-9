<script setup lang="ts">
import { RotateCw, Trash2 } from '@lucide/vue'
import type { Piece } from '@/shared/document'

defineProps<{ piece: Piece | null }>()
const emit = defineEmits<{
  rotate: [string]; remove: [string]
  update: [string, Partial<Pick<Piece, 'label' | 'height' | 'fallThreshold' | 'friction' | 'energyJ' | 'startAngleDeg'>>]
}>()
function value(event: Event) { return (event.target as HTMLInputElement).value }
function number(event: Event) { return Number(value(event)) }
</script>

<template>
  <section class="inspector">
    <div class="section-kicker"><span>02 / SELECTED</span><h2>元件属性</h2></div>
    <template v-if="piece">
      <label class="field-label">名称<input :value="piece.label" maxlength="18" @change="emit('update', piece.id, { label: value($event) })" /></label>
      <div class="field-pair">
        <label class="field-label">横坐标<input type="number" :value="piece.x.toFixed(1)" step="0.1" readonly /></label>
        <label class="field-label">纵坐标<input type="number" :value="piece.y.toFixed(1)" step="0.1" readonly /></label>
      </div>
      <label class="field-label">倾倒门槛 <span>{{ piece.fallThreshold.toFixed(1) }}</span>
        <input type="range" min="0.3" max="1.6" step="0.1" :value="piece.fallThreshold"
          @change="emit('update', piece.id, { fallThreshold: number($event) })" />
      </label>
      <template v-if="piece.kind === 'pendulum'">
        <label class="field-label">摆锤储能 <span>{{ (piece.energyJ ?? 40).toFixed(1) }} J</span>
          <input type="range" min="4" max="160" step="1" :value="piece.energyJ ?? 40"
            @change="emit('update', piece.id, { energyJ: number($event) })" />
        </label>
        <label class="field-label">起始摆角 <span>{{ (piece.startAngleDeg ?? 38).toFixed(0) }}°</span>
          <input type="range" min="10" max="80" step="1" :value="piece.startAngleDeg ?? 38"
            @change="emit('update', piece.id, { startAngleDeg: number($event) })" />
        </label>
        <p class="inspector-note">摆锤储能即本次回放的外部输入，会全额记入能量账。</p>
      </template>
      <div class="inspector-actions">
        <button @click="emit('rotate', piece.id)"><RotateCw :size="15" /> 旋转 15°</button>
        <button class="danger" @click="emit('remove', piece.id)"><Trash2 :size="15" /> 删除</button>
      </div>
      <p class="inspector-note">在场景中拖动，或使用方向键微调位置。</p>
    </template>
    <div v-else class="inspector-empty"><span class="empty-cross">＋</span><span>选择一个元件查看属性</span></div>
  </section>
</template>
