#include "crate_engine.h"

#include "crate_ble_midi.h"

#include <math.h>
#include <string.h>

void crate_engine_default_config(crate_engine_config *config) {
    config->sample_rate = 44100;
    config->max_frames = 256;
    config->max_voices = 8;
    config->bpm = 120;
    /* Off, as the iOS instrument slot: an instrument plays its own sound. */
    config->dry_under_instruments = 0;
    config->mono_input = 0;
    config->output_safety = 1;
    /* -1 dBFS. */
    config->safety_threshold = 0.891f;
}

void crate_engine_set_dry_under_instruments(crate_engine *e, int on) { e->config.dry_under_instruments = on != 0; }
void crate_engine_set_output_safety(crate_engine *e, int on) { e->config.output_safety = on != 0; }

/* Identity up to t, then t + (1 - t) * tanh((|x| - t) / (1 - t)): continuous
 * in value and slope at the knee, and never past full scale. */
static inline float safety_sample(float x, float t) {
    float a = x < 0 ? -x : x;
    if (a <= t) return x;
    if (a != a) return 0; /* NaN */
    float k = 1.0f - t;
    float y = t + k * tanhf((a - t) / k);
    return x < 0 ? -y : y;
}

static void output_safety(const crate_engine *e, float *buf, int frames) {
    float t = e->config.safety_threshold;
    if (!(t > 0 && t < 1)) t = 0.891f;
    for (int i = 0; i < frames; i++) buf[i] = safety_sample(buf[i], t);
}

static const char *pack_string(const crate_engine *e, uint32_t off) {
    return (const char *)(e->pack + e->h->strings_off + off);
}

int crate_engine_init(crate_engine *e, const crate_engine_config *config,
                      const void *pack, size_t pack_size, void *arena, size_t arena_bytes) {
    memset(e, 0, sizeof *e);
    e->config = *config;
    if (e->config.max_frames < 1) e->config.max_frames = 1;
    if (e->config.max_voices < 1) e->config.max_voices = 1;
    if (e->config.max_voices > CRATE_MAX_VOICES) e->config.max_voices = CRATE_MAX_VOICES;
    e->current = -1;
    e->requested = -1;
    e->arena_memory = (uint8_t *)arena;
    e->arena_bytes = arena_bytes;
    crate_transport_default(&e->transport);
    e->transport.playing = 1;
    crate_engine_set_bpm(e, config->bpm);

    const crate_pack_header *h = (const crate_pack_header *)pack;
    if (!pack || pack_size < sizeof *h || h->magic != CRATE_PACK_MAGIC || h->version != CRATE_PACK_VERSION ||
        h->size > pack_size || h->entries_off + (size_t)h->count * sizeof(crate_pack_entry) > h->size) {
        return CRATE_ENGINE_BAD_PACK;
    }
    e->pack = (const uint8_t *)pack;
    e->h = h;
    e->entries = (const crate_pack_entry *)(e->pack + h->entries_off);
    return CRATE_ENGINE_OK;
}

int crate_engine_count(const crate_engine *e) { return e->h ? e->h->count : 0; }

const char *crate_engine_name(const crate_engine *e, int i) {
    return i >= 0 && i < crate_engine_count(e) ? pack_string(e, e->entries[i].name_off) : NULL;
}

const char *crate_engine_id(const crate_engine *e, int i) {
    return i >= 0 && i < crate_engine_count(e) ? pack_string(e, e->entries[i].id_off) : NULL;
}

const char *crate_engine_category(const crate_engine *e, int i) {
    return i >= 0 && i < crate_engine_count(e) ? pack_string(e, e->entries[i].category_off) : NULL;
}

int crate_engine_role(const crate_engine *e, int i) {
    return i >= 0 && i < crate_engine_count(e) ? e->entries[i].role : -1;
}

int crate_engine_slot(const crate_engine *e, int i) {
    return i >= 0 && i < crate_engine_count(e) ? e->entries[i].slot : -1;
}

