import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { createNote, getErrorMessage, getNote, listNotes, updateNote } from "../features/notes/api";
import { useImagePaste } from "../features/images/useImagePaste";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import { handleMarkdownShortcut } from "../features/shortcuts/markdownShortcuts";
import { exportNoteAsPdf } from "../features/pdfExport/api";
import { saveImageFromPath } from "../features/images/api";
import { open } from "@tauri-apps/plugin-dialog";
import { reportInstallPreparation } from "../features/update/api";
import type { UpdateInstallPrepareRequest } from "../features/update/types";
import { showToast } from "./Toast";
import { PluginCommandPanel } from "./PluginCommandPanel";
import { FindReplacePanel } from "./FindReplacePanel";
import { registerActiveContent } from "../features/plugins/activeContent";
import { registerEditorJump } from "../features/plugins/jump";
import { loadPlugins } from "../features/plugins/loader";
import { notifyContentChanged } from "../features/plugins/registry";
import { usePluginStatusBar } from "../features/plugins/usePluginStatusBar";
import { renderMarkdownHighlight } from "../features/markdown/syntaxHighlight";
import { measureSelectionRects } from "../features/markdown/scrollSync";
import type { Selection } from "../features/plugins/types";
import type { Note, NoteMetadata } from "../features/notes/types";
import { countNoteChars, metadataFromNote } from "../features/notes/noteUtils";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  animateCurrentWindowBounds,
  closeCurrentWindow,
  getCurrentWindowBounds,
  recycleCurrentNotepad,
  setCurrentWindowAlwaysOnTop,
  showCurrentWindow,
  startCurrentWindowDrag,
  startCurrentWindowDragWithOffset,
  startCurrentWindowResize,
} from "../features/windows/controls";
import type { ResizeDirection } from "../features/windows/controls";
import { getConfig } from "../features/settings/api";
import {
  DEFAULT_TILE_COLOR,
  normalizeTileColor,
  resolveTileColor,
} from "../features/settings/tileColor";
import type { TileColorMode } from "../features/settings/types";
import {
  shouldEnterPadFromTileOnDoubleClick,
  shouldReturnToTileAfterManualSave,
  shouldSaveBeforeSwitchingToTile,
} from "../features/windows/noteSurfaceSavePolicy";
import {
  NOTE_SURFACE_ACTION_EVENT,
  surfaceActionFromEvent,
} from "../features/windows/surfaceActions";
import {
  NOTE_SURFACE_MODE_EVENT,
  getSurfaceTargetBounds,
  surfaceModeFromEvent,
} from "../features/windows/surfaceMode";
import type { NoteSurfaceMode } from "../features/windows/surfaceMode";
import {
  emitTileWindowUnpinned,
  tileSurfaceModeUnpinNoteId,
} from "../features/windows/tileWindowEvents";
import { NotepadOpenPanel } from "./NotepadOpenPanel";
import { Tile } from "./Tile";

type OpenMode = "new" | "open";
type NotePadStatus = "empty" | "opened" | "saved" | "dirty" | "saveFailed" | "copied";

interface NotePadProps {
  initialNoteId?: string;
  initialSurfaceMode?: NoteSurfaceMode;
  initialAutoSave?: boolean;
  initialTileColor?: string;
}

const surfaceResizeHandles: Array<{
  direction: ResizeDirection;
  className: string;
  size: string;
}> = [
  {
    direction: "NorthWest",
    size: "w-8 h-8",
    className: "top-0 left-0 cursor-nwse-resize",
  },
  {
    direction: "NorthEast",
    size: "w-5 h-5",
    className: "top-0 right-0 cursor-nesw-resize",
  },
  {
    direction: "SouthWest",
    size: "w-8 h-8",
    className: "bottom-0 left-0 cursor-nesw-resize",
  },
  {
    direction: "SouthEast",
    size: "w-5 h-5",
    className: "bottom-0 right-0 cursor-nwse-resize",
  },
];

function isTileControlDoubleClickTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('button,input,textarea,select,a,[data-surface-resize-handle="true"]'))
  );
}

const TILE_DRAG_START_THRESHOLD_PX = 5;

function SurfaceResizeHandles() {
  return (
    <>
      {surfaceResizeHandles.map((handle) => (
        <div
          key={handle.direction}
          aria-hidden="true"
          data-surface-resize-handle="true"
          data-resize-direction={handle.direction}
          onMouseDown={(event) => {
            event.stopPropagation();
            void startCurrentWindowResize(handle.direction).catch(() => undefined);
          }}
          className={`absolute ${handle.size} opacity-0 ${handle.className}`}
        />
      ))}
    </>
  );
}

