#pragma once

#include <Accelerate/Accelerate.h>
#include <vector>
#include <cstddef>

// Uniform partitioned convolution using vDSP split-complex FFT (overlap-save).
// All memory is allocated at setup time; process() is real-time safe.
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

    // Perform a single FFT partition accumulation step.
    void processPartition(const float* inputChunk);

    int mPartSize  = 0;
    int mFftSize   = 0;   // 2 * mPartSize
    int mLog2      = 0;
    int mNumParts  = 0;

    FFTSetup mFFTSetup = nullptr;

    // Pre-computed split-complex FFT of each IR partition.
    // Layout: mIRParts[p] stores (re[], im[]) for partition p.
    std::vector<std::vector<float>> mIRPartsRe;
    std::vector<std::vector<float>> mIRPartsIm;

    // Circular delay line of input FFT spectra for the partitioned convolution.
    // mInputSpectraRe/Im[slot] has mFftSize/2 + 1 complex bins.
    std::vector<std::vector<float>> mInputSpectraRe;
    std::vector<std::vector<float>> mInputSpectraIm;
    int mSpectraWriteIdx = 0;

    // Overlap-save input history: mPartSize samples of past input.
    std::vector<float> mInputHistory;

    // Accumulation buffer (split-complex, fftSize bins).
    std::vector<float> mAccumRe;
    std::vector<float> mAccumIm;

    // Time-domain workspace for IFFT output (fftSize samples).
    std::vector<float> mWorkRe;
    std::vector<float> mWorkIm;

    // Carry buffer for sub-partition-sized process() calls.
    std::vector<float> mInputCarry;
    int mCarryCount = 0;

    // Scratch buffers pre-allocated in setup() to avoid heap allocation in processPartition().
    std::vector<float> mTimeBuf;    // mFftSize samples: overlap-save input window
    std::vector<float> mOutTimeBuf; // mFftSize samples: IFFT output (real)

    // Output ring buffer so we can return samples from previous IFFT.
    std::vector<float> mOutputRing;
    int mRingWriteIdx = 0;
    int mRingReadIdx  = 0;
    int mRingAvail    = 0;

    bool mReady = false;
};
