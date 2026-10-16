//! 把窗口「打印」成一份 PDF 文件 —— 走 WebView2 自己的 `PrintToPdf`。
//!
//! ## 为什么不用 `window.print()`
//!
//! 那条路必然弹系统打印对话框：用户得自己挑「Microsoft Print to PDF」、再去「更多设置」里
//! 取消页眉页脚 —— 每一步都可能把结果弄成另一副样子，而我们从代码里既看不到也管不了。
//! `ICoreWebView2_7::PrintToPdf` 直接写文件，而 `ICoreWebView2PrintSettings` 上正好有我们要的
//! 那几样：页眉页脚、缩放、纸张、边距、方向、是否打印背景。**没有任何对话框。**
//!
//! 它印的是**这个窗口此刻的 DOM**，`@media print` 照常生效 —— 所以调用之前页面得已经把
//! 「要打印的那一份」摆好（见前端 `src/features/pdfExport/`）。
//!
//! ## 三件必须守住的事
//!
//! 1. **命令声明成 `async`**：`with_webview` 是把闭包丢到**主线程**去执行的，如果命令本身
//!    就占着主线程等它，那就是自己把自己锁死（界面直接卡住）。
//! 2. **参数一律不信任**：全都要 clamp 过再交给 COM。纸张尺寸给个 0 或者负数，WebView2
//!    要么不干活，要么拿去排版出一个荒唐的结果 —— 而用户只会看到「导出坏了」。
//! 3. **等它真的写完**：`PrintToPdf` 是异步的，完成回调没回来就报成功，用户会拿到一个
//!    半截的文件。所以这里等回调，并且带超时。
//!
//! 平台：只有 Windows 有 WebView2。别的平台上命令返回 `pdfPrintUnsupported`，前端自己
//! 退回 `window.print()` 那条老路。

use serde::Deserialize;
use std::collections::BTreeMap;

use crate::services::notes::AppError;

fn err(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.to_string(),
        message: message.into(),
        details: BTreeMap::new(),
    }
}

/// 缩放的上下限（`SetScaleFactor` 收的是倍数，不是百分比）。
const SCALE_MIN: f64 = 0.1;
const SCALE_MAX: f64 = 2.0;
/// 纸张边长（英寸）。下限不是 0 —— 一张 0 宽的纸只会让 WebView2 直接罢工。
const PAPER_MIN: f64 = 2.0;
const PAPER_MAX: f64 = 22.0;
/// 边距（英寸）。0 是合法的（无边距打印）。
const MARGIN_MAX: f64 = 11.0;
/// 页眉文字按**字符**截断：它进的是页眉那一行，几百个字只会被挤成一团。
const MAX_HEADER_CHARS: usize = 120;
/// 等 WebView2 写盘的上限。几十页的文档一般几秒，60 秒还没回来说明它卡住了。
pub const PRINT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 前端递过来的打印设置。
///
/// 全部字段都可缺省（`#[serde(default)]`）：少给一个字段应该是「用默认值」，而不是整次调用
/// 失败。数字用 `Option` 包着 —— 「没给」与「给了 0」得能分开，前者用默认值，后者该被
/// clamp 到下限。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfPrintSettings {
    /// 要不要页眉页脚那一行。
    pub header_footer: bool,
    /// 页眉上写的字（一般就是笔记标题）。
    pub header_title: String,
    /// 页脚左下角写的字。空 = 不写。
    ///
    /// ⚠️ WebView2 里这个设置叫 `FooterUri`（它本来是给「打印网页时带上网址」用的），
    /// 但收的就是一段文本 —— 我们拿它当「页脚文字」用。页码那一块是 Chromium 自己按
    /// 当前页/总页数画的，**没有接口能改它的文案**。
    pub footer_text: String,
    /// 缩放倍数（1.0 = 100%）。
    pub scale: Option<f64>,
    /// 纸张大小（英寸）。缺省 A4（8.27 × 11.69）。
    pub page_width: Option<f64>,
    pub page_height: Option<f64>,
    pub margin_top: Option<f64>,
    pub margin_bottom: Option<f64>,
    pub margin_left: Option<f64>,
    pub margin_right: Option<f64>,
    /// 横向。
    pub landscape: bool,
    /// 要不要打印背景色 / 底纹。默认**要** —— 代码块与表头没了底色就散了。
    pub backgrounds: Option<bool>,
}

