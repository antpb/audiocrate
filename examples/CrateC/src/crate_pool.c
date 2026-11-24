#include "crate_pool.h"

#include <stdio.h>
#include <string.h>

static float *scratch(crate_arena *arena, int frames) {
    return (float *)crate_arena_alloc(arena, sizeof(float) * (size_t)frames);
}

int crate_pool_init(crate_pool *pool, const crate_plan *plan, crate_arena *arena,
                    int polyphony, uint32_t seed, int max_frames) {
    memset(pool, 0, sizeof *pool);
    if (polyphony < 1) polyphony = 1;
    if (polyphony > CRATE_MAX_VOICES) polyphony = CRATE_MAX_VOICES;
    if (plan->h->send_count > CRATE_MAX_SENDS) return -1;
    pool->plan = plan;
    pool->polyphony = polyphony;
    pool->policy = CRATE_STEAL_OLDEST;
    pool->max_frames = max_frames;
    pool->silence_floor = 1e-5f;
    pool->quiet_blocks_to_retire = 4;
    for (int i = 0; i < polyphony; i++) {
        /* Voice i is seeded seed + i, as `AudioMaterial.bind` does: the
         * voices stay independent of each other and identical across runs. */
        if (crate_state_init(&pool->voices[i], plan, arena, seed + (uint32_t)i) != 0) return -1;
        pool->slots[i].note = -1;
    }
    pool->mix_l = scratch(arena, max_frames);
    pool->mix_r = scratch(arena, max_frames);
    if (!pool->mix_l || !pool->mix_r) return -1;

    if (plan->bus_blob) {
        const crate_plan_header *bh = (const crate_plan_header *)plan->bus_blob;
        if (crate_plan_open(&pool->bus_plan, plan->bus_blob, bh->size) != 0) return -1;
        /* Seeded like voice 0, as a one-voice host seeds the bus it carries. */
        if (crate_state_init(&pool->bus_state, &pool->bus_plan, arena, seed) != 0) return -1;
        /* An effect on the voices' sum: its gate opens once and stays open. */
        pool->bus_state.gate = 1;
        pool->has_bus = 1;
        for (int k = 0; k < plan->h->send_count; k++) {
            /* "send0".."send7": built by hand rather than with snprintf, whose
             * printf machinery is tens of KB on a freestanding target. Sends
             * never exceed CRATE_MAX_SENDS (single digit). */
            char name[8] = { 's', 'e', 'n', 'd', (char)('0' + (k % 10)), 0, 0, 0 };
            pool->bus_send_ports[k] = crate_plan_port_index(&pool->bus_plan, name);
            pool->voice_send_l[k] = scratch(arena, max_frames);
            pool->voice_send_r[k] = scratch(arena, max_frames);
            pool->sum_send_l[k] = scratch(arena, max_frames);
            pool->sum_send_r[k] = scratch(arena, max_frames);
            if (!pool->voice_send_l[k] || !pool->voice_send_r[k] || !pool->sum_send_l[k] || !pool->sum_send_r[k]) return -1;
        }
    }
    return 0;
}

int crate_pool_prepare(crate_pool *pool, double sample_rate) {
    for (int i = 0; i < pool->polyphony; i++) {
        if (crate_state_prepare(&pool->voices[i], sample_rate) != 0) return -1;
    }
    if (pool->has_bus && crate_state_prepare(&pool->bus_state, sample_rate) != 0) return -1;
    return 0;
}

void crate_pool_set_param(crate_pool *pool, const char *name, double value) {
    for (int i = 0; i < pool->polyphony; i++) crate_set_param(&pool->voices[i], name, value);
    if (pool->has_bus) crate_set_param(&pool->bus_state, name, value);
}

void crate_pool_glide_param(crate_pool *pool, const char *name, double value) {
    for (int i = 0; i < pool->polyphony; i++) crate_glide_param(&pool->voices[i], name, value);
    if (pool->has_bus) crate_glide_param(&pool->bus_state, name, value);
}