int crate_engine_available(const crate_engine *e, int i) {
    if (i < 0 || i >= crate_engine_count(e)) return 0;
    /* The pack's verdict, and this device's own arena, which may be smaller
     * than the budget the pack was built for. */
    return (e->entries[i].flags & CRATE_PACK_AVAILABLE) && e->entries[i].arena_bytes <= e->arena_bytes;
}

int crate_engine_category_count(const crate_engine *e) { return e->h ? e->h->category_count : 0; }

const char *crate_engine_category_at(const crate_engine *e, int i) {
    if (i < 0 || i >= crate_engine_category_count(e)) return NULL;
    const uint32_t *offs = (const uint32_t *)(e->pack + e->h->categories_off);
    return pack_string(e, offs[i]);
}

void crate_engine_request(crate_engine *e, int index) { e->requested = index; }

void crate_engine_set_bpm(crate_engine *e, double bpm) {
    /* Delay lines in the pack were sized for this range; a tempo outside it
     * would ask a synced delay for more line than it has. */
    double lo = e->h && e->h->bpm_min ? e->h->bpm_min : 20;
    double hi = e->h && e->h->bpm_max ? e->h->bpm_max : 999;
    if (!(bpm >= lo)) bpm = lo;
    if (bpm > hi) bpm = hi;
    e->transport.bpm = bpm;
}

static void unload(crate_engine *e) {
    e->current = -1;
    e->role = CRATE_ROLE_INSERT;
    for (int k = 0; k < 128; k++) {
        e->cc_voice[k] = -1;
        e->cc_bus[k] = -1;
        e->cc_entry[k] = -1;
    }
}

int crate_engine_load(crate_engine *e, int index) {
    unload(e);
    if (index < 0 || index >= crate_engine_count(e)) return e->load_error = CRATE_ENGINE_NO_SUCH_PATCH;
    if (!crate_engine_available(e, index)) return e->load_error = CRATE_ENGINE_UNAVAILABLE;
    const crate_pack_entry *entry = &e->entries[index];
    if (crate_plan_open(&e->plan, e->pack + entry->plan_off, entry->plan_size) != 0) {
        return e->load_error = CRATE_ENGINE_BAD_PLAN;
    }

    /* The whole previous patch goes with the arena, in one store. */
    crate_arena_init(&e->arena, e->arena_memory, e->arena_bytes);
    e->scratch_r = (float *)crate_arena_alloc(&e->arena, sizeof(float) * (size_t)e->config.max_frames);
    if (!e->scratch_r) return e->load_error = CRATE_ENGINE_OUT_OF_MEMORY;

    const crate_pack_param *params = (const crate_pack_param *)(e->pack + entry->params_off);
    e->seed += 1;
    e->role = entry->role;
    if (entry->role == CRATE_ROLE_INSTRUMENT) {
        int polyphony = entry->polyphony ? entry->polyphony : 8;
        if (polyphony > e->config.max_voices) polyphony = e->config.max_voices;
        if (crate_pool_init(&e->pool, &e->plan, &e->arena, polyphony, e->seed, e->config.max_frames) != 0 ||
            crate_pool_prepare(&e->pool, e->config.sample_rate) != 0) {
            return e->load_error = CRATE_ENGINE_OUT_OF_MEMORY;
        }
        for (int p = 0; p < entry->param_count; p++) {
            crate_pool_set_param(&e->pool, pack_string(e, params[p].name_off), params[p].def);
        }
    } else {
        int lanes = e->plan.stereo && !(e->config.mono_input && e->plan.mirrors_mono_input) ? 2 : 1;
        if (crate_state_init(&e->state, &e->plan, &e->arena, e->seed) != 0 ||
            crate_state_prepare_lanes(&e->state, e->config.sample_rate, lanes) != 0) {
            return e->load_error = CRATE_ENGINE_OUT_OF_MEMORY;
        }
        for (int p = 0; p < entry->param_count; p++) {
            crate_set_param(&e->state, pack_string(e, params[p].name_off), params[p].def);
        }
        /* An effect has no notes, so its gate is simply open. */
        e->state.gate = 1;
    }

    /* CC n moves the param whose address is n. Resolved now, so a CC on the
     * render thread is three array reads. */
    for (int p = 0; p < entry->param_count; p++) {
        int address = params[p].address;
        if (address >= 128) continue;
        const char *name = pack_string(e, params[p].name_off);
        e->cc_entry[address] = (int16_t)p;
        e->cc_voice[address] = (int16_t)crate_plan_param_index(&e->plan, name);
        if (entry->role == CRATE_ROLE_INSTRUMENT && e->pool.has_bus) {
            e->cc_bus[address] = (int16_t)crate_plan_param_index(&e->pool.bus_plan, name);
        }
    }
    e->current = index;
    e->load_error = CRATE_ENGINE_OK;
    return CRATE_ENGINE_OK;
}

