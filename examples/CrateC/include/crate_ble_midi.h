/*
 * BLE MIDI packets to plain MIDI bytes.
 *
 * A BLE MIDI characteristic carries packets, not a byte stream: a header
 * byte, then each message preceded by a timestamp byte, with running status
 * allowed to drop both the status and its timestamp, and SysEx allowed to
 * span packets. Whatever sits on the radio side (the pedal as a peripheral
 * that homecrate connects to, or as a central subscribed to a keyboard),
 * the characteristic's value arrives here and comes out as the bytes a
 * 5-pin cable would have carried, ready for `crate_engine_midi`.
 *
 * Timestamps are dropped. A note is applied at the top of the next audio
 * block either way, which at 256 frames is finer than a BLE connection
 * interval.
 */
#ifndef CRATE_BLE_MIDI_H
#define CRATE_BLE_MIDI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Decodes one packet into `out`. Returns the number of bytes written, or -1
 * if the packet has no valid header (bit 7 set, bit 6 clear). Never writes
 * past `capacity`; a packet is at most an ATT MTU, so 512 is always enough. */
int crate_ble_midi_decode(const uint8_t *packet, int length, uint8_t *out, int capacity);

#ifdef __cplusplus
}
#endif

#endif
