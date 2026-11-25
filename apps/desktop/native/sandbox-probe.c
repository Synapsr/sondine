// sandbox-probe: how scripts/check-package.mjs proves a sandboxed helper's
// limits (ADR 010, ADR 016). Built by the check, never shipped.
//
//   sandbox-probe check <pid> <operation>[=<path>]...
//     Asks the sandbox of a running process, without logging a violation,
//     whether it allows each operation (on a path). One JSON line per query:
//       {"operation":"sandboxed","result":"yes"|"no"}
//       {"operation":"file-write-create","path":"/x","result":"allowed"|"denied"|"error"}
//
//   sandbox-probe connect <ipv4> <port>
//     Runs as the main executable of a twin bundle signed with a helper's
//     entitlements, and tries one TCP connect to a literal address (no DNS):
//       {"sandboxed":true,"connect":"connected"|"denied"|"refused"|"error","errno":1}
//
//   sandbox-probe write <path>...
//     Same twin: creates each file (O_EXCL) and removes it again.
//       {"path":"/x","write":"created"|"denied"|"error","errno":1}
//
// sandbox_check cannot see what App Sandbox grants through extensions, such
// as the app's own container, so the twin tries real writes there.
//
// sandbox_check is private API in libsystem_sandbox; it has kept this
// signature for years and the check fails loudly if it changes.
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
extern const int SANDBOX_CHECK_NO_REPORT;

enum { SANDBOX_FILTER_NONE = 0, SANDBOX_FILTER_PATH = 1 };

static void json_string(const char *text) {
  putchar('"');
  for (const char *c = text; *c != '\0'; c++) {
    if (*c == '"' || *c == '\\') putchar('\\');
    putchar(*c);
  }
  putchar('"');
}

static int check(int argc, char **argv) {
  if (argc < 3) return 2;
  pid_t pid = (pid_t)strtol(argv[2], NULL, 10);
  int sandboxed = sandbox_check(pid, NULL, SANDBOX_FILTER_NONE);
  printf("{\"operation\":\"sandboxed\",\"result\":\"%s\"}\n",
         sandboxed == 1 ? "yes" : sandboxed == 0 ? "no" : "error");
  for (int i = 3; i < argc; i++) {
    char *operation = strdup(argv[i]);
    char *path = strchr(operation, '=');
    int result;
    if (path != NULL) {
      *path++ = '\0';
      result = sandbox_check(pid, operation, SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, path);
    } else {
      result = sandbox_check(pid, operation, SANDBOX_FILTER_NONE | SANDBOX_CHECK_NO_REPORT);
    }
    printf("{\"operation\":");
    json_string(operation);
    if (path != NULL) {
      printf(",\"path\":");
      json_string(path);
    }
    printf(",\"result\":\"%s\"}\n", result == 0 ? "allowed" : result == 1 ? "denied" : "error");
    free(operation);
  }
  return 0;
}

static int connect_once(int argc, char **argv) {
  if (argc < 4) return 2;
  int sandboxed = sandbox_check(getpid(), NULL, SANDBOX_FILTER_NONE) == 1;
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_len = sizeof address;
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)strtol(argv[3], NULL, 10));
  if (inet_pton(AF_INET, argv[2], &address.sin_addr) != 1) return 2;
  const char *outcome;
  int error = 0;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof address) != 0) {
    error = errno;
    outcome = error == EPERM || error == EACCES ? "denied"
              : error == ECONNREFUSED          ? "refused"
                                               : "error";
  } else {
    outcome = "connected";
  }
  if (fd >= 0) close(fd);
  printf("{\"sandboxed\":%s,\"connect\":\"%s\",\"errno\":%d}\n", sandboxed ? "true" : "false",
         outcome, error);
  return 0;
}

static int write_files(int argc, char **argv) {
  for (int i = 2; i < argc; i++) {
    int fd = open(argv[i], O_WRONLY | O_CREAT | O_EXCL, 0600);
    int error = fd < 0 ? errno : 0;
    if (fd >= 0) {
      close(fd);
      unlink(argv[i]);
    }
    printf("{\"path\":");
    json_string(argv[i]);
    printf(",\"write\":\"%s\",\"errno\":%d}\n",
           fd >= 0                              ? "created"
           : error == EPERM || error == EACCES ? "denied"
                                               : "error",
           error);
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "check") == 0) return check(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "connect") == 0) return connect_once(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "write") == 0) return write_files(argc, argv);
  fprintf(stderr, "usage: sandbox-probe check <pid> <operation>[=<path>]...\n"
                  "       sandbox-probe connect <ipv4> <port>\n"
                  "       sandbox-probe write <path>...\n");
  return 2;
}
