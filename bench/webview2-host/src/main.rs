//! Opens one WebView2 window on the URL given as the first argument. With
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N`, Playwright can attach to it
//! over CDP, as the desktop smoke test does. Spike code: it never ships.

use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

fn main() -> wry::Result<()> {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "about:blank".to_string());
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Cash Gear Workspace spike host")
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .build(&event_loop)
        .expect("a window");
    let _webview = WebViewBuilder::new().with_url(&url).build(&window)?;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}
