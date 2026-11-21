#pragma once

#include <FastLED.h>

struct LightState {
    u8 start;
    u8 length;
    u8 gradientLength;
    CHSV color;
};

inline LightState interpolate(const LightState& state1, const LightState& state2, float t) {
    LightState result;
    result.start = state1.start + (state2.start - state1.start) * t;
    result.length = state1.length + (state2.length - state1.length) * t;
    result.gradientLength = state1.gradientLength + (state2.gradientLength - state1.gradientLength) * t;
    result.color.h = state1.color.h + (state2.color.h - state1.color.h) * t;
    result.color.s = state1.color.s + (state2.color.s - state1.color.s) * t;
    result.color.v = state1.color.v + (state2.color.v - state1.color.v) * t;
    return result;
}
