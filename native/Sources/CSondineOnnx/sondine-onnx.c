#include "sondine-onnx.h"

#include <onnxruntime/onnxruntime_c_api.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct SondineOrtOptions {
    OrtSessionOptions *options;
    SondineOrtThreading applied;
};

struct SondineSilero {
    OrtSession *session;
    OrtMemoryInfo *memory;
    float input[SONDINE_SILERO_CONTEXT + SONDINE_SILERO_WINDOW];
    float state_in[SONDINE_SILERO_STATE];
    float state_out[SONDINE_SILERO_STATE];
    float output[1];
    int64_t sample_rate;
    OrtValue *values_in[3];
    OrtValue *values_out[2];
};

static const OrtApi *ort_api = NULL;
static OrtEnv *ort_env = NULL;
static OrtStatus *ort_env_status = NULL;
static pthread_once_t ort_once = PTHREAD_ONCE_INIT;

static const char *const input_names[3] = {"input", "state", "sr"};
static const char *const output_names[2] = {"output", "stateN"};

static void ort_initialize(void) {
    ort_api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
    if (ort_api == NULL) return;
    ort_env_status = ort_api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "sondine", &ort_env);
}

static void write_error(char *error, size_t length, const char *message) {
    if (error == NULL || length == 0) return;
    snprintf(error, length, "%s", message);
}

/// Copies the status message into `error`, releases the status, and returns 1 when it was an error.
static int take_status(OrtStatus *status, char *error, size_t length) {
    if (status == NULL) return 0;
    write_error(error, length, ort_api->GetErrorMessage(status));
    ort_api->ReleaseStatus(status);
    return 1;
}

static int ensure_api(char *error, size_t length) {
    pthread_once(&ort_once, ort_initialize);
    if (ort_api == NULL) {
        write_error(error, length, "ONNX Runtime API version mismatch");
        return 0;
    }
    if (ort_env == NULL) {
        write_error(error, length, ort_env_status ? ort_api->GetErrorMessage(ort_env_status) : "cannot create ONNX Runtime environment");
        return 0;
    }
    return 1;
}

const char *sondine_ort_version(void) {
    return OrtGetApiBase()->GetVersionString();
}

SondineOrtOptions *sondine_ort_options_create(SondineOrtThreading threading, char *error, size_t error_length) {
    if (!ensure_api(error, error_length)) return NULL;
    SondineOrtOptions *result = calloc(1, sizeof(SondineOrtOptions));
    if (result == NULL) {
        write_error(error, error_length, "out of memory");
        return NULL;
    }
    // Unset fields stay at -1 so a failed setter is visible in `applied`.
    result->applied = (SondineOrtThreading){-1, -1, -1, -1};
    if (take_status(ort_api->CreateSessionOptions(&result->options), error, error_length)) goto fail;

    if (take_status(ort_api->SetIntraOpNumThreads(result->options, threading.intra_op_threads), error, error_length)) goto fail;
    result->applied.intra_op_threads = threading.intra_op_threads;

    if (take_status(ort_api->SetInterOpNumThreads(result->options, threading.inter_op_threads), error, error_length)) goto fail;
    result->applied.inter_op_threads = threading.inter_op_threads;

    const char *spinning = threading.allow_spinning ? "1" : "0";
    if (take_status(ort_api->AddSessionConfigEntry(result->options, "session.intra_op.allow_spinning", spinning), error, error_length)) goto fail;
    if (take_status(ort_api->AddSessionConfigEntry(result->options, "session.inter_op.allow_spinning", spinning), error, error_length)) goto fail;
    result->applied.allow_spinning = threading.allow_spinning ? 1 : 0;

    ExecutionMode mode = threading.sequential ? ORT_SEQUENTIAL : ORT_PARALLEL;
    if (take_status(ort_api->SetSessionExecutionMode(result->options, mode), error, error_length)) goto fail;
    result->applied.sequential = threading.sequential ? 1 : 0;

    if (take_status(ort_api->SetSessionGraphOptimizationLevel(result->options, ORT_ENABLE_ALL), error, error_length)) goto fail;
    return result;

fail:
    sondine_ort_options_destroy(result);
    return NULL;
}

void sondine_ort_options_destroy(SondineOrtOptions *options) {
    if (options == NULL) return;
    if (options->options != NULL) ort_api->ReleaseSessionOptions(options->options);
    free(options);
}

SondineOrtThreading sondine_ort_options_applied(const SondineOrtOptions *options) {
    return options->applied;
}

int sondine_ort_options_config_entry(const SondineOrtOptions *options, const char *key, char *value, size_t value_length) {
    int has = 0;
    if (take_status(ort_api->HasSessionConfigEntry(options->options, key, &has), NULL, 0)) return -1;
    if (!has) return 0;
    size_t size = value_length;
    if (take_status(ort_api->GetSessionConfigEntry(options->options, key, value, &size), NULL, 0)) return -1;
    return 1;
}