void crate_pool_glide_param_index(crate_pool *pool, int voice_index, int bus_index, double value) {
    if (voice_index >= 0) {
        for (int i = 0; i < pool->polyphony; i++) crate_glide_param_index(&pool->voices[i], voice_index, value);
    }
    if (pool->has_bus && bus_index >= 0) crate_glide_param_index(&pool->bus_state, bus_index, value);
}

static int oldest(const crate_pool *pool, int want_held, int want_releasing) {
    int best = -1;
    for (int i = 0; i < pool->polyphony; i++) {
        const crate_slot *s = &pool->slots[i];
        int match = (want_held && s->held) || (want_releasing && s->note >= 0 && !s->held);
        if (!match) continue;
        if (best < 0 || s->started_at < pool->slots[best].started_at) best = i;
    }
    return best;
}

static int allocate_slot(const crate_pool *pool, int note) {
    for (int i = 0; i < pool->polyphony; i++) {
        if (pool->slots[i].held && pool->slots[i].note == note) return i;
    }
    for (int i = 0; i < pool->polyphony; i++) {
        if (pool->slots[i].note < 0) return i;
    }
    int releasing = oldest(pool, 0, 1);
    if (releasing >= 0) return releasing;
    if (pool->policy == CRATE_STEAL_QUIETEST) {
        int best = -1;
        for (int i = 0; i < pool->polyphony; i++) {
            const crate_slot *s = &pool->slots[i];
            if (!s->held) continue;
            if (best < 0) { best = i; continue; }
            const crate_slot *b = &pool->slots[best];
            if (s->velocity != b->velocity ? s->velocity < b->velocity : s->started_at < b->started_at) best = i;
        }
        return best < 0 ? 0 : best;
    }
    int held = oldest(pool, 1, 0);
    return held < 0 ? 0 : held;
}

void crate_pool_note_on(crate_pool *pool, int note, double velocity) {
    int index = allocate_slot(pool, note);
    crate_state *state = &pool->voices[index];
    crate_slot *slot = &pool->slots[index];
    /* Stealing is a note off then a note on on the same voice, which gives
     * the envelope a chance to restart from where it was. */
    if (slot->note >= 0) state->gate = 0;
    pool->clock += 1;
    slot->note = note;
    slot->velocity = velocity;
    slot->held = 1;
    slot->started_at = pool->clock;
    slot->quiet_blocks = 0;
    crate_set_param(state, "note", (double)note);
    crate_set_param(state, "velocity", velocity);
    state->gate = 1;
}

void crate_pool_note_off(crate_pool *pool, int note) {
    for (int i = 0; i < pool->polyphony; i++) {
        if (pool->slots[i].held && pool->slots[i].note == note) {
            pool->slots[i].held = 0;
            pool->voices[i].gate = 0;
            return;
        }
    }
}

void crate_pool_all_notes_off(crate_pool *pool) {
    for (int i = 0; i < pool->polyphony; i++) {
        if (pool->slots[i].note < 0) continue;
        pool->slots[i].held = 0;
        pool->slots[i].note = -1;
        pool->slots[i].velocity = 0;
        pool->slots[i].quiet_blocks = 0;
        pool->voices[i].gate = 0;
    }
}

int crate_pool_active_voices(const crate_pool *pool) {
    int count = 0;
    for (int i = 0; i < pool->polyphony; i++) count += pool->slots[i].note >= 0;
    return count;
}

/* A released voice whose tail has fallen under the floor stops being
 * rendered. A held voice is never retired: a finger is still down. */
static void retire(crate_pool *pool, int index, float peak) {
    crate_slot *slot = &pool->slots[index];
    if (slot->held || peak > pool->silence_floor) {
        slot->quiet_blocks = 0;
        return;
    }
    slot->quiet_blocks += 1;
    if (slot->quiet_blocks >= pool->quiet_blocks_to_retire) {
        slot->note = -1;
        slot->velocity = 0;
        slot->quiet_blocks = 0;
    }
}

