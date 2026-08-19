// Looking up what something costs, without an API.
//
// A web page cannot fetch a supermarket site — no CORS — and a static bundle cannot
// hold an API key. The shell has neither limit: a headless WebView loads the shop's
// own search page and reads the price out of it, using this device's connection.
//
// Extraction prefers the page's own JSON-LD (shops publish it so Google can show
// prices) over CSS selectors, because structured data survives the redesigns that
// break selectors. A visible-text scan is the fallback.
//
// These adapters will rot as sites change; they are all in one file so a break is
// repaired in one place. Nothing here tries to look like anything other than what it
// is — a WebView loading a public page.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

class Store {
  const Store(this.id, this.label, this.search);
  final String id;
  final String label;
  final String Function(String query) search;
}

String _q(String value) => Uri.encodeQueryComponent(value);

final Map<String, Store> kStores = {
  'asda': Store('asda', 'ASDA',
      (q) => 'https://groceries.asda.com/search/${_q(q)}'),
  'aldi': Store('aldi', 'Aldi',
      (q) => 'https://groceries.aldi.co.uk/en-GB/Search?keywords=${_q(q)}'),
  'morrisons': Store('morrisons', 'Morrisons',
      (q) => 'https://groceries.morrisons.com/search?entry=${_q(q)}'),
  'sainsburys': Store('sainsburys', "Sainsbury's",
      (q) => 'https://www.sainsburys.co.uk/gol-ui/SearchResults/${_q(q)}'),
};

// Runs inside the loaded page. Polls, because these are all client-rendered: the
// price is not in the document when loading finishes.
const String _extractJs = r'''
(function () {
  function fromJsonLd() {
    var nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      var data;
      try { data = JSON.parse(nodes[i].textContent); } catch (e) { continue; }
      var stack = [data];
      while (stack.length) {
        var node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) { stack.push.apply(stack, node); continue; }
        var offers = node.offers;
        if (offers) {
          var offer = Array.isArray(offers) ? offers[0] : offers;
          var price = offer && (offer.price || offer.lowPrice);
          if (price !== undefined && price !== null && !isNaN(parseFloat(price))) {
            return { price: parseFloat(price), title: String(node.name || '').trim() };
          }
        }
        for (var key in node) { if (node[key] && typeof node[key] === 'object') stack.push(node[key]); }
      }
    }
    return null;
  }

  function fromText() {
    // First plausible shelf price on the page, with its nearest heading as a label.
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var match = node.nodeValue && node.nodeValue.match(/£\s?(\d+(?:\.\d{2})?)/);
      if (!match) continue;
      var value = parseFloat(match[1]);
      if (!(value > 0)) continue;
      var box = node.parentElement ? node.parentElement.closest('li, article, div') : null;
      var label = box ? (box.querySelector('h2, h3, a[href*="product"]') || {}).textContent : '';
      return { price: value, title: (label || '').trim() };
    }
    return null;
  }

  return JSON.stringify(fromJsonLd() || fromText() || null);
})();
''';

class PriceResult {
  PriceResult.found(this.query, this.price, this.title)
      : unavailable = false,
        error = null;
  PriceResult.unavailable(this.query)
      : price = null,
        title = null,
        unavailable = true,
        error = null;
  PriceResult.failed(this.query, this.error)
      : price = null,
        title = null,
        unavailable = false;

  final String query;
  final double? price;
  final String? title;
  final bool unavailable;
  final String? error;

  Map<String, dynamic> toJson() => {
        'query': query,
        if (price != null) 'price': price,
        if (price != null) 'currency': 'GBP',
        if (title != null && title!.isNotEmpty) 'title': title,
        if (price != null) 'source': 'store page',
        if (unavailable) 'unavailable': true,
        if (error != null) 'error': error,
      };
}

class PriceLookup {
  static const Duration perItemTimeout = Duration(seconds: 12);
  static const int maxItems = 40;

  /// Prices [queries] at [storeId], one page at a time. A page that never shows a
  /// price is reported as unavailable rather than as an error: "not sold here" is
  /// the answer the list wants.
  static Future<List<Map<String, dynamic>>> run(
    String storeId,
    List<String> queries, {
    void Function(int done, int total)? onProgress,
  }) async {
    final store = kStores[storeId];
    if (store == null) {
      return [
        for (final q in queries) PriceResult.failed(q, 'unknown store').toJson()
      ];
    }

    final results = <Map<String, dynamic>>[];
    final wanted = queries.take(maxItems).toList();

    for (var i = 0; i < wanted.length; i++) {
      final query = wanted[i];
      try {
        results.add(await _lookupOne(store, query).timeout(perItemTimeout));
      } on TimeoutException {
        results.add(PriceResult.failed(query, 'took too long').toJson());
      } catch (err) {
        results.add(PriceResult.failed(query, 'lookup failed').toJson());
      }
      onProgress?.call(i + 1, wanted.length);
    }
    return results;
  }

  static Future<Map<String, dynamic>> _lookupOne(Store store, String query) async {
    final completer = Completer<Map<String, dynamic>>();
    HeadlessInAppWebView? headless;

    Future<void> finish(Map<String, dynamic> value) async {
      if (!completer.isCompleted) completer.complete(value);
      await headless?.dispose();
    }

    headless = HeadlessInAppWebView(
      initialUrlRequest: URLRequest(url: WebUri(store.search(query))),
      initialSettings: InAppWebViewSettings(
        // Nothing here needs pictures, and skipping them is most of the load time
        // and most of the data.
        blockNetworkImage: true,
        javaScriptEnabled: true,
        isInspectable: kDebugMode,
      ),
      onLoadStop: (controller, url) async {
        // Search results render after load, so poll rather than reading once.
        for (var attempt = 0; attempt < 10; attempt++) {
          await Future<void>.delayed(const Duration(milliseconds: 600));
          final raw = await controller.evaluateJavascript(source: _extractJs);
          final parsed = _parse(raw);
          if (parsed != null) {
            await finish(PriceResult.found(query, parsed.$1, parsed.$2).toJson());
            return;
          }
        }
        await finish(PriceResult.unavailable(query).toJson());
      },
      onReceivedError: (controller, request, error) async {
        await finish(PriceResult.failed(query, 'could not open the store page').toJson());
      },
    );

    await headless.run();
    return completer.future;
  }

  /// evaluateJavascript hands back a decoded value on one platform and a JSON
  /// string on the other, so accept both rather than trusting either.
  static (double, String)? _parse(dynamic raw) {
    if (raw == null) return null;
    dynamic value = raw;
    if (value is String) {
      if (value.isEmpty || value == 'null') return null;
      try {
        value = jsonDecode(value);
      } catch (_) {
        return null;
      }
    }
    if (value is! Map) return null;
    final price = value['price'];
    if (price is! num) return null;
    return (price.toDouble(), (value['title'] ?? '').toString());
  }
}
