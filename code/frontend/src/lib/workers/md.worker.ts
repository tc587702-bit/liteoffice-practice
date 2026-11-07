/// <reference lib="webworker" />
import { renderMarkdown } from '../markdown'

interface Request {
  id: number
  text: string
}

interface Reply {
  id: number
  ok: boolean
  result?: string
  message?: string
  name?: string
}

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<Request>) => {
  const { id, text } = event.data
  try {
    scope.postMessage({ id, progress: { done: 0, total: text.length } })
    const html = renderMarkdown(text)
    const reply: Reply = { id, ok: true, result: html }
    scope.postMessage(reply)
  } catch (error) {
    const reply: Reply = { id, ok: false, message: (error as Error)?.message ?? 'Markdown 渲染失败', name: (error as Error)?.name }
    scope.postMessage(reply)
  }
}
