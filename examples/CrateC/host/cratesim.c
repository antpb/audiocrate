/*
 * cratesim: the pedal, on a desktop.
 *
 * Runs `crate_engine` exactly as a device would: one pack, one arena of the
 * device's size, blocks of the device's size, MIDI arriving as raw bytes in
 * the USB ring. Built with the device's sample type and line storage.
 *
 *   cratesim pack --list
 *   cratesim pack --smoke [--arena bytes] [--block frames]
 *   cratesim pack --render id in.wav out.wav [--notes 60,64,67] [--cc n=v,...]
 *
 * --smoke is `validate-factory.sh` for the device path: every available
 * patch is loaded through the engine and held to the bars the iOS factory
 * gate uses (see `smoke`). It also times every render, as a multiple of
 * real time on this machine, which ranks patches by cost though it says
 * nothing absolute about a 320 MHz core.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "crate_engine.h"

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static void *read_all(const char *path, size_t *size) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    void *buf = malloc((size_t)n);
    *size = fread(buf, 1, (size_t)n, f);
    fclose(f);
    return buf;
}

static void note(crate_engine *e, int on, int key, int velocity) {
    uint8_t msg[3] = { (uint8_t)(on ? 0x90 : 0x80), (uint8_t)key, (uint8_t)velocity };
    crate_engine_midi(e, CRATE_MIDI_USB, msg, 3);
}

/* Renders `seconds` of the loaded patch with `in` as input (NULL for none)
 * and returns the peak, skipping the first `skip` seconds; NaN if any
 * sample was not finite. Also returns the render time. */
static double listen(crate_engine *e, int block, double seconds, double skip, int saw_input, double *elapsed) {
    double rate = e->config.sample_rate;
    int total = (int)(rate * seconds), from = (int)(rate * skip);
    float *in = (float *)calloc((size_t)block, sizeof(float));
    float *out_l = (float *)calloc((size_t)block, sizeof(float));
    float *out_r = (float *)calloc((size_t)block, sizeof(float));
    double peak = 0, phase = 0;
    int finite = 1;
    double started = now_seconds();
    for (int done = 0; done < total; done += block) {
        int n = total - done < block ? total - done : block;
        for (int i = 0; i < n; i++) {
            /* The iOS gate's test signal: a 0.30 saw at 110 Hz, which has
             * something in every band a filter patch might cut. */
            in[i] = saw_input ? (float)((phase * 2 - 1) * 0.3) : 0;
            phase += 110.0 / rate;
            if (phase >= 1) phase -= 1;
        }
        crate_engine_process(e, in, NULL, out_l, out_r, n);
        for (int i = 0; i < n; i++) {
            if (!isfinite(out_l[i]) || !isfinite(out_r[i])) { finite = 0; continue; }
            if (done + i < from) continue;
            double m = fabs(out_l[i]) > fabs(out_r[i]) ? fabs(out_l[i]) : fabs(out_r[i]);
            if (m > peak) peak = m;
        }
    }
    *elapsed += now_seconds() - started;
    free(in);
    free(out_l);
    free(out_r);
    return finite ? peak : NAN;
}

static void chord(crate_engine *e, const int *notes, int count, int on) {
    for (int k = 0; k < count; k++) note(e, on, notes[k], on ? 127 : 0);
}

/*
 * `validate-factory.sh`, run through the device engine instead of the Swift
 * interpreter, with the same bars:
 *
 *   instrument  held middle C peaks at 0.18 or more; a four note chord on the
 *               pool the plugin builds (one voice: no factory patch sets a
 *               polyphony) peaks at 1.6 or less.
 *   either      four seconds with the transport rolling, still sounding
 *               after the first: peaks at 0.05 or more.
 *   effect      a 0.30 saw comes out between 0.06 and 0.75.
 *
 * Plus what only a device has: the same chord on this device's voices,
 * reported, since four voices summing is what its converter will see.
 */
