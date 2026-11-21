#pragma once

#include <Arduino.h>
#include <FastLED.h>

#include "light_state.h"

enum class EffectMode : uint8_t {
    RAINBOW_COMET = 0,      // Default existing effect
    GROUND_CARPET = 1,      // Road-speed locked standing wave markers
    PARK_TO_SLIPSTREAM = 2, // Calm breathe() when parked -> dynamic slipstream comet
    DOPPLER_WAKE = 3,       // Ice-blue bow shock at nose -> speed-shifted turbulent wake
    WIND_SPARKS = 4,        // Nose-spawned particles stretching into warp streaks
    DYNAMIC = 5             // Breathe -> peak-bright moving blobs -> slipstream morph at 5 mph
};

class VelocityEffects {
public:
    static constexpr float MPH_TO_MPS = 0.44704f;
    // Physical span of the 144-LED strip along the underside of the Load 75 cargo box (~0.94 m)
    static constexpr float STRIP_LENGTH_M = 0.94f;
    static constexpr uint8_t MAX_SPARKS = 10;

    struct Spark {
        int16_t posQ6; // Fixed-point LED index * 64 (0 .. NUM_LEDS*64 - 1)
        uint8_t hue;
        uint8_t active;
    };

    VelocityEffects()
        : lastUpdateMs(0),
          initialized(false),
          distanceMeters(0.0f),
          slipstreamPhase(0.0f),
          flowPhase(0.0f),
          sparkSpawnAccum(0.0f),
          dynBreathPhase(0),
          dynOffsetQ4(0),
          dynDopplerProg(0),
          dynMorph8(0),
          dynMoving(0) {
        for (uint8_t i = 0; i < MAX_SPARKS; ++i) {
            sparks[i] = {0, 0, 0};
        }
    }

    void reset() {
        initialized = false;
        distanceMeters = 0.0f;
        slipstreamPhase = 0.0f;
        flowPhase = 0.0f;
        sparkSpawnAccum = 0.0f;
        dynBreathPhase = 0;
        dynOffsetQ4 = 0;
        dynDopplerProg = 0;
        dynMorph8 = 0;
        dynMoving = 0;
        for (uint8_t i = 0; i < MAX_SPARKS; ++i) {
            sparks[i].active = 0;
        }
    }

    // Advance shared kinematic & physics state once per frame (~20 ms)
    void stepPhysics(float velocityMph, uint16_t numLeds) {
        unsigned long nowMs = millis();
        if (!initialized) {
            initialized = true;
            lastUpdateMs = nowMs;
            return;
        }

        unsigned long dtMs = nowMs - lastUpdateMs;
        if (dtMs == 0) return;
        lastUpdateMs = nowMs;
        if (dtMs > 200UL) dtMs = 200UL;

        float dtSec = static_cast<float>(dtMs) * 0.001f;
        float speedMps = velocityMph * MPH_TO_MPS;

        // 1. Cumulative ground distance (meters)
        distanceMeters += speedMps * dtSec;
        if (distanceMeters > 10000.0f) {
            distanceMeters -= 10000.0f;
        }

        // 2. Slipstream & aerodynamic wake phases
        float cometCyclesPerSec = 0.15f + velocityMph * 0.11f;
        slipstreamPhase += cometCyclesPerSec * dtSec * static_cast<float>(numLeds);
        if (slipstreamPhase >= static_cast<float>(numLeds)) {
            slipstreamPhase -= static_cast<float>(numLeds) *
                               static_cast<int>(slipstreamPhase / static_cast<float>(numLeds));
        }

        flowPhase += (18.0f + velocityMph * 26.0f) * dtSec;
        if (flowPhase > 65535.0f) flowPhase -= 65535.0f;

        // 3. Update wind-tunnel sparks (fixed-point Q6 positions)
        stepSparks(velocityMph, dtSec, numLeds);

        // 4. Update Dynamic breathe-to-slipstream state machine
        stepDynamic(velocityMph, dtMs, dtSec, numLeds);
    }

