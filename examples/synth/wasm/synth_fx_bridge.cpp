#include "homecrate_synthDSPKernel.h"

#include <exception>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr int kMaxFrames = 4096;

struct SynthFxInstance {
  homecrate_synthDSPKernel kernel;
  std::vector<float*> outPtrs{2, nullptr};
  double sampleRate = 48000.0;
  bool ready = false;

  void setup(double sr) {
    sampleRate = sr;
    kernel.setMaximumFramesToRender(kMaxFrames);
    kernel.initialize(2, sr);
    ready = true;
  }
};

std::unordered_map<int, std::unique_ptr<SynthFxInstance>> gInstances;
int gNextId = 1;
std::string gLastError;

void setError(const std::string& message) { gLastError = message; }

SynthFxInstance* findInstance(int handle) {
  auto it = gInstances.find(handle);
  return it == gInstances.end() ? nullptr : it->second.get();
}

} // namespace

extern "C" {

const char* synthfx_last_error() { return gLastError.c_str(); }

int synthfx_create(double sample_rate) {
  try {
    gLastError.clear();
    if (sample_rate <= 0.0) {
      setError("synthfx_create: invalid sample_rate");
      return 0;
    }
    const int id = gNextId++;
    auto instance = std::make_unique<SynthFxInstance>();
    instance->setup(sample_rate);
    gInstances.emplace(id, std::move(instance));
    return id;
  } catch (const std::exception& error) {
    setError(error.what());
    return 0;
  }
}

void synthfx_destroy(int handle) { gInstances.erase(handle); }

void synthfx_set_param(int handle, int address, float value) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.setParameter(static_cast<AUParameterAddress>(address), value);
}

void synthfx_set_host_bpm(int handle, double bpm) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.setHostBPM(bpm);
}

void synthfx_process(int handle, float* out_l, float* out_r, int frames) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready || frames <= 0 || !out_l) return;
  if (frames > kMaxFrames) frames = kMaxFrames;
  instance->outPtrs[0] = out_l;
  instance->outPtrs[1] = out_r ? out_r : out_l;
  instance->kernel.process(
      instance->outPtrs.data(),
      2,
      0,
      static_cast<AUAudioFrameCount>(frames));
}

void synthfx_note_on(int handle, int note, float velocity) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.triggerNoteOn(note, velocity);
}

void synthfx_note_off(int handle, int note) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.triggerNoteOff(note);
}

void synthfx_all_notes_off(int handle) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.allNotesOff();
}

void synthfx_set_ir_slot(int handle, int slot, const float* data, int count) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready || !data || count <= 0) return;
  instance->kernel.setIRForSlot(slot, data, count);
}

void synthfx_clear_ir_slot(int handle, int slot) {
  SynthFxInstance* instance = findInstance(handle);
  if (!instance || !instance->ready) return;
  instance->kernel.clearIRForSlot(slot);
}

} // extern "C"
