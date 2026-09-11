#pragma once

#include <cstdint>

enum space_reverbParameterAddress : uint64_t {
    reverbDecay    = 0,
    reverbBlend    = 1,
    reverbSize     = 2,
    reverbPreDelay = 3,
    reverbTone     = 4,
    reverbGate     = 5,
};