static int smoke(crate_engine *e, int block) {
    int failures = 0, skipped = 0, device_over = 0, pool_voices = 0;
    double slowest = 1e30;
    const char *slowest_id = "";
    int device_voices = e->config.max_voices;
    int safety = e->config.output_safety;
    /* The patch is measured, not the safety stage: the iOS bars are about
     * what a patch does, and a limiter would pass a runaway chord and hide a
     * NaN. Only the device chord below is heard through it. */
    e->config.output_safety = 0;
    int device_over_safe = 0;
    static const int held[1] = { 60 };
    static const int four[4] = { 48, 55, 60, 67 };
    printf("%-22s %-10s %-26s %13s %6s  %s\n", "id", "slot", "measure", "device chord", "x rt", "result");
    for (int p = 0; p < crate_engine_count(e); p++) {
        const char *id = crate_engine_id(e, p);
        int slot = crate_engine_slot(e, p);
        const char *slot_name = slot == CRATE_SLOT_INSTRUMENT ? "instrument" : slot == CRATE_SLOT_EITHER ? "either" : "effect";
        if (!crate_engine_available(e, p)) {
            printf("%-22s %-10s %-26s %13s %6s  unavailable on this device\n", id, slot_name, "", "", "");
            skipped++;
            continue;
        }
        char measure[64] = "", device[32] = "";
        const char *verdict = "ok";
        double elapsed = 0, rendered = 0;
        if (crate_engine_role(e, p) == CRATE_ROLE_INSTRUMENT) {
            e->config.max_voices = 1;
            crate_engine_load(e, p);
            chord(e, held, 1, 1);
            double h = listen(e, block, 2, 0, 0, &elapsed);
            crate_engine_load(e, p);
            chord(e, four, 4, 1);
            double c = listen(e, block, 2, 0, 0, &elapsed);
            e->config.max_voices = device_voices;
            crate_engine_load(e, p);
            chord(e, four, 4, 1);
            if (e->current >= 0) pool_voices = e->pool.polyphony;
            double d = listen(e, block, 2, 0, 0, &elapsed);
            e->config.output_safety = 1;
            crate_engine_load(e, p);
            chord(e, four, 4, 1);
            double ds = listen(e, block, 2, 0, 0, &elapsed);
            e->config.output_safety = 0;
            if (!isnan(ds) && ds > 1.0) device_over_safe++;
            rendered = 8;
            snprintf(measure, sizeof measure, "held %.3f chord %.3f", h, c);
            snprintf(device, sizeof device, "%.3f>%.3f", d, ds);
            if (isnan(h) || isnan(c) || isnan(d)) verdict = "NON-FINITE";
            else if (h < 0.18) verdict = "QUIET";
            else if (c > 1.6) verdict = "RUNS AWAY";
            if (!isnan(d) && d > 1.0) device_over++;
        } else if (slot == CRATE_SLOT_EITHER) {
            crate_engine_load(e, p);
            double later = listen(e, block, 4, 1, 0, &elapsed);
            rendered = 4;
            snprintf(measure, sizeof measure, "after 1 s %.3f", later);
            if (isnan(later)) verdict = "NON-FINITE";
            else if (later < 0.05) verdict = "STOPPED";
        } else {
            crate_engine_load(e, p);
            double out = listen(e, block, 1, 0, 1, &elapsed);
            rendered = 1;
            snprintf(measure, sizeof measure, "in 0.300 out %.3f", out);
            if (isnan(out)) verdict = "NON-FINITE";
            else if (out > 0.75) verdict = "LOUDER";
            else if (out < 0.06) verdict = "MUTES";
        }
        if (e->current < 0) verdict = "LOAD FAILED";
        else if (e->role == CRATE_ROLE_INSTRUMENT ? e->pool.voices[0].starved : e->state.starved) verdict = "STARVED";
        if (strcmp(verdict, "ok") != 0) failures++;
        double realtime = elapsed > 0 ? rendered / elapsed : 0;
        if (realtime < slowest) { slowest = realtime; slowest_id = id; }
        printf("%-22s %-10s %-26s %13s %6.0f  %s\n", id, slot_name, measure, device, realtime, verdict);
    }
    printf("\n%d patches: %d failed, %d unavailable.\n", crate_engine_count(e), failures, skipped);
    printf("On a %d-voice chord: %d instruments over full scale before the safety stage, %d after.\n",
           pool_voices, device_over, device_over_safe);
    if (device_over_safe) failures++;
    e->config.output_safety = safety;
    printf("Slowest: %s at %.0fx real time on this machine.\n", slowest_id, slowest);
    return failures ? 1 : 0;
}

/* --- WAV, the two shapes anybody hands this: 16-bit PCM and 32-bit float - */

typedef struct wav {
    int channels;
    int rate;
    long frames;
    float *samples; /* interleaved */
} wav;

