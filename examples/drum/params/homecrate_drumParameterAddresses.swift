//
//  homecrate_drumParameterAddresses.swift
//  homecrate drum
//

import AudioToolbox

enum homecrate_drumParameterAddress: AUParameterAddress {
    case pad0Vol  = 0
    case pad1Vol  = 1
    case pad2Vol  = 2
    case pad3Vol  = 3
    case pad4Vol  = 4
    case pad5Vol  = 5
    case pad6Vol  = 6
    case pad7Vol  = 7
    case pad8Vol  = 8
    case pad9Vol  = 9
    case pad10Vol = 10
    case pad11Vol = 11
    case pad12Vol = 12
    case pad13Vol = 13
    case pad14Vol = 14
    case pad15Vol = 15

    case pad0Pitch  = 16
    case pad1Pitch  = 17
    case pad2Pitch  = 18
    case pad3Pitch  = 19
    case pad4Pitch  = 20
    case pad5Pitch  = 21
    case pad6Pitch  = 22
    case pad7Pitch  = 23
    case pad8Pitch  = 24
    case pad9Pitch  = 25
    case pad10Pitch = 26
    case pad11Pitch = 27
    case pad12Pitch = 28
    case pad13Pitch = 29
    case pad14Pitch = 30
    case pad15Pitch = 31

    // ── 026S character — per-pad sample-rate reduction (0..1, 1 = native) ──
    case pad0SRate  = 32
    case pad1SRate  = 33
    case pad2SRate  = 34
    case pad3SRate  = 35
    case pad4SRate  = 36
    case pad5SRate  = 37
    case pad6SRate  = 38
    case pad7SRate  = 39
    case pad8SRate  = 40
    case pad9SRate  = 41
    case pad10SRate = 42
    case pad11SRate = 43
    case pad12SRate = 44
    case pad13SRate = 45
    case pad14SRate = 46
    case pad15SRate = 47

    // ── Per-pad bit depth (1..16, 16 = clean) ──
    case pad0Bits  = 48
    case pad1Bits  = 49
    case pad2Bits  = 50
    case pad3Bits  = 51
    case pad4Bits  = 52
    case pad5Bits  = 53
    case pad6Bits  = 54
    case pad7Bits  = 55
    case pad8Bits  = 56
    case pad9Bits  = 57
    case pad10Bits = 58
    case pad11Bits = 59
    case pad12Bits = 60
    case pad13Bits = 61
    case pad14Bits = 62
    case pad15Bits = 63

    // ── Per-pad low-pass filter cutoff (20..20000 Hz) ──
    case pad0Cut  = 64
    case pad1Cut  = 65
    case pad2Cut  = 66
    case pad3Cut  = 67
    case pad4Cut  = 68
    case pad5Cut  = 69
    case pad6Cut  = 70
    case pad7Cut  = 71
    case pad8Cut  = 72
    case pad9Cut  = 73
    case pad10Cut = 74
    case pad11Cut = 75
    case pad12Cut = 76
    case pad13Cut = 77
    case pad14Cut = 78
    case pad15Cut = 79

    // ── Per-pad filter resonance (0..1) ──
    case pad0Res  = 80
    case pad1Res  = 81
    case pad2Res  = 82
    case pad3Res  = 83
    case pad4Res  = 84
    case pad5Res  = 85
    case pad6Res  = 86
    case pad7Res  = 87
    case pad8Res  = 88
    case pad9Res  = 89
    case pad10Res = 90
    case pad11Res = 91
    case pad12Res = 92
    case pad13Res = 93
    case pad14Res = 94
    case pad15Res = 95

    // ── Master bus ──
    case masterCut          = 96   // 20..20000 Hz
    case masterRes          = 97   // 0..1
    case masterIRMix        = 98   // 0..1
    case masterBypassPadDSP = 99   // 0/1 boolean (treated as >= 0.5)
    case masterVol          = 100  // 0..1 linear output gain

