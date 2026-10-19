import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "../features/notes/api";
import { listWorkspaceDir, type WorkspaceEntry } from "../features/workspace/api";
import { Modal, ModalActions } from "./Modal";

/**
 * 「移动到…」的目标选择器：一棵**逐级展开**的目录树。
 *
 * 为什么不是平铺一长串子目录：工作区一深，菜单里直接铺开几十个相对路径既难扫，
 * 也会把屏幕撑满。这里只画当前展开的层级，点箭头才加载下一层 —— 与左侧目录树同一套
 * 懒加载节奏。
 *
 * `exclude` 是正在移动的那些目录：不能把文件夹移进它自己或它的子树里，所以这些行
 * 会被禁用，连展开都不给（展开只为了选里面的目录，没有意义）。
 */
export function WorkspaceFolderPicker({
  root,
  title,
  exclude,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: {
  root: string;
  title: string;
  /** 这些目录及其子树不可选。 */
  exclude: string[];
  confirmLabel: string;
  /** 移动请求进行中：按钮暂时不可用，避免连点发出两次。 */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (dir: string) => void;
}) {
  const { t } = useTranslation();
  const [levels, setLevels] = useState<Map<string, WorkspaceEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(root);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const listing = await listWorkspaceDir(dir);
      setLevels((current) =>
        new Map(current).set(
          dir,
          listing.entries.filter((entry) => entry.isDir),
        ),
      );
      setError(null);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load(root);
  }, [load, root]);

  const separator = root.includes("\\") ? "\\" : "/";
  const normalize = (path: string) => path.replace(/[\\/]+$/, "");
  const excluded = (path: string) => {
    const target = normalize(path);
    return exclude.some((source) => {
      const base = normalize(source);
      return target === base || target.startsWith(`${base}${separator}`);
    });
  };

  const toggle = (path: string) => {
    if (excluded(path)) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!levels.has(path)) void load(path);
      }
      return next;
    });
  };

  const renderLevel = (dir: string, depth: number) => {
    const entries = levels.get(dir);
    if (!entries) {
      return (
        <p className="py-1 text-[11px] text-ink-ghost" style={{ paddingLeft: 12 + depth * 14 }}>
          {t("common.loading", { defaultValue: "载入中…" })}
        </p>
      );
    }
    if (entries.length === 0) {
      return (
        <p className="py-1 text-[11px] text-ink-ghost" style={{ paddingLeft: 12 + depth * 14 }}>
          {t("main.workspace.noSubfolders", { defaultValue: "没有子文件夹" })}
        </p>
      );
    }

    return entries.map((entry) => {
      const disabled = excluded(entry.path);
      const isOpen = expanded.has(entry.path);
      const isSelected = selected === entry.path;
      return (
        <div key={entry.path}>
          <div
            className={`picker-row flex items-center gap-1 rounded-md ${
              isSelected ? "is-selected bg-bamboo-mist/60" : "hover:bg-paper-warm/70"
            } ${disabled ? "is-disabled opacity-40" : ""}`}
            style={{ paddingLeft: 4 + depth * 14 }}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => toggle(entry.path)}
              className="w-5 h-5 flex items-center justify-center rounded text-ink-ghost hover:text-bamboo disabled:cursor-not-allowed cursor-pointer"
              title={isOpen ? "收起" : "展开"}
            >
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setSelected(entry.path)}
              className={`flex-1 min-w-0 text-left py-1 pr-2 text-[12px] font-body truncate disabled:cursor-not-allowed cursor-pointer ${
                isSelected ? "text-bamboo" : "text-ink-soft"
              }`}
            >
              {entry.name}
            </button>
          </div>
          {isOpen ? renderLevel(entry.path, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <Modal title={title} onCancel={onCancel}>
      <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-paper-deep/30 bg-paper-warm/30 p-1">
        <button
          type="button"
          onClick={() => setSelected(root)}
          className={`w-full text-left px-2 py-1.5 rounded-md text-[12px] font-body truncate cursor-pointer ${
            selected === root ? "is-selected bg-bamboo-mist/60 text-bamboo" : "text-ink-soft hover:bg-paper-warm/70"
          }`}
        >
          {t("main.workspace.rootFolder", { defaultValue: "根目录" })}
        </button>
        {renderLevel(root, 1)}
      </div>
      {error ? <p className="mt-2 text-[11px] text-red-400 leading-relaxed">{error}</p> : null}
      <ModalActions
        busy={busy}
        confirmLabel={confirmLabel}
        onCancel={onCancel}
        onConfirm={() => {
          if (selected) onConfirm(selected);
        }}
      />
    </Modal>
  );
}
