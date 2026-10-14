import type { Note, NoteMetadata } from "../notes/types";

export interface Selection {
  text: string;
  start: number;
  end: number;
}

export interface PluginManifest {
  name: string;
  version: string;
  main: string;
  description: string;
}

export interface PluginCommand {
  id: string;
  title: string;
  plugin: string;
  run: () => void | Promise<void>;
}

export interface PluginPanelDef {
  id: string;
  title: string;
  width?: number;
  plugin?: string;
  standalone?: boolean;
  render: () => string;
  onClick?: (target: HTMLElement) => void;
}

export interface PluginApi {
  addCommand(command: { title: string; run: () => void | Promise<void> }): void;
  getActiveNoteContent(): string | null;
  setActiveNoteContent(content: string): boolean;
  getActiveNoteSelection(): Selection | null;
  replaceActiveNoteSelection(replacement: string): boolean;
  registerSelectionTransformer(transformer: (text: string) => string | null): void;
  registerStatusBarItem(render: (selection: Selection | null) => string | null): void;
  registerPanel(def: PluginPanelDef): void;
  scrollEditorTo(offset: number): void;
  scrollPreviewTo(offset: number): void;
  showToast(message: string, type?: "error" | "warning" | "info"): void;
  listNotes(): Promise<NoteMetadata[]>;
  getNote(id: string): Promise<Note>;
}

export interface PluginDefinition {
  name: string;
  onLoad(api: PluginApi): void | Promise<void>;
}
