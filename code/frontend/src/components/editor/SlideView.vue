<script setup lang="ts">
/**
 * PPTX 幻灯片视图（版式级渲染）。
 *
 * 不是"把文字排成卡片"，而是按 XML 里的真实坐标画：
 *   背景（纯色 / 背景图）+ 版式装饰形状 + 每页的文本框/图片/表格，
 *   字号、颜色、加粗、对齐都从 a:rPr / a:pPr 读取。
 *
 * 坐标统一是百分比，卡片宽度变化时整体等比缩放。
 */
import { computed } from 'vue'
import type { DocRecord } from '../../lib/db'
import { ptToCardFont } from '../../lib/pptxLayout'
import type { PptPara, PptShapeBox } from '../../lib/pptxLayout'

const props = defineProps<{ doc: DocRecord }>()

interface RichSlide {
  index?: number
  background?: string
  backgroundImage?: string
  shapes?: PptShapeBox[]
  text?: string
  /** 兼容旧数据（纯文本幻灯片） */
  title?: string
  lines?: string[]
}

const slides = computed<RichSlide[]>(() => (props.doc.slides ?? []) as RichSlide[])

/** 换算实现放在 lib 里，与回归测试共用同一份，避免两处各写一遍 */
function ptToPx(pt: number | undefined, widthPt: number): string {
  return ptToCardFont(pt, widthPt)
}

function alignClass(align?: PptPara['align']): string {
  if (align === 'ctr') return 'text-center'
  if (align === 'r') return 'text-right'
  if (align === 'just') return 'text-justify'
  return 'text-left'
}

/**
 * 幻灯片真实页宽（pt）。
 *
 * 以前这里写死 720pt（那是 4:3 的页宽），而 16:9 的稿子页宽是 960pt。
 * 同一个 28pt 的字按 720 算出来比按 960 大 33%，文字撑出文本框被裁掉，
 * 用户看到的就是「有些文字加载不出来」。旧数据没存这个字段时仍按 720 兜底。
 */
const slideWidthPt = computed(() => props.doc.slidesWidthPt || 720)

/** 用文档真实比例（4:3 或 16:9），没有就按 4:3 兜底 */
const aspectStyle = computed(() => {
  const a = props.doc.slidesAspect || 4 / 3
  return { aspectRatio: String(a) }
})

/**
 * 段落基准字号 = 该段最大的 run 字号。
 *
 * 必须把字号也设到 <p> 上：行高（leading-snug）是按元素自身 font-size 算的，
 * 只给内层 span 设字号时，段落仍按浏览器默认 16px 撑出 22px 行高，
 * 而框高是按真实 pt 换算的（11pt 只有 15px）——小字反而被裁掉。
 */
function paraFont(para: PptPara, widthPt: number): string {
  let max = 0
  for (const r of para.runs || []) max = Math.max(max, r.sizePt ?? 18)
  return ptToPx(max || undefined, widthPt)
}

function isLegacy(slide: RichSlide): boolean {
  return !slide.shapes && Boolean(slide.title || slide.lines)
}
</script>

