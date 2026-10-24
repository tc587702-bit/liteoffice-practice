/**
 * 把块列表渲染成 VNode 的无状态组件。
 *
 * 单独拆一个组件而不是在 MarkdownPreview 里直接返回数组：
 * 组件边界让「解析」与「渲染」的依赖方向保持单向 ——
 * MarkdownPreview 管状态（解码、解析、错误），MdBody 只把数据画出来，
 * 换渲染策略时不用碰状态逻辑。
 */
import { defineComponent, type PropType } from 'vue';
import type { Block } from './udm';
import { renderBlocks } from './render';

export const MdBody = defineComponent({
  name: 'MdBody',
  props: {
    blocks: {
      type: Array as PropType<Block[]>,
      required: true,
    },
  },
  setup(props) {
    return () => renderBlocks(props.blocks);
  },
});