    void renderEffect(EffectMode mode, CRGB* ledsLeft, CRGB* ledsRight, uint16_t numLeds, float velocityMph) {
        stepPhysics(velocityMph, numLeds);

        switch (mode) {
            case EffectMode::GROUND_CARPET:
                renderGroundCarpet(ledsLeft, numLeds, velocityMph);
                break;
            case EffectMode::PARK_TO_SLIPSTREAM:
                renderParkToSlipstream(ledsLeft, numLeds, velocityMph);
                break;
            case EffectMode::DOPPLER_WAKE:
                renderDopplerWake(ledsLeft, numLeds, velocityMph);
                break;
            case EffectMode::WIND_SPARKS:
                renderWindSparks(ledsLeft, numLeds, velocityMph);
                break;
            case EffectMode::DYNAMIC:
                renderDynamic(ledsLeft, numLeds, velocityMph);
                break;
            case EffectMode::RAINBOW_COMET:
            default:
                renderClassicComet(ledsLeft, numLeds, static_cast<int>((millis() / 10) % numLeds));
                break;
        }

        memcpy(ledsRight, ledsLeft, numLeds * sizeof(CRGB));
    }

    // Classic Rainbow Comet (Effect 0 — matches original firmware implementation)
    static void renderClassicComet(CRGB* leds, uint16_t numLeds, int position) {
        fill_solid(leds, numLeds, CRGB::Black);

        int cometLength = numLeds / 10;
        int head = static_cast<int>(numLeds) - 1 - position;
        for (int i = 0; i < cometLength; i++) {
            int ledIndex = head + i;
            if (ledIndex >= static_cast<int>(numLeds)) {
                ledIndex -= numLeds;
            }
            if (ledIndex >= 0 && ledIndex < static_cast<int>(numLeds)) {
                uint8_t brightness = map(i, 0, cometLength - 1, 255, 0);
                leds[ledIndex] = CHSV(0, 0, brightness);
            }
        }

        int rainbowLength = (static_cast<int>(numLeds) * 3) / 8;
        for (int i = 0; i < rainbowLength; i++) {
            int ledIndex = head + cometLength + i - 1;
            if (ledIndex >= static_cast<int>(numLeds)) {
                ledIndex -= numLeds;
            }
            if (ledIndex >= 0 && ledIndex < static_cast<int>(numLeds)) {
                uint8_t hue = map(i, 0, rainbowLength - 1, 0, 255);
                uint8_t brightness = constrain(inoise8(i * 20, millis() / 5), 0, 255);
                leds[ledIndex] = CHSV(hue, 255, brightness);
            }
        }
    }

private:
    static LightState computeBreatheStateFromValue(uint16_t numLeds, uint8_t value) {
        LightState state;
        uint8_t minBrightness = 40;
        uint8_t brightness = map(value, 0, 255, minBrightness, 255);
        uint8_t hue = map(brightness, minBrightness, 255, 160, 210);
        uint8_t middleWidth = map(value, 0, 255, (3 * numLeds) / 4, numLeds / 5);
        state.color = CHSV(hue, 123, brightness);
        state.gradientLength = (numLeds - middleWidth) / 2;
        state.start = state.gradientLength;
        state.length = numLeds - state.gradientLength * 2;
        return state;
    }

    static LightState computeBreatheState(uint16_t numLeds) {
        return computeBreatheStateFromValue(numLeds, beatsin8(25, 0, 255));
    }

    static void renderLightStateToBuffer(CRGB* leds, uint16_t numLeds, const LightState& state) {
        fill_solid(leds, numLeds, CRGB::Black);
        fill_solid(leds + state.start, state.length, state.color);
        for (int i = 0; i < state.gradientLength; i++) {
            uint8_t ledBrightness = map(i, 0, state.gradientLength, 0, state.color.v);
            CHSV color = CHSV(state.color.h, state.color.s, ledBrightness);
            leds[i] = color;
            leds[numLeds - i - 1] = color;
        }
    }

