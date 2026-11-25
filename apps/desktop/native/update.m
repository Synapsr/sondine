// Node-API addon loaded by main in packaged builds (ADR 045), built by
// scripts/build-mac.mjs: the two things an update needs of macOS that neither
// Node nor Electron offers.
//
// swap(a: string, b: string): number
//   Exchanges two paths of one volume in one step (renamex_np, RENAME_SWAP):
//   there is no moment without an app, even if the Mac loses power. 0, or errno.
// network(): "free" | "metered" | "offline" | "unknown"
//   Whether a download may use the network now. The monitor starts at the
//   first call, which says "unknown": nothing watches the network before an
//   update is to download.
#define NAPI_VERSION 8
#import <Foundation/Foundation.h>
#import <Network/Network.h>
#include <errno.h>
#include <node_api.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/param.h>

static bool readPath(napi_env env, napi_value value, char path[MAXPATHLEN]) {
  size_t length = 0;
  return napi_get_value_string_utf8(env, value, path, MAXPATHLEN, &length) == napi_ok && length > 0 &&
         length < MAXPATHLEN - 1;
}

static napi_value Swap(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char a[MAXPATHLEN];
  char b[MAXPATHLEN];
  if (argc < 2 || !readPath(env, argv[0], a) || !readPath(env, argv[1], b)) {
    napi_throw_type_error(env, NULL, "swap(a: string, b: string)");
    return NULL;
  }
  int failure = renamex_np(a, b, RENAME_SWAP) == 0 ? 0 : errno;
  napi_value result;
  napi_create_int32(env, failure, &result);
  return result;
}

static const char *const kKinds[] = {"unknown", "free", "metered", "offline"};
static atomic_int kind = 0;
static nw_path_monitor_t monitor = nil;

static napi_value Network(napi_env env, napi_callback_info info) {
  if (monitor == nil) {
    monitor = nw_path_monitor_create();
    nw_path_monitor_set_queue(monitor, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
      if (nw_path_get_status(path) != nw_path_status_satisfied) {
        atomic_store(&kind, 3);
      } else if (nw_path_is_expensive(path) || nw_path_is_constrained(path)) {
        atomic_store(&kind, 2);
      } else {
        atomic_store(&kind, 1);
      }
    });
    nw_path_monitor_start(monitor);
  }
  napi_value result;
  napi_create_string_utf8(env, kKinds[atomic_load(&kind)], NAPI_AUTO_LENGTH, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "swap", NAPI_AUTO_LENGTH, Swap, NULL, &function);
  napi_set_named_property(env, exports, "swap", function);
  napi_create_function(env, "network", NAPI_AUTO_LENGTH, Network, NULL, &function);
  napi_set_named_property(env, exports, "network", function);
  return exports;
}
