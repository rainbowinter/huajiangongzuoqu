export interface NoteMetadata {
  id: string;
  title: string;
  fileName: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  preview: string;
}

export interface Note extends Omit<NoteMetadata, "preview"> {
  content: string;
}

export interface SaveNoteRequest {
  title: string;
  content: string;
  category: string;
}

export interface ExternalFile {
  id: string;
  title: string;
  filePath: string;
  /**
   * 这个文件是从**工作区树**里点开的，而不是从系统拖进来 / 用花笺打开 / 启动参数进来的。
   *
   * 这类文件**不进侧栏的「外部文件」列表**（见 `listableExternalFiles`）：工作区树本身就是
   * 它的导航，再在「笔记」面板里列一条只会让人以为多了篇笔记。
   *
   * 但它**照旧留在 `externalFiles` 里** —— 保存路由（`performSave`）与「这算不算外部文件」
   * 的判据全靠这个列表，抽掉它会让编辑工作区文件时把内容写进笔记。
   */
  fromWorkspace?: boolean;
}
