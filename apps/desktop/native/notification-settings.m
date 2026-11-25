// Node-API addon loaded by main in packaged builds (ADR 036), built by
// scripts/build-mac.mjs.
//
// Electron's Notification asks macOS for authorization but never says the
// answer. This reads Sondine's notification settings from User Notifications,
// for Settings ▸ Écoute: whether macOS lets Sondine notify, and whether its
// notifications appear on screen (an alert style of « Aucun » keeps them in
// Notification Center only).
//
// settings(callback: (authorization: string, alertStyle: string) => void): void
//   authorization: "authorized" | "denied" | "not-determined" | "provisional"
//   alertStyle: "none" | "banner" | "alert"
#define NAPI_VERSION 8
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

typedef struct {
  const char *authorization;
  const char *alertStyle;
} Answer;

static const char *authorizationName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusAuthorized: return "authorized";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusProvisional: return "provisional";
    case UNAuthorizationStatusNotDetermined:
    default: return "not-determined";
  }
}

static const char *alertStyleName(UNAlertStyle style) {
  switch (style) {
    case UNAlertStyleBanner: return "banner";
    case UNAlertStyleAlert: return "alert";
    case UNAlertStyleNone:
    default: return "none";
  }
}

// Runs on the JavaScript thread: hands the answer to the callback.
static void callJs(napi_env env, napi_value callback, void *context, void *data) {
  Answer *answer = data;
  if (env != NULL && callback != NULL) {
    napi_value argv[2];
    napi_create_string_utf8(env, answer->authorization, NAPI_AUTO_LENGTH, &argv[0]);
    napi_create_string_utf8(env, answer->alertStyle, NAPI_AUTO_LENGTH, &argv[1]);
    napi_value global;
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, 2, argv, NULL);
  }
  free(answer);
}

static napi_value Settings(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype type = napi_undefined;
  if (argc < 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, NULL, "settings(callback)");
    return NULL;
  }
  napi_value name;
  napi_create_string_utf8(env, "notificationSettings", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function tsfn;
  if (napi_create_threadsafe_function(env, argv[0], NULL, name, 0, 1, NULL, NULL, NULL, callJs,
                                      &tsfn) != napi_ok) {
    napi_throw_error(env, NULL, "settings: no threadsafe function");
    return NULL;
  }
  [UNUserNotificationCenter.currentNotificationCenter
      getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        Answer *answer = malloc(sizeof(Answer));
        answer->authorization = authorizationName(settings.authorizationStatus);
        answer->alertStyle = alertStyleName(settings.alertStyle);
        napi_call_threadsafe_function(tsfn, answer, napi_tsfn_blocking);
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
      }];
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "settings", NAPI_AUTO_LENGTH, Settings, NULL, &function);
  napi_set_named_property(env, exports, "settings", function);
  return exports;
}
