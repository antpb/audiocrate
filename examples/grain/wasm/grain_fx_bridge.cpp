#include "homecrate_grainDSPKernel.h"

#include <exception>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr int kMaxFrames = 4096;

struct GrainFxInstance {
  homecrate_grainDSPKernel kernel;
  std::vector<const float*> inPtrs{2, nullptr};
  std::vector<float*> outPtrs{2, nullptr};
  double sampleRate = 48000.0;
  bool ready = false;

  void setup(double sr) {
    sampleRate = sr;
    kernel.setMaximumFramesToRender(kMaxFrames);
    kernel.initialize(2, 2, sr);
    ready = true;
  }
};

std::unordered_map<int, std::unique_ptr<GrainFxInstance>> gInstances;
int gNextId = 1;
std::string gLastError;

void setError(const std::string& message) { gLastError = message; }

GrainFxInstance* findInstance(int handle) {
  auto it = gInstances.find(handle);
  return it == gInstances.end() ? nullptr : it->second.get();
}

} // namespace

extern "C" {

const char* grainfx_last_error() { return gLastError.c_str(); }

int grainfx_create(double sample_rate) {
  try {
    gLastError.clear();
    if (sample_rate <= 0.0) {
      setError("grainfx_create: invalid sample_rate");
      return 0;
    }
    const int id = gNextId++;
    auto instance = std::make_unique<GrainFxInstance>();
    instance->setup(sample_rate);
    gInstances.emplace(id, std::move(instance));
    return id;
  } catch (const std::exception& error) {
    setError(error.what());
    return 0;
  }
}

void grainfx_destroy(int handle) { gInstances.erase(handle); }

void grainfx_set_param(int handle, int address, float value) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.setParameter(static_cast<AUParameterAddress>(address), value);
}

void grainfx_set_host_bpm(int handle, double bpm) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.setHostBPM(bpm);
}

void grainfx_process(
    int handle,
    const float* in_l,
    const float* in_r,
    float* out_l,
    float* out_r,
    int frames) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready || frames <= 0) return;
  if (frames > kMaxFrames) frames = kMaxFrames;
  instance->inPtrs[0] = in_l;
  instance->inPtrs[1] = in_r ? in_r : in_l;
  instance->outPtrs[0] = out_l;
  instance->outPtrs[1] = out_r ? out_r : out_l;
  instance->kernel.process(
      instance->inPtrs.data(),
      2,
      instance->outPtrs.data(),
      2,
      0,
      static_cast<AUAudioFrameCount>(frames));
}

void grainfx_load_loop(int handle, const float* data_l, const float* data_r, int count) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready || !data_l || count <= 0) return;
  instance->kernel.loadLoopSamples(data_l, data_r, count);
}

void grainfx_release_loop(int handle) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.releaseLoop();
}

void grainfx_note_on(int handle, int note, float velocity) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.handleNoteOn(note, velocity);
}

void grainfx_note_off(int handle, int note) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.handleNoteOff(note);
}

void grainfx_cc(int handle, int cc, int on) {
  GrainFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.handleMIDIControlChange(cc, on != 0);
}

} // extern "C"
