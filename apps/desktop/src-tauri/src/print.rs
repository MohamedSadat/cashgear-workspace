//! Phase 19: the print view printed by the desktop's own engine (ARCHITECTURE.md, "Word, PDF and
//! print"). The page has drawn the view in its own document, shown by print media alone; this
//! prints that document as the layout sets it, as the spike found each engine can
//! (DECISIONS.md, 2026-11-26):
//!
//! - Windows: Save as PDF goes straight to a file the person names, through WebView2's own
//!   `PrintToPdf` (no print dialog), its paper and margins those of the layout; Print is the
//!   page's own `window.print()` (answered `dialog`), WebView2's print dialog.
//! - macOS: WKWebView prints only through AppKit: an `NSPrintOperation` of the webview, its paper
//!   the layout's and its margins 0 (the page cut itself into pages by script), through the print
//!   panel, or with none to a PDF file the person names. A delegate says when it is done.
//!
//! The page sends the job; it never sends a path. `CGW_SAVE_DIR` (the tests') takes the place of
//! the save dialog, as `save_file` does.
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Webview};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrintJob {
    /// A PDF to a file, else a print through the system's dialog.
    pub pdf: bool,
    /// The file's suggested name.
    pub name: String,
    /// The page cut itself into pages: the print's margins are 0.
    #[allow(dead_code)]
    pub paged: bool,
    /// The paper as it lies, in millimetres.
    pub paper: Size,
    /// Margins in millimetres (0 when paged).
    pub margins: Margins,
}

#[derive(Deserialize, Debug, Clone, Copy)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Deserialize, Debug, Clone, Copy)]
pub struct Margins {
    pub block: f64,
    pub inline: f64,
}

/// Where a PDF goes: the tests' folder, else the file the person picks; None when they cancel.
async fn choose_path(app: &AppHandle, name: &str) -> Result<Option<PathBuf>, String> {
    let name = cgw_native::file_name(name);
    if let Some(dir) = std::env::var_os("CGW_SAVE_DIR") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        return Ok(Some(dir.join(name)));
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&name)
        .add_filter("PDF", &["pdf"])
        .save_file(move |chosen| {
            let _ = sender.send(chosen);
        });
    let chosen = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .map_err(|error| error.to_string())?;
    Ok(chosen.and_then(|chosen| chosen.into_path().ok()))
}

/// Waits for an engine's answer off the async runtime (two minutes at most).
async fn answer(receiver: std::sync::mpsc::Receiver<bool>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(120))
            .unwrap_or(false)
    })
    .await
    .map_err(|error| error.to_string())
}

/// Prints the page's document, or saves it as a PDF: `saved`, `printed`, `cancelled`, or `dialog`
/// (the page opens the engine's own dialog itself).
#[tauri::command]
pub async fn print_page(app: AppHandle, webview: Webview, job: PrintJob) -> Result<String, String> {
    run(app, webview, job).await
}

#[cfg(windows)]
async fn run(app: AppHandle, webview: Webview, job: PrintJob) -> Result<String, String> {
    if !job.pdf {
        return Ok("dialog".into());
    }
    let Some(path) = choose_path(&app, &job.name).await? else {
        return Ok("cancelled".into());
    };
    let receiver = win::print_to_pdf(&webview, path, &job)?;
    if answer(receiver).await? {
        Ok("saved".into())
    } else {
        Err("WebView2 could not write the PDF.".into())
    }
}

