/// <reference lib="webworker" />
import { parseXlsxWithSheetJS } from '../xlsx'

interface Request {
  id: number
  buffer: ArrayBuffer
}

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<Request>) => {
  const { id, buffer } = event.data
  try {
    const result = await parseXlsxWithSheetJS(buffer, {
      onProgress: (progress) => {
        scope.postMessage({ id, progress: { done: progress.done, total: progress.total, label: progress.sheet } })
      },
    })
    scope.postMessage({ id, ok: true, result })
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      message: (error as Error)?.message ?? '工作表解析失败',
      name: (error as Error)?.name,
    })
  }
}
