// Phase 19's print spike in WKWebView, on GitHub's macOS runner (`.github/workflows/print-spike.yml`):
// each spike page loaded in a WKWebView in an off-screen window, then printed with no panel by
// `printOperation(with:)` to a PDF file (NSPrintInfo's job disposition "save"), as the Mac app
// would through wry's webview. Three ways: the print info's paper and margins from the layout; the
// same with NSPrintHeaderAndFooter (AppKit's own header and footer); and the margins at 0, so the
// page's `@page` margin applies. `node bench/print-spike/judge-dir.mjs` reads the PDFs after.
// Spike code: it never ships.
//
//   swift bench/print-spike/wkwebview.swift <folder of pages> <folder for PDFs>
import AppKit
import WebKit

let args = CommandLine.arguments
let www = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

struct Job {
  let page: String
  let size: String
  let mode: String
}

let sizes: [String: (NSSize, NSPrintInfo.PaperOrientation)] = [
  "a4-portrait": (NSSize(width: 595.28, height: 841.89), .portrait),
  "letter-landscape": (NSSize(width: 612, height: 792), .landscape),
]
var jobs: [Job] = []
for size in ["a4-portrait", "letter-landscape"] {
  for page in ["doc", "main", "main-fixed"] {
    for mode in ["layout", "headerFooter", "cssMargins"] {
      jobs.append(Job(page: "\(page)-\(size)", size: size, mode: mode))
    }
  }
}

final class Runner: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var index = 0
  var report: [[String: Any]] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: -3000, y: -3000, width: 1200, height: 900),
      styleMask: [.titled], backing: .buffered, defer: false)
    webView = WKWebView(frame: window.contentView!.bounds, configuration: WKWebViewConfiguration())
    webView.navigationDelegate = self
    window.contentView!.addSubview(webView)
    window.orderFront(nil)
    next()
  }

  func next() {
    guard index < jobs.count else {
      let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted])
      try! data.write(to: out.appendingPathComponent("wkwebview-runs.json"))
      NSApp.terminate(nil)
      return
    }
    let job = jobs[index]
    let url = www.appendingPathComponent("\(job.page).html")
    webView.loadFileURL(url, allowingReadAccessTo: www)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.print() }
  }

  func print() {
    let job = jobs[index]
    let file = out.appendingPathComponent("wkwebview-\(job.page)-\(job.mode).pdf")
    try? FileManager.default.removeItem(at: file)
    let info = NSPrintInfo()
    let (paper, orientation) = sizes[job.size]!
    info.paperSize = paper
    info.orientation = orientation
    let margin: CGFloat = job.mode == "cssMargins" ? 0 : 20 / 25.4 * 72
    info.topMargin = margin
    info.bottomMargin = margin
    info.leftMargin = margin
    info.rightMargin = margin
    info.horizontalPagination = .automatic
    info.verticalPagination = .automatic
    info.jobDisposition = .save
    info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = file
    info.dictionary()[NSPrintInfo.AttributeKey.headerAndFooter] = job.mode == "headerFooter"
    let operation = webView.printOperation(with: info)
    operation.showsPrintPanel = false
    operation.showsProgressPanel = false
    operation.view?.frame = webView.bounds
    let started = Date()
    operation.runModal(
      for: window, delegate: self, didRun: #selector(printed(_:success:contextInfo:)),
      contextInfo: nil)
    report.append(["page": job.page, "size": job.size, "mode": job.mode, "file": file.lastPathComponent,
                   "started": started.timeIntervalSince1970])
  }

  @objc func printed(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
    report[report.count - 1]["success"] = success
    index += 1
    DispatchQueue.main.async { self.next() }
  }
}

let app = NSApplication.shared
let runner = Runner()
app.delegate = runner
app.setActivationPolicy(.accessory)
app.run()
