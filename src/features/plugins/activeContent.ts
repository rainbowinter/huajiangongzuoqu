import type { Selection } from "./types";

interface ActiveContentAccessor {
  getContent: () => string;
  setContent: (content: string) => void;
  getSelection: () => Selection | null;
  replaceSelection: (replacement: string) => boolean;
}

let accessor: ActiveContentAccessor | null = null;

export function registerActiveContent(next: ActiveContentAccessor | null): void {
  accessor = next;
}

export function getActiveContent(): string | null {
  return accessor?.getContent() ?? null;
}

export function setActiveContent(content: string): boolean {
  if (!accessor) return false;
  accessor.setContent(content);
  return true;
}

export function getActiveSelection(): Selection | null {
  return accessor?.getSelection() ?? null;
}

export function replaceActiveSelection(replacement: string): boolean {
  if (!accessor) return false;
  return accessor.replaceSelection(replacement);
}
