/*
 * A pool of voices over one plan: `VoicePool.swift` in C.
 *
 * An instrument patch is one voice graph played by several voices at once.
 * Allocation is `voices/allocate.ts` rule for rule (same-pitch retrigger,
 * then idle, then the oldest releasing tail, then steal a held voice), and a
 * released voice whose output stays under -100 dBFS for a few blocks is
 * retired so that eight slots playing one note cost one voice.
 *
 * A split instrument (effects that run once on the sum of the voices) has a
 * bus plan nested in its blob. Each voice renders only its sends, the sends
 * are summed, and the bus runs once on the sums: a chord through a reverb
 * costs one reverb.
 */
#ifndef CRATE_POOL_H
#define CRATE_POOL_H

#include "crate.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CRATE_MAX_VOICES 16
#define CRATE_MAX_SENDS 8

typedef enum { CRATE_STEAL_OLDEST, CRATE_STEAL_QUIETEST } crate_steal_policy;

typedef struct crate_slot {
    int note;          /* -1 for an idle slot */
    double velocity;
    int started_at;
    int held;
    int quiet_blocks;
} crate_slot;

typedef struct crate_pool {
    const crate_plan *plan;
    crate_plan bus_plan;
    int has_bus;
    crate_state bus_state;
    int bus_quiet_blocks;
    int bus_send_ports[CRATE_MAX_SENDS];
    int polyphony;
    crate_steal_policy policy;
    crate_state voices[CRATE_MAX_VOICES];
    crate_slot slots[CRATE_MAX_VOICES];
    int clock;
    int max_frames;
    float *mix_l;
    float *mix_r;
    float *voice_send_l[CRATE_MAX_SENDS];
    float *voice_send_r[CRATE_MAX_SENDS];
    float *sum_send_l[CRATE_MAX_SENDS];
    float *sum_send_r[CRATE_MAX_SENDS];
    float silence_floor;
    int quiet_blocks_to_retire;
} crate_pool;

/* Returns 0, or -1 when the arena cannot hold the pool or the plan asks for
 * more sends than CRATE_MAX_SENDS. `max_frames` sizes the scratch once. */
int crate_pool_init(crate_pool *pool, const crate_plan *plan, crate_arena *arena,
                    int polyphony, uint32_t seed, int max_frames);
/* Takes every voice's memory up front. See `crate_state_prepare`. */
int crate_pool_prepare(crate_pool *pool, double sample_rate);

void crate_pool_set_param(crate_pool *pool, const char *name, double value);
void crate_pool_glide_param(crate_pool *pool, const char *name, double value);
/* By index, for the render thread. The voice plan and the bus plan number
 * their params separately; either index may be -1 when that half of a split
 * instrument does not read the param. */
void crate_pool_glide_param_index(crate_pool *pool, int voice_index, int bus_index, double value);
void crate_pool_note_on(crate_pool *pool, int note, double velocity);
void crate_pool_note_off(crate_pool *pool, int note);
void crate_pool_all_notes_off(crate_pool *pool);
int crate_pool_active_voices(const crate_pool *pool);

/* Renders every active voice and sums them into out_l / out_r (out_r may be
 * NULL). Returns how many voices rendered. Frames must not exceed the
 * `max_frames` the pool was built with. */
int crate_pool_render(crate_pool *pool, double sample_rate, int frames,
                      float *out_l, float *out_r, const crate_transport *transport);

#ifdef __cplusplus
}
#endif

#endif
