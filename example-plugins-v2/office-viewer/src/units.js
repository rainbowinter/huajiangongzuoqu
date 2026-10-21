/**
 * 单位换算。
 *
 * 引擎内部统一用 **CSS px（96dpi）**：
 *
 * * 1 pt = 4/3 px
 * * 1 twip = 1/20 pt = 1/15 px
 * * 1 inch = 914400 EMU = 96 px
 */

export const PT_TO_PX = 4 / 3;
export const TWIPS_PER_PX = 15;
export const EMU_PER_PX = 9525;

export function twipsToPx(value) {
  return (Number(value) || 0) / TWIPS_PER_PX;
}

export function ptToPx(value) {
  return (Number(value) || 0) * PT_TO_PX;
}

export function halfPointsToPx(value) {
  return ((Number(value) || 0) / 2) * PT_TO_PX;
}

export function emuToPx(value) {
  return (Number(value) || 0) / EMU_PER_PX;
}

export function pxToPt(value) {
  return (Number(value) || 0) / PT_TO_PX;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
