<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue'
import ErrorBoundary from './components/app/ErrorBoundary.vue'
import FileDropProvider from './components/app/FileDropProvider.vue'
import ImportProgress from './components/app/ImportProgress.vue'
import Toaster from './components/app/Toaster.vue'
import ConfirmDialog from './components/ui/ConfirmDialog.vue'
import FatalDialog from './components/ui/FatalDialog.vue'
import { aiPanelOpen } from './lib/aiPanelState'

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
    </FileDropProvider>
  </ErrorBoundary>
</template>
