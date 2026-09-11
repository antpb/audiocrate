#pragma once

#include <vector>
#include <cstddef>

struct PFFFT_Setup;

// Uniform partitioned convolution using pffft real FFT (overlap-save).
// All memory is allocated at setup time; process() is real-time safe.
// Cross-platform port of the vDSP implementation in the iOS AUv3 — the
// public API and output behavior are identical (same partition scheme,
// same latency characteristics), only the FFT backend differs.
class IRConvolver {
public:
    IRConvolver() = default;
    ~IRConvolver();

    IRConvolver(const IRConvolver&) = delete;
    IRConvolver& operator=(const IRConvolver&) = delete;

    // Call once (off the audio thread) after loading a new IR.
    // irData    : mono float PCM samples
    // irLength  : number of samples in irData
    // partSize  : FFT partition size (must be a power of 2, e.g. 512)
    void setup(const float* irData, int irLength, int partSize);

    // Reset overlap history to zeros (call on stream restart).
    void reset();

    // Process one block. input/output may alias. frameCount may be any size;
    // internally we work in partSize-sample chunks. This is real-time safe.
    void process(const float* input, float* output, int frameCount);

    bool isReady() const { return mReady; }

private:
    void teardown();
    void processPartition(const float* inputChunk);

    // 16-byte-aligned float block sized for pffft (freed in teardown).
    float* alignedAlloc(int floats);

    int mPartSize  = 0;
    int mFftSize   = 0;   // 2 * mPartSize
    int mNumParts  = 0;

    PFFFT_Setup* mSetup = nullptr;

    // Frequency-domain data kept in pffft's internal (unordered) layout —
    // mFftSize floats per real spectrum. All blocks live in one aligned pool.
    std::vector<float*> mIRParts;       // [numParts] -> mFftSize floats
    std::vector<float*> mInputSpectra;  // [numParts] -> mFftSize floats
    float* mAccum   = nullptr;          // mFftSize floats
    float* mTimeBuf = nullptr;          // mFftSize floats (overlap-save window)
    float* mOutTimeBuf = nullptr;       // mFftSize floats (IFFT output)
    float* mWork    = nullptr;          // pffft work area, mFftSize floats
    std::vector<float*> mPool;          // every aligned allocation, for teardown

    int mSpectraWriteIdx = 0;

    // Overlap-save input history: mPartSize samples of past input.
    std::vector<float> mInputHistory;

    // Carry buffer for sub-partition-sized process() calls.
    std::vector<float> mInputCarry;
    int mCarryCount = 0;

    // Output ring buffer so we can return samples from previous IFFT.
    std::vector<float> mOutputRing;
    int mRingWriteIdx = 0;
    int mRingReadIdx  = 0;
    int mRingAvail    = 0;

    bool mReady = false;
};