/// 校验并补齐之后的设置。只有这份会交给 Chromium。
#[derive(Debug, Clone, PartialEq)]
pub struct PrintPlan {
    pub header_footer: bool,
    pub header_title: String,
    pub footer_text: String,
    pub scale: f64,
    pub page_width: f64,
    pub page_height: f64,
    pub margin_top: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    pub margin_right: f64,
    pub landscape: bool,
    pub backgrounds: bool,
}

fn clamp(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if !value.is_finite() {
        return fallback;
    }
    value.clamp(min, max)
}

/// 页眉文字：去掉换行与其它控制字符（它们会把页眉那行顶开），再按字符数截断。
///
/// ⚠️ **先 trim、再 take**，顺序不能反。反过来的话，`take` 之后停在两端的那几个
/// 空白会被 `trim` 一起吃掉，于是结果比 `MAX_HEADER_CHARS` **短** ——
/// 单测 `header_text_is_stripped_of_control_chars_and_capped` 盯的正是这个
///（原来那个写法在「开头带空格 + 超长」的输入上会少 2 个字符）。
fn clean_header(text: &str) -> String {
    let cleaned: String = text.chars().filter(|c| !c.is_control()).collect();
    cleaned.trim().chars().take(MAX_HEADER_CHARS).collect()
}

/// 把前端那份设置变成可以交给 WebView2 的那份。**纯函数**，单测盯的就是它。
pub fn plan(settings: &PdfPrintSettings) -> PrintPlan {
    PrintPlan {
        header_footer: settings.header_footer,
        header_title: clean_header(&settings.header_title),
        footer_text: clean_header(&settings.footer_text),
        scale: clamp(settings.scale.unwrap_or(1.0), SCALE_MIN, SCALE_MAX, 1.0),
        page_width: clamp(settings.page_width.unwrap_or(8.27), PAPER_MIN, PAPER_MAX, 8.27),
        page_height: clamp(
            settings.page_height.unwrap_or(11.69),
            PAPER_MIN,
            PAPER_MAX,
            11.69,
        ),
        margin_top: clamp(settings.margin_top.unwrap_or(0.7), 0.0, MARGIN_MAX, 0.7),
        margin_bottom: clamp(settings.margin_bottom.unwrap_or(0.7), 0.0, MARGIN_MAX, 0.7),
        margin_left: clamp(settings.margin_left.unwrap_or(0.79), 0.0, MARGIN_MAX, 0.79),
        margin_right: clamp(settings.margin_right.unwrap_or(0.79), 0.0, MARGIN_MAX, 0.79),
        landscape: settings.landscape,
        backgrounds: settings.backgrounds.unwrap_or(true),
    }
}

/// 打开**原生的**系统打印对话框（Windows 自己的那个窗口，不是浏览器内嵌的打印预览）。
///
/// 浏览器内嵌的预览把「打印预览」塞在应用窗口里，还要用户自己去找「使用系统对话框打印…」
/// 那行小字。`ICoreWebView2_16::ShowPrintUI(SYSTEM)` 直接弹系统那个窗口。
///
/// ⚠️ 它和 `PrintToPdf` 是两回事：这条走的是**打印机驱动**，输出由驱动决定（就像用户按了
/// Ctrl+P 再选系统对话框）。要「一份确定的 PDF」请用 `print_pdf`。
#[tauri::command(async)]
pub fn print_with_dialog(window: tauri::WebviewWindow) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        window
            .with_webview(move |webview| {
                let outcome = (|| -> windows::core::Result<()> {
                    let core = unsafe { webview.controller().CoreWebView2()? };
                    let view = core.cast::<ICoreWebView2_16>()?;
                    unsafe {
                        view.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)?;
                    }
                    Ok(())
                })();
                let _ = tx.send(outcome.map_err(|error| error.to_string()));
            })
            .map_err(|e| err("pdfPrintFailed", format!("拿不到这个窗口的打印接口：{e}")))?;

        // 弹对话框本身是立刻返回的，这里只等「有没有弹出来」。
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(err("pdfPrintFailed", message)),
            Err(_) => Err(err("pdfPrintTimeout", "等系统打印对话框超时了")),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = &window;
        Err(err("pdfPrintUnsupported", "这个平台请用浏览器自带的打印"))
    }
}

