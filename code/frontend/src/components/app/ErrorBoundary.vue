<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'

/** 捕获子组件渲染期错误，避免整页白屏（替代 React ErrorBoundary）。 */
const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  return false
})

function reload() {
  error.value = null
  window.location.reload()
}
</script>

<template>
  <div v-if="error" class="flex min-h-screen items-center justify-center bg-lo-bg px-6 text-lo-text-1">
    <section class="lo-card max-w-md p-6">
      <p class="text-[12px] font-medium text-lo-danger-text">PREVIEW FAILED TO RENDER</p>
      <h1 class="mt-2 text-[22px] font-semibold">页面捕获到一个运行时错误</h1>
      <p class="mt-3 text-[13px] leading-relaxed text-lo-text-3">
        应用没有崩溃成白屏，错误信息如下；刷新后可以继续使用本地文档。
      </p>
      <pre
        class="mt-4 max-h-40 overflow-auto rounded-xl bg-lo-fill-3 p-3 text-[12px] text-lo-text-5"
      >{{ error.message }}</pre>
      <button type="button" class="lo-btn lo-btn-primary lo-btn-md mt-5" @click="reload">重新加载</button>
    </section>
  </div>
  <slot v-else />
</template>
