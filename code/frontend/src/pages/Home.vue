<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import TopBar from '../components/app/TopBar.vue'
import Sidebar from '../components/app/Sidebar.vue'
import SlotNumber from '../components/app/SlotNumber.vue'
import { useFileDrop } from '../components/app/fileDropContext'
import AppButton from '../components/ui/AppButton.vue'
import AppIcon from '../components/ui/AppIcon.vue'
import type { IconName } from '../components/ui/iconRegistry'
import { useWorkspaceStore } from '../stores/workspace'
import { formatSize, KIND_EXT } from '../lib/file'
import { exportDocument } from '../lib/exporter'

const FORMAT_PILLS = ['docx', 'xlsx', 'pptx', 'md', 'pdf']

const PRIVACY: { key: string; icon: IconName; title: string; caption: string }[] = [
  { key: 'local', icon: 'cpu', title: '本地处理', caption: '解析与编辑都在浏览器内完成' },
  { key: 'upload', icon: 'upload-cloud', title: '次上传', caption: '文件从不离开这台设备' },
  { key: 'tracker', icon: 'ban', title: '无广告追踪', caption: '零 Cookie、零第三方统计脚本' },
  { key: 'speed', icon: 'zap', title: '极速响应', caption: '大文件解析也无需等待上传' },
]

const router = useRouter()
const store = useWorkspaceStore()
const { docs, activeId, loading, persistence } = storeToRefs(store)
const { openPicker, busy } = useFileDrop()

/* 「次上传」始终为 0：文件从未离开本机，这个数字不会随导入变化 */
const uploadCount = 0

const cardRef = ref<HTMLElement | null>(null)
const spotlight = ref({ x: 0, y: 0, on: false })
const dropHover = ref(false)
const saving = ref(false)

const activeDoc = computed(() => docs.value.find((doc) => doc.id === activeId.value) ?? docs.value[0] ?? null)

onMounted(() => {
  if (!docs.value.length && loading.value) void store.hydrate()
})

function handleMove(event: MouseEvent) {
  const rect = cardRef.value?.getBoundingClientRect()
  if (!rect) return
  spotlight.value = { x: event.clientX - rect.left, y: event.clientY - rect.top, on: true }
}

function handleLeave() {
  spotlight.value = { ...spotlight.value, on: false }
}

async function handleSave() {
  if (!activeDoc.value) {
    store.addToast({ title: '还没有打开文件', description: '先打开一个文档，再保存下载', tone: 'info' })
    return
  }
  saving.value = true
  try {
    const result = await exportDocument(activeDoc.value)
    store.addToast({
      title: result.ok ? '已准备下载' : '保存提示',
      description: result.message,
      tone: result.ok ? 'success' : 'warning',
    })
  } finally {
    saving.value = false
  }
}

/* AI 助手 / 云端工作区均为预留位：只弹 Toast，不改变选中态 */
function handleReserved() {
  store.addToast({
    title: '云端工作区正在开发中，目前请使用本地安全模式',
    description: '本地文档仍保持选中，文件不会上传到任何服务器',
    tone: 'info',
  })
}