    // 1. Ground-Locked Light Carpet: 0.50m standing markers stationary relative to the road
    void renderGroundCarpet(CRGB* leds, uint16_t numLeds, float velocityMph) {
        const float markerSpacingM = 0.50f; // Aligns with 0.5m pavement grid
        const float invSpacing = 1.0f / markerSpacingM;
        const float metersPerLed = STRIP_LENGTH_M / static_cast<float>(numLeds - 1);

        // Idle breathe blend when parked (< 1.2 mph)
        uint8_t movingBlend = static_cast<uint8_t>(constrain(velocityMph * 212.0f, 0.0f, 255.0f));
        if (movingBlend < 255) {
            LightState idle = computeBreatheState(numLeds);
            renderLightStateToBuffer(leds, numLeds, idle);
        }

        uint8_t baseHueShift = static_cast<uint8_t>(millis() / 40);
        for (uint16_t i = 0; i < numLeds; ++i) {
            // LED 0 is at rear of box, LED 143 is at front nose (+x along travel direction)
            float worldM = distanceMeters + static_cast<float>(i) * metersPerLed;
            float cellPos = worldM * invSpacing;
            int cellIdx = static_cast<int>(cellPos);
            float frac = cellPos - static_cast<float>(cellIdx); // 0.0 .. 1.0 within 0.5m cell

            // Distance from cell center (0.5 -> 0.0 at center, 0.5 at edges)
            float distFromNode = (frac > 0.5f) ? (frac - 0.5f) : (0.5f - frac);
            // Sharp glowing rune/stepping-stone profile
            float norm = 1.0f - constrain(distFromNode * 3.4f, 0.0f, 1.0f);
            uint8_t v = static_cast<uint8_t>(norm * norm * 255.0f);

            // Alternate aurora hues per ground stone so individual stones are distinct
            uint8_t stoneHue = static_cast<uint8_t>((cellIdx * 37) + baseHueShift);
            uint8_t sat = (v > 210) ? static_cast<uint8_t>(255 - (v - 210) * 3) : 240;
            CRGB carpetPx = CHSV(stoneHue, sat, v);

            if (movingBlend == 255) {
                leds[i] = carpetPx;
            } else if (movingBlend > 0) {
                leds[i] = blend(leds[i], carpetPx, movingBlend);
            }
        }
    }

    // 2. Park-to-Slipstream Morph: calm breathe() while stopped -> dynamic speed comet
    void renderParkToSlipstream(CRGB* leds, uint16_t numLeds, float velocityMph) {
        LightState idle = computeBreatheState(numLeds);
        uint8_t moveMix = static_cast<uint8_t>(constrain((velocityMph - 0.3f) * 85.0f, 0.0f, 255.0f));

        if (moveMix == 0) {
            renderLightStateToBuffer(leds, numLeds, idle);
            return;
        }

        // Render idle first if blending in low-speed transition (0.3 .. 3.3 mph)
        if (moveMix < 255) {
            renderLightStateToBuffer(leds, numLeds, idle);
        } else {
            fill_solid(leds, numLeds, CRGB::Black);
        }

        int headOffset = static_cast<int>(slipstreamPhase) % static_cast<int>(numLeds);
        int head = static_cast<int>(numLeds) - 1 - headOffset; // Moves nose (#143) -> rear (#0)
        int headLen = constrain(8 + static_cast<int>(velocityMph * 0.5f), 8, 22);
        int tailLen = constrain(24 + static_cast<int>(velocityMph * 4.2f), 24, static_cast<int>(numLeds) - headLen - 4);

        // Hue warms from calm aqua/blue at low speed to electric magenta/gold at high speed
        uint8_t leadHue = static_cast<uint8_t>(135 + constrain(static_cast<int>(velocityMph * 4.5f), 0, 110));
        uint16_t noiseT = static_cast<uint16_t>(flowPhase);

        for (int k = 0; k < headLen + tailLen; ++k) {
            int idx = head + k;
            if (idx >= static_cast<int>(numLeds)) idx -= numLeds;

            CRGB slipPx;
            if (k < headLen) {
                uint8_t v = map(k, 0, headLen - 1, 255, 190);
                uint8_t s = map(k, 0, headLen - 1, 20, 200);
                slipPx = CHSV(leadHue, s, v);
            } else {
                int tIdx = k - headLen;
                uint8_t fade = map(tIdx, 0, tailLen - 1, 210, 0);
                uint8_t shimmer = inoise8(tIdx * 18, noiseT);
                uint8_t v = scale8(fade, qadd8(95, shimmer >> 1));
                uint8_t hue = leadHue - static_cast<uint8_t>((tIdx * 90) / tailLen);
                slipPx = CHSV(hue, 245, v);
            }

            if (moveMix == 255) {
                leds[idx] = slipPx;
            } else {
                leds[idx] = blend(leds[idx], slipPx, moveMix);
            }
        }
    }

