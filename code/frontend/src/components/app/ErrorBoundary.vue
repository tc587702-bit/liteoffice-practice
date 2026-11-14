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
  <div v-if="error" class="flex min-h-screen items-center justify-center bg-black px-6 text-[#F5F5F7]">
    <section class="lo-card max-w-md p-6">
      <p class="text-[12px] font-medium text-[#FF6961]">PREVIEW FAILED TO RENDER</p>
      <h1 class="mt-2 text-[22px] font-semibold">页面捕获到一个运行时错误</h1>
      <p class="mt-3 text-[13px] leading-relaxed text-[#A1A1A6]">
        应用没有崩溃成白屏，错误信息如下；刷新后可以继续使用本地文档。
      </p>
      <pre
        class="mt-4 max-h-40 overflow-auto rounded-xl bg-black/60 p-3 text-[12px] text-[#C7C7CC]"
      >{{ error.message }}</pre>
      <button type="button" class="lo-btn lo-btn-primary lo-btn-md mt-5" @click="reload">重新加载</button>
    </section>
  </div>
  <slot v-else />
</template>
