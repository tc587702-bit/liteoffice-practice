<template>
</template>
<script setup>
import { useNav } from '@slidev/client'
const $nav = useNav()
// 页面加载自动关闭侧边 TOC 面板
$nav.setSidebar(false)
</script>
