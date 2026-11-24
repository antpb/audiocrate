#include "crate_ble_midi.h"

/*
 * After the header, bytes with bit 7 set alternate between a timestamp and
 * a status: a timestamp always comes first, and a status is always followed
 * by data or by the next timestamp. So a bit-7 byte is a timestamp exactly
 * when the byte before it was not one. That one rule covers every shape the
 * spec allows:
 *
 *   ts status data...            a message
 *   ts data...                   running status with its timestamp
 *   data...                      running status without one
 *   ts F0 data... ts F7          SysEx, with ts F8 (realtime) anywhere inside
 *   data... ts F7                SysEx continued from the previous packet
 */
int crate_ble_midi_decode(const uint8_t *packet, int length, uint8_t *out, int capacity) {
    if (length < 1 || (packet[0] & 0xC0) != 0x80) return -1;
    int written = 0;
    int expect_timestamp = 1;
    for (int i = 1; i < length; i++) {
        uint8_t b = packet[i];
        if ((b & 0x80) && expect_timestamp) {
            expect_timestamp = 0;
            continue;
        }
        if (written < capacity) out[written++] = b;
        expect_timestamp = 1;
    }
    return written;
}