int crate_engine_midi(crate_engine *e, int source, const uint8_t *bytes, int count) {
    if (source < 0 || source >= CRATE_MIDI_SOURCES) return 0;
    crate_midi_ring *r = &e->rings[source];
    int queued = 0;
    for (int i = 0; i < count; i++) {
        uint16_t head = r->head;
        uint16_t next = (uint16_t)((head + 1) & (CRATE_MIDI_RING - 1));
        if (next == r->tail) break;
        r->data[head] = bytes[i];
        r->head = next;
        queued++;
    }
    return queued;
}

int crate_engine_ble_midi(crate_engine *e, const uint8_t *packet, int length) {
    uint8_t bytes[512];
    int n = crate_ble_midi_decode(packet, length, bytes, (int)sizeof bytes);
    if (n < 0) return -1;
    return crate_engine_midi(e, CRATE_MIDI_BLE, bytes, n);
}

static void apply_message(crate_engine *e, uint8_t status, uint8_t d1, uint8_t d2) {
    if (e->current < 0) return;
    int instrument = e->role == CRATE_ROLE_INSTRUMENT;
    switch (status & 0xF0) {
    case 0x90:
        if (d2 > 0) {
            if (instrument) crate_pool_note_on(&e->pool, d1, (double)d2 / 127.0);
            break;
        }
        /* A zero-velocity note on is a note off. */
        /* fall through */
    case 0x80:
        if (instrument) crate_pool_note_off(&e->pool, d1);
        break;
    case 0xB0: {
        if ((d1 == 120 || d1 == 123) && instrument) crate_pool_all_notes_off(&e->pool);
        int p = e->cc_entry[d1];
        if (p < 0) break;
        const crate_pack_param *params = (const crate_pack_param *)(e->pack + e->entries[e->current].params_off);
        double t = (double)d2 / 127.0;
        double value = params[p].min + t * (params[p].max - params[p].min);
        if (instrument) crate_pool_glide_param_index(&e->pool, e->cc_voice[d1], e->cc_bus[d1], value);
        else crate_glide_param_index(&e->state, e->cc_voice[d1], value);
        break;
    }
    default:
        break;
    }
}

static void apply_realtime(crate_engine *e, uint8_t byte) {
    switch (byte) {
    case 0xFA: /* Start: the song from the top */
        e->transport.beats = 0;
        e->transport.playing = 1;
        break;
    case 0xFB: /* Continue */
        e->transport.playing = 1;
        break;
    case 0xFC: /* Stop: the transport holds, and nothing is left sounding */
        e->transport.playing = 0;
        if (e->current >= 0 && e->role == CRATE_ROLE_INSTRUMENT) crate_pool_all_notes_off(&e->pool);
        break;
    case 0xFF: /* System reset */
        if (e->current >= 0 && e->role == CRATE_ROLE_INSTRUMENT) crate_pool_all_notes_off(&e->pool);
        break;
    default:
        break;
    }
}

