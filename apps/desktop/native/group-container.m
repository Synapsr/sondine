// Node-API addon loaded by main in packaged builds (ADR 013), built by
// scripts/build-mac.mjs.
//
// macOS lets an unsandboxed app into its app group container only after the
// app asked NSFileManager for it; a path built by hand is refused, silently.
// The request covers this process and the children it starts (core). It also
// reports the team that signed this process, so unsigned and ad-hoc builds
// never touch the container.
#define NAPI_VERSION 8
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <node_api.h>

static napi_value stringOrNull(napi_env env, NSString *value) {
  napi_value result;
  if (value == nil) {
    napi_get_null(env, &result);
  } else {
    napi_create_string_utf8(env, value.UTF8String, NAPI_AUTO_LENGTH, &result);
  }
  return result;
}

// groupContainerPath(groupId: string): string | null
static napi_value GroupContainerPath(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char group[256];
  size_t length = 0;
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], group, sizeof group, &length) != napi_ok ||
      length == 0 || length >= sizeof group - 1) {
    napi_throw_type_error(env, NULL, "groupContainerPath(groupId: string)");
    return NULL;
  }
  @autoreleasepool {
    NSString *identifier = [NSString stringWithUTF8String:group];
    NSURL *url = [NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:identifier];
    return stringOrNull(env, url.path);
  }
}

// teamIdentifier(): string | null — null when unsigned or ad-hoc signed.
static napi_value TeamIdentifier(napi_env env, napi_callback_info info) {
  NSString *team = nil;
  SecCodeRef code = NULL;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &code) == errSecSuccess) {
    SecStaticCodeRef staticCode = NULL;
    if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &staticCode) == errSecSuccess) {
      CFDictionaryRef signing = NULL;
      if (SecCodeCopySigningInformation(staticCode, kSecCSSigningInformation, &signing) == errSecSuccess) {
        CFTypeRef value = CFDictionaryGetValue(signing, kSecCodeInfoTeamIdentifier);
        if (value != NULL && CFGetTypeID(value) == CFStringGetTypeID()) {
          team = [(__bridge NSString *)value copy];
        }
        CFRelease(signing);
      }
      CFRelease(staticCode);
    }
    CFRelease(code);
  }
  return stringOrNull(env, team);
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "groupContainerPath", NAPI_AUTO_LENGTH, GroupContainerPath, NULL, &function);
  napi_set_named_property(env, exports, "groupContainerPath", function);
  napi_create_function(env, "teamIdentifier", NAPI_AUTO_LENGTH, TeamIdentifier, NULL, &function);
  napi_set_named_property(env, exports, "teamIdentifier", function);
  return exports;
}
