#include "IRConvolver.h"
#include "pffft.h"
#include <cmath>
#include <cstring>
#include <algorithm>

// ── Teardown / Setup ─────────────────────────────────────────────────────────

IRConvolver::~IRConvolver() {
    teardown();
}

float* IRConvolver::alignedAlloc(int floats) {
    float* p = static_cast<float*>(pffft_aligned_malloc(sizeof(float) * static_cast<size_t>(floats)));
    std::memset(p, 0, sizeof(float) * static_cast<size_t>(floats));
    mPool.push_back(p);
    return p;
}

void IRConvolver::teardown() {
    if (mSetup) {
        pffft_destroy_setup(mSetup);
        mSetup = nullptr;
    }
    for (float* p : mPool) pffft_aligned_free(p);
    mPool.clear();
    mIRParts.clear();
    mInputSpectra.clear();
    mAccum = mTimeBuf = mOutTimeBuf = mWork = nullptr;
    mReady = false;
}

void IRConvolver::setup(const float* irData, int irLength, int partSize) {
    teardown();
    if (!irData || irLength <= 0 || partSize < 32) return;

    mPartSize = partSize;
    mFftSize  = 2 * partSize;
    mNumParts = (irLength + partSize - 1) / partSize;

    // pffft real transforms need N to be a multiple of 32 — guaranteed for
    // any power-of-two partSize >= 16 (fftSize >= 32).
    mSetup = pffft_new_setup(mFftSize, PFFFT_REAL);
    if (!mSetup) return;

    mWork      = alignedAlloc(mFftSize);
    mTimeBuf   = alignedAlloc(mFftSize);
    mOutTimeBuf = alignedAlloc(mFftSize);
    mAccum     = alignedAlloc(mFftSize);

    mIRParts.resize(mNumParts);
    mInputSpectra.resize(mNumParts);
    for (int p = 0; p < mNumParts; ++p) {
        mIRParts[p]      = alignedAlloc(mFftSize);
        mInputSpectra[p] = alignedAlloc(mFftSize);
    }

    // Pre-compute the (unordered) spectrum of each zero-padded IR partition.
    for (int p = 0; p < mNumParts; ++p) {
        int offset = p * partSize;
        int count  = std::min(partSize, irLength - offset);

        std::memset(mTimeBuf, 0, sizeof(float) * static_cast<size_t>(mFftSize));
        std::memcpy(mTimeBuf, irData + offset, sizeof(float) * static_cast<size_t>(count));

        pffft_transform(mSetup, mTimeBuf, mIRParts[p], mWork, PFFFT_FORWARD);
    }

    mSpectraWriteIdx = 0;
    mInputHistory.assign(partSize, 0.f);
    mInputCarry.assign(partSize, 0.f);
    mCarryCount = 0;

    const int ringSize = mFftSize + partSize;
    mOutputRing.assign(ringSize, 0.f);
    mRingWriteIdx = 0;
    mRingReadIdx  = 0;
    mRingAvail    = 0;

    mReady = true;
}

void IRConvolver::reset() {
    if (!mReady) return;
    for (int p = 0; p < mNumParts; ++p)
        std::memset(mInputSpectra[p], 0, sizeof(float) * static_cast<size_t>(mFftSize));
    std::memset(mAccum, 0, sizeof(float) * static_cast<size_t>(mFftSize));
    std::fill(mInputHistory.begin(), mInputHistory.end(), 0.f);
    std::fill(mInputCarry.begin(), mInputCarry.end(), 0.f);
    std::fill(mOutputRing.begin(), mOutputRing.end(), 0.f);
    mCarryCount      = 0;
    mSpectraWriteIdx = 0;
    mRingWriteIdx    = 0;
    mRingReadIdx     = 0;
    mRingAvail       = 0;
}

// ── Per-partition processing ──────────────────────────────────────────────────

void IRConvolver::processPartition(const float* inputChunk) {
    // Overlap-save window: [history | new chunk]
    std::memcpy(mTimeBuf, mInputHistory.data(), sizeof(float) * static_cast<size_t>(mPartSize));
    std::memcpy(mTimeBuf + mPartSize, inputChunk, sizeof(float) * static_cast<size_t>(mPartSize));
    std::memcpy(mInputHistory.data(), inputChunk, sizeof(float) * static_cast<size_t>(mPartSize));

    pffft_transform(mSetup, mTimeBuf, mInputSpectra[mSpectraWriteIdx], mWork, PFFFT_FORWARD);

    std::memset(mAccum, 0, sizeof(float) * static_cast<size_t>(mFftSize));

    // Frequency-domain multiply-accumulate over all partitions. pffft's
    // zconvolve works directly on the unordered internal layout.
    for (int p = 0; p < mNumParts; ++p) {
        int slot = (mSpectraWriteIdx - p + mNumParts) % mNumParts;
        pffft_zconvolve_accumulate(mSetup, mInputSpectra[slot], mIRParts[p], mAccum, 1.0f);
    }

    pffft_transform(mSetup, mAccum, mOutTimeBuf, mWork, PFFFT_BACKWARD);

    // pffft: BACKWARD(FORWARD(x)) == N * x, so exact convolution needs 1/N.
    // The shipped AUv3 uses vDSP zrip (forward = 2×DFT) scaled by 1/(2N),
    // which nets out to 2× the mathematical convolution — that gain is part
    // of the product's IR sound, so match it here with 2/N.
    const float scale = 2.f / static_cast<float>(mFftSize);
    const float* validOut = mOutTimeBuf + mPartSize;   // discard aliased half
    const int ringSize = static_cast<int>(mOutputRing.size());
    for (int i = 0; i < mPartSize; ++i) {
        mOutputRing[mRingWriteIdx] = validOut[i] * scale;
        mRingWriteIdx = (mRingWriteIdx + 1) % ringSize;
    }
    mRingAvail += mPartSize;

    mSpectraWriteIdx = (mSpectraWriteIdx + 1) % mNumParts;
}

// ── Public process ────────────────────────────────────────────────────────────

void IRConvolver::process(const float* input, float* output, int frameCount) {
    if (!mReady) {
        if (input != output) std::copy(input, input + frameCount, output);
        return;
    }

    int consumed = 0;
    while (consumed < frameCount) {
        int toCopy = std::min(frameCount - consumed, mPartSize - mCarryCount);
        std::copy(input + consumed, input + consumed + toCopy, mInputCarry.data() + mCarryCount);
        consumed    += toCopy;
        mCarryCount += toCopy;

        if (mCarryCount == mPartSize) {
            processPartition(mInputCarry.data());
            mCarryCount = 0;
        }
    }

    const int ringSize = static_cast<int>(mOutputRing.size());
    int toDrain = std::min(frameCount, mRingAvail);
    for (int i = 0; i < toDrain; ++i) {
        output[i] = mOutputRing[mRingReadIdx];
        mRingReadIdx = (mRingReadIdx + 1) % ringSize;
    }
    mRingAvail -= toDrain;

    if (toDrain < frameCount) {
        std::fill(output + toDrain, output + frameCount, 0.f);
    }
}
