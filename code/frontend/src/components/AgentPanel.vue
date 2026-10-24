<script setup lang="ts">
/**
 * 右侧「文档助手」占位面板。
 *
 * 规划里它是占位（features.agentEnabled = false），所以默认**不渲染**。
 * 保留组件而不是留个空文件，是为了在答辩时能说明「这块留了接口，
 * 但 5 天内不做」，而不是被问到时才现场解释。
 */
defineProps<{
  docName?: string;
}>();
</script>

<template>
  <aside class="agent-panel">
    <div class="sidebar-head">文档助手</div>
    <div class="agent-body">
      <p class="muted">该功能尚未实现。</p>
      <p class="muted small" v-if="docName">当前文档：{{ docName }}</p>
      <p class="muted small">
        接口已预留：后续可在这里接入摘要、问答、格式检查等能力。
      </p>
    </div>
  </aside>
</template>
