export type ViewMode = "edit" | "split" | "preview";

export type ThemeOption = "light" | "dark" | "system";

export type AccentColor = "green" | "purple" | "pink";

export type TileColorMode = "system" | "custom";
export type BackgroundFit = "cover" | "contain" | "repeat";

export interface AppConfig {
  locale: string;
  dataDir: string;
  globalShortcut: string;
  closeToTray: boolean;
  autostart: boolean;
  defaultViewMode: string;
  noteAutoSave: boolean;
  noteSurfaceAutoSave: boolean;
  tileColor: string;
  tileColorMode: TileColorMode;
  theme: ThemeOption;
  accentColor?: AccentColor;
  fontSize: number;
  surfaceFontSize: number;
  tabIndentSize: number;
  externalFileAutoSave: boolean;
  rememberSurfaceSize: boolean;
  tileCtrlClose: boolean;
  tileDoubleClickToEdit: boolean;
  tileSaveReturnsToPin: boolean;
  tileRenderMarkdown: boolean;
  renderHtmlMarkdown: boolean;
  splitScrollSync: boolean;
  surfaceWidth?: number;
  surfaceHeight?: number;
  toggleVisibilityShortcut: string;
  openAtCursor: boolean;
  backgroundImagePath?: string;
  backgroundFit?: BackgroundFit;
  backgroundDim?: number;
  backgroundBlur?: number;
  backgroundEnabled?: boolean;
  backgroundScale?: number;
  backgroundPositionX?: number;
  backgroundPositionY?: number;
  /** 表格边框颜色。空串/缺省表示跟随主题。 */
  tableColor?: string;
  /** 水平分割线颜色。 */
  dividerColor?: string;
  /** 引用块左侧竖线与文字颜色。 */
  quoteColor?: string;
  /** 图片图注颜色。 */
  captionColor?: string;
  /** 用户添加的工作文件夹（绝对路径）。浏览与编辑只允许落在这些根之内。 */
  workspaceFolders?: string[];
}