export function NotePad({
  initialNoteId,
  initialSurfaceMode = "pad",
  initialAutoSave = true,
  initialTileColor = DEFAULT_TILE_COLOR,
}: NotePadProps) {
  const { t } = useTranslation();
  const [surfaceMode, setSurfaceMode] = useState<NoteSurfaceMode>(initialSurfaceMode);
  const [mode, setMode] = useState<OpenMode>("new");
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [findMatches, setFindMatches] = useState<Array<{ start: number; end: number }>>([]);
  const [currentFindIndex, setCurrentFindIndex] = useState(-1);
  const [status, setStatus] = useState<NotePadStatus>("empty");
  const [noteSurfaceAutoSave, setNoteSurfaceAutoSave] = useState(initialAutoSave);
  const [tileColorRaw, setTileColorRaw] = useState(normalizeTileColor(initialTileColor));
  const [tileColorMode, setTileColorMode] = useState<TileColorMode>("system");
  const [surfaceFontSize, setSurfaceFontSize] = useState(14);
  const [tileRenderMarkdown, setTileRenderMarkdown] = useState(false);
  const [tileDoubleClickToEdit, setTileDoubleClickToEdit] = useState(false);
  const [tileSaveReturnsToPin, setTileSaveReturnsToPin] = useState(false);
  const [tileColor, setTileColor] = useState(() =>
    resolveTileColor("system", normalizeTileColor(initialTileColor)),
  );
  const [textRenderColor, setTextRenderColor] = useState("");
  const [isExiting, setIsExiting] = useState(false);
  const [pluginsPanelOpen, setPluginsPanelOpen] = useState(false);
  const [activeSelection, setActiveSelection] = useState<Selection | null>(null);
  const [editorScrollTop, setEditorScrollTop] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const tileDragIntentRef = useRef<{ x: number; y: number } | null>(null);
  const windowLabelRef = useRef("");
  const statusRef = useRef<NotePadStatus>("empty");
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const isStandby = useRef(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("standby") === "1",
  );
  const hasEnteredOnce = useRef(false);
  const statusLabel = useMemo<Record<NotePadStatus, string>>(
    () => ({
      empty: t("notepad.status.empty", { defaultValue: "空" }),
      opened: t("notepad.status.opened", { defaultValue: "已打开" }),
      saved: t("notepad.status.saved", { defaultValue: "已保存" }),
      dirty: t("notepad.status.unsaved", { defaultValue: "未保存" }),
      saveFailed: t("notepad.status.saveFailed", { defaultValue: "保存失败" }),
      copied: t("notepad.status.copied", { defaultValue: "已复制" }),
    }),
    [t],
  );
  const tabLabels = useMemo(
    () => ({
      new: t("notepad.tab.new", { defaultValue: "新建" }),
      edit: t("notepad.tab.edit", { defaultValue: "编辑" }),
      open: t("notepad.tab.open", { defaultValue: "打开" }),
    }),
    [t],
  );
  statusRef.current = status;

  const pluginStatusItems = usePluginStatusBar(activeSelection);
  const highlightedHtml = useMemo(() => renderMarkdownHighlight(content), [content]);

  const findAllMatches = useCallback(
    (findText: string) => {
      if (!findText) return [] as Array<{ start: number; end: number }>;
      const matches: Array<{ start: number; end: number }> = [];
      let index = content.indexOf(findText);
      while (index !== -1) {
        matches.push({ start: index, end: index + findText.length });
        index = content.indexOf(findText, index + findText.length);
      }
      return matches;
    },
    [content],
  );

  const handleFindNext = useCallback(
    (findText: string) => {
      const textarea = contentRef.current;
      if (!textarea || !findText) return;
      const matches = findAllMatches(findText);
      if (matches.length === 0) {
        setFindMatches([]);
        setCurrentFindIndex(-1);
        return;
      }
      const currentPos = textarea.selectionStart;
      let nextIndex = matches.findIndex((m) => m.start > currentPos);
      if (nextIndex === -1) nextIndex = 0;
      const match = matches[nextIndex];
      setFindMatches(matches);
      setCurrentFindIndex(nextIndex);
      textarea.focus();
      textarea.setSelectionRange(match.start, match.end);
      const rects = measureSelectionRects(textarea, match.start, match.start + 1);
      if (rects.length > 0) textarea.scrollTop = rects[0].top;
    },
    [content, findAllMatches],
  );

  const handleFindPrev = useCallback(
    (findText: string) => {
      const textarea = contentRef.current;
      if (!textarea || !findText) return;
      const matches = findAllMatches(findText);
      if (matches.length === 0) {
        setFindMatches([]);
        setCurrentFindIndex(-1);
        return;
      }
      const currentPos = textarea.selectionStart;
      let prevIndex = -1;
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i].end <= currentPos) {
          prevIndex = i;
          break;
        }
      }
      if (prevIndex === -1) prevIndex = matches.length - 1;
      const match = matches[prevIndex];
      setFindMatches(matches);
      setCurrentFindIndex(prevIndex);
      textarea.focus();
      textarea.setSelectionRange(match.start, match.end);
      const rects = measureSelectionRects(textarea, match.start, match.start + 1);
      if (rects.length > 0) textarea.scrollTop = rects[0].top;
    },
    [content, findAllMatches],
  );

  const handleReplace = useCallback(
    (findText: string, replaceText: string) => {
      const textarea = contentRef.current;
      if (!textarea || !findText) return;
      const matches = findAllMatches(findText);
      if (matches.length === 0) return;
      const currentStart = textarea.selectionStart;
      const currentEnd = textarea.selectionEnd;
      let replaceIndex = matches.findIndex(
        (m) => m.start === currentStart && m.end === currentEnd,
      );
      if (replaceIndex === -1) {
        replaceIndex = matches.findIndex((m) => m.start >= currentStart);
        if (replaceIndex === -1) replaceIndex = 0;
      }
      const match = matches[replaceIndex];
      const next = content.slice(0, match.start) + replaceText + content.slice(match.end);
      setContent(next);
      setStatus("dirty");
      const newEnd = match.start + replaceText.length;
      textarea.setSelectionRange(match.start, newEnd);
      setFindMatches([]);
      setCurrentFindIndex(-1);
    },
    [content, findAllMatches],
  );

  const handleReplaceAll = useCallback(
    (findText: string, replaceText: string) => {
      if (!findText) return;
      const next = content.split(findText).join(replaceText);
      if (next === content) return;
      setContent(next);
      setStatus("dirty");
      setFindMatches([]);
      setCurrentFindIndex(-1);
    },
    [content],
  );

  useEffect(() => {
    registerActiveContent({
      getContent: () => contentValueRef.current,
      setContent: (value) => setContent(value),
      getSelection: () => {
        const textarea = contentRef.current;
        if (!textarea) return null;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        return { text: textarea.value.slice(start, end), start, end };
      },
      replaceSelection: (replacement) => {
        const textarea = contentRef.current;
        if (!textarea) return false;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const next = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
        setContent(next);
        setStatus("dirty");
        return true;
      },
    });
    return () => registerActiveContent(null);
  }, []);

  useEffect(() => {
    void loadPlugins();
  }, []);

  useEffect(() => {
    registerEditorJump((offset) => {
      const textarea = contentRef.current;
      if (!textarea) return;
      const rects = measureSelectionRects(textarea, offset, offset + 1);
      if (rects.length > 0) {
        textarea.scrollTop = rects[0].top;
      }
    });
    return () => registerEditorJump(null);
  }, [content]);

  useEffect(() => {
    notifyContentChanged();
  }, [content]);

  const refreshNotes = useCallback(async () => {
    const loadedNotes = await listNotes();
    setNotes(loadedNotes);
    return loadedNotes;
  }, []);

  const applyNote = useCallback((note: Note) => {
    setEditingNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setMode("new");
    setStatus("opened");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [loadedConfig] = await Promise.all([getConfig(), refreshNotes()]);
        if (!cancelled) {
          setNoteSurfaceAutoSave(loadedConfig.noteSurfaceAutoSave);
          setSurfaceFontSize(loadedConfig.surfaceFontSize ?? 14);
          setTileRenderMarkdown(loadedConfig.tileRenderMarkdown ?? false);
          setTileDoubleClickToEdit(loadedConfig.tileDoubleClickToEdit ?? false);
          setTileSaveReturnsToPin(loadedConfig.tileSaveReturnsToPin ?? false);
          setTileColorRaw(normalizeTileColor(loadedConfig.tileColor));
          setTileColorMode(loadedConfig.tileColorMode ?? "system");
          setTileColor(
            resolveTileColor(loadedConfig.tileColorMode ?? "system", loadedConfig.tileColor),
          );
          if (loadedConfig.textRenderColor) {
            setTextRenderColor(loadedConfig.textRenderColor);
            document.documentElement.style.setProperty(
              "--text-render-color",
              loadedConfig.textRenderColor,
            );
          }
        }
        if (initialNoteId) {
          const note = await getNote(initialNoteId);
          if (!cancelled) applyNote(note);
        }
      } catch (error) {
        if (!cancelled) showToast(getErrorMessage(error));
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, initialNoteId, refreshNotes]);

  useEffect(() => {
    const unlisten = listen("notes-changed", () => {
      void refreshNotes().catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  useEffect(() => {
    if (isStandby.current) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          hasEnteredOnce.current = true;
          void showCurrentWindow()
            .then(() => contentRef.current?.focus())
            .catch(() => undefined);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      tileColor?: string;
      tileColorMode?: TileColorMode;
      surfaceFontSize?: number;
      tileRenderMarkdown?: boolean;
      tileDoubleClickToEdit?: boolean;
      tileSaveReturnsToPin?: boolean;
      textRenderColor?: string;
    }>("config-changed", (event) => {
      const mode = event.payload.tileColorMode ?? tileColorMode;
      const raw = event.payload.tileColor ?? tileColorRaw;
      setTileColorMode(mode);
      setTileColorRaw(normalizeTileColor(raw));
      setTileColor(resolveTileColor(mode, raw));
      if (event.payload.surfaceFontSize != null) setSurfaceFontSize(event.payload.surfaceFontSize);
      if (event.payload.tileRenderMarkdown != null)
        setTileRenderMarkdown(event.payload.tileRenderMarkdown);
      if (event.payload.tileDoubleClickToEdit != null)
        setTileDoubleClickToEdit(event.payload.tileDoubleClickToEdit);
      if (event.payload.tileSaveReturnsToPin != null)
        setTileSaveReturnsToPin(event.payload.tileSaveReturnsToPin);
      if (event.payload.textRenderColor != null) {
        setTextRenderColor(event.payload.textRenderColor);
        document.documentElement.style.setProperty(
          "--text-render-color",
          event.payload.textRenderColor || "inherit",
        );
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [tileColorMode, tileColorRaw]);

  useEffect(() => {
    if (tileColorMode !== "system") return;
    const observer = new MutationObserver(() => {
      setTileColor(resolveTileColor("system", tileColorRaw));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [tileColorMode, tileColorRaw]);

  useEffect(() => {
    let myLabel = "";
    try {
      myLabel = getCurrentWindow().label;
      windowLabelRef.current = myLabel;
    } catch {
      // not in Tauri environment (tests)
    }

    const unlisten = listen<string>("notepad:activate", (event) => {
      if (event.payload !== myLabel) return;

      isStandby.current = false;
      hasEnteredOnce.current = true;
      setEditingNoteId(null);
      setTitle("");
      setContent("");
      setMode("new");
      setStatus("empty");
      setIsExiting(false);
      setSurfaceMode("pad");
      void refreshNotes().catch(() => undefined);
      void showCurrentWindow()
        .then(() => contentRef.current?.focus())
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  const saveNote = useCallback(async () => {
    const existingCategory = notes.find((n) => n.id === editingNoteId)?.category ?? "";
    const request = { title, content, category: existingCategory };
    const note = editingNoteId
      ? await updateNote(editingNoteId, request)
      : await createNote(request);

    setEditingNoteId(note.id);
    setNotes((current) => {
      const metadata = metadataFromNote(note);
      const exists = current.some((item) => item.id === note.id);
      const next = exists
        ? current.map((item) => (item.id === note.id ? metadata : item))
        : [metadata, ...current];
      return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    const contentChanged = contentValueRef.current !== content || titleValueRef.current !== title;
    setStatus(contentChanged ? "dirty" : "saved");
    return note;
  }, [content, editingNoteId, notes, title]);

  useEffect(() => {
    const unlisten = listen<UpdateInstallPrepareRequest>("update://prepare-install", (event) => {
      const respond = async () => {
        const windowLabel = windowLabelRef.current || "notepad";
        if (statusRef.current !== "dirty") {
          await reportInstallPreparation(event.payload.requestId, windowLabel, "ready");
          return;
        }

        try {
          await saveNote();
          await reportInstallPreparation(event.payload.requestId, windowLabel, "ready");
        } catch (error) {
          setStatus("saveFailed");
          showToast(getErrorMessage(error));
          await reportInstallPreparation(
            event.payload.requestId,
            windowLabel,
            "failed",
            getErrorMessage(error),
          );
        }
      };

      void respond().catch(async (error) => {
        await reportInstallPreparation(
          event.payload.requestId,
          windowLabelRef.current || "notepad",
          "failed",
          getErrorMessage(error),
        ).catch(() => undefined);
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [saveNote]);

  const hasDraftContent = useCallback(
    () => Boolean(editingNoteId || title.trim() || content.trim()),
    [content, editingNoteId, title],
  );

  const imageBaseDir = useImageBaseDir();

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (editingNoteId) return editingNoteId;
    try {
      const note = await saveNote();
      return note.id;
    } catch {
      return null;
    }
  }, [editingNoteId, saveNote]);

  const {
    handlePaste: imagePasteHandler,
    handleDrop: imageDropHandler,
    handleDragOver: imageDragOverHandler,
  } = useImagePaste({
    noteId: editingNoteId,
    textareaRef: contentRef,
    setContent,
    markDirty: () => setStatus("dirty"),
    onEnsureNoteSaved: ensureNoteSaved,
    onError: showToast,
    t,
  });

  // MD 文件拖入导入处理
  const handleMdFileDrop = useCallback(
    async (files: FileList) => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.name.endsWith(".md") && !file.name.endsWith(".markdown")) continue;
        try {
          const text = await file.text();
          // 提取标题：以 "# " 开头的第一行
          const lines = text.split("\n");
          const firstLine = lines[0]?.trim() ?? "";
          const extractedTitle = firstLine.startsWith("# ")
            ? firstLine.slice(2).trim()
            : file.name.replace(/\.(md|markdown)$/i, "");
          setTitle(extractedTitle);
          setContent(text);
          setStatus("dirty");
        } catch {
          showToast(t("errors.mdImportFailed", { defaultValue: "MD 文件导入失败" }));
        }
      }
    },
    [setTitle, setContent, showToast, t],
  );

  // 合并的拖入处理：图片 + MD 文件
  const handleCombinedDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;

      const items = Array.from(dataTransfer.items);
      const hasMdFile = items.some(
        (item) =>
          item.kind === "file" &&
          (item.type === "text/markdown" ||
            item.type === "text/x-markdown" ||
            item.type === ""),
      );

      if (hasMdFile && dataTransfer.files.length > 0) {
        // 检测是否有 .md 文件
        const mdFiles = Array.from(dataTransfer.files).filter(
          (f) => f.name.endsWith(".md") || f.name.endsWith(".markdown"),
        );
        if (mdFiles.length > 0) {
          event.preventDefault();
          const fileList = new DataTransfer();
          mdFiles.forEach((f) => fileList.items.add(f));
          void handleMdFileDrop(fileList.files);
          return;
        }
      }

      // 否则按图片处理
      imageDropHandler(event);
    },
    [imageDropHandler, handleMdFileDrop],
  );

  // 从文件对话框选择图片插入
  const handleInsertImage = useCallback(async () => {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
          },
        ],
      });

      if (typeof path !== "string") return;

      let resolvedId = editingNoteId;
      if (!resolvedId) {
        resolvedId = await ensureNoteSaved();
        if (!resolvedId) return;
      }

      const relativePath = await saveImageFromPath(resolvedId, path);
      const textarea = contentRef.current;
      if (textarea && relativePath) {
        const mdImage = `![](${relativePath})`;
        textarea.focus();
        document.execCommand("insertText", false, "\n" + mdImage + "\n");
        setContent(textarea.value);
        setStatus("dirty");
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [editingNoteId, ensureNoteSaved, contentRef, setContent, showToast]);

  const handleCombinedDragOver = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.dataTransfer.items);
      const hasMd = items.some(
        (item) =>
          item.kind === "file" &&
          (item.type === "text/markdown" ||
            item.type === "text/x-markdown" ||
            (item.type === "" &&
              (item as DataTransferItem & { getAsFile?: () => File })
                ?.getAsFile?.()
                ?.name?.endsWith?.(".md"))),
      );
      if (hasMd) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        return;
      }
      imageDragOverHandler(event);
    },
    [imageDragOverHandler],
  );

  const tileNoteId = editingNoteId ?? initialNoteId ?? "";

  const switchSurfaceMode = useCallback(
    async (nextMode: NoteSurfaceMode) => {
      const unpinnedNoteId = tileSurfaceModeUnpinNoteId(surfaceMode, nextMode, tileNoteId);
      setSurfaceMode(nextMode);
      if (unpinnedNoteId) {
        void emitTileWindowUnpinned(unpinnedNoteId).catch(() => undefined);
      }

      try {
        const currentBounds = await getCurrentWindowBounds();
        const targetBounds = getSurfaceTargetBounds(nextMode, currentBounds);

        if (nextMode === "tile") {
          await setCurrentWindowAlwaysOnTop(true);
        }

        await animateCurrentWindowBounds(targetBounds);
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [surfaceMode, tileNoteId],
  );

  useEffect(() => {
    function handleSurfaceModeRequest(event: Event) {
      const nextMode = surfaceModeFromEvent(event);
      if (!nextMode) return;
      void switchSurfaceMode(nextMode);
    }

    window.addEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    };
  }, [switchSurfaceMode]);

  useEffect(() => {
    if (surfaceMode !== "tile") return;
    void setCurrentWindowAlwaysOnTop(true).catch(() => undefined);
  }, [surfaceMode]);

  const handleSave = useCallback(
    async ({ isAutoSave = false }: { isAutoSave?: boolean } = {}) => {
      try {
        const savedNote = await saveNote();
        if (
          shouldReturnToTileAfterManualSave({
            enabled: tileSaveReturnsToPin,
            noteId: savedNote.id,
            currentMode: surfaceMode,
            isAutoSave,
          })
        ) {
          await switchSurfaceMode("tile");
        }
      } catch (error) {
        setStatus("saveFailed");
        showToast(getErrorMessage(error));
      }
    },
    [saveNote, surfaceMode, switchSurfaceMode, tileSaveReturnsToPin],
  );

  const clearPendingTileDrag = useCallback(() => {
    tileDragIntentRef.current = null;
  }, []);

  useEffect(() => clearPendingTileDrag, [clearPendingTileDrag]);

  useEffect(() => {
    if (surfaceMode !== "tile" || !tileDoubleClickToEdit) {
      clearPendingTileDrag();
      return undefined;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const intent = tileDragIntentRef.current;
      if (!intent) return;
      // Pointer left the window during a missed mouseup, etc. — drop the stale intent.
      if ((event.buttons & 1) === 0) {
        clearPendingTileDrag();
        return;
      }

      const distanceX = event.screenX - intent.x;
      const distanceY = event.screenY - intent.y;
      const distance = Math.hypot(distanceX, distanceY);
      if (distance < TILE_DRAG_START_THRESHOLD_PX) return;

      tileDragIntentRef.current = null;
      // Compensate for the deadzone drift before handing off to the OS drag.
      void startCurrentWindowDragWithOffset(distanceX, distanceY).catch(() => undefined);
    };

    const handleMouseUp = () => clearPendingTileDrag();

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clearPendingTileDrag, surfaceMode, tileDoubleClickToEdit]);

  const handleTileDoubleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (
        !shouldEnterPadFromTileOnDoubleClick(
          tileDoubleClickToEdit,
          isTileControlDoubleClickTarget(event.target),
        )
      ) {
        return;
      }

      clearPendingTileDrag();
      event.preventDefault();
      event.stopPropagation();
      void switchSurfaceMode("pad");
    },
    [clearPendingTileDrag, switchSurfaceMode, tileDoubleClickToEdit],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void handleSave();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  const handleOpenNote = async (noteId: string) => {
    try {
      const note = await getNote(noteId);
      applyNote(note);
      await switchSurfaceMode("pad");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handlePin = async () => {
    try {
      if (shouldSaveBeforeSwitchingToTile(noteSurfaceAutoSave) || !editingNoteId) {
        await saveNote();
      }
      await switchSurfaceMode("tile");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleClose = useCallback(() => {
    setIsExiting(true);
    const closeSurface = surfaceMode === "tile" ? closeCurrentWindow : recycleCurrentNotepad;
    void closeSurface().catch((error) => {
      setIsExiting(false);
      showToast(getErrorMessage(error));
    });
  }, [surfaceMode]);

  const copyTileContent = useCallback(async () => {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        throw new Error(t("notepad.error.copyUnsupported", { defaultValue: "当前环境不支持复制" }));
      }
      await clipboard.writeText(content);
      setStatus("copied");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [content, t]);

  useEffect(() => {
    function handleSurfaceActionRequest(event: Event) {
      const action = surfaceActionFromEvent(event);
      if (!action) return;

      if (action === "copy") {
        void copyTileContent();
        return;
      }

      if (action === "save") {
        void handleSave();
        return;
      }

      if (action === "close") {
        void handleClose();
        return;
      }

      void switchSurfaceMode("pad");
    }

    window.addEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    };
  }, [copyTileContent, handleClose, handleSave, switchSurfaceMode]);

  useEffect(() => {
    if (!noteSurfaceAutoSave || mode !== "new" || status !== "dirty") {
      return undefined;
    }
    if (!hasDraftContent()) return undefined;

    const timer = window.setTimeout(() => {
      void handleSave({ isAutoSave: true });
    }, 900);

    return () => window.clearTimeout(timer);
  }, [handleSave, hasDraftContent, mode, noteSurfaceAutoSave, status]);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea")) return;

    if (surfaceMode === "tile" && tileDoubleClickToEdit) {
      if (event.button !== 0 || event.detail > 1) return;
      clearPendingTileDrag();
      tileDragIntentRef.current = {
        x: event.screenX,
        y: event.screenY,
      };
      return;
    }

    void startCurrentWindowDrag().catch(() => undefined);
  };

  const resetDraft = () => {
    setEditingNoteId(null);
    setTitle("");
    setContent("");
    setMode("new");
    setStatus("empty");
  };

  const isTile = surfaceMode === "tile";
  const tileTitle = title.trim();
  const enterClass = hasEnteredOnce.current ? "" : "animate-window-enter";
  const surfaceWrapperClassName = `w-full h-screen flex flex-col bg-transparent p-0 ${isExiting ? "animate-window-exit" : enterClass}`;
  const padSurfaceClassName =
    "app-surface-frame relative noise-bg w-full h-full min-h-0 bg-cloud overflow-hidden flex flex-col flex-1 border border-paper-deep/70 shadow-[0_1px_10px_rgba(26,26,24,0.06)] transition-all duration-200 ease-out";

  return (
    <div className={surfaceWrapperClassName}>
      {isTile ? (
        <Tile
          title={tileTitle || undefined}
          content={content}
          color={tileColor}
          fontSize={surfaceFontSize}
          renderMarkdown={tileRenderMarkdown}
          imageBaseDir={imageBaseDir ?? undefined}
          width="100%"
          className="h-full cursor-default"
          data-surface-mode={surfaceMode}
          data-context-menu="tile"
          data-note-id={tileNoteId}
          onMouseDown={handleDrag}
          onDoubleClick={handleTileDoubleClick}
        >
          <button
            type="button"
            aria-label="取消钉屏"
            title="取消钉屏"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void handleClose()}
            className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full text-ink-ghost/70 hover:text-red-400 hover:bg-danger-bg/80 transition-colors cursor-pointer"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <SurfaceResizeHandles />
        </Tile>
      ) : (
        <div className={padSurfaceClassName} data-surface-mode={surfaceMode}>
          <>
            <div
              className="flex items-center justify-between px-4 pt-3 pb-0 cursor-default"
              onMouseDown={handleDrag}
            >
              <div className="flex items-center gap-0.5">
                <button
                  onClick={resetDraft}
                  className={`relative px-3.5 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
                    mode === "new"
                      ? "text-bamboo font-medium"
                      : "text-ink-ghost hover:text-ink-faint"
                  }`}
                >
                  {editingNoteId ? tabLabels.edit : tabLabels.new}
                  {mode === "new" && (
                    <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-bamboo rounded-full" />
                  )}
                </button>
                <button
                  onClick={() => setMode("open")}
                  className={`relative px-3.5 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
                    mode === "open"
                      ? "text-bamboo font-medium"
                      : "text-ink-ghost hover:text-ink-faint"
                  }`}
                >
                  {tabLabels.open}
                  {mode === "open" && (
                    <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-bamboo rounded-full" />
                  )}
                </button>
              </div>

              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => void handlePin()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-200 cursor-pointer text-ink-ghost hover:text-ink-faint hover:bg-paper-warm"
                  title={t("notepad.tooltip.pinToTile", { defaultValue: "转为磁贴" })}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 17v5" />
                    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z" />
                  </svg>
                </button>

                <button
                  onClick={() => void handleClose()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:bg-danger-bg hover:text-red-400 transition-all duration-200 cursor-pointer"
                  title={t("notepad.tooltip.close", { defaultValue: "关闭" })}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="mx-4 mt-1 h-px bg-paper-deep/50" />

            {mode === "new" ? (
              <div
                data-pad-editor-body="true"
                className="px-4 pt-3 pb-2 flex flex-col flex-1 min-h-0"
              >
                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setStatus("dirty");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "ArrowDown") {
                      event.preventDefault();
                      contentRef.current?.focus();
                    }
                  }}
                  placeholder={t("notepad.placeholder.title", { defaultValue: "标题（可选）" })}
                  className="w-full font-display font-medium text-ink placeholder:text-ink-ghost/60 mb-2 tracking-wide shrink-0"
                  style={{
                    fontSize: `${surfaceFontSize}px`,
                    color: textRenderColor || undefined,
                  }}
                />

                <div className="relative flex-1 min-h-0">
                  <div
                    aria-hidden="true"
                    className="absolute left-0 right-0 pointer-events-none font-body leading-relaxed"
                    style={{
                      top: -editorScrollTop,
                      fontSize: `${surfaceFontSize}px`,
                      tabSize: `var(--tab-indent-size, 2)`,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      padding: "2px",
                      color: textRenderColor || "var(--color-ink-soft)",
                    }}
                    dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                  />
                <textarea
                  ref={contentRef}
                  data-tab-indent="true"
                  value={content}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setStatus("dirty");
                  }}
                  onSelect={(event) => {
                    const textarea = event.currentTarget;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    setActiveSelection(
                      start === end
                        ? null
                        : { text: textarea.value.slice(start, end), start, end },
                    );
                  }}
                  onScroll={(event) => {
                    setEditorScrollTop(event.currentTarget.scrollTop);
                  }}
                  onPaste={imagePasteHandler}
                  onDrop={handleCombinedDrop}
                  onDragOver={handleCombinedDragOver}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key.toLowerCase() === "h"
                    ) {
                      event.preventDefault();
                      setFindReplaceOpen((open) => !open);
                      return;
                    }
                    // Markdown 快捷键（Ctrl+B/I//\ 等）
                    if (handleMarkdownShortcut(event)) return;

                    if (event.key === "ArrowUp") {
                      const ta = contentRef.current;
                      if (ta && ta.selectionStart === ta.selectionEnd) {
                        const textBeforeCursor = content.slice(0, ta.selectionStart);
                        if (!textBeforeCursor.includes("\n")) {
                          event.preventDefault();
                          titleRef.current?.focus();
                        }
                      }
                    }
                  }}
                  placeholder={t("notepad.placeholder.content", { defaultValue: "写点什么……" })}
                  className="relative w-full h-full leading-relaxed text-ink-soft font-body placeholder:text-ink-ghost/50"
                  style={{
                    fontSize: `${surfaceFontSize}px`,
                    tabSize: `var(--tab-indent-size, 2)`,
                    color: "transparent",
                    caretColor: textRenderColor || "var(--color-ink)",
                    padding: "2px",
                  }}
                />
                </div>

                <div className="flex items-center justify-between mt-auto pt-2 border-t border-paper-deep/30 shrink-0">
                  <span className="text-[11px] text-ink-ghost font-mono tabular-nums truncate max-w-[170px]">
                    {`${countNoteChars(content)} ${t("common.wordCountUnit", { defaultValue: "字" })} · ${statusLabel[status]}`}
                  </span>
                  {pluginStatusItems.map((text) => (
                    <span key={text} className="text-[11px] text-ink-ghost font-mono tabular-nums shrink-0">
                      · {text}
                    </span>
                  ))}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPluginsPanelOpen(true)}
                      className="px-2 py-1.5 text-[11px] text-ink-faint hover:text-ink-soft rounded-lg hover:bg-paper-warm transition-all duration-200 cursor-pointer"
                      title="插件"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M9 3v2a2 2 0 1 0 4 0V3h4a1 1 0 0 1 1 1v4h-2a2 2 0 1 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H5a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H4V5a1 1 0 0 1 1-1h4z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => void handleInsertImage()}
                      className="px-2 py-1.5 text-[11px] text-ink-faint hover:text-ink-soft rounded-lg hover:bg-paper-warm transition-all duration-200 cursor-pointer"
                      title={t("notepad.button.insertImage", { defaultValue: "插入图片" })}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                    </button>
                    <button
                      onClick={() => {
                        if (content.trim() || title.trim()) {
                          void exportNoteAsPdf(title || "笔记", content).catch((err) =>
                            showToast(getErrorMessage(err)),
                          );
                        } else {
                          showToast(
                            t("errors.emptyContentExport", {
                              defaultValue: "没有可导出的内容",
                            }),
                          );
                        }
                      }}
                      className="px-3 py-1.5 text-[11px] text-ink-faint hover:text-ink-soft rounded-lg hover:bg-paper-warm transition-all duration-200 cursor-pointer"
                      title={t("notepad.button.exportPdf", { defaultValue: "导出 PDF" })}
                    >
                      PDF
                    </button>
                    <button
                      onClick={resetDraft}
                      className="px-4 py-1.5 text-[12px] text-ink-faint hover:text-ink-soft rounded-lg hover:bg-paper-warm transition-all duration-200 cursor-pointer"
                    >
                      {t("notepad.button.clear", { defaultValue: "清空" })}
                    </button>
                    <button
                      onClick={() => void handleSave()}
                      className="px-4 py-1.5 text-[12px] text-cloud bg-bamboo hover:bg-bamboo-light rounded-lg transition-all duration-200 font-medium cursor-pointer"
                    >
                      {t("common.save", { defaultValue: "保存" })}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <NotepadOpenPanel
                notes={notes}
                onOpenNote={(noteId) => void handleOpenNote(noteId)}
              />
            )}
          </>
          <SurfaceResizeHandles />
        </div>
      )}
      {pluginsPanelOpen && (
        <div className="fixed inset-0 z-[10000]">
          <div
            className="absolute inset-0 bg-ink/20 backdrop-blur-sm animate-fade-in"
            onClick={() => setPluginsPanelOpen(false)}
          />
          <div className="absolute right-0 top-0 bottom-0 animate-slide-in-right">
            <PluginCommandPanel onClose={() => setPluginsPanelOpen(false)} />
          </div>
        </div>
      )}
      {findReplaceOpen && (
        <FindReplacePanel
          matchInfo={
            findMatches.length > 0
              ? `${currentFindIndex + 1}/${findMatches.length}`
              : "0/0"
          }
          onFindNext={handleFindNext}
          onFindPrev={handleFindPrev}
          onReplace={handleReplace}
          onReplaceAll={handleReplaceAll}
          onClose={() => setFindReplaceOpen(false)}
        />
      )}
    </div>
  );
}
