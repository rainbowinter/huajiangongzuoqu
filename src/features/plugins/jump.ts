type JumpFn = (offset: number) => void;

let editorJump: JumpFn | null = null;
let previewJump: JumpFn | null = null;

export function registerEditorJump(fn: JumpFn | null): void {
  editorJump = fn;
}

export function registerPreviewJump(fn: JumpFn | null): void {
  previewJump = fn;
}

export function scrollEditorTo(offset: number): void {
  editorJump?.(offset);
}

export function scrollPreviewTo(offset: number): void {
  previewJump?.(offset);
}
