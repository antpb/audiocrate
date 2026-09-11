//
//  PolyFilter.h
//  homecrate synth
//
//  Multi-topology filter dispatcher. Holds SVF, Ladder, and Cascade simultaneously;
//  routes process() to the active topology. All parameter setters propagate to all
//  three topologies so switching mid-note doesn't produce stale-state clicks.
//  Header-only. Thread-unsafe — one instance per voice.
//

#pragma once

#include "SVFilter.h"
#include "LadderFilter.h"
#include "CascadeFilter.h"

class PolyFilter {
public:
    enum Topology { SVF = 0, Ladder = 1, Cascade = 2 };

    PolyFilter() = default;

    void init(double sampleRate) {
        mSampleRate = sampleRate;
        mSvf.init(sampleRate);
        mSvf2.init(sampleRate);
        mSvf3.init(sampleRate);
        mLadder.init(sampleRate);
        mCascade.init(sampleRate);
    }

    void reset() {
        mSvf.reset();
        mSvf2.reset();
        mSvf3.reset();
        mLadder.reset();
        mCascade.reset();
    }

    void setTopology(int t) {
        mTopology = static_cast<Topology>(std::clamp(t, 0, 2));
    }

    // order: 1=6dB, 2=12dB, 3=18dB, 4=24dB
    void setOrder(int order) {
        mOrder = std::clamp(order, 1, 4);
        mLadder.setOrder(mOrder);
        mCascade.setOrder(mOrder);
    }

    void setCutoff(float hz) {
        mSvf.setCutoff(hz);
        mSvf2.setCutoff(hz);
        mSvf3.setCutoff(hz);
        mLadder.setCutoff(hz);
        mCascade.setCutoff(hz);
    }

    void setResonance(float q) {
        mSvf.setResonance(q);
        mSvf2.setResonance(q);
        mSvf3.setResonance(q);
        mLadder.setResonance(q);
        mCascade.setResonance(q);
    }

    void setType(int t) {
        mType = std::clamp(t, 0, 2);
        mSvf.setType(t);
        mSvf2.setType(t);
        mSvf3.setType(t);
        mLadder.setType(t);
        mCascade.setType(t);
    }

    void setSampleRate(double sr) {
        mSampleRate = sr;
        mSvf.setSampleRate(sr);
        mSvf2.setSampleRate(sr);
        mSvf3.setSampleRate(sr);
        mLadder.setSampleRate(sr);
        mCascade.setSampleRate(sr);
    }

    inline float process(float input) {
        switch (mTopology) {
            case Ladder:  return mLadder.process(input);
            case Cascade: return mCascade.process(input);
            default:      return processSVF(input);
        }
    }

private:
    // SVF multi-order via chaining:
    // order 1 (6 dB):  Use Cascade's calibrated 1-pole stages (identically configured)
    // order 2 (12 dB): Single SVF — normal path
    // order 3 (18 dB): SVF → mSvf2 (two 12dB stages in series ≈ 18-24dB character)
    // order 4 (24 dB): SVF → mSvf2 → mSvf3
    inline float processSVF(float input) {
        switch (mOrder) {
            case 1: {
                // Cascade's 1-pole is kept in sync via setType/setCutoff/setResonance
                switch (mType) {
                    case 0:  return mCascade.processLP6(input);
                    case 1:  return mCascade.processHP6(input);
                    default: return mCascade.processHP6(mCascade.processLP6(input)); // BP
                }
            }
            case 2: return mSvf.process(input);
            case 3: return mSvf2.process(mSvf.process(input));
            default: return mSvf3.process(mSvf2.process(mSvf.process(input)));
        }
    }

    Topology mTopology   = SVF;
    int      mOrder      = 2;
    int      mType       = 0;   // mirrors last setType() call for order-1 dispatch
    double   mSampleRate = 48000.0;

    SVFilter      mSvf;    // primary SVF stage
    SVFilter      mSvf2;   // chained for 18dB
    SVFilter      mSvf3;   // chained for 24dB
    LadderFilter  mLadder;
    CascadeFilter mCascade;
};
