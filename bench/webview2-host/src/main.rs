//! Opens one WebView2 window on the URL given as the first argument. With
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N`, Playwright can attach to it
//! over CDP, as the desktop smoke test does. Spike code: it never ships.
//!
//! Phase 19's print spike: `--pdf <file>` prints the page, once loaded, to a PDF with WebView2's
//! own `PrintToPdf` (no dialog), then exits. `--page a4|letter`, `--landscape` and
//! `--margin-mm <n>` fill its print settings; `--css-margins` leaves the settings' margins at 0 so
//! the page's `@page` margin applies.

use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, HSTRING};
use wry::{PageLoadEvent, WebViewBuilder, WebViewExtWindows};

enum Spike {
    Loaded,
    Printed(bool),
}

fn main() -> wry::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let url = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "about:blank".to_string());
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };
    let flag = |name: &str| args.iter().any(|a| a == name);
    let pdf = value("--pdf");
    let letter = value("--page").as_deref() == Some("letter");
    let landscape = flag("--landscape");
    let margin_mm = if flag("--css-margins") {
        0.0
    } else {
        value("--margin-mm")
            .and_then(|m| m.parse::<f64>().ok())
            .unwrap_or(20.0)
    };
    let event_loop = EventLoopBuilder::<Spike>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Cash Gear Workspace spike host")
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .build(&event_loop)
        .expect("a window");
    let loaded = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_on_page_load_handler(move |event, _| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = loaded.send_event(Spike::Loaded);
            }
        })
        .build(&window)?;
    let mut printing = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(Spike::Loaded) if pdf.is_some() && !printing => {
                printing = true;
                let path = pdf.clone().unwrap();
                let done = proxy.clone();
                // Images may still be decoding: give the page a moment, as a person would.
                std::thread::sleep(std::time::Duration::from_millis(1500));
                unsafe {
                    let core = webview.webview();
                    let seven: ICoreWebView2_7 = core.cast().expect("WebView2 1.0.992 or later");
                    let environment: ICoreWebView2Environment6 =
                        webview.environment().cast().expect("print settings");
                    let settings = environment.CreatePrintSettings().expect("settings");
                    let (w, h) = if letter { (8.5, 11.0) } else { (8.27, 11.69) };
                    settings.SetPageWidth(w).unwrap();
                    settings.SetPageHeight(h).unwrap();
                    settings
                        .SetOrientation(if landscape {
                            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                        } else {
                            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                        })
                        .unwrap();
                    let inches = margin_mm / 25.4;
                    settings.SetMarginTop(inches).unwrap();
                    settings.SetMarginBottom(inches).unwrap();
                    settings.SetMarginLeft(inches).unwrap();
                    settings.SetMarginRight(inches).unwrap();
                    settings.SetShouldPrintHeaderAndFooter(false).unwrap();
                    settings.SetShouldPrintBackgrounds(true).unwrap();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |error, ok| {
                        let _ = done.send_event(Spike::Printed(error.is_ok() && ok));
                        Ok(())
                    }));
                    seven
                        .PrintToPdf(&HSTRING::from(path), &settings, &handler)
                        .expect("PrintToPdf");
                }
            }
            Event::UserEvent(Spike::Printed(ok)) => {
                println!("printed: {ok}");
                *control_flow = ControlFlow::ExitWithCode(if ok { 0 } else { 1 });
            }
            _ => {}
        }
    });
}