static int check_names(OrtSession *session, int inputs, char *error, size_t length) {
    OrtAllocator *allocator = NULL;
    if (take_status(ort_api->GetAllocatorWithDefaultOptions(&allocator), error, length)) return 0;
    size_t count = 0;
    OrtStatus *status = inputs ? ort_api->SessionGetInputCount(session, &count) : ort_api->SessionGetOutputCount(session, &count);
    if (take_status(status, error, length)) return 0;
    size_t expected = inputs ? 3 : 2;
    if (count != expected) {
        write_error(error, length, inputs ? "unexpected Silero input count" : "unexpected Silero output count");
        return 0;
    }
    for (size_t index = 0; index < count; index++) {
        char *name = NULL;
        status = inputs ? ort_api->SessionGetInputName(session, index, allocator, &name) : ort_api->SessionGetOutputName(session, index, allocator, &name);
        if (take_status(status, error, length)) return 0;
        const char *want = inputs ? input_names[index] : output_names[index];
        int same = strcmp(name, want) == 0;
        if (!same) {
            char message[256];
            snprintf(message, sizeof message, "unexpected Silero %s %zu: %s (want %s)", inputs ? "input" : "output", index, name, want);
            write_error(error, length, message);
        }
        (void)ort_api->AllocatorFree(allocator, name);
        if (!same) return 0;
    }
    return 1;
}

static OrtStatus *make_tensor(SondineSilero *silero, void *data, size_t bytes, const int64_t *shape, size_t rank, ONNXTensorElementDataType type, OrtValue **value) {
    return ort_api->CreateTensorWithDataAsOrtValue(silero->memory, data, bytes, shape, rank, type, value);
}

SondineSilero *sondine_silero_create(const char *model_path, const SondineOrtOptions *options, char *error, size_t error_length) {
    if (!ensure_api(error, error_length)) return NULL;
    SondineSilero *silero = calloc(1, sizeof(SondineSilero));
    if (silero == NULL) {
        write_error(error, error_length, "out of memory");
        return NULL;
    }
    silero->sample_rate = 16000;
    if (take_status(ort_api->CreateSession(ort_env, model_path, options->options, &silero->session), error, error_length)) goto fail;
    if (!check_names(silero->session, 1, error, error_length)) goto fail;
    if (!check_names(silero->session, 0, error, error_length)) goto fail;
    if (take_status(ort_api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &silero->memory), error, error_length)) goto fail;

    // Tensors wrap the session's own buffers, so a run allocates no tensors.
    const int64_t input_shape[2] = {1, SONDINE_SILERO_CONTEXT + SONDINE_SILERO_WINDOW};
    const int64_t state_shape[3] = {2, 1, 128};
    const int64_t output_shape[2] = {1, 1};
    if (take_status(make_tensor(silero, silero->input, sizeof silero->input, input_shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &silero->values_in[0]), error, error_length)) goto fail;
    if (take_status(make_tensor(silero, silero->state_in, sizeof silero->state_in, state_shape, 3, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &silero->values_in[1]), error, error_length)) goto fail;
    if (take_status(make_tensor(silero, &silero->sample_rate, sizeof silero->sample_rate, NULL, 0, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &silero->values_in[2]), error, error_length)) goto fail;
    if (take_status(make_tensor(silero, silero->output, sizeof silero->output, output_shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &silero->values_out[0]), error, error_length)) goto fail;
    if (take_status(make_tensor(silero, silero->state_out, sizeof silero->state_out, state_shape, 3, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &silero->values_out[1]), error, error_length)) goto fail;
    return silero;

fail:
    sondine_silero_destroy(silero);
    return NULL;
}

void sondine_silero_destroy(SondineSilero *silero) {
    if (silero == NULL) return;
    for (int index = 0; index < 3; index++) {
        if (silero->values_in[index] != NULL) ort_api->ReleaseValue(silero->values_in[index]);
    }
    for (int index = 0; index < 2; index++) {
        if (silero->values_out[index] != NULL) ort_api->ReleaseValue(silero->values_out[index]);
    }
    if (silero->memory != NULL) ort_api->ReleaseMemoryInfo(silero->memory);
    if (silero->session != NULL) ort_api->ReleaseSession(silero->session);
    free(silero);
}

int sondine_silero_run(SondineSilero *silero, const float *input, float *state, float *probability, char *error, size_t error_length) {
    memcpy(silero->input, input, sizeof silero->input);
    memcpy(silero->state_in, state, sizeof silero->state_in);
    OrtStatus *status = ort_api->Run(
        silero->session, NULL,
        input_names, (const OrtValue *const *)silero->values_in, 3,
        output_names, 2, silero->values_out);
    if (take_status(status, error, error_length)) return -1;
    memcpy(state, silero->state_out, sizeof silero->state_out);
    *probability = silero->output[0];
    return 0;
}
