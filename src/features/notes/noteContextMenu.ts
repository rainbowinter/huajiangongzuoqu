import { t, type TFunction } from "i18next";

export type NoteContextMenuAction = "export" | "openInTab" | "move" | "delete";

export interface NoteContextMenuItem {
  action: NoteContextMenuAction;
  label: string;
  tone?: "danger";
}

export function getNoteContextMenuItems(translate: TFunction = t): NoteContextMenuItem[] {
  return [
    {
      action: "openInTab",
      label: translate("noteMenu.openInTab", { defaultValue: "在新标签页中打开" }),
    },
    {
      action: "move",
      label: translate("noteMenu.moveToCategory", { defaultValue: "移动到分类…" }),
    },
    {
      action: "delete",
      label: translate("noteMenu.delete", { defaultValue: "删除笔记" }),
      tone: "danger",
    },
  ];
}
