import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage, readExternalFile } from "../features/notes/api";
import { sanitizePluginHtml } from "../features/plugins/sanitizeHtml";
import { readWorkspaceFile } from "../features/workspace/api";
import {
  getFileRenderer,
  type FileType,
  type WorkspaceFilePayload,
} from "../features/workspace/fileTypes";

/**
 * **没有编辑器**的那些类型的展示：图片 / 媒体 / 插件自定义 / 不支持。
 *
 * `code` / `text` / `markdown` / `table` 不在这条路径上 —— 它们有编辑器，走
 * MainWindow 的编辑区（其中 markdown 与 table 另外有预览面板）。这样 `.py`、`.txt`
 * 这类文件打开时不会挂一个空的预览窗格。
 *
 * **图片/媒体不走文本读取**：通过 Tauri 的 asset 协议直接交给 WebView，避免把二进制
 * 当字符串搬一遍。前提是所在的工作文件夹在 asset scope 里 —— 添加文件夹时登记过。
 */
interface FilePreviewProps {
  path: string;
  type: FileType;
}

/** 表格预览最多渲染多少行。 */
const MAX_TABLE_ROWS = 500;

/**
 * 读文件的文本内容。
 *
 * 优先走工作文件夹通道（路径限制更紧）；文件不在任何工作文件夹里时（例如从系统
 * 「打开方式」进来的），退回既有的外部文件通道 —— 它本来就无路径限制，所以这不算
 * 新增能力，只是让两种来源都能正常预览。
 */
async function readText(path: string): Promise<string> {
  try {
    return await readWorkspaceFile(path);
  } catch {
    return readExternalFile(path);
  }
}

/** RFC4180 风格的定界文本解析：支持双引号包裹与 `""` 转义。 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        // 连续两个引号表示一个字面引号，否则退出引号区。
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * 表格预览。
 *
 * 独立导出是因为它现在挂在编辑区的**预览面板**上（和 Markdown 预览并列），而不是
 * 独立页面 —— csv 的编辑态是原始文本，预览态才是这张表。
 */
export function TablePreview({ text, isTsv }: { text: string; isTsv: boolean }) {
  const { t } = useTranslation();

  const rows = parseDelimited(text, isTsv ? "\t" : ",");
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const [header, ...body] = shown;

  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-ink-ghost leading-relaxed">
        {t("main.filePreview.emptyTable", { defaultValue: "没有可显示的内容" })}
      </p>
    );
  }

  return (
    <div>
      <table className="min-w-full text-[12px] border-collapse border md-table">
        {header ? (
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th
                  key={index}
                  className="text-left px-2.5 py-1.5 border md-table font-semibold text-ink bg-paper-warm/50 whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="px-2.5 py-1.5 border md-table text-ink-soft whitespace-nowrap"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_TABLE_ROWS ? (
        <p className="px-1 pt-2 text-[10px] text-ink-ghost/70">
          {t("main.filePreview.truncatedRows", {
            defaultValue: "行数过多，仅显示前 {{count}} 行",
            count: MAX_TABLE_ROWS,
          })}
        </p>
      ) : null}
    </div>
  );
}

export function FilePreview({ path, type }: FilePreviewProps) {
  const { t } = useTranslation();
  const [customHtml, setCustomHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = path.split(/[\\/]/).pop() ?? path;

  // 只有插件自定义类型需要宿主先读内容；图片/媒体走 asset 协议。
  useEffect(() => {
    setCustomHtml(null);
    setError(null);

    if (type.kind !== "custom") return;

    let cancelled = false;

    const render = (payload: WorkspaceFilePayload) => {
      const renderer = getFileRenderer(type.id);
      if (!renderer) {
        setError(t("main.filePreview.noRenderer", { defaultValue: "该类型没有提供预览器" }));
        return;
      }
      void renderer(payload)
        .then((html) => {
          if (!cancelled) setCustomHtml(html);
        })
        .catch((renderError: unknown) => {
          if (!cancelled) setError(getErrorMessage(renderError));
        });
    };

    void readText(path)
      .then((text) => {
        if (!cancelled) render({ name, path, content: text });
      })
      .catch(() => {
        // 二进制文件读不成文本是正常的：把内容置空再交给渲染器，由它自己决定
        // 怎么处理（例如按路径渲染图片）。
        if (!cancelled) render({ name, path, content: null });
      });

    return () => {
      cancelled = true;
    };
  }, [path, type.id, type.kind, name, t]);

  const centered = "flex-1 flex items-center justify-center overflow-auto p-6";

  if (type.kind === "none") {
    return (
      <div className={centered}>
        <p className="text-[12px] text-ink-ghost">
          {t("main.filePreview.unsupported", { defaultValue: "该格式暂不支持预览" })}
        </p>
      </div>
    );
  }

  if (type.kind === "image") {
    return (
      <div className={centered}>
        <img
          src={convertFileSrc(path)}
          alt={name}
          className="max-w-full max-h-full rounded object-contain"
        />
      </div>
    );
  }

  if (type.kind === "media") {
    const src = convertFileSrc(path);
    const isAudio = /\.(mp3|wav|ogg|flac|m4a)$/i.test(path);
    return (
      <div className={centered}>
        {isAudio ? (
          <audio src={src} controls className="w-full max-w-[520px]" />
        ) : (
          <video src={src} controls className="max-w-full max-h-full rounded" />
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className={centered}>
        <p className="text-[12px] text-ink-ghost leading-relaxed text-center">{error}</p>
      </div>
    );
  }

  if (customHtml === null) {
    return (
      <div className={centered}>
        <p className="text-[12px] text-ink-ghost">
          {t("common.loading", { defaultValue: "载入中…" })}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-auto p-4"
      // 插件产出的 HTML 与插件面板走同一道消毒闸：这里同样是注入主世界。
      dangerouslySetInnerHTML={{ __html: sanitizePluginHtml(customHtml) }}
    />
  );
}
