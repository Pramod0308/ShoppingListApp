import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'price_lookup.dart';

/// The bundle is served over loopback HTTP rather than opened as a file:// URL.
/// A real origin is what lets the two file-URL access settings stay off, and it is
/// also what makes ES modules, the history API and persistent storage behave the
/// way they do in a browser.
///
/// Changing this port changes the page's origin, which orphans everything already
/// saved in IndexedDB under the old one. Treat it as part of the on-disk format.
const int kLocalServerPort = 8737;

/// Bound to 127.0.0.1 by the plugin, so nothing off the device can reach it.
final InAppLocalhostServer localhostServer = InAppLocalhostServer(
  port: kLocalServerPort,
  documentRoot: 'assets/www/',
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
    ),
  );

  await localhostServer.start();

  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Shopping List',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
      ),
      home: const WebViewScreen(),
    );
  }
}

class WebViewScreen extends StatefulWidget {
  const WebViewScreen({super.key});

  @override
  State<WebViewScreen> createState() => _WebViewScreenState();
}

class _WebViewScreenState extends State<WebViewScreen> {
  InAppWebViewController? webViewController;
  InAppWebViewSettings settings = InAppWebViewSettings(
    // Remote debugging is a debug-build affordance, not something to ship.
    isInspectable: kDebugMode,
    mediaPlaybackRequiresUserGesture: false,
    allowsInlineMediaPlayback: true,
    iframeAllowFullscreen: true,
    databaseEnabled: true,
    domStorageEnabled: true,
    javaScriptEnabled: true,
  );

  /// Offers the back gesture to the web app first. It navigates in place rather
  /// than through page loads, so there is no WebView history to walk back
  /// through — `__shopnestBack` returns true when it moved off the list view.
  Future<bool> _webAppHandledBack() async {
    final controller = webViewController;
    if (controller == null) return false;

    final handled = await controller.evaluateJavascript(
      source: "window.__shopnestBack ? window.__shopnestBack() : false",
    );
    // Android returns a bool, iOS can hand back the string "true".
    return handled == true || handled == 'true';
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop) return;
        if (await _webAppHandledBack()) return;
        // Nothing left to go back to — behave like the launcher activity closing.
        await SystemNavigator.pop();
      },
      child: Scaffold(
        backgroundColor:
            const Color(0xFFF8F9FF), // Matches surface-container-lowest
        body: SafeArea(
          bottom: false,
          child: InAppWebView(
            initialUrlRequest: URLRequest(
              url: WebUri("http://localhost:$kLocalServerPort/"),
            ),
            initialSettings: settings,
            onWebViewCreated: (controller) {
              webViewController = controller;

              // The page cannot fetch a shop's site itself — no CORS, and no key it
              // could hold — so it asks the shell, which has neither limit. Results
              // come back in the shape assets/www/pricing.js already expects.
              controller.addJavaScriptHandler(
                handlerName: 'priceLookup',
                callback: (args) async {
                  final request = args.isNotEmpty && args.first is Map
                      ? Map<String, dynamic>.from(args.first as Map)
                      : const <String, dynamic>{};
                  final store = (request['store'] ?? '').toString();
                  final items = (request['items'] as List?)
                          ?.map((i) => i.toString())
                          .where((i) => i.trim().isNotEmpty)
                          .toList() ??
                      const <String>[];

                  if (items.isEmpty) return {'results': <dynamic>[]};

                  final results = await PriceLookup.run(
                    store,
                    items,
                    onProgress: (done, total) {
                      // Lets the page show "3 of 12" while a slow run is going.
                      controller.evaluateJavascript(
                        source: 'window.__shopnestPriceProgress '
                            '&& window.__shopnestPriceProgress($done, $total)',
                      );
                    },
                  );
                  return {'store': store, 'results': results};
                },
              );
            },
            // Nothing in the bundle uses the camera, the microphone or location.
            // If a request ever appears, something is wrong — refuse it rather
            // than handing it over on the user's behalf.
            onPermissionRequest: (controller, request) async {
              return PermissionResponse(
                  resources: request.resources,
                  action: PermissionResponseAction.DENY);
            },
            onConsoleMessage: (controller, consoleMessage) {
              debugPrint("WEBVIEW: ${consoleMessage.message}");
            },
          ),
        ),
      ),
    );
  }
}
