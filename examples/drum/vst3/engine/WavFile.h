//
//  WavFile.h — minimal RIFF/WAVE reader for IR cabinet loading.
//
//  Supports PCM 16/24/32-bit and IEEE float 32-bit, any channel count
//  (channels are averaged to mono — IR slots are mono, matching the AUv3).
//  Includes a linear resampler so IRs recorded at any rate can be matched
//  to the session sample rate.
//

#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace hcwav {

struct WavData {
    std::vector<float> samples;   // mono
    double sampleRate = 0;
    bool ok = false;
};

inline WavData load(const std::string& path) {
    WavData out;
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return out;

    auto rd32 = [&](uint32_t& v) { return std::fread(&v, 4, 1, f) == 1; };
    auto rd16 = [&](uint16_t& v) { return std::fread(&v, 2, 1, f) == 1; };

    uint32_t riff = 0, size = 0, wave = 0;
    if (!rd32(riff) || !rd32(size) || !rd32(wave) ||
        riff != 0x46464952u /*RIFF*/ || wave != 0x45564157u /*WAVE*/) {
        std::fclose(f);
        return out;
    }

    uint16_t fmt = 0, channels = 0, bits = 0;
    uint32_t rate = 0;
    std::vector<uint8_t> data;

    while (true) {
        uint32_t chunkId = 0, chunkSize = 0;
        if (!rd32(chunkId) || !rd32(chunkSize)) break;
        if (chunkId == 0x20746D66u /*fmt */) {
            uint16_t blockAlign; uint32_t byteRate;
            if (!rd16(fmt) || !rd16(channels) || !rd32(rate) ||
                !rd32(byteRate) || !rd16(blockAlign) || !rd16(bits)) break;
            long skip = static_cast<long>(chunkSize) - 16;
            if (skip > 0) std::fseek(f, skip, SEEK_CUR);
        } else if (chunkId == 0x61746164u /*data*/) {
            data.resize(chunkSize);
            if (std::fread(data.data(), 1, chunkSize, f) != chunkSize) { data.clear(); }
            break;
        } else {
            std::fseek(f, static_cast<long>(chunkSize + (chunkSize & 1)), SEEK_CUR);
        }
    }
    std::fclose(f);

    if (data.empty() || channels == 0 || rate == 0) return out;
    // WAVE_FORMAT_EXTENSIBLE (0xFFFE) wraps PCM/float; bit width disambiguates.
    const bool isFloat = (fmt == 3) || (fmt == 0xFFFE && bits == 32);
    const bool isPCM   = (fmt == 1) || (fmt == 0xFFFE);
    if (!isFloat && !isPCM) return out;

    const int bytesPer = bits / 8;
    if (bytesPer < 2 || bytesPer > 4) return out;
    const size_t frames = data.size() / (static_cast<size_t>(bytesPer) * channels);
    out.samples.resize(frames);

    const uint8_t* p = data.data();
    for (size_t i = 0; i < frames; ++i) {
        double acc = 0;
        for (int c = 0; c < channels; ++c) {
            const uint8_t* s = p + (i * channels + c) * bytesPer;
            double v = 0;
            if (isFloat && bits == 32) {
                float fv; std::memcpy(&fv, s, 4); v = fv;
            } else if (bits == 16) {
                int16_t iv; std::memcpy(&iv, s, 2); v = iv / 32768.0;
            } else if (bits == 24) {
                int32_t iv = (s[0] << 8) | (s[1] << 16) | (static_cast<int32_t>(static_cast<int8_t>(s[2])) << 24);
                v = (iv >> 8) / 8388608.0;
            } else if (bits == 32) {
                int32_t iv; std::memcpy(&iv, s, 4); v = iv / 2147483648.0;
            }
            acc += v;
        }
        out.samples[i] = static_cast<float>(acc / channels);
    }
    out.sampleRate = rate;
    out.ok = true;
    return out;
}

// Stereo variant for drum pad samples — keeps L/R separate (mono files are
// mirrored to both channels). Same format support as load().
struct WavDataStereo {
    std::vector<float> left, right;
    double sampleRate = 0;
    bool ok = false;
};

