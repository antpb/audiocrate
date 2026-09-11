#include "NAM/dsp.h"
#include "NAM/get_dsp.h"
#if defined(NAM_ENABLE_A2_FAST)
#include "NAM/wavenet/a2_fast.h"
#endif
#include "json.hpp"

#include <exception>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

struct NamInstance {
  std::unique_ptr<nam::DSP> dsp;
  std::vector<NAM_SAMPLE> inBuf;
  std::vector<NAM_SAMPLE> outBuf;
  std::string architecture;
  bool a2Fast = false;
  int a2Channels = 0;
};

std::unordered_map<int, NamInstance> gInstances;
int gNextId = 1;
std::string gLastError;

void setError(const std::string& message) { gLastError = message; }

NamInstance* findInstance(int handle) {
  auto it = gInstances.find(handle);
  return it == gInstances.end() ? nullptr : &it->second;
}

} // namespace

extern "C" {

const char* nam_last_error() { return gLastError.c_str(); }

int nam_create(const char* json, double sample_rate, int max_frames) {
  try {
    gLastError.clear();
    if (!json || max_frames < 1 || sample_rate <= 0.0) {
      setError("nam_create: invalid json, sample_rate, or max_frames");
      return 0;
    }
    const nlohmann::json config = nlohmann::json::parse(json);
    auto dsp = nam::get_dsp(config);
    if (!dsp) {
      setError("get_dsp returned null (architecture parser missing? WHOLE_ARCHIVE)");
      return 0;
    }
    dsp->ResetAndPrewarm(sample_rate, max_frames);
    const int id = gNextId++;
    NamInstance instance;
    instance.dsp = std::move(dsp);
    instance.inBuf.resize(static_cast<size_t>(max_frames));
    instance.outBuf.resize(static_cast<size_t>(max_frames));
    instance.architecture = config.value("architecture", std::string{});
#if defined(NAM_ENABLE_A2_FAST)
    if (instance.architecture == "WaveNet" && config.contains("config")) {
      instance.a2Fast = nam::wavenet::a2_fast::is_a2_shape(config["config"], &instance.a2Channels);
    }
#endif
    gInstances.emplace(id, std::move(instance));
    return id;
  } catch (const std::exception& error) {
    setError(error.what());
    return 0;
  }
}

void nam_destroy(int handle) { gInstances.erase(handle); }

void nam_process(int handle, const float* input, float* output, int frames) {
  NamInstance* instance = findInstance(handle);
  if (!instance || !input || !output || frames <= 0) {
    return;
  }
  if (static_cast<int>(instance->inBuf.size()) < frames) {
    instance->inBuf.resize(static_cast<size_t>(frames));
    instance->outBuf.resize(static_cast<size_t>(frames));
  }
  for (int i = 0; i < frames; ++i) {
    instance->inBuf[static_cast<size_t>(i)] = static_cast<NAM_SAMPLE>(input[i]);
  }
  NAM_SAMPLE* inPtr = instance->inBuf.data();
  NAM_SAMPLE* outPtr = instance->outBuf.data();
  instance->dsp->process(&inPtr, &outPtr, frames);
  for (int i = 0; i < frames; ++i) {
    output[i] = static_cast<float>(instance->outBuf[static_cast<size_t>(i)]);
  }
}

int nam_has_loudness(int handle) {
  NamInstance* instance = findInstance(handle);
  return instance && instance->dsp->HasLoudness() ? 1 : 0;
}

float nam_get_loudness(int handle) {
  NamInstance* instance = findInstance(handle);
  if (!instance || !instance->dsp->HasLoudness()) {
    return 0.f;
  }
  return static_cast<float>(instance->dsp->GetLoudness());
}

int nam_has_input_level(int handle) {
  NamInstance* instance = findInstance(handle);
  return instance && instance->dsp->HasInputLevel() ? 1 : 0;
}

float nam_get_input_level(int handle) {
  NamInstance* instance = findInstance(handle);
  if (!instance || !instance->dsp->HasInputLevel()) {
    return 0.f;
  }
  return static_cast<float>(instance->dsp->GetInputLevel());
}

const char* nam_architecture(int handle) {
  NamInstance* instance = findInstance(handle);
  return instance ? instance->architecture.c_str() : "";
}

int nam_is_a2_fast(int handle) {
  NamInstance* instance = findInstance(handle);
  return instance && instance->a2Fast ? 1 : 0;
}

int nam_a2_channels(int handle) {
  NamInstance* instance = findInstance(handle);
  return instance ? instance->a2Channels : 0;
}

} // extern "C"