/// 生成 PDF 并写到 `path`。
///
/// ⚠️ 这个命令**必须**是 `async`：`with_webview` 的闭包在主线程上跑，同步命令也在主线程上
/// 等 —— 那样两边就都动不了了。
#[tauri::command(async)]
pub fn print_pdf(
    window: tauri::WebviewWindow,
    path: String,
    settings: PdfPrintSettings,
) -> Result<(), AppError> {
    let target = path.trim();
    if target.is_empty() {
        return Err(err("pdfPrintPathMissing", "没有指定要保存到哪个文件"));
    }
    let target = std::path::PathBuf::from(target);
    if let Some(parent) = target.parent() {
        // 用户选的多半是已存在的目录，但「另存为」也允许现场新建一层。
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| err("pdfPrintFailed", format!("建不了那个目录：{e}")))?;
        }
    }

    let plan = plan(&settings);
    let target_display = target.to_string_lossy().to_string();

    #[cfg(windows)]
    {
        windows_impl::print_to_pdf(&window, &target_display, &plan)
    }
    #[cfg(not(windows))]
    {
        let _ = (&window, &target_display, &plan);
        Err(err(
            "pdfPrintUnsupported",
            "这个平台还不支持直接生成 PDF，请用「系统打印机」那条路",
        ))
    }
}

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
};
#[cfg(windows)]
use windows::core::Interface as _;

#[cfg(windows)]
mod windows_impl {
    use super::{err, PrintPlan, PRINT_TIMEOUT};
    use crate::services::notes::AppError;
    use std::sync::mpsc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_7, ICoreWebView2Environment6, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    /// `&str` → 有 NUL 结尾的宽字符缓冲。**缓冲区必须活到调用返回** —— 传下去的是裸指针。
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn print_to_pdf(
        window: &tauri::WebviewWindow,
        target: &str,
        plan: &PrintPlan,
    ) -> Result<(), AppError> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let plan = plan.clone();
        let target = target.to_string();

        window
            .with_webview(move |webview| {
                // 一路 `?` 下去，出错就整段落到下面那个 `if let Err`。
                let outcome = (|| -> windows::core::Result<()> {
                    let core = unsafe { webview.controller().CoreWebView2()? };
                    let printer = core.cast::<ICoreWebView2_7>()?;
                    // 打印设置在 `ICoreWebView2Environment6` 上，不在基础 Environment 上。
                    let environment = webview.environment().cast::<ICoreWebView2Environment6>()?;
                    let settings = unsafe { environment.CreatePrintSettings()? };

                    // 这几个缓冲要活到 `PrintToPdf` 返回为止 —— 传下去的是裸指针，不是拷贝。
                    let header = wide(&plan.header_title);
                    let footer = wide(&plan.footer_text);
                    let file = wide(&target);

                    unsafe {
                        settings.SetShouldPrintHeaderAndFooter(plan.header_footer)?;
                        settings.SetShouldPrintBackgrounds(plan.backgrounds)?;
                        settings.SetScaleFactor(plan.scale)?;
                        settings.SetPageWidth(plan.page_width)?;
                        settings.SetPageHeight(plan.page_height)?;
                        settings.SetMarginTop(plan.margin_top)?;
                        settings.SetMarginBottom(plan.margin_bottom)?;
                        settings.SetMarginLeft(plan.margin_left)?;
                        settings.SetMarginRight(plan.margin_right)?;
                        settings.SetOrientation(if plan.landscape {
                            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                        } else {
                            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                        })?;
                        settings.SetHeaderTitle(PCWSTR::from_raw(header.as_ptr()))?;
                        settings.SetFooterUri(PCWSTR::from_raw(footer.as_ptr()))?;
                    }

                    // 回调在**主线程的消息循环**上送达（我们一返回它就转起来了），所以这里
                    // 只管把结果丢进通道，命令那一头在等工作线程上等。
                    //
                    // ⚠️ 两个参数都已经过 `ClosureArg` 转换：第一个是 `Result<()>`
                    // （HRESULT 的 `ok()`），第二个是 `bool`。**两个都要看** —— 有没有
                    // `ok = false` 而 HRESULT 是 0 的情况，光看一个会漏。
                    let report = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |outcome, ok| {
                        let result = match (outcome, ok) {
                            (Ok(()), true) => Ok(()),
                            (Ok(()), false) => {
                                Err("WebView2 说这份 PDF 没写成，但没给原因".to_string())
                            }
                            (Err(error), _) => {
                                Err(format!("WebView2 没能写出这份 PDF：{error}"))
                            }
                        };
                        let _ = report.send(result);
                        Ok(())
                    }));

                    unsafe { printer.PrintToPdf(PCWSTR::from_raw(file.as_ptr()), &settings, &handler)? };
                    Ok(())
                })();

