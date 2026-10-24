import { inject, provide, type InjectionKey, type Ref } from 'vue'

export interface FileDropApi {
  openPicker: () => void
  open: (files: File[]) => Promise<void>
  busy: Ref<boolean>
}

const FILE_DROP_KEY: InjectionKey<FileDropApi> = Symbol('liteoffice/file-drop')

export function provideFileDrop(api: FileDropApi) {
  provide(FILE_DROP_KEY, api)
}

export function useFileDrop(): FileDropApi {
  const api = inject(FILE_DROP_KEY)
  if (!api) throw new Error('useFileDrop 必须在 FileDropProvider 内使用')
  return api
}