    // ── Per-pad time stretch enable (0/1) ──
    case pad0StretchOn  = 101
    case pad1StretchOn  = 102
    case pad2StretchOn  = 103
    case pad3StretchOn  = 104
    case pad4StretchOn  = 105
    case pad5StretchOn  = 106
    case pad6StretchOn  = 107
    case pad7StretchOn  = 108
    case pad8StretchOn  = 109
    case pad9StretchOn  = 110
    case pad10StretchOn = 111
    case pad11StretchOn = 112
    case pad12StretchOn = 113
    case pad13StretchOn = 114
    case pad14StretchOn = 115
    case pad15StretchOn = 116

    // ── Per-pad time stretch amount (0.5..2.0, 1.0 = unity) ──
    case pad0StretchAmt  = 117
    case pad1StretchAmt  = 118
    case pad2StretchAmt  = 119
    case pad3StretchAmt  = 120
    case pad4StretchAmt  = 121
    case pad5StretchAmt  = 122
    case pad6StretchAmt  = 123
    case pad7StretchAmt  = 124
    case pad8StretchAmt  = 125
    case pad9StretchAmt  = 126
    case pad10StretchAmt = 127
    case pad11StretchAmt = 128
    case pad12StretchAmt = 129
    case pad13StretchAmt = 130
    case pad14StretchAmt = 131
    case pad15StretchAmt = 132

    // ── Sample record (host-driven capture flow) ──
    // Mode: 0 = off, 1 = threshold/monitor, 2 = armed, 3 = recording,
    //       4 = sampleEdit. State transitions are observable by the
    //       host (RecorderPluginModule's SampleRecordCoordinator).
    case sampleRecordMode      = 133
    case sampleRecordLevel     = 134  // host writes peak/RMS 0..1 ~30 Hz
    case sampleRecordThreshold = 135  // user-controlled 0..1, starts at 1.0

    // ── Per-pad "Character" velocity variance (-1..1, 0 = off) ──
    // Bipolar humanize: sign = direction (− softer / + louder), magnitude =
    // amount + likelihood. Applied to incoming MIDI velocity in Swift at
    // note-on via a smoothed random walk; NOT a DSP-kernel parameter.
    case pad0Character  = 136
    case pad1Character  = 137
    case pad2Character  = 138
    case pad3Character  = 139
    case pad4Character  = 140
    case pad5Character  = 141
    case pad6Character  = 142
    case pad7Character  = 143
    case pad8Character  = 144
    case pad9Character  = 145
    case pad10Character = 146
    case pad11Character = 147
    case pad12Character = 148
    case pad13Character = 149
    case pad14Character = 150
    case pad15Character = 151

    // ── Per-pad "Pan" stereo position (-1..1, 0 = center) ──
    // Equal-power L/R gain applied in Swift at the per-pad mix-add stage
    // (before the master filter + IR, which are already stereo); NOT a
    // DSP-kernel parameter.
    case pad0Pan  = 152
    case pad1Pan  = 153
    case pad2Pan  = 154
    case pad3Pan  = 155
    case pad4Pan  = 156
    case pad5Pan  = 157
    case pad6Pan  = 158
    case pad7Pan  = 159
    case pad8Pan  = 160
    case pad9Pan  = 161
    case pad10Pan = 162
    case pad11Pan = 163
    case pad12Pan = 164
    case pad13Pan = 165
    case pad14Pan = 166
    case pad15Pan = 167

    // ── Per-pad NON-DESTRUCTIVE sample start (0..1 fraction of buffer) ──
    // Applied in the Swift voice at trigger/render; the file on disk is
    // untouched (unlike the destructive post-record trim). 0 = play from head.
    case pad0SampleStart  = 168
    case pad1SampleStart  = 169
    case pad2SampleStart  = 170
    case pad3SampleStart  = 171
    case pad4SampleStart  = 172
    case pad5SampleStart  = 173
    case pad6SampleStart  = 174
    case pad7SampleStart  = 175
    case pad8SampleStart  = 176
    case pad9SampleStart  = 177
    case pad10SampleStart = 178
    case pad11SampleStart = 179
    case pad12SampleStart = 180
    case pad13SampleStart = 181
    case pad14SampleStart = 182
    case pad15SampleStart = 183