function openDoc(id: string) {
  store.setActive(id)
  void router.push('/editor')
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden text-[#F5F5F7]">
    <TopBar :saving="saving" @save="handleSave" />

    <div class="flex min-h-0 flex-1">
      <Sidebar :active-id="activeDoc?.id ?? null" variant="home" @select="openDoc" @remove="(id) => void store.removeDoc(id)" @reserved="handleReserved" />

      <main class="thin-scroll min-w-0 flex-1 overflow-y-auto px-5 pb-10 pt-6 md:px-8">
        <div class="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
          <div class="lo-rise lo-delay-1 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-[12px] text-[#636366]">
              <AppIcon name="shield-check" class="h-3.5 w-3.5 text-[#30D158]" />
              本地安全模式
              <span class="h-1 w-1 rounded-full bg-[#3A3A3C]" />
              当前会话：
              <span class="tabular-nums text-[#A1A1A6]">
                {{ loading ? '加载中' : docs.length ? `${docs.length} 个文件` : '暂无文件' }}
              </span>
            </div>
            <div class="flex items-center gap-2 text-[12px] text-[#636366]">
              <AppIcon name="hard-drive" class="h-3.5 w-3.5" />
              {{ persistence === 'degraded' ? '存储降级：仅当前页面' : 'IndexedDB 已启用' }}
            </div>
          </div>

          <!-- Hero 主卡片：#303032 / 24px 圆角 / 1px rgba(255,255,255,0.08) -->
          <section
            ref="cardRef"
            data-hero-card
            class="lo-card lo-rise lo-delay-2 relative overflow-hidden shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
            @mousemove="handleMove"
            @mouseleave="handleLeave"
          >
            <div
              class="lo-spotlight pointer-events-none absolute inset-0"
              :class="spotlight.on ? 'lo-spotlight-on' : ''"
              :style="{ '--spot-x': `${spotlight.x}px`, '--spot-y': `${spotlight.y}px` }"
            />
            <div class="relative grid gap-7 p-7 lg:grid-cols-[3fr_2fr] lg:p-9">
              <div class="flex min-w-0 flex-col">
                <p class="text-[12px] font-medium tracking-[0.16em] text-[#98989D]">LOCAL-FIRST WORKSPACE</p>
                <h1 class="mt-3 text-[34px] font-semibold leading-[1.15] tracking-tight text-white md:text-[40px]">
                  打开一个文档
                </h1>
                <p class="mt-3 text-[14.5px] leading-relaxed text-[#A1A1A6] md:mt-4">
                  拖进窗口，或点顶部「打开文件」
                </p>

                <div class="mt-8">
                  <AppButton variant="primary" size="lg" :disabled="busy" @click="openPicker">
                    <AppIcon :name="busy ? 'loader' : 'file-text'" class="h-4 w-4" :class="busy ? 'lo-spin' : ''" :stroke-width="2" />
                    {{ busy ? '正在本地解析…' : '打开文件' }}
                    <AppIcon name="arrow-up-right" class="h-4 w-4 opacity-80" :stroke-width="2" />
                  </AppButton>
                </div>

                <div class="mt-5 flex flex-wrap items-center gap-2">
                  <span
                    v-for="format in FORMAT_PILLS"
                    :key="format"
                    class="rounded-[8px] bg-[rgba(255,255,255,0.06)] px-[8px] py-[4px] text-[12px] font-medium leading-none text-[#A1A1A6]"
                  >
                    {{ format }}
                  </span>
                </div>

                <div class="mt-auto hidden items-center gap-2 pt-6 text-[12px] text-[#636366] md:flex">
                  <AppIcon name="lock" class="h-3.5 w-3.5 text-[#30D158]" />
                  解析、渲染与导出全部在本机完成
                </div>
              </div>

              <!-- 虚线拖拽框：与左列等高 -->
              <button
                type="button"
                class="lo-press group relative flex min-h-[200px] w-full flex-col lg:min-h-[248px] items-center justify-center overflow-hidden rounded-[24px] border border-dashed px-4 py-8 text-center outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]/60"
                :class="
                  dropHover
                    ? 'lo-drag-breathe border-solid border-[#0A84FF]'
                    : 'border-white/[0.12] bg-white/[0.012] hover:border-white/20 hover:bg-white/[0.03]'
                "
                @click="openPicker"
                @dragenter="dropHover = true"
                @dragleave="dropHover = false"
                @drop="dropHover = false"
              >
                <span
                  class="lo-drag-breathe absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(10,132,255,0.16),transparent_62%)] transition-opacity duration-200"
                  :class="dropHover ? 'opacity-100' : 'opacity-0'"
                />
                <span
                  class="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-[#0A84FF]/15 transition-transform duration-300"
                  :class="dropHover ? 'lo-eye-float' : ''"
                >
                  <AppIcon name="upload-cloud" class="h-7 w-7 text-[#0A84FF]" :stroke-width="1.6" />
                  <span class="lo-ring-spin absolute -inset-2 rounded-[22px] border border-dashed border-[#0A84FF]/25" />
                </span>
                <span class="relative mt-4 text-[14px] font-medium text-[#F5F5F7]">
                  {{ dropHover ? '松手即可打开' : '或拖入文件' }}
                </span>
                <span class="relative mt-1.5 max-w-[220px] text-[12px] leading-relaxed text-[#636366]">
                  {{ busy ? '正在本地解析，文件不会离开这台设备' : '支持多文件同时导入，切换后内容互不影响' }}
                </span>
                <span
                  class="relative mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2 py-1 text-[11px] text-[#A1A1A6]"
                >
                  <AppIcon name="gauge" class="h-3 w-3" :stroke-width="2" />
                  单文件 ≤ 4 MB
                </span>
              </button>
            </div>
          </section>

          <!-- 底部隐私通栏 -->
          <section class="lo-rise lo-delay-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <div
              v-for="item in PRIVACY"
              :key="item.key"
              class="lo-card lo-hover-lift flex min-w-0 items-center gap-3 px-4 py-3.5"
            >
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                <AppIcon :name="item.icon" class="h-4 w-4 text-[#C7C7CC]" />
              </span>
              <span class="min-w-0">
                <span v-if="item.key === 'upload'" class="flex items-baseline gap-1 whitespace-nowrap">
                  <span class="text-[24px] font-semibold leading-none text-[#F5F5F7]">
                    <SlotNumber :value="uploadCount" />
                  </span>
                  <span class="text-[14px] text-[#A1A1A6]">次上传</span>
                </span>
                <span v-else class="block whitespace-nowrap text-[14px] font-medium leading-tight text-[#F5F5F7]">{{ item.title }}</span>
                <span class="mt-1 block truncate text-[11.5px] text-[#98989D]" :title="item.caption">
                  {{ item.caption }}
                </span>
              </span>
            </div>
          </section>

          <!-- 当前会话：只有存在真实文件时展示 -->
          <section v-if="docs.length > 0" class="lo-card lo-rise lo-delay-4 p-5">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h2 class="text-[14px] font-semibold text-[#F5F5F7]">当前会话</h2>
                <p class="mt-1 text-[12px] text-[#98989D]">
                  共 {{ docs.length }} 个文件，均为本机读取，可直接进入编辑
                </p>
              </div>
              <RouterLink to="/editor" class="lo-btn lo-btn-secondary lo-btn-sm lo-press">进入编辑器</RouterLink>
            </div>
            <ul class="mt-4 grid gap-2 md:grid-cols-2">
              <li v-for="doc in docs" :key="doc.id">
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-[16px] border border-white/[0.06] bg-[#262628] px-3 py-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-white/15"
                  @click="openDoc(doc.id)"
                >
                  <span
                    class="flex h-8 w-10 shrink-0 items-center justify-center rounded-md bg-white/[0.07] text-[9px] font-bold tracking-wide text-[#C7C7CC]"
                  >
                    {{ KIND_EXT[doc.kind] }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[13px] text-[#F5F5F7]" :title="doc.name">{{ doc.name }}</span>
                    <span class="mt-0.5 block text-[11px] tabular-nums text-[#636366]">
                      {{ formatSize(doc.size) }}
                      <template v-if="doc.warnings.length"> · {{ doc.warnings[0] }}</template>
                    </span>
                  </span>
                  <AppIcon name="arrow-up-right" class="h-4 w-4 shrink-0 text-[#636366]" />
                </button>
              </li>
            </ul>
          </section>

          <div v-else class="lo-card lo-rise lo-delay-4 flex items-center gap-3 px-5 py-4">
            <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.06]">
              <AppIcon name="file-text" class="h-4 w-4 text-[#636366]" />
            </span>
            <div class="min-w-0">
              <p class="text-[13px] font-medium text-[#F5F5F7]">还没有打开文件</p>
              <p class="mt-0.5 text-[12px] text-[#636366]">
                支持 docx / xlsx / pptx / md / pdf，导入后会自动出现在左侧会话列表
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>
