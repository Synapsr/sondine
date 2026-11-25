#ifndef SONDINE_ONNX_H
#define SONDINE_ONNX_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Threading settings applied to an ONNX Runtime session.
typedef struct SondineOrtThreading {
    int32_t intra_op_threads;
    int32_t inter_op_threads;
    /// 0 or 1; written to both `session.intra_op.allow_spinning` and `session.inter_op.allow_spinning`.
    int32_t allow_spinning;
    /// 1 = ORT_SEQUENTIAL, 0 = ORT_PARALLEL.
    int32_t sequential;
} SondineOrtThreading;

/// Session options with the settings that ONNX Runtime accepted.
typedef struct SondineOrtOptions SondineOrtOptions;

/// Silero VAD session (inputs `input`, `state`, `sr`; outputs `output`, `stateN`).
typedef struct SondineSilero SondineSilero;

enum {
    SONDINE_SILERO_WINDOW = 512,
    SONDINE_SILERO_CONTEXT = 64,
    SONDINE_SILERO_STATE = 2 * 1 * 128,
};

/// ONNX Runtime version string of the linked library.
const char *sondine_ort_version(void);

/// Creates options and applies `threading`. Returns NULL and fills `error` on failure.
SondineOrtOptions *sondine_ort_options_create(SondineOrtThreading threading, char *error, size_t error_length);
void sondine_ort_options_destroy(SondineOrtOptions *options);

/// The settings ONNX Runtime accepted (each is recorded only after its setter succeeded).
SondineOrtThreading sondine_ort_options_applied(const SondineOrtOptions *options);

/// Reads a session config entry back from ONNX Runtime. Returns 1 when found, 0 when absent, -1 on error.
int sondine_ort_options_config_entry(const SondineOrtOptions *options, const char *key, char *value, size_t value_length);

/// Loads the model. `options` stays owned by the caller and may be destroyed afterwards.
SondineSilero *sondine_silero_create(const char *model_path, const SondineOrtOptions *options, char *error, size_t error_length);
void sondine_silero_destroy(SondineSilero *session);

/// Runs one window. `input` holds CONTEXT + WINDOW samples; `state` (STATE floats) is read and
/// replaced by the new state. Returns 0 on success.
int sondine_silero_run(SondineSilero *session, const float *input, float *state, float *probability, char *error, size_t error_length);

#ifdef __cplusplus
}
#endif

#endif
