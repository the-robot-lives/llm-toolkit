import LLMToolkitKit
import SwiftUI
import WebKit

struct ConsoleWebView: NSViewRepresentable {
    var baseURL: URL
    var route: ConsoleRoute
    var harness: Harness
    var nativeChrome: Bool
    var reloadToken: Int
    var onRoute: (ConsoleRoute) -> Void
    var onHarness: (Harness) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onRoute: onRoute, onHarness: onHarness)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let user = WKUserContentController()
        user.add(context.coordinator, name: "host")
        user.addUserScript(WKUserScript(
            source: HostBridge.bootstrap(nativeChrome: nativeChrome),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        config.userContentController = user

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = view
        if let url = route.url(relativeTo: baseURL) {
            view.load(URLRequest(url: url))
            context.coordinator.loadedPath = route.path
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.onRoute = onRoute
        context.coordinator.onHarness = onHarness

        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            view.reload()
            return
        }

        if context.coordinator.lastNativeChrome != nativeChrome {
            context.coordinator.lastNativeChrome = nativeChrome
            view.evaluateJavaScript(HostBridge.setNativeChrome(nativeChrome), completionHandler: nil)
        }

        if context.coordinator.lastHarness != harness {
            context.coordinator.lastHarness = harness
            view.evaluateJavaScript(HostBridge.setHarness(harness.rawValue), completionHandler: nil)
        }

        if context.coordinator.loadedPath != route.path {
            view.evaluateJavaScript(HostBridge.navigate(route.path), completionHandler: { _, error in
                if error != nil, let url = route.url(relativeTo: baseURL) {
                    view.load(URLRequest(url: url))
                }
            })
            context.coordinator.loadedPath = route.path
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var onRoute: (ConsoleRoute) -> Void
        var onHarness: (Harness) -> Void
        weak var webView: WKWebView?
        var loadedPath: String?
        var lastReloadToken = 0
        var lastHarness: Harness?
        var lastNativeChrome: Bool?

        init(onRoute: @escaping (ConsoleRoute) -> Void, onHarness: @escaping (Harness) -> Void) {
            self.onRoute = onRoute
            self.onHarness = onHarness
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "route":
                if let path = body["path"] as? String {
                    let route = ConsoleRoute.parse(pathFromHost: path)
                    loadedPath = route.path
                    onRoute(route)
                }
            case "harness":
                if let value = body["value"] as? String, let harness = Harness.parse(value) {
                    lastHarness = harness
                    onHarness(harness)
                }
            default:
                break
            }
        }

        // Login stays in the system browser; never inject the host bridge into remote pages.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if let host = url.host, ["localhost", "127.0.0.1", "::1"].contains(host) {
                decisionHandler(.allow)
            } else {
                if ["https", "http"].contains(url.scheme) { NSWorkspace.shared.open(url) }
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme) {
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let url = webView.url {
                let route = ConsoleRoute.parse(url: url)
                loadedPath = route.path
                onRoute(route)
            }
        }
    }
}

enum HostBridge {
    static func bootstrap(nativeChrome: Bool) -> String {
        """
        (function () {
          window.__LLM_TOOLKIT_NATIVE_CHROME__ = \(nativeChrome ? "true" : "false");
          const post = (payload) => {
            try { window.webkit.messageHandlers.host.postMessage(payload); } catch (e) {}
          };
          const notifyRoute = () => {
            post({ type: "route", path: location.pathname + location.search });
          };
          const wrap = (fn) => function () {
            const ret = fn.apply(this, arguments);
            notifyRoute();
            return ret;
          };
          history.pushState = wrap(history.pushState.bind(history));
          history.replaceState = wrap(history.replaceState.bind(history));
          window.addEventListener("popstate", notifyRoute);
          window.addEventListener("llm-toolkit-harness-changed", (event) => {
            post({ type: "harness", value: event.detail });
          });
        })();
        """
    }

    static func navigate(_ path: String) -> String {
        let escaped = path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        return """
        (function () {
          const path = '\(escaped)';
          if (typeof window.__LLM_TOOLKIT_NAVIGATE__ === "function") {
            window.__LLM_TOOLKIT_NAVIGATE__(path);
            return true;
          }
          window.dispatchEvent(new CustomEvent("llm-toolkit-navigate", { detail: path }));
          return true;
        })();
        """
    }

    static func setHarness(_ raw: String) -> String {
        """
        window.dispatchEvent(new CustomEvent("llm-toolkit-set-harness", { detail: "\(raw)" }));
        """
    }

    static func setNativeChrome(_ enabled: Bool) -> String {
        """
        window.__LLM_TOOLKIT_NATIVE_CHROME__ = \(enabled ? "true" : "false");
        window.dispatchEvent(new CustomEvent("llm-toolkit-native-chrome", { detail: \(enabled ? "true" : "false") }));
        """
    }
}
