#include "AmpDelayEngine.h"
#include "CostelloReverbEngine.h"
#include "IRConvolver.h"
#include "homecrate_ampParameterAddresses.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr int kIRPartitionSize = 512;
constexpr int kDelaySeamA = 0;
constexpr int kDelaySeamB = 1;
constexpr int kDelaySeamC = 2;
constexpr int kDelaySeamD = 3;

void clipInPlace(float* buf, int n) {
  for (int i = 0; i < n; ++i) {
    float s = buf[i];
    if (s > 1.0f) s = 1.0f;
    if (s < -1.0f) s = -1.0f;
    buf[i] = s;
  }
}

struct AmpFxInstance {
  CostelloReverbEngine reverb;
  AmpDelayEngine delay;
  std::unique_ptr<IRConvolver> convolver;

  double sampleRate = 48000.0;
  double hostBpm = 120.0;

  float reverbDecay = 0.5f;
  float reverbBlend = 0.0f;
  float reverbSize = 1.0f;
  float reverbPreDelay = 0.0f;
  float reverbTone = 0.7f;
  bool reverbPreAmp = false;
  bool irNormalize = true;
  float irNormScale = 1.0f;

  // Gated-reverb VCA (envelope-follower noise gate), pre-amp reverb only.
  // Matches homecrate_ampDSPKernel::computeReverbGateGains exactly.
  bool reverbGate = false;
  float gateEnv = 0.f;
  float gateGain = 0.f;
  bool gateOpen = false;
  std::vector<float> gateScratch;

  float delayTime = 350.0f;
  float delayFeedback = 0.35f;
  float delayTone = 0.7f;
  float delayMix = 0.0f;
  bool delaySync = false;
  int delayDivision = 1;
  bool delayPingPong = false;
  bool delayTape = false;
  bool delayDuck = false;
  int delayPlacement = 2;
  bool delayOscillate = false;

  bool reverbDirty = true;
  bool delayDirty = true;

  void setup(double sr) {
    sampleRate = sr;
    reverb.setup(sr);
    delay.init(sr);
    reverbDirty = true;
    delayDirty = true;
  }

  void refresh() {
    if (reverbDirty) {
      const float cutoff = 1500.0f * std::pow(9000.0f / 1500.0f, reverbTone);
      const float feedback = 0.70f + (reverbDecay * 0.27f);
      reverb.setFeedback(feedback);
      reverb.setCutoff(cutoff);
      reverb.setSize(reverbSize);
      reverb.setPreDelayMs(reverbPreDelay);
      reverb.setBlend(reverbBlend);
      reverbDirty = false;
    }
    if (delayDirty) {
      delay.setFeedback(delayFeedback);
      delay.setToneNorm(delayTone);
      delay.setMix(delayMix);
      delay.setPingPong(delayPingPong);
      delay.setTape(delayTape);
      delay.setDuck(delayDuck);
      if (!delaySync) delay.setTimeMs(delayTime);
      delayDirty = false;
    }
    if (delaySync) {
      if (hostBpm > 1.0) delay.updateFromBPM(hostBpm, delayDivision);
      else delay.setTimeMs(delayTime);
    }
    delay.setOscillate(delayOscillate);
  }

  int delaySeam() const {
    switch (delayPlacement) {
      case 0:
        return reverbPreAmp ? kDelaySeamA : kDelaySeamC;
      case 1:
        return reverbPreAmp ? kDelaySeamB : kDelaySeamD;
      default:
        return kDelaySeamD;
    }
  }

  // Envelope-follower noise gate keying the pre-amp reverb's wet output:
  // opens on the DRY signal's peak envelope, closes with hysteresis so it
  // doesn't chatter at the threshold. `dry` and `gains` may alias different
  // buffers; `gains[i]` is a 0..1 VCA multiplier, not applied here.
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

      if (gateOpen) { if (gateEnv < kCloseThresh) gateOpen = false; }
      else { if (gateEnv > kOpenThresh) gateOpen = true; }

      const float target = gateOpen ? 1.0f : 0.0f;
      gateGain += (target > gateGain ? gateAtk : gateRel) * (target - gateGain);
      gains[i] = gateGain;
    }
  }

  void processPre(float* buf, int n) {
    refresh();
    const bool reverbActive = reverbBlend > 0.001f;
    const bool delayActive = delayMix > 0.001f;
    const int seam = delaySeam();
    if (delayActive && seam == kDelaySeamA) {
      delay.processMono(buf, n);
      clipInPlace(buf, n);
    }
    if (reverbPreAmp && reverbActive) {
      if (reverbGate) {
        if (static_cast<int>(gateScratch.size()) < n) gateScratch.resize(n);
        computeReverbGateGains(buf, gateScratch.data(), n);
      }
      reverb.process(buf, n);
      if (reverbGate) {
        for (int i = 0; i < n; ++i) buf[i] *= gateScratch[i];
      }
      clipInPlace(buf, n);
    }
    if (delayActive && seam == kDelaySeamB) {
      delay.processMono(buf, n);
      clipInPlace(buf, n);
    }
  }

  void processPost(float* buf, int n) {
    refresh();
    if (convolver && convolver->isReady()) {
      convolver->process(buf, buf, n);
      if (irNormalize) {
        const float scale = irNormScale;
        for (int i = 0; i < n; ++i) buf[i] *= scale;
      }
    }
    const bool reverbActive = reverbBlend > 0.001f;
    const bool delayActive = delayMix > 0.001f;
    const int seam = delaySeam();
    if (delayActive && seam == kDelaySeamC) delay.processMono(buf, n);
    if (!reverbPreAmp && reverbActive) reverb.process(buf, n);
    if (delayActive && seam == kDelaySeamD) delay.processMono(buf, n);
  }
};

