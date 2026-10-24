<script setup lang="ts">
import ErrorBoundary from './components/app/ErrorBoundary.vue'
import FileDropProvider from './components/app/FileDropProvider.vue'
import ImportProgress from './components/app/ImportProgress.vue'
import Toaster from './components/app/Toaster.vue'
import ConfirmDialog from './components/ui/ConfirmDialog.vue'
</script>

<template>
  <ErrorBoundary>
    <FileDropProvider>
      <div class="relative h-full">
        <!-- 纯黑底 + 蓝紫径向光晕 -->
        <div class="lo-ambient" aria-hidden="true" />
        <div class="relative z-10 flex h-full min-h-0 flex-col">
          <RouterView />
        </div>
      </div>
      <ImportProgress />
      <Toaster />
      <ConfirmDialog />
    </FileDropProvider>
  </ErrorBoundary>
</template>