<template>
  <section class="mx-auto mb-6 w-full max-w-[960px]">
    <div class="mb-2 flex items-center justify-between gap-3 text-[11.5px] text-lo-text-4">
      <span>幻灯片（{{ slides.length }} 页）· 按原版式渲染，只读</span>
      <span>字号/颜色/位置来自 PPT 原始数据</span>
    </div>

    <div class="flex flex-col gap-5">
      <div v-for="(slide, i) in slides" :key="i" class="relative" :data-slide-index="i">
        <div
          class="relative w-full overflow-hidden rounded-[10px] bg-white shadow-[0_20px_48px_-28px_rgba(0,0,0,0.85)]"
          :style="{
            ...aspectStyle,
            // 字号用 cqw 跟随卡片宽度，必须先声明容器；缺了它 cqw 会按视口算
            containerType: 'inline-size',
            backgroundColor: slide.background || undefined,
            backgroundImage: slide.backgroundImage ? `url(${slide.backgroundImage})` : undefined,
            backgroundSize: slide.backgroundImage ? 'cover' : undefined,
          }"
        >
          <!-- 版式形状层 -->
          <template v-if="!isLegacy(slide)">
            <template v-for="(shape, k) in slide.shapes || []" :key="k">
              <img
                v-if="shape.kind === 'image'"
                :src="shape.src"
                class="pointer-events-none absolute select-none"
                :style="{
                  left: shape.left + '%',
                  top: shape.top + '%',
                  width: shape.width + '%',
                  height: shape.height + '%',
                  objectFit: 'contain',
                }"
                alt=""
              />
              <!-- wmf/emf 等浏览器显示不了的图片：
                   小图给虚线占位框；大图（多半是整页背景）只留一个小角标，别糊住文字 -->
              <div
                v-else-if="shape.kind === 'missing'"
                class="absolute flex items-center justify-center"
                :class="
                  shape.width * shape.height > 2500
                    ? 'items-start justify-start bg-transparent px-1 text-[9px] text-[#B0B0B5]'
                    : 'rounded-[4px] border border-dashed border-[#C7C7CC] bg-[#F2F2F7]/70 px-2 text-center text-[10.5px] text-[#8E8E93]'
                "
                :style="{
                  left: shape.left + '%',
                  top: shape.top + '%',
                  width: shape.width + '%',
                  height: shape.height + '%',
                }"
              >
                {{ shape.label || '图片无法显示' }}
              </div>
              <table
                v-else-if="shape.kind === 'table' && shape.rows"
                class="absolute border-collapse text-[11px] text-[#1C1C1E]"
                :style="{
                  left: shape.left + '%',
                  top: shape.top + '%',
                  width: shape.width + '%',
                }"
              >
                <tbody>
                  <tr v-for="(row, ri) in shape.rows" :key="ri">
                    <td
                      v-for="(cell, ci) in row"
                      :key="ci"
                      class="border border-[#9A9A9E] px-1.5 py-1 align-top"
                    >
                      {{ cell }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <!-- 不裁切文字：PowerPoint 在没有 spAutoFit/normAutofit 时，
                   文字超出文本框仍照常显示（实测用户课件 12 页均无自适应设置）。
                   原来用 overflow-hidden，超出的那几行直接被切掉，
                   用户看到的就是「有些文字加载不出来」。 -->
              <div
                v-else-if="shape.kind === 'text'"
                class="absolute overflow-visible"
                :style="{
                  left: shape.left + '%',
                  top: shape.top + '%',
                  width: shape.width + '%',
                  height: shape.height + '%',
                }"
              >
                <p
                  v-for="(para, pi) in shape.paras || []"
                  :key="pi"
                  :class="alignClass(para.align)"
                  class="leading-snug text-[#1C1C1E]"
                  :style="{
                    paddingLeft: (para.level || 0) * 1.6 + 'cqw',
                    fontSize: paraFont(para, slideWidthPt),
                  }"
                >
                  <span v-if="para.bullet" class="mr-1">•</span>
                  <span
                    v-for="(run, rui) in para.runs"
                    :key="rui"
                    :style="{
                      fontSize: ptToPx(run.sizePt, slideWidthPt),
                      color: run.color || undefined,
                      fontWeight: run.bold ? 600 : 400,
                      fontStyle: run.italic ? 'italic' : undefined,
                      // 字体族以前完全没应用，导致中文一律回退到浏览器默认字体；
                      // 但也不能覆盖符号映射后的字符（那些已换成通用 Unicode），
                      // 所以只在有具体字体名时才设。
                      fontFamily: run.fontFamily ? `'${run.fontFamily}', sans-serif` : undefined,
                    }"
                    >{{ run.text }}</span
                  >
                </p>
              </div>
            </template>
          </template>

          <!-- 旧的纯文本数据（兼容已保存的文档） -->
          <div v-else class="absolute inset-0 flex flex-col justify-center px-10 py-8">
            <h2 class="mb-3 text-[22px] font-semibold text-[#1C1C1E]">{{ slide.title || `第 ${i + 1} 页` }}</h2>
            <ul class="flex flex-col gap-1.5">
              <li v-for="(line, j) in slide.lines || []" :key="j" class="text-[15px] text-[#3A3A3C]">
                · {{ line }}
              </li>
            </ul>
          </div>

          <span class="absolute bottom-2 right-3 text-[10.5px] tabular-nums text-[#8E8E93]">
            {{ i + 1 }} / {{ slides.length }}
          </span>
        </div>
      </div>
    </div>

    <p v-if="!slides.length" class="text-[12px] text-lo-text-2">这份 PPTX 没有解析出可渲染内容。</p>
  </section>
</template>
