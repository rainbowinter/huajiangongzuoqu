import { useEffect, useState } from "react";
import { getStatusBarRenderers, subscribeStatusBar } from "./registry";
import type { Selection } from "./types";

export function usePluginStatusBar(selection: Selection | null): string[] {
  const [renderers, setRenderers] = useState(() => getStatusBarRenderers());

  useEffect(() => subscribeStatusBar(() => setRenderers(getStatusBarRenderers())), []);

  return renderers
    .map((renderer) => renderer(selection))
    .filter((text): text is string => Boolean(text));
}
