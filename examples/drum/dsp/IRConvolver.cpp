#include "IRConvolver.h"
#include <Accelerate/Accelerate.h>
#include <cmath>
#include <cstring>
#include <algorithm>

// ── Helpers ──────────────────────────────────────────────────────────────────

static int nextPow2(int n) {
    if (n <= 1) return 1;
    int p = 1;
    while (p < n) p <<= 1;
    return p;
}

static int log2int(int n) {
    int k = 0;
    while ((1 << k) < n) ++k;
    return k;
}

// ── Teardown / Setup ─────────────────────────────────────────────────────────

IRConvolver::~IRConvolver() {
    teardown();
}

void IRConvolver::teardown() {
    if (mFFTSetup) {
        vDSP_destroy_fftsetup(mFFTSetup);
        mFFTSetup = nullptr;
    }
    mReady = false;
}

void IRConvolver::setup(const float* irData, int irLength, int partSize) {
    teardown();

    mPartSize = partSize;
    mFftSize  = 2 * partSize;
    mLog2     = log2int(mFftSize);
    mNumParts = (irLength + partSize - 1) / partSize;

    mFFTSetup = vDSP_create_fftsetup(mLog2, FFT_RADIX2);

    const int specBins = mFftSize / 2;

    mIRPartsRe.assign(mNumParts, std::vector<float>(specBins, 0.f));
    mIRPartsIm.assign(mNumParts, std::vector<float>(specBins, 0.f));

    std::vector<float> workRe(specBins, 0.f);
    std::vector<float> workIm(specBins, 0.f);
    DSPSplitComplex sc { workRe.data(), workIm.data() };

    std::vector<float> timeBuf(mFftSize, 0.f);

    for (int p = 0; p < mNumParts; ++p) {
        int offset = p * partSize;
        int count  = std::min(partSize, irLength - offset);

        std::fill(timeBuf.begin(), timeBuf.end(), 0.f);
        std::copy(irData + offset, irData + offset + count, timeBuf.begin());

        vDSP_ctoz(reinterpret_cast<const DSPComplex*>(timeBuf.data()), 2, &sc, 1, specBins);
        vDSP_fft_zrip(mFFTSetup, &sc, 1, mLog2, FFT_FORWARD);

        mIRPartsRe[p] = workRe;
        mIRPartsIm[p] = workIm;
    }

    mInputSpectraRe.assign(mNumParts, std::vector<float>(specBins, 0.f));
    mInputSpectraIm.assign(mNumParts, std::vector<float>(specBins, 0.f));
    mSpectraWriteIdx = 0;

    mInputHistory.assign(partSize, 0.f);

    mAccumRe.assign(specBins, 0.f);
    mAccumIm.assign(specBins, 0.f);
    mWorkRe.assign(specBins, 0.f);
    mWorkIm.assign(specBins, 0.f);

    mTimeBuf.assign(mFftSize, 0.f);
    mOutTimeBuf.assign(mFftSize, 0.f);

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
    for (auto& v : mInputSpectraRe) std::fill(v.begin(), v.end(), 0.f);
    for (auto& v : mInputSpectraIm) std::fill(v.begin(), v.end(), 0.f);
    std::fill(mInputHistory.begin(), mInputHistory.end(), 0.f);
    std::fill(mAccumRe.begin(), mAccumRe.end(), 0.f);
    std::fill(mAccumIm.begin(), mAccumIm.end(), 0.f);
    std::fill(mOutputRing.begin(), mOutputRing.end(), 0.f);
    std::fill(mInputCarry.begin(), mInputCarry.end(), 0.f);
    std::fill(mTimeBuf.begin(), mTimeBuf.end(), 0.f);
    std::fill(mOutTimeBuf.begin(), mOutTimeBuf.end(), 0.f);
    mCarryCount      = 0;
    mSpectraWriteIdx = 0;
    mRingWriteIdx    = 0;
    mRingReadIdx     = 0;
    mRingAvail       = 0;
}

// ── Per-partition processing ──────────────────────────────────────────────────

void IRConvolver::processPartition(const float* inputChunk) {
    const int specBins = mFftSize / 2;

    std::copy(mInputHistory.begin(), mInputHistory.end(), mTimeBuf.begin());
    std::copy(inputChunk, inputChunk + mPartSize, mTimeBuf.begin() + mPartSize);
    std::copy(inputChunk, inputChunk + mPartSize, mInputHistory.begin());

    DSPSplitComplex inputSC {
        mInputSpectraRe[mSpectraWriteIdx].data(),
        mInputSpectraIm[mSpectraWriteIdx].data()
    };
    vDSP_ctoz(reinterpret_cast<const DSPComplex*>(mTimeBuf.data()), 2, &inputSC, 1, specBins);
    vDSP_fft_zrip(mFFTSetup, &inputSC, 1, mLog2, FFT_FORWARD);

    std::fill(mAccumRe.begin(), mAccumRe.end(), 0.f);
    std::fill(mAccumIm.begin(), mAccumIm.end(), 0.f);

    DSPSplitComplex accumSC { mAccumRe.data(), mAccumIm.data() };

    for (int p = 0; p < mNumParts; ++p) {
        int slot = (mSpectraWriteIdx - p + mNumParts) % mNumParts;
        DSPSplitComplex xSC { mInputSpectraRe[slot].data(), mInputSpectraIm[slot].data() };
        DSPSplitComplex hSC { mIRPartsRe[p].data(), mIRPartsIm[p].data() };
        vDSP_zvma(&xSC, 1, &hSC, 1, &accumSC, 1, &accumSC, 1, specBins);
    }

    vDSP_fft_zrip(mFFTSetup, &accumSC, 1, mLog2, FFT_INVERSE);

    vDSP_ztoc(&accumSC, 1, reinterpret_cast<DSPComplex*>(mOutTimeBuf.data()), 2, specBins);

    float scale = 1.f / static_cast<float>(mFftSize * 2);
    vDSP_vsmul(mOutTimeBuf.data(), 1, &scale, mOutTimeBuf.data(), 1, mFftSize);

    const float* validOut = mOutTimeBuf.data() + mPartSize;
    const int ringSize = static_cast<int>(mOutputRing.size());
    for (int i = 0; i < mPartSize; ++i) {
        mOutputRing[mRingWriteIdx] = validOut[i];
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