static int read_wav(const char *path, wav *w) {
    size_t size = 0;
    uint8_t *d = (uint8_t *)read_all(path, &size);
    if (!d || size < 44 || memcmp(d, "RIFF", 4) || memcmp(d + 8, "WAVE", 4)) { free(d); return -1; }
    int format = 0, bits = 0;
    size_t at = 12;
    memset(w, 0, sizeof *w);
    while (at + 8 <= size) {
        uint32_t len = (uint32_t)d[at + 4] | (uint32_t)d[at + 5] << 8 | (uint32_t)d[at + 6] << 16 | (uint32_t)d[at + 7] << 24;
        if (!memcmp(d + at, "fmt ", 4)) {
            format = d[at + 8] | d[at + 9] << 8;
            w->channels = d[at + 10] | d[at + 11] << 8;
            w->rate = (int)((uint32_t)d[at + 12] | (uint32_t)d[at + 13] << 8 | (uint32_t)d[at + 14] << 16 | (uint32_t)d[at + 15] << 24);
            bits = d[at + 22] | d[at + 23] << 8;
            if (format == 0xFFFE) format = d[at + 32] | d[at + 33] << 8;
        } else if (!memcmp(d + at, "data", 4)) {
            size_t avail = len < size - at - 8 ? len : size - at - 8;
            int bytes = bits / 8;
            if (!w->channels || !bytes) break;
            w->frames = (long)(avail / (size_t)(bytes * w->channels));
            w->samples = (float *)malloc(sizeof(float) * (size_t)(w->frames * w->channels));
            const uint8_t *s = d + at + 8;
            for (long i = 0; i < w->frames * w->channels; i++) {
                if (format == 3 && bits == 32) { float f; memcpy(&f, s + i * 4, 4); w->samples[i] = f; }
                else if (format == 1 && bits == 16) w->samples[i] = (float)(int16_t)(s[i * 2] | s[i * 2 + 1] << 8) / 32768.0f;
                else if (format == 1 && bits == 24) {
                    int32_t v = (int32_t)((uint32_t)s[i * 3] << 8 | (uint32_t)s[i * 3 + 1] << 16 | (uint32_t)s[i * 3 + 2] << 24) >> 8;
                    w->samples[i] = (float)v / 8388608.0f;
                } else { free(w->samples); w->samples = NULL; break; }
            }
            break;
        }
        at += 8 + len + (len & 1);
    }
    free(d);
    return w->samples ? 0 : -1;
}

static int write_wav(const char *path, const float *l, const float *r, long frames, int rate) {
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    uint32_t data = (uint32_t)(frames * 2 * 4);
    uint8_t h[44] = { 'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ', 16, 0, 0, 0, 3, 0, 2, 0 };
    uint32_t riff = 36 + data, byte_rate = (uint32_t)rate * 8;
    memcpy(h + 4, &riff, 4);
    memcpy(h + 24, &rate, 4);
    memcpy(h + 28, &byte_rate, 4);
    h[32] = 8; h[34] = 32;
    memcpy(h + 36, "data", 4);
    memcpy(h + 40, &data, 4);
    fwrite(h, 1, 44, f);
    for (long i = 0; i < frames; i++) {
        fwrite(&l[i], 4, 1, f);
        fwrite(&r[i], 4, 1, f);
    }
    fclose(f);
    return 0;
}

static int find_patch(const crate_engine *e, const char *id) {
    for (int p = 0; p < crate_engine_count(e); p++) {
        if (strcmp(crate_engine_id(e, p), id) == 0) return p;
    }
    return -1;
}

