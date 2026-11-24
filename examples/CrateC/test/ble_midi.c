/*
 * The BLE MIDI decoder against the packet shapes the spec allows.
 */
#include <stdio.h>
#include <string.h>

#include "crate_ble_midi.h"

static int failures = 0;

static void expect(const char *name, const uint8_t *packet, int length, const uint8_t *want, int want_length) {
    uint8_t out[64];
    int n = crate_ble_midi_decode(packet, length, out, (int)sizeof out);
    int ok = n == want_length && (n <= 0 || memcmp(out, want, (size_t)n) == 0);
    printf("%s %s\n", ok ? "ok  " : "FAIL", name);
    if (!ok) {
        failures++;
        printf("     got %d:", n);
        for (int i = 0; i < n; i++) printf(" %02X", out[i]);
        printf("\n");
    }
}

int main(void) {
    /* Header 0x80 | ts_high, timestamp 0x80 | ts_low. */
    { const uint8_t p[] = { 0x80, 0x80, 0x90, 0x3C, 0x64 };
      const uint8_t w[] = { 0x90, 0x3C, 0x64 };
      expect("note on", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x80, 0x81, 0x90, 0x3C, 0x64, 0x82, 0x80, 0x3C, 0x00 };
      const uint8_t w[] = { 0x90, 0x3C, 0x64, 0x80, 0x3C, 0x00 };
      expect("two messages, each with a timestamp", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x80, 0x81, 0x90, 0x3C, 0x64, 0x82, 0x40, 0x64 };
      const uint8_t w[] = { 0x90, 0x3C, 0x64, 0x40, 0x64 };
      expect("running status with a timestamp", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x80, 0x81, 0x90, 0x3C, 0x64, 0x40, 0x64, 0x43, 0x64 };
      const uint8_t w[] = { 0x90, 0x3C, 0x64, 0x40, 0x64, 0x43, 0x64 };
      expect("running status without one", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x80, 0x81, 0xB0, 0x07, 0x7F, 0x82, 0xC0, 0x05 };
      const uint8_t w[] = { 0xB0, 0x07, 0x7F, 0xC0, 0x05 };
      expect("CC then a program change", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x80, 0x81, 0xF0, 0x7E, 0x7F, 0x83, 0xF8, 0x06, 0x01, 0x84, 0xF7 };
      const uint8_t w[] = { 0xF0, 0x7E, 0x7F, 0xF8, 0x06, 0x01, 0xF7 };
      expect("SysEx with a clock inside", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x80, 0x01, 0x02, 0x03, 0x85, 0xF7 };
      const uint8_t w[] = { 0x01, 0x02, 0x03, 0xF7 };
      expect("SysEx continued from the last packet", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x80, 0x81, 0xFA, 0x82, 0xF8, 0x83, 0xFC };
      const uint8_t w[] = { 0xFA, 0xF8, 0xFC };
      expect("realtime only: start, clock, stop", p, sizeof p, w, sizeof w); }

    { const uint8_t p[] = { 0x40, 0x81, 0x90, 0x3C, 0x64 };
      expect("refuses a packet with no header", p, sizeof p, NULL, -1); }

    printf("%s\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
}
