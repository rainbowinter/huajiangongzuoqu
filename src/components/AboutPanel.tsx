import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ABOUT_DOCS } from "../features/docs/catalog";
import { releasePageFromEndpoint } from "../features/docs/aboutLinks";
import { readBundledDoc } from "../features/docs/api";
import { getUpdateEndpoint } from "../features/update/api";
import type { UpdateController } from "../features/update/useUpdate";
import { getPluginsDir } from "../features/plugins/api";
import { showToast } from "./Toast";

interface AboutPanelProps {
  onClose: () => void;
  /** 打开一篇只读文档（作为标签页）。`key` 用来去重，随包文档传文件名。 */
  onOpenDoc: (title: string, content: string, key?: string) => void;
  /** 笔记所在目录。由主窗口从设置里取 —— 这里不再去问一遍后端。 */
  notesDir?: string;
  /** 与标题栏徽标、设置面板共用同一个更新控制器 —— 绝不能在这里再 useUpdate()。 */
  update: UpdateController;
}

/** 一节：小标题 + 若干行。 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-[10.5px] font-mono uppercase tracking-wider text-ink-ghost/80 mb-1.5">
        {title}
      </h3>
      <div className="rounded-lg bg-paper-warm/50 divide-y divide-paper-deep/25">{children}</div>
    </section>
  );
}

/** 一行：左边标签，右边值。`onOpen` 有值时整行可点。 */
function Row({
  label,
  value,
  onOpen,
  title,
}: {
  label: string;
  value: string;
  onOpen?: () => void;
  title?: string;
}) {
  const content = (
    <>
      <span className="text-[11px] text-ink-ghost shrink-0">{label}</span>
      <span
        className={`text-[11px] font-mono truncate text-right ${
          onOpen ? "text-bamboo group-hover:underline" : "text-ink-soft"
        }`}
        title={title ?? value}
      >
        {value}
      </span>
    </>
  );

  if (!onOpen) {
    return <div className="about-row flex items-center justify-between gap-3 px-3 py-2">{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="about-row group w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-bamboo-mist/40 transition-colors cursor-pointer"
    >
      {content}
    </button>
  );
}

/**
 * 「关于」面板。
 *
 * 做成侧栏而不是标题栏上的下拉菜单：下拉会被标题栏那套拖拽/叠层吃掉点击（实测点不动），
 * 而且**它放不下东西** —— 版本、下载地址、更新源、数据目录这些都属于「关于」该说的。
 */
export function AboutPanel({ onClose, onOpenDoc, notesDir, update }: AboutPanelProps) {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [pluginsDir, setPluginsDir] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    // 这三样都拿不到也不该让面板开天窗 —— 有哪个显示哪个。
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
    void getUpdateEndpoint()
      .then(setEndpoint)
      .catch(() => setEndpoint(null));
    void getPluginsDir()
      .then(setPluginsDir)
      .catch(() => setPluginsDir(""));
  }, []);

  const openDoc = (doc: (typeof ABOUT_DOCS)[number]) => {
    const title = t(doc.titleKey, { defaultValue: doc.fallbackTitle });
    void readBundledDoc(doc.name)
      .then((content) => onOpenDoc(title, content, doc.name))
      .catch((error) => showToast(String(error)));
  };

  const releasePage = releasePageFromEndpoint(endpoint);

  /**
   * 「关于」里的手动检查。
   *
   * 直接用共用的 `update.check()` —— 它会把标题栏那颗更新胶囊一起点亮。
   * 返回值而不是读 `update.state`：`check()` 是异步的，await 回来时闭包里的 state
   * 还是调用前那一份。
   */
  const checkUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const result = await update.check();
      if (result.status === "available") {
        showToast(
          t("main.about.updateAvailable", {
            version: result.version,
            defaultValue: "发现新版本 {{version}}",
          }),
          "info",
        );
      } else if (result.status === "up-to-date") {
        showToast(
          t("main.about.updateUpToDate", { defaultValue: "已是最新版本" }),
          "info",
        );
      } else {
        // 端点连不上、超时、被代理拦了 —— 对用户来说都是「这次没查成」。
        console.warn("[update] 手动检查失败", result.message);
        showToast(
          t("main.about.updateTimeout", {
            defaultValue: "检查更新超时，请检查网络连接或代理",
          }),
          "error",
        );
      }
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <div className="about-panel w-full h-full flex flex-col bg-cloud/92 backdrop-blur-sm">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between shrink-0 border-b border-paper-deep/20">
        <span className="text-[13px] font-medium text-ink">
          {t("main.about.title", { defaultValue: "关于" })}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded-md text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
          title={t("common.close", { defaultValue: "关闭" })}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <div className="pt-3">
          <div className="text-[15px] font-display font-semibold text-ink tracking-wide">花笺</div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-[11px] font-mono text-ink-ghost">
              {version ? `v${version}` : "…"}
            </span>
            {update.enabled === true ? (
              <button
                type="button"
                onClick={() => void checkUpdate()}
                disabled={checkingUpdate || update.state.stage === "checking"}
                className="about-check-update shrink-0 px-2 h-5 rounded-md text-[10px] font-body text-bamboo bg-bamboo-mist/40 hover:bg-bamboo-mist/70 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
              >
                {checkingUpdate || update.state.stage === "checking"
                  ? t("main.about.checkingUpdate", { defaultValue: "检查中…" })
                  : t("main.about.checkUpdate", { defaultValue: "检查更新" })}
              </button>
            ) : null}
          </div>
        </div>

        {/* 三篇说明文档 */}
        <Section title={t("main.about.docs", { defaultValue: "说明文档" })}>
          {ABOUT_DOCS.map((doc) => (
            <Row
              key={doc.name}
              label={t(doc.titleKey, { defaultValue: doc.fallbackTitle })}
              value="›"
              onOpen={() => openDoc(doc)}
            />
          ))}
        </Section>

        {/* 下载与更新。没有更新源时整节只留「未配置」——不显示一个点不动的链接。 */}
        <Section title={t("main.about.downloadAndUpdate", { defaultValue: "下载与更新" })}>
          {releasePage ? (
            <Row
              label={t("main.about.releasePage", { defaultValue: "发布页" })}
              value={releasePage.replace(/^https?:\/\//, "")}
              title={releasePage}
              onOpen={() => void openUrl(releasePage)}
            />
          ) : null}
          <Row
            label={t("main.about.updateSource", { defaultValue: "更新源" })}
            value={endpoint ?? t("main.about.updateSourceNone", { defaultValue: "未配置" })}
            title={endpoint ?? undefined}
          />
        </Section>

        {/* 数据在哪。用户最常问的问题之一，顺手放这儿。 */}
        <Section title={t("main.about.dataLocation", { defaultValue: "数据位置" })}>
          <Row
            label={t("main.about.notesDir", { defaultValue: "笔记" })}
            value={notesDir ?? "—"}
            title={notesDir}
          />
          <Row
            label={t("main.about.pluginsDir", { defaultValue: "插件" })}
            value={pluginsDir || "—"}
            title={pluginsDir}
          />
        </Section>
      </div>
    </div>
  );
}