static int render(crate_engine *e, const char *id, const char *in_path, const char *out_path,
                  const char *notes, const char *ccs, int block) {
    int p = find_patch(e, id);
    if (p < 0) { fprintf(stderr, "no patch %s\n", id); return 2; }
    int rc = crate_engine_load(e, p);
    if (rc != CRATE_ENGINE_OK) { fprintf(stderr, "%s: load failed (%d)\n", id, rc); return 1; }
    wav w;
    if (read_wav(in_path, &w) != 0) { fprintf(stderr, "cannot read %s (16/24-bit PCM or 32-bit float)\n", in_path); return 2; }
    if (w.rate != (int)e->config.sample_rate) {
        fprintf(stderr, "note: %s is %d Hz and the engine runs at %.0f Hz; no resampling is done\n", in_path, w.rate, e->config.sample_rate);
    }
    /* CCs as name=value pairs, applied before the first block. */
    for (const char *c = ccs; c && *c;) {
        int n = 0, v = 0;
        if (sscanf(c, "%d=%d", &n, &v) == 2) {
            uint8_t msg[3] = { 0xB0, (uint8_t)(n & 0x7F), (uint8_t)(v & 0x7F) };
            crate_engine_midi(e, CRATE_MIDI_USB, msg, 3);
        }
        c = strchr(c, ',');
        if (c) c++;
    }
    for (const char *c = notes; c && *c;) {
        note(e, 1, atoi(c), 100);
        c = strchr(c, ',');
        if (c) c++;
    }
    float *in_l = (float *)calloc((size_t)w.frames + 1, sizeof(float));
    float *in_r = (float *)calloc((size_t)w.frames + 1, sizeof(float));
    for (long i = 0; i < w.frames; i++) {
        in_l[i] = w.samples[i * w.channels];
        in_r[i] = w.samples[i * w.channels + (w.channels > 1 ? 1 : 0)];
    }
    float *out_l = (float *)calloc((size_t)w.frames + 1, sizeof(float));
    float *out_r = (float *)calloc((size_t)w.frames + 1, sizeof(float));
    double started = now_seconds();
    for (long done = 0; done < w.frames; done += block) {
        int n = (int)(w.frames - done < block ? w.frames - done : block);
        crate_engine_process(e, in_l + done, w.channels > 1 ? in_r + done : NULL, out_l + done, out_r + done, n);
    }
    double elapsed = now_seconds() - started;
    write_wav(out_path, out_l, out_r, w.frames, (int)e->config.sample_rate);
    printf("%s: %ld frames through %s, %.0fx real time\n", out_path, w.frames, crate_engine_name(e, p),
           elapsed > 0 ? ((double)w.frames / e->config.sample_rate) / elapsed : 0);
    free(w.samples);
    free(in_l);
    free(in_r);
    free(out_l);
    free(out_r);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: cratesim pack (--list | --smoke | --render id in.wav out.wav) [--arena bytes] [--block frames] [--voices n] [--notes a,b] [--cc n=v,...]\n");
        return 2;
    }
    size_t pack_size = 0;
    void *pack = read_all(argv[1], &pack_size);
    if (!pack) { fprintf(stderr, "cannot read %s\n", argv[1]); return 2; }
    const crate_pack_header *h = (const crate_pack_header *)pack;

    long arena_bytes = h->budget_bytes;
    int block = 256, voices = 0;
    const char *notes = NULL, *ccs = NULL;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--arena") == 0 && i + 1 < argc) arena_bytes = atol(argv[++i]);
        else if (strcmp(argv[i], "--block") == 0 && i + 1 < argc) block = atoi(argv[++i]);
        else if (strcmp(argv[i], "--voices") == 0 && i + 1 < argc) voices = atoi(argv[++i]);
        else if (strcmp(argv[i], "--notes") == 0 && i + 1 < argc) notes = argv[++i];
        else if (strcmp(argv[i], "--cc") == 0 && i + 1 < argc) ccs = argv[++i];
    }

    crate_engine_config config;
    crate_engine_default_config(&config);
    config.sample_rate = h->magic == CRATE_PACK_MAGIC ? h->sample_rate : 44100;
    config.max_frames = block;
    if (voices > 0) config.max_voices = voices;
    config.mono_input = h->magic == CRATE_PACK_MAGIC && (h->flags & CRATE_PACK_MEASURED_MONO);
    void *arena = malloc((size_t)arena_bytes);
    crate_engine engine;
    if (crate_engine_init(&engine, &config, pack, pack_size, arena, (size_t)arena_bytes) != CRATE_ENGINE_OK) {
        fprintf(stderr, "%s is not a pack\n", argv[1]);
        return 2;
    }

    int rc = 0;
    if (strcmp(argv[2], "--list") == 0) {
        for (int c = 0; c < crate_engine_category_count(&engine); c++) {
            const char *category = crate_engine_category_at(&engine, c);
            printf("%s\n", category);
            for (int p = 0; p < crate_engine_count(&engine); p++) {
                if (strcmp(crate_engine_category(&engine, p), category) != 0) continue;
                printf("  %-22s %-24s %s%s\n", crate_engine_id(&engine, p), crate_engine_name(&engine, p),
                       crate_engine_role(&engine, p) == CRATE_ROLE_INSTRUMENT ? "instrument" : "insert",
                       crate_engine_available(&engine, p) ? "" : "  (unavailable)");
            }
        }
    } else if (strcmp(argv[2], "--smoke") == 0) {
        rc = smoke(&engine, block);
    } else if (strcmp(argv[2], "--render") == 0 && argc >= 6) {
        rc = render(&engine, argv[3], argv[4], argv[5], notes, ccs, block);
    } else {
        fprintf(stderr, "unknown command %s\n", argv[2]);
        rc = 2;
    }
    free(arena);
    free(pack);
    return rc;
}
