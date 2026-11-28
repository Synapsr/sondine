// Node-API addon loaded by main in packaged builds, built by
// scripts/build-mac.mjs.
//
// A light tap of the Force Touch trackpad, for a moment the user should feel
// (Téo, 2026-11-28: the first run's opening, as it fades away). macOS plays
// it only while a finger is on the trackpad and Sondine is the active app;
// otherwise nothing happens. Called on main's thread, the app's main thread.
//
// tap(): void
#define NAPI_VERSION 8
#import <AppKit/AppKit.h>
#include <node_api.h>

static napi_value Tap(napi_env env, napi_callback_info info) {
  [NSHapticFeedbackManager.defaultPerformer
      performFeedbackPattern:NSHapticFeedbackPatternGeneric
             performanceTime:NSHapticFeedbackPerformanceTimeNow];
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_value tap;
  napi_create_function(env, "tap", NAPI_AUTO_LENGTH, Tap, NULL, &tap);
  napi_set_named_property(env, exports, "tap", tap);
  return exports;
}
