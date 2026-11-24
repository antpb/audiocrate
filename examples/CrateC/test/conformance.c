/*
 * Does the C interpreter render what the JavaScript one renders.
 *
 * `ConformanceTests.swift`, for the third implementation: the same fixture
 * (`fixtures/asl-conformance.json`), the same render recipe, the same
 * tolerance, and the same refusal to treat a mirrored right channel as a
 * rounding disagreement. Run against a double build this is the gate. Run
 * against a float build (`make conformance-float`) it is a measurement: the
 * worst deviation per case is what evaluating in single precision costs,
 * and `--tolerance` sets the bar that build is held to.
 *
 *   conformance [fixture.json] [--tolerance x] [--verbose]
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "crate.h"
#include "crate_build.h"
#include "json.h"

#define DEFAULT_FIXTURE "../../fixtures/asl-conformance.json"
#define EXPECTED_VERSION 2

static float *floats_of(const json_value *array, int *count) {
    *count = array && array->type == JSON_ARRAY ? array->count : 0;
    float *out = (float *)calloc((size_t)(*count ? *count : 1), sizeof(float));
    for (int i = 0; i < *count; i++) out[i] = (float)json_number(&array->items[i], 0);
    return out;
}

static double worst_of(const json_value *expected, const float *got, int frames) {
    double worst = 0;
    for (int i = 0; i < frames && i < expected->count; i++) {
        double e = json_number(&expected->items[i], 0);
        double d = fabs(e - (double)got[i]);
        if (isnan(d)) d = INFINITY;
        if (d > worst) worst = d;
    }
    return worst;
}

int main(int argc, char **argv) {
    const char *path = DEFAULT_FIXTURE;
    double tolerance = 5e-6;
    int verbose = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--tolerance") == 0 && i + 1 < argc) tolerance = atof(argv[++i]);
        else if (strcmp(argv[i], "--verbose") == 0) verbose = 1;
        else path = argv[i];
    }

    size_t length = 0;
    char *text = json_read_file(path, &length);
    if (!text) {
        fprintf(stderr, "cannot read %s\n", path);
        return 2;
    }
    char error[256];
    json_value *fixture = json_parse(text, length, error, sizeof error);
    free(text);
    if (!fixture) {
        fprintf(stderr, "fixture: %s\n", error);
        return 2;
    }

    int version = (int)json_number(json_get(fixture, "version"), 0);
    if (version != EXPECTED_VERSION) {
        fprintf(stderr, "fixture is version %d, this build reads %d\n", version, EXPECTED_VERSION);
        return 1;
    }

    /* The vocabulary check: kinds crate can emit that this cannot decode, and
     * kinds this has that crate no longer emits. */
    int vocabulary_ok = 1;
    const json_value *kinds = json_get(fixture, "kinds");
    for (int i = 0; kinds && i < kinds->count; i++) {
        const char *name = json_string(&kinds->items[i], "");
        int found = 0;
        for (int k = 0; k < CK_COUNT; k++) if (strcmp(crate_kind_names[k], name) == 0) found = 1;
        if (!found) { fprintf(stderr, "kind crate emits that C cannot decode: %s\n", name); vocabulary_ok = 0; }
    }
    for (int k = 0; k < CK_COUNT; k++) {
        int found = 0;
        for (int i = 0; kinds && i < kinds->count; i++) if (strcmp(json_string(&kinds->items[i], ""), crate_kind_names[k]) == 0) found = 1;
        if (!found) { fprintf(stderr, "kind C has that crate no longer emits: %s\n", crate_kind_names[k]); vocabulary_ok = 0; }
    }

    double sample_rate = json_number(json_get(fixture, "sampleRate"), 48000);
    int frames = (int)json_number(json_get(fixture, "frames"), 512);
    int blocks = (int)json_number(json_get(fixture, "blocks"), 4);
    double bpm = json_number(json_get(fixture, "bpm"), 120);
    const json_value *params = json_get(fixture, "params");
    int in_count = 0, in_r_count = 0;
    float *input = floats_of(json_get(fixture, "input"), &in_count);
    float *input_r = floats_of(json_get(fixture, "inputR"), &in_r_count);
    const json_value *cases = json_get(fixture, "cases");

    size_t arena_bytes = (size_t)64 << 20;
    void *arena_memory = malloc(arena_bytes);
    float *out = (float *)calloc((size_t)frames, sizeof(float));
    float *out_r = (float *)calloc((size_t)frames, sizeof(float));
    float *first = (float *)calloc((size_t)frames, sizeof(float));
    float *first_r = (float *)calloc((size_t)frames, sizeof(float));

    int failures = 0, exact = 0, stereo_cases = 0;
    double worst_all = 0;
    const char *worst_name = "";
    for (int c = 0; cases && c < cases->count; c++) {
        const json_value *tc = &cases->items[c];
        const char *name = json_string(json_get(tc, "name"), "?");
        int insert = json_get(tc, "insert") && json_get(tc, "insert")->boolean;

        size_t blob_size = 0;
        void *blob = crate_build_plan(json_get(tc, "graph"), &blob_size, error, sizeof error);
        if (!blob) {
            printf("FAIL %-40s build: %s\n", name, error);
            failures++;
            continue;
        }
        crate_plan plan;
        if (crate_plan_open(&plan, blob, blob_size) != 0) {
            printf("FAIL %-40s plan did not open\n", name);
            failures++;
            free(blob);
            continue;
        }
        crate_arena arena;
        crate_arena_init(&arena, arena_memory, arena_bytes);
        crate_state state;
        if (crate_state_init(&state, &plan, &arena, CRATE_DEFAULT_SEED) != 0) {
            printf("FAIL %-40s state did not fit\n", name);
            failures++;
            free(blob);
            continue;
        }
        for (int p = 0; params && p < params->count; p++) {
            crate_set_param(&state, params->keys[p], json_number(&params->items[p], 0));
        }
        state.gate = 1; /* noteOn */

        int wrote_right = 0;
        for (int block = 0; block < blocks; block++) {
            crate_transport t;
            crate_transport_default(&t);
            t.beats = ((double)block * (double)frames * bpm) / (sample_rate * 60);
            t.bpm = bpm;
            t.playing = 1;
            memset(out_r, 0, sizeof(float) * (size_t)frames);
            wrote_right = crate_render(&state, sample_rate, frames, out, out_r,
                                       insert ? input : NULL, insert ? input_r : NULL, &t, NULL, NULL);
            if (block == 0) {
                memcpy(first, out, sizeof(float) * (size_t)frames);
                memcpy(first_r, out_r, sizeof(float) * (size_t)frames);
            }
        }

        const json_value *exp_first_r = json_get(tc, "firstR");
        int expects_stereo = exp_first_r != NULL;
        double worst = fmax(worst_of(json_get(tc, "first"), first, frames), worst_of(json_get(tc, "last"), out, frames));
        if (expects_stereo) {
            stereo_cases++;
            if (wrote_right) {
                worst = fmax(worst, worst_of(exp_first_r, first_r, frames));
                worst = fmax(worst, worst_of(json_get(tc, "lastR"), out_r, frames));
            }
        }
        int ok = worst <= tolerance && expects_stereo == wrote_right && !state.starved;
        if (worst == 0) exact++;
        if (worst > worst_all) { worst_all = worst; worst_name = name; }
        if (!ok) {
            failures++;
            printf("FAIL %-40s worst %.3g%s%s\n", name, worst,
                   expects_stereo != wrote_right ? (expects_stereo ? "  (JS wrote the right channel, C mirrored)" : "  (C wrote a right channel JS mirrored)") : "",
                   state.starved ? "  (arena ran dry)" : "");
        } else if (verbose) {
            printf("ok   %-40s worst %.3g  nodes %d  arena %zu B\n", name, worst, plan.h->node_count, arena.used);
        }
        free(blob);
    }

    int count = cases ? cases->count : 0;
    printf("\ncases            %d, %d stereo\n", count, stereo_cases);
    printf("bit-exact        %d\n", exact);
    printf("worst deviation  %.3g (%s)\n", worst_all, worst_name);
    printf("tolerance        %.3g\n", tolerance);
    printf("sample type      %s\n", sizeof(crate_real) == sizeof(double) ? "double" : "float");
    printf("%s\n", failures == 0 && vocabulary_ok ? "PASS" : "FAIL");

    free(input);
    free(input_r);
    free(out);
    free(out_r);
    free(first);
    free(first_r);
    free(arena_memory);
    json_free(fixture);
    return failures == 0 && vocabulary_ok ? 0 : 1;
}
