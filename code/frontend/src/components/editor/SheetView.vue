<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import type { DocRecord } from '../../lib/db'
import type { PersistedSheet } from '../../lib/xlsx'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{ doc: DocRecord }>()

const store = useWorkspaceStore()
const activeSheet = ref(0)
const query = ref('')

const sheets = computed<PersistedSheet[]>(() => props.doc.sheets ?? [])

watch(
  () => props.doc.id,
  () => {
    activeSheet.value = 0
    query.value = ''
  },
)

const sheet = computed<PersistedSheet | undefined>(() => {
  if (!sheets.value.length) return undefined
  return sheets.value[Math.min(activeSheet.value, sheets.value.length - 1)]
})

const rows = computed(() => {
  if (!sheet.value) return []
  const q = query.value.trim().toLowerCase()
  if (!q) return sheet.value.rows
  return sheet.value.rows.filter((row) => row.cells.some((cell) => cell.toLowerCase().includes(q)))
})

const width = computed(() => Math.max(sheet.value?.totalCols ?? 0, 1))

function update(rowNumber: number, col: number, value: string) {
  store.updateCell(props.doc.id, activeSheet.value, rowNumber, col, value)
}

function cellValue(cells: string[], col: number) {
  return cells[col] ?? ''
}

/** 截断必须显式标注：已截断，仅显示前 N 行（共 M 行） */
function truncationLabel(target: PersistedSheet) {
  if (target.truncatedNote) return target.truncatedNote
  const shown = target.shownRows ?? target.rows.length
  const total = Math.max(target.totalRows, shown)
  return `已截断，仅显示前 ${shown} 行（共 ${total} 行）`
}
</script>

<template>
  <div v-if="!sheet" class="lo-card p-6 text-[13px] text-[#A1A1A6]">暂无工作表内容。</div>
  <div v-else class="flex min-h-0 flex-1 flex-col gap-3 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-1">
        <button
          v-for="(item, index) in sheets"
          :key="`${item.name}-${index}`"
          type="button"
          class="rounded-lg px-3 py-1.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
          :class="
            index === activeSheet
              ? 'bg-white/[0.1] font-medium text-white'
              : 'text-[#A1A1A6] hover:bg-white/[0.05] hover:text-white'
          "
          @click="activeSheet = index"
        >
          {{ item.name }}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="query"
          placeholder="筛选单元格内容"
          class="lo-input h-8 w-44 px-2.5 text-[12px]"
        />
        <span class="text-[11.5px] tabular-nums text-[#636366]">
          {{ rows.length }} / {{ sheet.totalRows }} 行 · {{ sheet.totalCols }} 列
        </span>
      </div>
    </div>

    <p v-if="sheet.truncated" class="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[#FFB340]">
      <AppIcon name="alert-triangle" class="h-3.5 w-3.5 shrink-0" />
      <span class="font-medium">{{ truncationLabel(sheet) }}</span>
      <span class="text-[#A1A1A6]">· 导出会按当前已加载的行回写，未加载的尾部数据不会写入</span>
    </p>

    <div class="thin-scroll min-h-0 flex-1 overflow-auto rounded-xl border border-white/[0.07] bg-white">
      <table class="w-max min-w-full border-collapse text-[12.5px] text-[#1D1D1F]">
        <thead class="sticky top-0 z-10">
          <tr>
            <th
              class="sticky left-0 z-20 w-12 border-b border-r border-[#E5E5EA] bg-[#F2F2F7] px-2 py-1.5 text-[11px] font-medium text-[#98989D]"
            />
            <th
              v-for="index in width"
              :key="index"
              class="min-w-[110px] border-b border-r border-[#E5E5EA] bg-[#F2F2F7] px-2 py-1.5 text-left text-[11px] font-semibold text-[#636366]"
            >
              {{ sheet.columns[index - 1] ?? '' }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.r" class="even:bg-[#FAFAFB]">
            <th
              class="sticky left-0 z-10 border-b border-r border-[#EDEDF0] bg-[#F7F7FA] px-2 py-1 text-[10.5px] font-normal tabular-nums text-[#98989D]"
            >
              {{ row.r }}
            </th>
            <td v-for="col in width" :key="col" class="border-b border-r border-[#F0F0F3] p-0 align-top">
              <input
                :value="cellValue(row.cells, col - 1)"
                class="h-8 w-full min-w-[110px] bg-transparent px-2 text-[12.5px] text-[#1D1D1F] outline-none focus:bg-[#EAF4FF] focus:ring-1 focus:ring-inset focus:ring-[#0A84FF]/60"
                :aria-label="`${sheet.name} 第 ${row.r} 行 ${sheet.columns[col - 1] ?? col} 列`"
                @input="update(row.r, col - 1, ($event.target as HTMLInputElement).value)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
