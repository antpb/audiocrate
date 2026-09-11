#include "CostelloReverbEngine.h"
#include "space_reverbParameterAddresses.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

struct SpaceReverbInstance {
  CostelloReverbEngine reverb;

  double sampleRate = 48000.0;

  float reverbDecay = 0.5f;
  float reverbBlend = 0.28f;
  float reverbSize = 1.0f;
  float reverbPreDelay = 0.0f;
  float reverbTone = 0.7f;
  bool reverbDirty = true;

  bool reverbGate = false;
  float gateEnv = 0.f;
  float gateGain = 0.f;
  bool gateOpen = false;
  std::vector<float> gateScratch;
  std::vector<float> dryScratch;

  void setup(double sr) {
    sampleRate = sr;
    reverb.setup(sr);
    reverbDirty = true;
  }

  void refresh() {
    if (!reverbDirty) return;
    const float cutoff = 1500.0f * std::pow(9000.0f / 1500.0f, reverbTone);
    const float feedback = 0.70f + (reverbDecay * 0.27f);
    reverb.setFeedback(feedback);
    reverb.setCutoff(cutoff);
    reverb.setSize(reverbSize);
    reverb.setPreDelayMs(reverbPreDelay);
    reverb.setBlend(reverbBlend);
    reverbDirty = false;
  }

  void computeReverbGateGains(const float* dry, float* gains, int n) {
    const double fs = sampleRate > 0.0 ? sampleRate : 48000.0;
    auto onePole = [fs](double seconds) -> float {
      const double t = seconds > 1e-6 ? seconds : 1e-6;
      return static_cast<float>(1.0 - std::exp(-1.0 / (t * fs)));
    };
    const float envRel = onePole(0.040);
    const float gateAtk = onePole(0.0015);
    const float gateRel = onePole(0.070);
    constexpr float kOpenThresh = 0.003f;
    constexpr float kCloseThresh = 0.0012f;

    for (int i = 0; i < n; ++i) {
      const float rect = std::fabs(dry[i]);
      if (rect > gateEnv) gateEnv = rect;
      else gateEnv += envRel * (rect - gateEnv);

      if (gateOpen) {
        if (gateEnv < kCloseThresh) gateOpen = false;
      } else {
        if (gateEnv > kOpenThresh) gateOpen = true;
      }

      const float target = gateOpen ? 1.0f : 0.0f;
      gateGain += (target > gateGain ? gateAtk : gateRel) * (target - gateGain);
      gains[i] = gateGain;
    }
  }

  void process(float* buf, int n) {
    refresh();
    if (reverbBlend <= 0.001f) return;
    if (reverbGate) {
      if (static_cast<int>(gateScratch.size()) < n) gateScratch.resize(n);
      if (static_cast<int>(dryScratch.size()) < n) dryScratch.resize(n);
      std::memcpy(dryScratch.data(), buf, static_cast<size_t>(n) * sizeof(float));
      computeReverbGateGains(buf, gateScratch.data(), n);
    }
    reverb.process(buf, n);
    if (reverbGate) {
      for (int i = 0; i < n; ++i) {
        const float mixed = buf[i];
        const float dry = dryScratch[i];
        buf[i] = dry + gateScratch[i] * (mixed - dry);
      }
    }
  }
};

std::unordered_map<int, std::unique_ptr<SpaceReverbInstance>> gInstances;
int gNextId = 1;
std::string gLastError;

void setError(const std::string& message) { gLastError = message; }

SpaceReverbInstance* findInstance(int handle) {
  auto it = gInstances.find(handle);
  return it == gInstances.end() ? nullptr : it->second.get();
}

} // namespace

extern "C" {

const char* spacereverb_last_error() { return gLastError.c_str(); }

int spacereverb_create(double sample_rate) {
  try {
    gLastError.clear();
    if (sample_rate <= 0.0) {
      setError("spacereverb_create: invalid sample_rate");
      return 0;
    }
    const int id = gNextId++;
    auto instance = std::make_unique<SpaceReverbInstance>();
    instance->setup(sample_rate);
    gInstances.emplace(id, std::move(instance));
    return id;
  } catch (const std::exception& error) {
    setError(error.what());
    return 0;
  }
}

void spacereverb_destroy(int handle) { gInstances.erase(handle); }

void spacereverb_set_param(int handle, int address, float value) {
  SpaceReverbInstance* instance = findInstance(handle);
  if (!instance) return;
  switch (static_cast<space_reverbParameterAddress>(address)) {
    case space_reverbParameterAddress::reverbDecay:
      instance->reverbDecay = value;
      instance->reverbDirty = true;
      break;
    case space_reverbParameterAddress::reverbBlend:
      instance->reverbBlend = value;
      instance->reverbDirty = true;
      break;
    case space_reverbParameterAddress::reverbSize:
      instance->reverbSize = value;
      instance->reverbDirty = true;
      break;
    case space_reverbParameterAddress::reverbPreDelay:
      instance->reverbPreDelay = value;
      instance->reverbDirty = true;
      break;
    case space_reverbParameterAddress::reverbTone:
      instance->reverbTone = value;
      instance->reverbDirty = true;
      break;
    case space_reverbParameterAddress::reverbGate: {
      const bool on = value >= 0.5f;
      if (on && !instance->reverbGate) {
        instance->gateEnv = 0.f;
        instance->gateGain = 0.f;
        instance->gateOpen = false;
      }
      instance->reverbGate = on;
      break;
    }
    default:
      break;
  }
}

void spacereverb_process(int handle, float* buf, int frames) {
  SpaceReverbInstance* instance = findInstance(handle);
  if (!instance || !buf || frames <= 0) return;
  instance->process(buf, frames);
}

} // extern "C"