    // 3. Aerodynamic Doppler Wake: compressed ice-blue bow shock at nose (#143), speed-shifted wake toward #0
    void renderDopplerWake(CRGB* leds, uint16_t numLeds, float velocityMph) {
        float speedNorm = constrain(velocityMph / 22.0f, 0.0f, 1.0f);
        int bowWidth = constrain(10 + static_cast<int>(speedNorm * 26.0f), 10, 38);
        uint16_t flowOffset = static_cast<uint16_t>(flowPhase * 3.0f);
        uint8_t idlePulse = beatsin8(20, 35, 85);

        // Wake palette shifts with speed: teal (135) -> deep blue/violet (185) -> hot crimson/amber (248)
        uint8_t tailBaseHue = static_cast<uint8_t>(138 + speedNorm * 112.0f);
        uint8_t wakeMaxBri = static_cast<uint8_t>(45 + speedNorm * 210.0f);

        for (uint16_t i = 0; i < numLeds; ++i) {
            int distFromNose = static_cast<int>(numLeds - 1 - i); // 0 at front nose (#143), 143 at rear (#0)

            if (velocityMph < 0.4f) {
                // Subtle idle indigo glow near center-front
                uint8_t v = (distFromNose < 50) ? map(distFromNose, 0, 49, idlePulse, 12) : 12;
                leds[i] = CHSV(165, 220, v);
                continue;
            }

            if (distFromNose < bowWidth) {
                // Blueshifted leading bow shock: incandescent white tip -> cyan/ice-blue shoulder
                uint8_t sat = map(distFromNose, 0, bowWidth - 1, static_cast<uint8_t>(30 * (1.0f - speedNorm)), 225);
                uint8_t val = map(distFromNose, 0, bowWidth - 1, 255, wakeMaxBri);
                leds[i] = CHSV(136, sat, val);
            } else {
                // Turbulent wake streaming rearward (+distFromNose)
                int wakeIdx = distFromNose - bowWidth;
                int wakeSpan = static_cast<int>(numLeds) - bowWidth;
                uint8_t n = inoise8(wakeIdx * 16 - flowOffset, static_cast<uint16_t>(millis() / 7));
                uint8_t falloff = map(wakeIdx, 0, wakeSpan - 1, wakeMaxBri, static_cast<uint8_t>(18 * speedNorm));
                uint8_t val = scale8(falloff, qadd8(70, n));
                uint8_t hue = map(wakeIdx, 0, wakeSpan - 1, 142, tailBaseHue);
                leds[i] = CHSV(hue, 245, val);
            }
        }
    }

    // 4. Wind-Tunnel Sparks: particles spawn at front nose (#143) and streak rearward (#0)
    void stepSparks(float velocityMph, float dtSec, uint16_t numLeds) {
        if (velocityMph < 0.4f) {
            for (uint8_t s = 0; s < MAX_SPARKS; ++s) {
                sparks[s].active = 0;
            }
            return;
        }

        // Spark speed in LEDs/sec (scales briskly with mph)
        float ledsPerSec = 22.0f + velocityMph * 13.5f;
        int16_t deltaQ6 = static_cast<int16_t>(ledsPerSec * dtSec * 64.0f);
        if (deltaQ6 < 1) deltaQ6 = 1;

        for (uint8_t s = 0; s < MAX_SPARKS; ++s) {
            if (!sparks[s].active) continue;
            sparks[s].posQ6 -= deltaQ6; // Move nose (#143) -> rear (#0)
            if (sparks[s].posQ6 < -1024) {
                sparks[s].active = 0;
            }
        }

        // Spawn rate proportional to mph (1.5 sparks/sec at 2 mph -> ~28 sparks/sec at 25 mph)
        float spawnsPerSec = 0.8f + velocityMph * 1.15f;
        sparkSpawnAccum += spawnsPerSec * dtSec;
        while (sparkSpawnAccum >= 1.0f) {
            sparkSpawnAccum -= 1.0f;
            for (uint8_t s = 0; s < MAX_SPARKS; ++s) {
                if (!sparks[s].active) {
                    sparks[s].active = 1;
                    sparks[s].posQ6 = static_cast<int16_t>((numLeds - 1) * 64);
                    // Cool cyan/white sparks at moderate speed, shifting to electric blue/violet/gold faster
                    sparks[s].hue = static_cast<uint8_t>(128 + random8(0, 55) + constrain(static_cast<int>(velocityMph * 2.5f), 0, 65));
                    break;
                }
            }
        }
    }