/* Channel voice messages out of a byte stream: running status, realtime
 * bytes anywhere, SysEx skipped whole. Messages on every channel are taken,
 * as the AU takes them; channel filtering is a host choice made upstream. */
static void parse_byte(crate_engine *e, crate_midi_parser *p, uint8_t b) {
    if (b >= 0xF8) {
        apply_realtime(e, b);
        return;
    }
    if (b == 0xF0) {
        p->in_sysex = 1;
        p->status = 0;
        return;
    }
    if (b == 0xF7) {
        p->in_sysex = 0;
        return;
    }
    if (b & 0x80) {
        p->in_sysex = 0;
        /* System common cancels running status and carries nothing here. */
        p->status = b < 0xF0 ? b : 0;
        p->count = 0;
        return;
    }
    if (p->in_sysex || !p->status) return;
    p->data[p->count++] = b;
    uint8_t kind = p->status & 0xF0;
    int needed = (kind == 0xC0 || kind == 0xD0) ? 1 : 2;
    if (p->count < needed) return;
    apply_message(e, p->status, p->data[0], needed > 1 ? p->data[1] : 0);
    p->count = 0;
}

static void drain_midi(crate_engine *e) {
    for (int s = 0; s < CRATE_MIDI_SOURCES; s++) {
        crate_midi_ring *r = &e->rings[s];
        while (r->tail != r->head) {
            uint16_t tail = r->tail;
            uint8_t b = r->data[tail];
            r->tail = (uint16_t)((tail + 1) & (CRATE_MIDI_RING - 1));
            parse_byte(e, &e->parsers[s], b);
        }
    }
}

static void render_chunk(crate_engine *e, const float *in_l, const float *in_r,
                         float *out_l, float *out_r, int frames) {
    double sr = e->config.sample_rate;
    float *right = out_r ? out_r : e->scratch_r;
    if (e->current < 0) {
        /* Nothing loaded: a wire, so the pedal is never a mute switch. */
        memcpy(out_l, in_l, sizeof(float) * (size_t)frames);
        if (out_r) memcpy(out_r, in_r ? in_r : in_l, sizeof(float) * (size_t)frames);
        return;
    }
    if (e->role == CRATE_ROLE_INSTRUMENT) {
        crate_pool_render(&e->pool, sr, frames, out_l, out_r, &e->transport);
        if (e->config.dry_under_instruments) {
            for (int i = 0; i < frames; i++) out_l[i] += in_l[i];
            if (out_r) for (int i = 0; i < frames; i++) out_r[i] += in_r ? in_r[i] : in_l[i];
        }
    } else {
        int wrote = crate_render(&e->state, sr, frames, out_l, right, in_l, in_r, &e->transport, NULL, NULL);
        if (out_r && !wrote) memcpy(out_r, out_l, sizeof(float) * (size_t)frames);
    }
    if (e->config.output_safety) {
        output_safety(e, out_l, frames);
        if (out_r) output_safety(e, out_r, frames);
    }
    if (e->transport.playing) e->transport.beats += (double)frames * e->transport.bpm / 60.0 / sr;
}

void crate_engine_process(crate_engine *e, const float *in_l, const float *in_r,
                          float *out_l, float *out_r, int frames) {
    int requested = e->requested;
    if (requested >= 0) {
        e->requested = -1;
        crate_engine_load(e, requested);
        /* A patch change costs one block of silence rather than a click: the
         * old patch's tail and the new one's first sample are not continuous. */
        memset(out_l, 0, sizeof(float) * (size_t)frames);
        if (out_r) memset(out_r, 0, sizeof(float) * (size_t)frames);
        return;
    }
    drain_midi(e);
    int done = 0;
    while (done < frames) {
        int n = frames - done;
        if (n > e->config.max_frames) n = e->config.max_frames;
        render_chunk(e, in_l + done, in_r ? in_r + done : NULL, out_l + done, out_r ? out_r + done : NULL, n);
        done += n;
    }
}