    // ── Per-pad sample stop (0..1 fraction of buffer, 1 = play to end) ──
    case pad0SampleStop  = 184
    case pad1SampleStop  = 185
    case pad2SampleStop  = 186
    case pad3SampleStop  = 187
    case pad4SampleStop  = 188
    case pad5SampleStop  = 189
    case pad6SampleStop  = 190
    case pad7SampleStop  = 191
    case pad8SampleStop  = 192
    case pad9SampleStop  = 193
    case pad10SampleStop = 194
    case pad11SampleStop = 195
    case pad12SampleStop = 196
    case pad13SampleStop = 197
    case pad14SampleStop = 198
    case pad15SampleStop = 199

    // ── Per-pad sample fade-in (0..2000 ms from the start point) ──
    case pad0SampleFadeIn  = 200
    case pad1SampleFadeIn  = 201
    case pad2SampleFadeIn  = 202
    case pad3SampleFadeIn  = 203
    case pad4SampleFadeIn  = 204
    case pad5SampleFadeIn  = 205
    case pad6SampleFadeIn  = 206
    case pad7SampleFadeIn  = 207
    case pad8SampleFadeIn  = 208
    case pad9SampleFadeIn  = 209
    case pad10SampleFadeIn = 210
    case pad11SampleFadeIn = 211
    case pad12SampleFadeIn = 212
    case pad13SampleFadeIn = 213
    case pad14SampleFadeIn = 214
    case pad15SampleFadeIn = 215

    // ── Per-pad sample fade-out (0..2000 ms ending at the stop point) ──
    case pad0SampleFadeOut  = 216
    case pad1SampleFadeOut  = 217
    case pad2SampleFadeOut  = 218
    case pad3SampleFadeOut  = 219
    case pad4SampleFadeOut  = 220
    case pad5SampleFadeOut  = 221
    case pad6SampleFadeOut  = 222
    case pad7SampleFadeOut  = 223
    case pad8SampleFadeOut  = 224
    case pad9SampleFadeOut  = 225
    case pad10SampleFadeOut = 226
    case pad11SampleFadeOut = 227
    case pad12SampleFadeOut = 228
    case pad13SampleFadeOut = 229
    case pad14SampleFadeOut = 230
    case pad15SampleFadeOut = 231

    // ── Global "Humanize" groove amount (0..1, 0 = off / dead-quantized) ──
    // One knob that loosens the machine feel: adds swing + micro-timing to
    // both trigger sources (internal sequencer + host MIDI) plus a symmetric
    // random velocity spread on every hit. Applied entirely in Swift (timing
    // in the sequencer / render-block pending-trigger queue, velocity in
    // `applyCharacter`); NOT a DSP-kernel parameter.
    case masterHumanize = 232

    // ── Per-pad "Humanize exempt" (0/1, 1 = pad ignores the global Humanize) ──
    // Keeps a pad dead-on the grid and at exact velocity while the rest of the
    // kit grooves (e.g. tight kick, swung hats). Skips only the GLOBAL Humanize
    // terms — the pad's own Character velocity knob still applies. Swift-side.
    case pad0HumanizeExempt  = 233
    case pad1HumanizeExempt  = 234
    case pad2HumanizeExempt  = 235
    case pad3HumanizeExempt  = 236
    case pad4HumanizeExempt  = 237
    case pad5HumanizeExempt  = 238
    case pad6HumanizeExempt  = 239
    case pad7HumanizeExempt  = 240
    case pad8HumanizeExempt  = 241
    case pad9HumanizeExempt  = 242
    case pad10HumanizeExempt = 243
    case pad11HumanizeExempt = 244
    case pad12HumanizeExempt = 245
    case pad13HumanizeExempt = 246
    case pad14HumanizeExempt = 247
    case pad15HumanizeExempt = 248
}