    void renderWindSparks(CRGB* leds, uint16_t numLeds, float velocityMph) {
        if (velocityMph < 0.4f) {
            // Gentle starlight shimmer when parked
            uint16_t t = static_cast<uint16_t>(millis() / 12);
            for (uint16_t i = 0; i < numLeds; ++i) {
                uint8_t n = inoise8(i * 35, t);
                uint8_t v = (n > 175) ? static_cast<uint8_t>((n - 175) * 2) : 8;
                leds[i] = CHSV(150, 160, v);
            }
            return;
        }

        // Subtle dark slipstream ambient bed
        fill_solid(leds, numLeds, CHSV(155, 220, 14));

        // Nose emitter glow at #143
        uint8_t noseGlow = static_cast<uint8_t>(constrain(50.0f + velocityMph * 8.0f, 50.0f, 220.0f));
        leds[numLeds - 1] += CHSV(135, 60, noseGlow);
        if (numLeds > 2) leds[numLeds - 2] += CHSV(135, 110, noseGlow >> 1);

        // Motion-blur streak length grows with speed (2 px slow -> 20 px warp streak)
        int streakLen = constrain(2 + static_cast<int>(velocityMph * 0.75f), 2, 20);

        for (uint8_t s = 0; s < MAX_SPARKS; ++s) {
            if (!sparks[s].active) continue;
            int headIdx = sparks[s].posQ6 >> 6;
            for (int k = 0; k < streakLen; ++k) {
                int idx = headIdx + k; // Trail extends forward toward nose where spark came from
                if (idx < 0 || idx >= static_cast<int>(numLeds)) continue;
                uint8_t bri = map(k, 0, streakLen, 255, 20);
                uint8_t sat = (k == 0) ? 35 : map(k, 1, streakLen, 160, 255);
                leds[idx] += CHSV(sparks[s].hue, sat, bri);
            }
        }
    }

    // 5. Dynamic: breathe() at 0 mph -> waits for full brightness -> moves blobs front-to-back,
    // skewing brighter toward the rear (#0), morphing into slipstream at 5 mph, and past 13 mph
    // sliding in the white bow shock and expanding the aerodynamic Doppler wake rearward from it.
    void stepDynamic(float velocityMph, unsigned long dtMs, float dtSec, uint16_t numLeds) {
        const bool isMovingSpeed = (velocityMph > 0.02f);

        if (!dynMoving) {
            dynDopplerProg = 0;
            // Advance 25 BPM breathing phase (1 full breath = 2400 ms = 65536 phase units)
            uint16_t prevRel = dynBreathPhase - 16384U; // 16384U => sin8(64) == 255 (full brightness)
            uint32_t inc = (25UL * 65536UL * dtMs) / 60000UL;
            if (inc == 0) inc = 1;
            dynBreathPhase += static_cast<uint16_t>(inc);
            uint16_t nextRel = dynBreathPhase - 16384U;

            // Once speed > 0, wait until breathing reaches peak brightness before starting motion
            if (isMovingSpeed && (prevRel == 0 || prevRel > nextRel)) {
                dynBreathPhase = 16384U;
                dynOffsetQ4 = 0;
                dynDopplerProg = 0;
                dynMorph8 = 0;
                dynMoving = 1;
            }
            return;
        }

        // Smoothly morph between symmetric full-bright breathe blob (0 mph) and slipstream (>= 5 mph)
        uint8_t targetMorph8 = isMovingSpeed
                                   ? static_cast<uint8_t>(constrain((velocityMph / 5.0f) * 255.0f, 0.0f, 255.0f))
                                   : 0;
        uint16_t maxMorphStep = static_cast<uint16_t>((dtMs * 560UL) / 1000UL);
        if (maxMorphStep < 1) maxMorphStep = 1;
        if (dynMorph8 < targetMorph8) {
            uint16_t nextM = static_cast<uint16_t>(dynMorph8) + maxMorphStep;
            dynMorph8 = (nextM > targetMorph8) ? targetMorph8 : static_cast<uint8_t>(nextM);
        } else if (dynMorph8 > targetMorph8) {
            dynMorph8 = (dynMorph8 > targetMorph8 + maxMorphStep)
                            ? static_cast<uint8_t>(dynMorph8 - maxMorphStep)
                            : targetMorph8;
        }

        // Past 13 mph: Stage 1 (0..256) slides the white bow shock in from the nose (#143),
        // then Stage 2 (256..512) expands the turbulent Doppler wake rearward from it.
        if (velocityMph > 13.0f) {
            if (dynDopplerProg < 512U) {
                uint32_t rate = (dynDopplerProg < 256U) ? 680UL : 465UL;
                uint16_t step = static_cast<uint16_t>((dtMs * rate) / 1000UL);
                if (step < 1) step = 1;
                uint16_t nextP = dynDopplerProg + step;
                dynDopplerProg = (nextP > 512U) ? 512U : nextP;
            }
        } else if (dynDopplerProg > 0) {
            uint32_t rate = (dynDopplerProg > 256U) ? 520UL : 720UL;
            uint16_t step = static_cast<uint16_t>((dtMs * rate) / 1000UL);
            if (step < 1) step = 1;
            dynDopplerProg = (dynDopplerProg > step) ? static_cast<uint16_t>(dynDopplerProg - step) : 0;
        }

        // Advance front-to-back position (Q4 subpixels: 16 units per LED), matching slipstream at >= 5 mph
        float cyclesPerSec = (velocityMph < 5.0f)
                                 ? (0.22f + velocityMph * 0.096f)
                                 : (0.15f + velocityMph * 0.11f);
        uint16_t periodQ4 = numLeds * 16U;
        int32_t deltaQ4 = static_cast<int32_t>(cyclesPerSec * dtSec * static_cast<float>(periodQ4) + 0.5f);
        if (deltaQ4 < 1) deltaQ4 = 1;

        uint32_t nextOffsetQ4 = static_cast<uint32_t>(dynOffsetQ4) + static_cast<uint32_t>(deltaQ4);

        // When stopped, keep cycling blobs until reaching the original centered position, then breathe
        if (!isMovingSpeed && dynMorph8 == 0 && dynDopplerProg == 0 && nextOffsetQ4 >= periodQ4) {
            dynOffsetQ4 = 0;
            dynBreathPhase = 16384U; // Resume breathing smoothly from full brightness
            dynMoving = 0;
            return;
        }

        dynOffsetQ4 = static_cast<uint16_t>(nextOffsetQ4 % periodQ4);
    }

