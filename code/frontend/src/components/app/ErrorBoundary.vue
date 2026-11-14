<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import { collectDiagnostics, reportError, toAppError } from '../../lib/errors'

/** 捕获子组件渲染期错误，避免整页白屏（替代 React ErrorBoundary）。 */
const error = ref<Error | null>(null)
const code = ref('')

onErrorCaptured((err, instance, info) => {
  const appError = toAppError(err)
  error.value = err instanceof Error ? err : new Error(String(err))
  code.value = appError.code
  // 白屏级错误必须带组件名与生命周期阶段上报，否则现场只剩一句 message
  reportError(err, {
    source: 'error-boundary',
    info,
    component: (instance?.$options?.name as string | undefined) ?? 'anonymous',
  })
  return false
})

function reload() {
  error.value = null
  window.location.reload()
}

/** 把诊断信息下载成 txt，方便用户直接发给开发者 */
function downloadDiagnostics() {
  const blob = new Blob([collectDiagnostics()], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `liteoffice-diagnostics-${Date.now()}.txt`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
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
      <p v-if="code" class="mt-2 text-[11px] uppercase tracking-wide text-[#636366]">code: {{ code }}</p>
      <pre
        class="mt-4 max-h-40 overflow-auto rounded-xl bg-black/60 p-3 text-[12px] text-[#C7C7CC]"
      >{{ error.message }}</pre>
      <div class="mt-5 flex flex-wrap gap-2">
        <button type="button" class="lo-btn lo-btn-primary lo-btn-md" @click="reload">重新加载</button>
        <button type="button" class="lo-btn lo-btn-md" @click="downloadDiagnostics">下载诊断信息</button>
      </div>
    </section>
  </div>
  <slot v-else />
</template>
