import { useCallback, useRef } from "react";
import type { TFunction } from "i18next";
import { saveImage } from "./api";

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

interface UseImagePasteOptions {
  noteId: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setContent: (content: string) => void;
  markDirty: () => void;
  onEnsureNoteSaved: () => Promise<string | null>;
  /** 数据目录。给了它才能把「笔记自己的图片」还原成 `images/…` 相对路径。 */
  imageBaseDir?: string;
  disabled?: boolean;
  onError?: (message: string) => void;
  t?: TFunction;
}

/**
 * 剪贴板里那些「本地图片路径」→ Markdown。
 *
 * 「复制图片」写剪贴板时同时放了文件列表与路径文本；Chromium 可能把它暴露成图片
 * `File`，于是会走「存进笔记 images」的老路。用户要的是**地址**，所以粘贴时先看
 * 文本：只要每一行都是一个本地图片路径，就整体转成 `![](路径)`，不再复制文件。
 *
 * 普通文字（哪怕恰好以 `.png` 结尾）不会被误判：要求整行只有路径，且是绝对路径 /
 * `file://` / `images/…` 这几类形态。`noteId` + `imageBaseDir` 都在时，落在当前
 * 笔记 `images/<noteId>/` 下的图片会还原成相对路径，笔记搬走也不断。
 *
 * 返回 `null` = 不是「一串图片路径」，交给原有逻辑处理。
 */
export function imagePathsToMarkdown(
  text: string,
  noteId: string | null | undefined,
  imageBaseDir: string | undefined,
): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > 20) return null;

  const noteImagesPrefix =
    noteId && imageBaseDir
      ? `${imageBaseDir.replace(/\\/g, "/").replace(/\/+$/, "")}/images/${noteId}/`
      : null;
  const noteImagesPrefixLower = noteImagesPrefix?.toLowerCase() ?? null;

  const paths: string[] = [];
  for (const line of lines) {
    // 有些程序会用尖括号包住带空格的路径。
    const candidate = line.replace(/^<(.+)>$/, "$1").trim();
    let path = candidate;

    if (/^file:\/\//i.test(path)) {
      try {
        path = decodeURIComponent(
          path.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1"),
        );
      } catch {
        return null;
      }
    } else if (/^images\//i.test(path)) {
      // 已经是笔记里的相对路径，原样保留。
      paths.push(path.replace(/\\/g, "/"));
      continue;
    }

    const isAbsolute =
      /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path) || /^\/\/[^/]/.test(path);
    if (!isAbsolute) return null;
    if (!/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(path)) return null;

    paths.push(path.replace(/\\/g, "/"));
  }

  const markdown = paths.map((path) => {
    let display = path;
    if (
      noteImagesPrefix &&
      noteImagesPrefixLower &&
      path.toLowerCase().startsWith(noteImagesPrefixLower)
    ) {
      display = `images/${noteId}/${path.slice(noteImagesPrefix.length)}`;
    }
    return `![](${display})`;
  });

  return markdown.join("\n");
}

async function processImageFile(file: File, noteId: string, t?: TFunction): Promise<string | null> {
  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error(
      t?.("errors.imageTooLarge", { defaultValue: "图片文件过大（上限 20 MB）" }) ??
        "图片文件过大（上限 20 MB）",
    );
  }

  const ext = MIME_TO_EXT[file.type];
  if (!ext) return null;

  const buffer = await file.arrayBuffer();
  const data = Array.from(new Uint8Array(buffer));
  return saveImage(noteId, data, ext);
}

export function insertTextAtCursor(
  textarea: HTMLTextAreaElement,
  setContent: (value: string) => void,
  text: string,
) {
  const before = textarea.value.slice(0, textarea.selectionStart);
  const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
  const insertion = (needsLeadingNewline ? "\n" : "") + text + "\n";

  textarea.focus();
  document.execCommand("insertText", false, insertion);
  setContent(textarea.value);
}

function getImageFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < dataTransfer.items.length; i++) {
    const item = dataTransfer.items[i];
    if (item.kind === "file" && item.type in MIME_TO_EXT) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

export function useImagePaste({
  noteId,
  textareaRef,
  setContent,
  markDirty,
  onEnsureNoteSaved,
  imageBaseDir,
  disabled,
  onError,
  t,
}: UseImagePasteOptions) {
  const processingRef = useRef(false);

  const processFiles = useCallback(
    async (files: File[]) => {
      if (processingRef.current || files.length === 0) return;
      processingRef.current = true;

      try {
        let resolvedId = noteId;
        if (!resolvedId) {
          resolvedId = await onEnsureNoteSaved();
          if (!resolvedId) return;
        }

        const textarea = textareaRef.current;
        if (!textarea) return;

        const markdownLines: string[] = [];
        for (const file of files) {
          const relativePath = await processImageFile(file, resolvedId, t);
          if (relativePath) {
            markdownLines.push(`![](${relativePath})`);
          }
        }

        if (markdownLines.length > 0) {
          insertTextAtCursor(textarea, setContent, markdownLines.join("\n"));
          markDirty();
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : (t?.("errors.imagePasteFailed", { defaultValue: "图片粘贴失败" }) ?? "图片粘贴失败");
        onError?.(message);
      } finally {
        processingRef.current = false;
      }
    },
    [noteId, textareaRef, setContent, markDirty, onEnsureNoteSaved, onError, t],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      /*
       * 先看文本：从花笺里「复制图片」得到的是「文件列表 + 路径文本」，用户期望粘进
       * 编辑器的是地址，而不是再存一份图片副本。
       *
       * 这条分支在 `disabled`（外部文件）时也要生效 —— 外部 .md 里插绝对路径同样
       * 合理；`imagePathsToMarkdown` 在没有 noteId 时不会做相对化。
       */
      const text = event.clipboardData.getData("text/plain");
      const markdown = imagePathsToMarkdown(text, noteId, imageBaseDir);
      if (markdown) {
        event.preventDefault();
        const textarea = textareaRef.current;
        if (!textarea) return;
        insertTextAtCursor(textarea, setContent, markdown);
        markDirty();
        return;
      }

      if (disabled) return;
      const files = getImageFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void processFiles(files);
    },
    [disabled, imageBaseDir, markDirty, noteId, processFiles, setContent, textareaRef],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = getImageFiles(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      void processFiles(files);
    },
    [disabled, processFiles],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const hasImage = Array.from(event.dataTransfer.items).some(
        (item) => item.kind === "file" && item.type in MIME_TO_EXT,
      );
      if (hasImage) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [disabled],
  );

  return { handlePaste, handleDrop, handleDragOver };
}