                if let Err(error) = outcome {
                    let _ = tx.send(Err(format!("调用 WebView2 的打印接口失败：{error}")));
                }
            })
            .map_err(|e| err("pdfPrintFailed", format!("拿不到这个窗口的打印接口：{e}")))?;

        match rx.recv_timeout(PRINT_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(err("pdfPrintFailed", message)),
            Err(_) => Err(err(
                "pdfPrintTimeout",
                "等 WebView2 写出 PDF 超时了，文件可能不完整",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_a4_at_full_scale() {
        let plan = plan(&PdfPrintSettings::default());
        assert_eq!(plan.scale, 1.0);
        assert!((plan.page_width - 8.27).abs() < 1e-9);
        assert!((plan.page_height - 11.69).abs() < 1e-9);
        assert!(plan.backgrounds, "底色默认要打印，否则代码块与表头都散了");
        assert!(!plan.header_footer);
        assert!(!plan.landscape);
    }

    #[test]
    fn absurd_numbers_are_clamped_not_rejected() {
        let plan = plan(&PdfPrintSettings {
            scale: Some(50.0),
            page_width: Some(0.0),
            page_height: Some(-3.0),
            margin_left: Some(1e9),
            margin_top: Some(-5.0),
            ..Default::default()
        });
        assert_eq!(plan.scale, SCALE_MAX);
        assert_eq!(plan.page_width, PAPER_MIN, "0 宽的纸 WebView2 会直接不干活");
        assert_eq!(plan.page_height, PAPER_MIN);
        assert_eq!(plan.margin_left, MARGIN_MAX);
        assert_eq!(plan.margin_top, 0.0, "0 边距是合法的");
    }

    #[test]
    fn nan_and_infinity_fall_back_to_the_default() {
        let plan = plan(&PdfPrintSettings {
            scale: Some(f64::NAN),
            page_width: Some(f64::INFINITY),
            margin_top: Some(f64::NEG_INFINITY),
            ..Default::default()
        });
        assert_eq!(plan.scale, 1.0);
        assert!((plan.page_width - 8.27).abs() < 1e-9);
        assert!((plan.margin_top - 0.7).abs() < 1e-9);
    }

    #[test]
    fn header_text_is_stripped_of_control_chars_and_capped() {
        let long = "标".repeat(MAX_HEADER_CHARS + 50);
        let plan = plan(&PdfPrintSettings {
            header_title: format!("  第一行\n第二行\t{long}  "),
            header_footer: true,
            ..Default::default()
        });
        assert!(!plan.header_title.contains('\n'));
        assert!(!plan.header_title.contains('\t'));
        assert!(!plan.header_title.starts_with(' '));
        assert_eq!(plan.header_title.chars().count(), MAX_HEADER_CHARS);
    }

    #[test]
    fn scaling_is_scoped_in_both_directions() {
        assert_eq!(
            plan(&PdfPrintSettings {
                scale: Some(0.01),
                ..Default::default()
            })
            .scale,
            SCALE_MIN
        );
        assert_eq!(
            plan(&PdfPrintSettings {
                scale: Some(0.5),
                ..Default::default()
            })
            .scale,
            0.5
        );
    }
}
