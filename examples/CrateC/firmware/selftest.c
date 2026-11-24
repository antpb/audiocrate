/*
 * The firmware host, proven on the desktop before it runs on the chip.
 *
 * crate_fw_process is the exact function the pedal's audio frame calls, built
 * here with the chip's types (CRATE_REAL_FLOAT, CRATE_LINE_INT16). This feeds
 * it a plucked-string test signal and checks:
 *
 *   - its int16 output matches a direct crate_render of the same embedded
 *     plan to within one int16 step (the wrapper only converts formats);
 *   - every sample is finite, in range, and the block is not silent;
 *   - two runs of a fresh host are bit-identical (no uninitialised state).
 *
 * The conformance gate already holds crate_render to the JS/Swift reference.
 * This closes the last link: the wrapper that will run on hardware does not
 * change the sound. A pass means a correct render on the chip is a wiring
 * question, not an interpreter question.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "crate.h"
#include "crate_firmware.h"
#include "crate_embed.h"

#define RATE 44100.0
#define FRAMES 256
#define BLOCKS 64

static float pluck(long i) {
    double t = fmod((double)i / RATE, 0.5);
    double ph = fmod(t * 110.0, 1.0);
    return (float)((2 * ph - 1) * 0.5 * exp(-t * 6));
}

int main(void) {
    if (crate_fw_init(RATE, malloc) != 0 || !crate_fw_ready()) {
        printf("FAIL firmware init\n");
        return 1;
    }

    /* The reference path: the same embedded plan through crate_render. */
    static uint8_t ref_mem[256 * 1024];
    crate_plan plan;
    crate_arena arena;
    crate_state ref;
    crate_arena_init(&arena, ref_mem, sizeof ref_mem);
    if (crate_plan_open(&plan, crate_embed_plan, sizeof crate_embed_plan) != 0 ||
        crate_state_init(&ref, &plan, &arena, 1) != 0 ||
        crate_state_prepare(&ref, RATE) != 0) {
        printf("FAIL reference open\n");
        return 1;
    }
    for (int i = 0; i < CRATE_EMBED_PARAM_COUNT; i++)
        crate_set_param(&ref, crate_embed_params[i].name, crate_embed_params[i].def);
    ref.gate = 1;

    int16_t block[FRAMES * 2];
    float in[FRAMES], out_l[FRAMES], out_r[FRAMES];
    double peak = 0, sum_sq = 0;
    int worst = 0, nonfinite = 0, clipped = 0;
    unsigned long checksum = 2166136261u;

    for (int b = 0; b < BLOCKS; b++) {
        for (int i = 0; i < FRAMES; i++) {
            float g = pluck((long)b * FRAMES + i);
            block[i * 2] = (int16_t)(g * 32767.0f);
            block[i * 2 + 1] = 0;
            /* The reference must see the same quantised input the hardware
             * hands the firmware: int16 read back as the host does it. */
            in[i] = (float)block[i * 2] * (1.0f / 32768.0f);
        }
        crate_fw_process(block, FRAMES);

        int ref_wrote = crate_render(&ref, RATE, FRAMES, out_l, out_r, in, NULL, NULL, NULL, NULL);
        for (int i = 0; i < FRAMES; i++) {
            float rl = out_l[i], rr = ref_wrote ? out_r[i] : out_l[i];
            if (rl > 1) rl = 1; else if (rl < -1) rl = -1;
            if (rr > 1) rr = 1; else if (rr < -1) rr = -1;
            int16_t erl = (int16_t)(rl * 32767.0f), err = (int16_t)(rr * 32767.0f);
            int dl = block[i * 2] - erl, dr = block[i * 2 + 1] - err;
            if (dl < 0) dl = -dl; if (dr < 0) dr = -dr;
            if (dl > worst) worst = dl;
            if (dr > worst) worst = dr;

            int16_t s = block[i * 2];
            if (!isfinite((float)s)) nonfinite++;
            double m = fabs((double)s / 32768.0);
            if (m > peak) peak = m;
            if (s == 32767 || s == -32768) clipped++;
            sum_sq += m * m;
            checksum = (checksum ^ (unsigned)(uint16_t)block[i * 2]) * 16777619u;
            checksum = (checksum ^ (unsigned)(uint16_t)block[i * 2 + 1]) * 16777619u;
        }
    }
    double rms = sqrt(sum_sq / (BLOCKS * FRAMES));

    /* Determinism: a fresh host over the same input must checksum the same. */
    crate_fw_init(RATE, malloc);
    unsigned long checksum2 = 2166136261u;
    for (int b = 0; b < BLOCKS; b++) {
        for (int i = 0; i < FRAMES; i++) {
            float g = pluck((long)b * FRAMES + i);
            block[i * 2] = (int16_t)(g * 32767.0f);
            block[i * 2 + 1] = 0;
        }
        crate_fw_process(block, FRAMES);
        for (int i = 0; i < FRAMES; i++) {
            checksum2 = (checksum2 ^ (unsigned)(uint16_t)block[i * 2]) * 16777619u;
            checksum2 = (checksum2 ^ (unsigned)(uint16_t)block[i * 2 + 1]) * 16777619u;
        }
    }

    printf("patch            %s (%s)\n", CRATE_EMBED_ID, CRATE_EMBED_ROLE_INSTRUMENT ? "instrument" : "insert");
    printf("plan             %zu bytes, arena used reported by cratesim\n", sizeof crate_embed_plan);
    printf("vs crate_render  worst int16 diff %d\n", worst);
    printf("output           peak %.3f  rms %.4f  nonfinite %d  clipped %d\n", peak, rms, nonfinite, clipped);
    printf("determinism      %s\n", checksum == checksum2 ? "identical" : "DIFFERS");

    int ok = worst <= 1 && nonfinite == 0 && rms > 1e-4 && peak <= 1.0 && checksum == checksum2;
    printf("%s\n", ok ? "PASS" : "FAIL");
    return ok ? 0 : 1;
}