inline WavDataStereo loadStereo(const std::string& path) {
    WavDataStereo out;
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return out;

    auto rd32 = [&](uint32_t& v) { return std::fread(&v, 4, 1, f) == 1; };
    auto rd16 = [&](uint16_t& v) { return std::fread(&v, 2, 1, f) == 1; };

    uint32_t riff = 0, size = 0, wave = 0;
    if (!rd32(riff) || !rd32(size) || !rd32(wave) ||
        riff != 0x46464952u || wave != 0x45564157u) {
        std::fclose(f);
        return out;
    }

    uint16_t fmt = 0, channels = 0, bits = 0;
    uint32_t rate = 0;
    std::vector<uint8_t> data;

    while (true) {
        uint32_t chunkId = 0, chunkSize = 0;
        if (!rd32(chunkId) || !rd32(chunkSize)) break;
        if (chunkId == 0x20746D66u) {
            uint16_t blockAlign; uint32_t byteRate;
            if (!rd16(fmt) || !rd16(channels) || !rd32(rate) ||
                !rd32(byteRate) || !rd16(blockAlign) || !rd16(bits)) break;
            long skip = static_cast<long>(chunkSize) - 16;
            if (skip > 0) std::fseek(f, skip, SEEK_CUR);
        } else if (chunkId == 0x61746164u) {
            data.resize(chunkSize);
            if (std::fread(data.data(), 1, chunkSize, f) != chunkSize) { data.clear(); }
            break;
        } else {
            std::fseek(f, static_cast<long>(chunkSize + (chunkSize & 1)), SEEK_CUR);
        }
    }
    std::fclose(f);

    if (data.empty() || channels == 0 || rate == 0) return out;
    const bool isFloat = (fmt == 3) || (fmt == 0xFFFE && bits == 32);
    const bool isPCM   = (fmt == 1) || (fmt == 0xFFFE);
    if (!isFloat && !isPCM) return out;

    const int bytesPer = bits / 8;
    if (bytesPer < 2 || bytesPer > 4) return out;
    const size_t frames = data.size() / (static_cast<size_t>(bytesPer) * channels);
    out.left.resize(frames);
    out.right.resize(frames);

    const uint8_t* p = data.data();
    auto decode = [&](const uint8_t* s) -> float {
        double v = 0;
        if (isFloat && bits == 32) {
            float fv; std::memcpy(&fv, s, 4); v = fv;
        } else if (bits == 16) {
            int16_t iv; std::memcpy(&iv, s, 2); v = iv / 32768.0;
        } else if (bits == 24) {
            int32_t iv = (s[0] << 8) | (s[1] << 16) | (static_cast<int32_t>(static_cast<int8_t>(s[2])) << 24);
            v = (iv >> 8) / 8388608.0;
        } else if (bits == 32) {
            int32_t iv; std::memcpy(&iv, s, 4); v = iv / 2147483648.0;
        }
        return static_cast<float>(v);
    };
    for (size_t i = 0; i < frames; ++i) {
        const uint8_t* frame = p + i * channels * bytesPer;
        out.left[i] = decode(frame);
        out.right[i] = channels >= 2 ? decode(frame + bytesPer) : out.left[i];
    }
    out.sampleRate = rate;
    out.ok = true;
    return out;
}

inline void resampleChannel(std::vector<float>& samples, double srcRate, double targetRate) {
    if (samples.empty() || srcRate <= 0 || targetRate <= 0) return;
    if (std::abs(srcRate - targetRate) < 0.5) return;
    const double ratio = srcRate / targetRate;
    const size_t outLen = static_cast<size_t>(samples.size() / ratio);
    std::vector<float> outv(outLen);
    for (size_t i = 0; i < outLen; ++i) {
        const double srcPos = i * ratio;
        const size_t i0 = static_cast<size_t>(srcPos);
        const size_t i1 = std::min(i0 + 1, samples.size() - 1);
        const double frac = srcPos - i0;
        outv[i] = static_cast<float>(samples[i0] * (1.0 - frac) + samples[i1] * frac);
    }
    samples = std::move(outv);
}

inline void resampleStereo(WavDataStereo& w, double targetRate) {
    if (!w.ok) return;
    resampleChannel(w.left, w.sampleRate, targetRate);
    resampleChannel(w.right, w.sampleRate, targetRate);
    if (std::abs(w.sampleRate - targetRate) >= 0.5) w.sampleRate = targetRate;
}

// Linear resample to a target rate (no-op if rates already match).
inline void resample(WavData& w, double targetRate) {
    if (!w.ok || w.sampleRate <= 0 || targetRate <= 0) return;
    if (std::abs(w.sampleRate - targetRate) < 0.5) return;
    const double ratio = w.sampleRate / targetRate;
    const size_t outLen = static_cast<size_t>(w.samples.size() / ratio);
    std::vector<float> out(outLen);
    for (size_t i = 0; i < outLen; ++i) {
        const double srcPos = i * ratio;
        const size_t i0 = static_cast<size_t>(srcPos);
        const size_t i1 = std::min(i0 + 1, w.samples.size() - 1);
        const double frac = srcPos - i0;
        out[i] = static_cast<float>(w.samples[i0] * (1.0 - frac) + w.samples[i1] * frac);
    }
    w.samples = std::move(out);
    w.sampleRate = targetRate;
}

} // namespace hcwav