#[cfg(target_os = "macos")]
async fn run(app: AppHandle, webview: Webview, job: PrintJob) -> Result<String, String> {
    let path = if job.pdf {
        match choose_path(&app, &job.name).await? {
            Some(path) => Some(path),
            None => return Ok("cancelled".into()),
        }
    } else {
        None
    };
    let saving = path.is_some();
    let receiver = mac::print(&webview, path, &job)?;
    let done = answer(receiver).await?;
    Ok(match (done, saving) {
        (false, _) => "cancelled",
        (true, true) => "saved",
        (true, false) => "printed",
    }
    .into())
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn run(_app: AppHandle, _webview: Webview, _job: PrintJob) -> Result<String, String> {
    Err("Printing is not built for this system.".into())
}

#[cfg(windows)]
mod win {
    use super::PrintJob;
    use std::path::PathBuf;
    use std::sync::mpsc::{channel, Receiver};
    use tauri::Webview;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    /// Starts WebView2's `PrintToPdf` of the top document into `path`; the receiver says whether
    /// it wrote the file.
    pub fn print_to_pdf(
        webview: &Webview,
        path: PathBuf,
        job: &PrintJob,
    ) -> Result<Receiver<bool>, String> {
        let (sender, receiver) = channel();
        let job = job.clone();
        webview
            .with_webview(move |platform| {
                let failed = sender.clone();
                let started = (|| -> windows_core::Result<()> {
                    unsafe {
                        let core = platform.controller().CoreWebView2()?;
                        let seven: ICoreWebView2_7 = core.cast()?;
                        let environment: ICoreWebView2Environment6 =
                            platform.environment().cast()?;
                        let settings = environment.CreatePrintSettings()?;
                        // Portrait sizes, and the orientation the paper lies in.
                        let inch = |mm: f64| mm / 25.4;
                        let (w, h) = (job.paper.width, job.paper.height);
                        settings.SetPageWidth(inch(w.min(h)))?;
                        settings.SetPageHeight(inch(w.max(h)))?;
                        settings.SetOrientation(if w > h {
                            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                        } else {
                            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                        })?;
                        settings.SetMarginTop(inch(job.margins.block))?;
                        settings.SetMarginBottom(inch(job.margins.block))?;
                        settings.SetMarginLeft(inch(job.margins.inline))?;
                        settings.SetMarginRight(inch(job.margins.inline))?;
                        settings.SetShouldPrintHeaderAndFooter(false)?;
                        settings.SetShouldPrintBackgrounds(true)?;
                        let handler =
                            PrintToPdfCompletedHandler::create(Box::new(move |error, written| {
                                let _ = sender.send(error.is_ok() && written);
                                Ok(())
                            }));
                        seven.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler)?;
                    }
                    Ok(())
                })();
                if started.is_err() {
                    let _ = failed.send(false);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(receiver)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::PrintJob;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject};
    use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass};
    use objc2_app_kit::{
        NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
        NSPrintingPaginationMode, NSWindow,
    };
    use objc2_foundation::{NSObjectProtocol, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use tauri::Webview;

    pub struct DelegateIvars {
        done: RefCell<Option<Sender<bool>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "CgwPrintDelegate"]
        #[ivars = DelegateIvars]
        pub struct PrintDelegate;

        unsafe impl NSObjectProtocol for PrintDelegate {}

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(
                &self,
                _operation: &NSPrintOperation,
                success: Bool,
                _context: *mut std::ffi::c_void,
            ) {
                if let Some(done) = self.ivars().done.borrow_mut().take() {
                    let _ = done.send(success.as_bool());
                }
                // The operation held no strong reference: this one was kept for it.
                unsafe {
                    let this: *const Self = self;
                    Retained::from_raw(this as *mut Self);
                }
            }
        }
    );

    impl PrintDelegate {
        fn new(done: Sender<bool>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars {
                done: RefCell::new(Some(done)),
            });
            unsafe { msg_send![super(this), init] }
        }
    }

    const POINTS_PER_MM: f64 = 72.0 / 25.4;

    /// Starts an `NSPrintOperation` of the webview (the print panel, or to `path` with none); the
    /// receiver says whether it ran to its end.
    pub fn print(
        webview: &Webview,
        path: Option<PathBuf>,
        job: &PrintJob,
    ) -> Result<Receiver<bool>, String> {
        let (sender, receiver) = channel();
        let job = job.clone();
        webview
            .with_webview(move |platform| unsafe {
                let view = &*(platform.inner() as *const WKWebView);
                let window = &*(platform.ns_window() as *const NSWindow);
                let info = NSPrintInfo::new();
                // The paper as it lies, in points.
                info.setPaperSize(NSSize::new(
                    job.paper.width * POINTS_PER_MM,
                    job.paper.height * POINTS_PER_MM,
                ));
                info.setOrientation(NSPaperOrientation::Portrait);
                let block = job.margins.block * POINTS_PER_MM;
                let inline = job.margins.inline * POINTS_PER_MM;
                info.setTopMargin(block);
                info.setBottomMargin(block);
                info.setLeftMargin(inline);
                info.setRightMargin(inline);
                info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
                info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
                info.setHorizontallyCentered(false);
                info.setVerticallyCentered(false);
                if let Some(path) = &path {
                    info.setJobDisposition(NSPrintSaveJob);
                    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                    let dictionary = info.dictionary();
                    let _: () =
                        msg_send![&*dictionary, setObject: &*url, forKey: NSPrintJobSavingURL];
                }
                let operation = view.printOperationWithPrintInfo(&info);
                operation.setShowsPrintPanel(path.is_none());
                operation.setShowsProgressPanel(false);
                // WebKit draws nothing into an operation whose view has no frame.
                if let Some(printed) = operation.view() {
                    printed.setFrame(view.frame());
                }
                // Kept until its callback lets it go (the operation holds no strong reference).
                let delegate = Retained::into_raw(PrintDelegate::new(sender));
                operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                    window,
                    Some(&*(delegate as *const AnyObject)),
                    Some(sel!(printOperationDidRun:success:contextInfo:)),
                    std::ptr::null_mut(),
                );
            })
            .map_err(|error| error.to_string())?;
        Ok(receiver)
    }
}