static float block_peak(const float *x, int frames) {
    float peak = 0;
    for (int i = 0; i < frames; i++) {
        float m = x[i] < 0 ? -x[i] : x[i];
        if (m > peak) peak = m;
    }
    return peak;
}

static int render_split(crate_pool *pool, double sample_rate, int frames,
                        float *out_l, float *out_r, const crate_transport *transport) {
    int count = pool->plan->h->send_count;
    for (int k = 0; k < count; k++) {
        memset(pool->sum_send_l[k], 0, sizeof(float) * (size_t)frames);
        memset(pool->sum_send_r[k], 0, sizeof(float) * (size_t)frames);
    }
    int rendered = 0, any_right = 0;
    for (int index = 0; index < pool->polyphony; index++) {
        if (pool->slots[index].note < 0) continue;
        rendered++;
        int wrote_right = crate_render(&pool->voices[index], sample_rate, frames, pool->mix_l, NULL,
                                       NULL, NULL, transport, pool->voice_send_l, pool->voice_send_r);
        if (wrote_right) any_right = 1;
        for (int k = 0; k < count; k++) {
            const float *l = pool->voice_send_l[k];
            const float *r = pool->voice_send_r[k];
            float *sum_l = pool->sum_send_l[k];
            float *sum_r = pool->sum_send_r[k];
            for (int i = 0; i < frames; i++) {
                sum_l[i] += l[i];
                sum_r[i] += wrote_right ? r[i] : l[i];
            }
        }
        /* Retired on its own signal, before the bus: its share of a reverb
         * tail is the bus's now. */
        retire(pool, index, block_peak(pool->mix_l, frames));
    }
    if (rendered == 0 && pool->bus_quiet_blocks >= pool->quiet_blocks_to_retire) return 0;

    for (int k = 0; k < count; k++) {
        if (pool->bus_send_ports[k] < 0) continue;
        /* Left only when no voice wrote a right channel, so a mono pool lets
         * a mirrorable bus run once and copy. */
        crate_set_port(&pool->bus_state, pool->bus_send_ports[k], pool->sum_send_l[k], any_right ? pool->sum_send_r[k] : NULL);
    }
    int bus_right = crate_render(&pool->bus_state, sample_rate, frames, out_l, out_r, NULL, NULL, transport, NULL, NULL);
    if (out_r && !bus_right) memcpy(out_r, out_l, sizeof(float) * (size_t)frames);
    float bus_peak = block_peak(out_l, frames);
    pool->bus_quiet_blocks = rendered == 0 && bus_peak <= pool->silence_floor ? pool->bus_quiet_blocks + 1 : 0;
    return rendered;
}

int crate_pool_render(crate_pool *pool, double sample_rate, int frames,
                      float *out_l, float *out_r, const crate_transport *transport) {
    if (frames > pool->max_frames) frames = pool->max_frames;
    memset(out_l, 0, sizeof(float) * (size_t)frames);
    if (out_r) memset(out_r, 0, sizeof(float) * (size_t)frames);
    if (pool->has_bus) return render_split(pool, sample_rate, frames, out_l, out_r, transport);

    int rendered = 0;
    for (int index = 0; index < pool->polyphony; index++) {
        if (pool->slots[index].note < 0) continue;
        rendered++;
        int wrote_right = crate_render(&pool->voices[index], sample_rate, frames, pool->mix_l,
                                       out_r ? pool->mix_r : NULL, NULL, NULL, transport, NULL, NULL);
        float peak = 0;
        for (int i = 0; i < frames; i++) {
            float value = pool->mix_l[i];
            out_l[i] += value;
            float m = value < 0 ? -value : value;
            if (m > peak) peak = m;
        }
        if (out_r) {
            /* A mono graph reports it did not fill the right channel, and
             * mirroring is the caller's job. Here the caller is this loop. */
            for (int i = 0; i < frames; i++) out_r[i] += wrote_right ? pool->mix_r[i] : pool->mix_l[i];
        }
        retire(pool, index, peak);
    }
    return rendered;
}
