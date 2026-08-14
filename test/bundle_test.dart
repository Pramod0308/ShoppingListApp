// The app's UI is the web bundle in assets/www, not Flutter widgets, so there is no
// widget tree here worth asserting on. What can go wrong on this side — and has —
// is the bundle arriving incomplete: Flutter's asset directories are not recursive,
// so adding a subdirectory under assets/www without listing it in pubspec.yaml
// silently ships an app whose page loads and then fails to start.

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('every file the page loads is bundled', () async {
    // Each of these is fetched by index.html or imported by app.js at startup.
    const required = <String>[
      'assets/www/index.html',
      'assets/www/app.js',
      'assets/www/store.js',
      'assets/www/peer-sync.js',
      'assets/www/order-key.js',
      'assets/www/text-sync.js',
      'assets/www/sync-config.js',
      'assets/www/styles.css',
      'assets/www/manifest.webmanifest',
      'assets/www/vendor/sync.js',
      'assets/www/fonts/fonts.css',
      'assets/www/icons/icon-192.png',
    ];

    for (final path in required) {
      final data = await rootBundle.load(path);
      expect(
        data.lengthInBytes,
        greaterThan(0),
        reason: '$path is empty or missing. If it is in a new directory, add that '
            'directory to the assets list in pubspec.yaml — they are not recursive.',
      );
    }
  });

  test('the bundle fetches nothing at runtime', () async {
    // The app has to start with no network. Anything pulled from a CDN would break
    // it offline, and the CSP in index.html would refuse it anyway.
    const sources = <String>[
      'assets/www/index.html',
      'assets/www/app.js',
      'assets/www/store.js',
    ];

    for (final path in sources) {
      final text = await rootBundle.loadString(path);
      expect(
        text.contains('https://esm.sh') || text.contains('cdn.tailwindcss.com'),
        isFalse,
        reason: '$path loads code from a CDN; the bundle must be self-contained.',
      );
    }
  });
}