std::unordered_map<int, std::unique_ptr<AmpFxInstance>> gInstances;
int gNextId = 1;
std::string gLastError;

void setError(const std::string& message) { gLastError = message; }

AmpFxInstance* findInstance(int handle) {
  auto it = gInstances.find(handle);
  return it == gInstances.end() ? nullptr : it->second.get();
}

} // namespace

extern "C" {

const char* ampfx_last_error() { return gLastError.c_str(); }

int ampfx_create(double sample_rate) {
  try {
    gLastError.clear();
    if (sample_rate <= 0.0) {
      setError("ampfx_create: invalid sample_rate");
      return 0;
    }
    const int id = gNextId++;
    auto instance = std::make_unique<AmpFxInstance>();
    instance->setup(sample_rate);
    gInstances.emplace(id, std::move(instance));
    return id;
  } catch (const std::exception& error) {
    setError(error.what());
    return 0;
  }
}

void ampfx_destroy(int handle) { gInstances.erase(handle); }

void ampfx_set_param(int handle, int address, float value) {
  AmpFxInstance* instance = findInstance(handle);
  if (!instance) return;
  switch (static_cast<homecrate_ampParameterAddress>(address)) {
    case homecrate_ampParameterAddress::reverbDecay:
      instance->reverbDecay = value;
      instance->reverbDirty = true;
      break;
    case homecrate_ampParameterAddress::reverbBlend:
      instance->reverbBlend = value;
      instance->reverbDirty = true;
      break;
    case homecrate_ampParameterAddress::reverbSize:
      instance->reverbSize = value;
      instance->reverbDirty = true;
      break;
    case homecrate_ampParameterAddress::reverbPreDelay:
      instance->reverbPreDelay = value;
      instance->reverbDirty = true;
      break;
    case homecrate_ampParameterAddress::reverbTone:
      instance->reverbTone = value;
      instance->reverbDirty = true;
      break;
    case homecrate_ampParameterAddress::reverbPreAmp:
      instance->reverbPreAmp = value >= 0.5f;
      break;
    case homecrate_ampParameterAddress::irNormalize:
      instance->irNormalize = value >= 0.5f;
      break;
    case homecrate_ampParameterAddress::reverbGate: {
      const bool on = value >= 0.5f;
      if (on && !instance->reverbGate) {
        instance->gateEnv = 0.f;
        instance->gateGain = 0.f;
        instance->gateOpen = false;
      }
      instance->reverbGate = on;
      break;
    }
    case homecrate_ampParameterAddress::delayTime:
      instance->delayTime = value;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayFeedback:
      instance->delayFeedback = value;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayTone:
      instance->delayTone = value;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayMix:
      instance->delayMix = value;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delaySync:
      instance->delaySync = value >= 0.5f;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayDivision:
      instance->delayDivision = std::clamp(static_cast<int>(value + 0.5f), 0, 6);
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayPingPong:
      instance->delayPingPong = value >= 0.5f;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayTape:
      instance->delayTape = value >= 0.5f;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayDuck:
      instance->delayDuck = value >= 0.5f;
      instance->delayDirty = true;
      break;
    case homecrate_ampParameterAddress::delayPlacement:
      instance->delayPlacement = std::clamp(static_cast<int>(value + 0.5f), 0, 2);
      break;
    case homecrate_ampParameterAddress::delayOscillate:
      instance->delayOscillate = value >= 0.5f;
      break;
    default:
      break;
  }
}

void ampfx_set_host_bpm(int handle, double bpm) {
  AmpFxInstance* instance = findInstance(handle);
  if (instance) instance->hostBpm = bpm;
}

void ampfx_set_ir(int handle, const float* data, int count) {
  AmpFxInstance* instance = findInstance(handle);
  if (!instance || !data || count <= 0) return;
  double sumSq = 0.0;
  for (int i = 0; i < count; ++i) sumSq += static_cast<double>(data[i]) * static_cast<double>(data[i]);
  float normScale = 1.f;
  if (sumSq > 1e-12) normScale = static_cast<float>(std::sqrt(0.25 / sumSq));
  auto conv = std::make_unique<IRConvolver>();
  conv->setup(data, count, kIRPartitionSize);
  instance->convolver = std::move(conv);
  instance->irNormScale = normScale;
}

void ampfx_clear_ir(int handle) {
  AmpFxInstance* instance = findInstance(handle);
  if (instance) {
    instance->convolver.reset();
    instance->irNormScale = 1.f;
  }
}

int ampfx_latency_samples(int handle) {
  AmpFxInstance* instance = findInstance(handle);
  if (!instance || !instance->convolver || !instance->convolver->isReady()) return 0;
  return kIRPartitionSize;
}

void ampfx_process_pre(int handle, float* buf, int frames) {
  AmpFxInstance* instance = findInstance(handle);
  if (!instance || !buf || frames <= 0) return;
  instance->processPre(buf, frames);
}

void ampfx_process_post(int handle, float* buf, int frames) {
  AmpFxInstance* instance = findInstance(handle);
  if (!instance || !buf || frames <= 0) return;
  instance->processPost(buf, frames);
}

} // extern "C"
