import { useCallback, useEffect, useMemo, useState } from "react";
import { settingsGet, settingsSet } from "../features/plugins/api";
import { listLoadedPlugins } from "../features/plugins/registry";
import type { PluginManifest } from "../features/plugins/types";
import { showToast } from "./Toast";

/**
 * 声明式插件设置。
 *
 * 设置项由插件在 `plugin.json` 的 `contributes.settings` 里声明，宿主据此渲染
 * 表单——插件不需要写任何界面代码。取值存在 `plugin-data/<name>/settings.json`，
 * 与插件的 `storage`（kv.json）分开：用户在界面上配的东西不该被插件一句
 * `storage.clear()` 抹掉。
 */

type FieldType = "boolean" | "number" | "string" | "textarea" | "select";

interface PluginSettingField {
  key: string;
  type: FieldType;
  title: string;
  description?: string;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 `contributes` 里安全地解析出设置项。清单来自磁盘，必须当不可信输入处理。 */
export function parseSettingFields(manifest: PluginManifest): PluginSettingField[] {
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return [];

  const raw = contributes.settings;
  if (!Array.isArray(raw)) return [];

  const fields: PluginSettingField[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key : null;
    const title = typeof entry.title === "string" ? entry.title : key;
    const type = entry.type;
    if (!key || !title) continue;
    if (type !== "boolean" && type !== "number" && type !== "string" && type !== "textarea" && type !== "select") {
      continue;
    }

    const options: Array<{ value: string; label: string }> = [];
    if (Array.isArray(entry.options)) {
      for (const option of entry.options) {
        if (typeof option === "string") {
          options.push({ value: option, label: option });
        } else if (isRecord(option) && typeof option.value === "string") {
          options.push({
            value: option.value,
            label: typeof option.label === "string" ? option.label : option.value,
          });
        }
      }
    }

    fields.push({
      key,
      type,
      title,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(entry.default !== undefined ? { default: entry.default } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(typeof entry.min === "number" ? { min: entry.min } : {}),
      ...(typeof entry.max === "number" ? { max: entry.max } : {}),
      ...(typeof entry.step === "number" ? { step: entry.step } : {}),
    });
  }

  return fields;
}

function PluginSettingsGroup({ manifest }: { manifest: PluginManifest }) {
  const fields = useMemo(() => parseSettingFields(manifest), [manifest]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settingsGet(manifest.name)
      .then((stored) => {
        if (cancelled) return;
        // 未存过的项回落到清单里的 default
        const merged: Record<string, unknown> = {};
        for (const field of fields) {
          merged[field.key] = stored[field.key] ?? field.default;
        }
        setValues(merged);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [manifest.name, fields]);

  const commit = useCallback(
    async (key: string, value: unknown) => {
      const next = { ...values, [key]: value };
      setValues(next);
      try {
        await settingsSet(manifest.name, { [key]: value });
      } catch (error) {
        showToast(`保存插件设置失败：${String(error)}`);
      }
    },
    [manifest.name, values],
  );

  if (fields.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-ink-soft">{manifest.name}</span>
        <span className="text-[10px] text-ink-ghost">v{manifest.version}</span>
      </div>

      {!loaded ? (
        <p className="text-[11px] text-ink-ghost">读取中…</p>
      ) : (
        fields.map((field) => (
          <div key={field.key} className="flex items-start justify-between gap-3 py-0.5">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-ink-soft">{field.title}</p>
              {field.description ? (
                <p className="text-[10.5px] text-ink-ghost leading-relaxed">
                  {field.description}
                </p>
              ) : null}
            </div>

            {field.type === "boolean" ? (
              <input
                type="checkbox"
                checked={Boolean(values[field.key])}
                onChange={(event) => void commit(field.key, event.target.checked)}
                className="mt-0.5 cursor-pointer accent-[var(--color-bamboo)]"
              />
            ) : field.type === "number" ? (
              <input
                type="number"
                value={Number(values[field.key] ?? 0)}
                min={field.min}
                max={field.max}
                step={field.step}
                onChange={(event) => void commit(field.key, Number(event.target.value))}
                className="w-20 px-2 py-1 text-[11px] rounded-lg bg-paper-warm/60 border border-paper-deep/30 outline-none text-ink-soft"
              />
            ) : field.type === "select" ? (
              <select
                value={String(values[field.key] ?? "")}
                onChange={(event) => void commit(field.key, event.target.value)}
                className="px-2 py-1 text-[11px] rounded-lg bg-paper-warm/60 border border-paper-deep/30 outline-none text-ink-soft cursor-pointer"
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <textarea
                value={String(values[field.key] ?? "")}
                onChange={(event) => void commit(field.key, event.target.value)}
                rows={3}
                className="w-40 px-2 py-1 text-[11px] rounded-lg bg-paper-warm/60 border border-paper-deep/30 outline-none text-ink-soft resize-y"
              />
            ) : (
              <input
                type="text"
                value={String(values[field.key] ?? "")}
                onChange={(event) => void commit(field.key, event.target.value)}
                className="w-32 px-2 py-1 text-[11px] rounded-lg bg-paper-warm/60 border border-paper-deep/30 outline-none text-ink-soft"
              />
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** 只显示声明了设置项的插件；一个都没有时整块不渲染。 */
export function PluginSettingsSection() {
  const plugins = useMemo(
    () =>
      listLoadedPlugins().filter(
        (record) => record.status !== "invalid" && parseSettingFields(record.manifest).length > 0,
      ),
    [],
  );

  if (plugins.length === 0) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-[12px] font-medium text-ink-soft">插件</h3>
      {plugins.map((record) => (
        <PluginSettingsGroup key={record.manifest.name} manifest={record.manifest} />
      ))}
    </section>
  );
}