    void renderDynamic(CRGB* leds, uint16_t numLeds, float velocityMph) {
        if (!dynMoving) {
            uint8_t beat = static_cast<uint8_t>(dynBreathPhase >> 8);
            uint8_t value = scale8(sin8(beat), 255);
            LightState idle = computeBreatheStateFromValue(numLeds, value);
            renderLightStateToBuffer(leds, numLeds, idle);
            return;
        }

        // Once the white bow shock & Doppler wake have fully expanded (> 13 mph), run Doppler Wake directly
        if (dynDopplerProg >= 512U) {
            renderDopplerWake(leds, numLeds, velocityMph);
            return;
        }

        if (dynDopplerProg < 128U) {
            const uint8_t m = dynMorph8; // 0 = full-bright symmetric breathe blob, 255 = full slipstream
            const int16_t periodQ4 = static_cast<int16_t>(numLeds * 16U);

            const int16_t breatheCore = static_cast<int16_t>(numLeds / 5U);
            const int16_t breatheGrad = (static_cast<int16_t>(numLeds) - breatheCore) / 2;
            const int16_t anchorQ4 = breatheGrad * 16;

            const int16_t slipHead = constrain(8 + static_cast<int>(velocityMph * 0.5f), 8, 22);
            const int16_t slipTail = constrain(
                24 + static_cast<int>(velocityMph * 4.2f),
                24,
                static_cast<int>(numLeds) - slipHead - 4
            );

            // Compress rear-facing ramp to 0 as speed approaches 5 mph so the bright face points rearward (#0)
            const uint8_t invM = 255U - m;
            const uint8_t rearKeep = scale8(invM, 255U - (m >> 1));
            const int16_t rearRampQ4 = static_cast<int16_t>((static_cast<int32_t>(anchorQ4) * rearKeep) / 255);
            const int16_t headLenQ4 = static_cast<int16_t>(
                ((static_cast<int32_t>(breatheCore * 16) * invM) + (static_cast<int32_t>(slipHead * 16) * m)) / 255
            );
            const int16_t tailLenQ4 = static_cast<int16_t>(
                ((static_cast<int32_t>(breatheGrad * 16) * invM) + (static_cast<int32_t>(slipTail * 16) * m)) / 255
            );

            const int16_t startQ4 = anchorQ4 - rearRampQ4;
            const int16_t headEndQ4 = rearRampQ4 + headLenQ4;
            const int16_t tailEndQ4 = headEndQ4 + tailLenQ4;

            const uint8_t leadHue = static_cast<uint8_t>(135 + constrain(static_cast<int>(velocityMph * 4.5f), 0, 110));
            const uint16_t noiseT = static_cast<uint16_t>(flowPhase);

            for (uint16_t i = 0; i < numLeds; ++i) {
                int16_t posQ4 = static_cast<int16_t>(i * 16U) + static_cast<int16_t>(dynOffsetQ4) - startQ4;
                while (posQ4 < 0) posQ4 += periodQ4;
                while (posQ4 >= periodQ4) posQ4 -= periodQ4;

                if (posQ4 < rearRampQ4) {
                    uint8_t rampBri = static_cast<uint8_t>(
                        (static_cast<uint32_t>(posQ4) * 255UL) / static_cast<uint32_t>(rearRampQ4)
                    );
                    CRGB breathePx = CHSV(210, 123, rampBri);
                    if (m == 0) {
                        leds[i] = breathePx;
                    } else {
                        CRGB slipTipPx = CHSV(leadHue, 20, rampBri);
                        leds[i] = blend(breathePx, slipTipPx, m);
                    }
                } else if (posQ4 < headEndQ4) {
                    int16_t hQ4 = posQ4 - rearRampQ4;
                    CRGB breathePx = CHSV(210, 123, 255);
                    if (m == 0) {
                        leds[i] = breathePx;
                    } else {
                        int16_t denom = (headLenQ4 > 16) ? (headLenQ4 - 16) : 1;
                        int16_t clampedHQ4 = (hQ4 > denom) ? denom : hQ4;
                        uint8_t v = static_cast<uint8_t>(
                            255 - (static_cast<uint32_t>(clampedHQ4) * 65UL) / static_cast<uint32_t>(denom)
                        );
                        uint8_t s = static_cast<uint8_t>(
                            20 + (static_cast<uint32_t>(clampedHQ4) * 180UL) / static_cast<uint32_t>(denom)
                        );
                        CRGB slipPx = CHSV(leadHue, s, v);
                        leds[i] = (m == 255) ? slipPx : blend(breathePx, slipPx, m);
                    }
                } else if (posQ4 < tailEndQ4) {
                    int16_t tQ4 = posQ4 - headEndQ4;
                    CRGB slipPx;
                    if (m > 0) {
                        int16_t denom = (tailLenQ4 > 16) ? (tailLenQ4 - 16) : 1;
                        int16_t clampedTQ4 = (tQ4 > denom) ? denom : tQ4;
                        uint8_t fade = static_cast<uint8_t>(
                            210 - (static_cast<uint32_t>(clampedTQ4) * 210UL) / static_cast<uint32_t>(denom)
                        );
                        uint8_t shimmer = inoise8(
                            static_cast<uint16_t>((static_cast<uint32_t>(tQ4) * 18UL) >> 4),
                            noiseT
                        );
                        uint8_t sVal = scale8(fade, qadd8(95, shimmer >> 1));
                        uint8_t sHue = leadHue - static_cast<uint8_t>(
                            (static_cast<uint32_t>(tQ4) * 90UL) / static_cast<uint32_t>(tailLenQ4)
                        );
                        slipPx = CHSV(sHue, 245, sVal);
                    }
                    if (m == 255) {
                        leds[i] = slipPx;
                    } else {
                        int16_t remQ4 = (tailLenQ4 > 16 + tQ4) ? (tailLenQ4 - 16 - tQ4) : 0;
                        uint8_t bVal = static_cast<uint8_t>(
                            (static_cast<uint32_t>(remQ4) * 255UL) / static_cast<uint32_t>(tailLenQ4)
                        );
                        CRGB breathePx = CHSV(210, 123, bVal);
                        leds[i] = (m == 0) ? breathePx : blend(breathePx, slipPx, m);
                    }
                } else {
                    leds[i] = CRGB::Black;
                }
            }

            if (dynDopplerProg > 0) {
                fadeToBlackBy(leds, numLeds, static_cast<uint8_t>(dynDopplerProg * 2U));
            }
        } else {
            fill_solid(leds, numLeds, CRGB::Black);
        }

        // Overlay Doppler Wake transition (> 13 mph):
        // Stage 1 (0..256): white bow shock slides in from nose (#143)
        // Stage 2 (256..512): turbulent wake expands rearward from the back of the bow shock
        if (dynDopplerProg > 0) {
            float speedNorm = constrain(velocityMph / 22.0f, 0.0f, 1.0f);
            int bowWidth = constrain(10 + static_cast<int>(speedNorm * 26.0f), 10, 38);
            uint16_t flowOffset = static_cast<uint16_t>(flowPhase * 3.0f);
            uint8_t tailBaseHue = static_cast<uint8_t>(138 + speedNorm * 112.0f);
            uint8_t wakeMaxBri = static_cast<uint8_t>(45 + speedNorm * 210.0f);
            uint8_t minBowSat = static_cast<uint8_t>(30 * (1.0f - speedNorm));

            int16_t curBowQ4 = (dynDopplerProg >= 256U)
                                   ? static_cast<int16_t>(bowWidth * 16)
                                   : static_cast<int16_t>((static_cast<int32_t>(bowWidth * 16) * dynDopplerProg) >> 8);

            int wakeSpan = static_cast<int>(numLeds) - bowWidth;
            uint16_t wakeProg = (dynDopplerProg > 256U) ? (dynDopplerProg - 256U) : 0U;
            int16_t curWakeQ4 = static_cast<int16_t>((static_cast<int32_t>(wakeSpan * 16) * wakeProg) >> 8);
            int16_t softFrontQ4 = static_cast<int16_t>(((256U - wakeProg) * 192U) >> 8);

            for (uint16_t i = 0; i < numLeds; ++i) {
                int distFromNose = static_cast<int>(numLeds - 1U - i);
                int16_t distQ4 = static_cast<int16_t>(distFromNose * 16);

                if (distQ4 < curBowQ4) {
                    uint8_t sat = map(distFromNose, 0, bowWidth - 1, minBowSat, 225);
                    uint8_t val = map(distFromNose, 0, bowWidth - 1, 255, wakeMaxBri);
                    int16_t edgeRemQ4 = curBowQ4 - distQ4;
                    if (dynDopplerProg < 256U && edgeRemQ4 < 16) {
                        val = scale8(val, static_cast<uint8_t>(edgeRemQ4 * 16));
                    }
                    CRGB bowPx = CHSV(136, sat, val);
                    leds[i] = CRGB(
                        (bowPx.r > leds[i].r) ? bowPx.r : leds[i].r,
                        (bowPx.g > leds[i].g) ? bowPx.g : leds[i].g,
                        (bowPx.b > leds[i].b) ? bowPx.b : leds[i].b
                    );
                } else if (distFromNose >= bowWidth && wakeProg > 0) {
                    int wakeIdx = distFromNose - bowWidth;
                    int16_t wakeQ4 = static_cast<int16_t>(wakeIdx * 16);
                    if (wakeQ4 < curWakeQ4) {
                        uint8_t n = inoise8(wakeIdx * 16 - flowOffset, static_cast<uint16_t>(millis() / 7));
                        uint8_t falloff = map(wakeIdx, 0, wakeSpan - 1, wakeMaxBri, static_cast<uint8_t>(18 * speedNorm));
                        int16_t distToFrontQ4 = curWakeQ4 - wakeQ4;
                        if (softFrontQ4 > 0 && distToFrontQ4 < softFrontQ4) {
                            uint8_t env = static_cast<uint8_t>(
                                (static_cast<uint32_t>(distToFrontQ4) * 255UL) / static_cast<uint32_t>(softFrontQ4)
                            );
                            falloff = scale8(falloff, env);
                        }
                        uint8_t val = scale8(falloff, qadd8(70, n));
                        uint8_t hue = map(wakeIdx, 0, wakeSpan - 1, 142, tailBaseHue);
                        leds[i] = CHSV(hue, 245, val);
                    }
                }
            }
        }
    }

    unsigned long lastUpdateMs;
    bool initialized;
    float distanceMeters;
    float slipstreamPhase;
    float flowPhase;
    float sparkSpawnAccum;
    uint16_t dynBreathPhase;
    uint16_t dynOffsetQ4;
    uint16_t dynDopplerProg;
    uint8_t dynMorph8;
    uint8_t dynMoving;
    Spark sparks[MAX_SPARKS];
};
