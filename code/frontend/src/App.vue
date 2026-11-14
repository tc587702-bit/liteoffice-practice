<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue'
import ErrorBoundary from './components/app/ErrorBoundary.vue'
import FileDropProvider from './components/app/FileDropProvider.vue'
import ImportProgress from './components/app/ImportProgress.vue'
import Toaster from './components/app/Toaster.vue'
import ConfirmDialog from './components/ui/ConfirmDialog.vue'
import FatalDialog from './components/ui/FatalDialog.vue'
import AppIcon from './components/ui/AppIcon.vue'
import { aiPanelOpen, openAiPanel } from './lib/aiPanelState'

/* AI 面板懒加载：只有第一次打开才 import 这个 chunk */
const AiAssistantPanel = defineAsyncComponent(() => import('./components/ai/AiAssistantPanel.vue'))
const aiLoaded = ref(false)
watch(aiPanelOpen, (open) => {
  if (open) aiLoaded.value = true
})
</script>

<template>
  <ErrorBoundary>
    <FileDropProvider>
      <div class="relative h-full">
        <!-- 纯黑底 + 蓝紫径向光晕 -->
        <div class="lo-ambient" aria-hidden="true" />
        <div class="relative z-10 flex h-full min-h-0">
          <div class="flex min-w-0 flex-1 flex-col">
            <RouterView />
          </div>
          <!-- AI 工具栏：停靠在右侧，打开时挤压文档区而不是盖住它 -->
          <AiAssistantPanel v-if="aiLoaded && aiPanelOpen" />
        </div>
      </div>
      <ImportProgress />
      <Toaster />
      <ConfirmDialog />
      <FatalDialog />
      <button
        v-if="!aiPanelOpen"
        type="button"
        aria-label="打开 AI 助手"
        class="lo-press fixed bottom-5 right-5 z-40 flex h-[46px] w-[46px] items-center justify-center rounded-full text-white shadow-[0_10px_28px_-8px_rgba(10,132,255,0.75)]"
        style="background-image: linear-gradient(135deg, #0a84ff 0%, #5e5ce6 100%)"
        @click="openAiPanel()"
      >
        <AppIcon name="sparkles" class="h-5 w-5" :stroke-width="1.8" />
      </button>
    </FileDropProvider>
  </ErrorBoundary>
</template>
