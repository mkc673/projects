#pragma once

#include <Arduino.h>

class WheelSpeedSensor {
public:
    // Load 75 26" rear wheel outer tire radius (~335 mm) and spoke magnet radius (200 mm)
    static constexpr float WHEEL_RADIUS_MM = 335.0f;
    static constexpr float MAGNET_RADIUS_MM = 200.0f;
    static constexpr float WHEEL_CIRCUMFERENCE_M = 2.0f * 3.14159265f * (WHEEL_RADIUS_MM / 1000.0f);
    static constexpr float MPS_TO_MPH = 2.23693629f;

    // Minimum plausible revolution period (60 ms => ~78 mph max) to reject sensor bounce
    static constexpr unsigned long MIN_PULSE_INTERVAL_US = 60000UL;
    // Clear active pulse tracking if no magnet pass occurs within 3 seconds (< ~1.6 mph)
    static constexpr unsigned long STOP_TIMEOUT_MS = 3000UL;
    // First-order low-pass time constant (ms) for continuous velocity output
    static constexpr float SMOOTHING_TAU_MS = 280.0f;

    explicit WheelSpeedSensor(uint8_t sensorPin)
        : pin(sensorPin),
          lastReading(HIGH),
          hasPulse(false),
          lastPulseMs(0),
          lastPulseUs(0),
          lastPeriodUs(0),
          lastFilterUs(0),
          rawVelocityMph(0.0f),
          smoothedVelocityMph(0.0f) {}

    void begin() {
        pinMode(pin, INPUT_PULLUP);
        lastReading = digitalRead(pin);
        lastFilterUs = micros();
    }

    // Call every loop() iteration for accurate edge timestamps and continuous smoothing
    void update() {
        uint8_t reading = digitalRead(pin);
        unsigned long nowMs = millis();
        unsigned long nowUs = micros();

        if (hasPulse && (nowMs - lastPulseMs) > STOP_TIMEOUT_MS) {
            clearPulses();
        }

        // INPUT_PULLUP Hall sensor pulls LOW when the spoke magnet passes
        if (lastReading == HIGH && reading == LOW) {
            if (!hasPulse) {
                hasPulse = true;
                lastPulseMs = nowMs;
                lastPulseUs = nowUs;
            } else {
                unsigned long dtUs = nowUs - lastPulseUs;
                if (dtUs >= MIN_PULSE_INTERVAL_US) {
                    lastPeriodUs = dtUs;
                    lastPulseUs = nowUs;
                    lastPulseMs = nowMs;
                    float speedMps = (WHEEL_CIRCUMFERENCE_M * 1000000.0f) / static_cast<float>(dtUs);
                    rawVelocityMph = speedMps * MPS_TO_MPH;
                }
            }
        }

        lastReading = reading;

        // Update continuous low-pass filter at >= 1 ms intervals
        unsigned long filterDtUs = nowUs - lastFilterUs;
        if (filterDtUs >= 1000UL) {
            lastFilterUs = nowUs;
            float dtMs = static_cast<float>(filterDtUs) * 0.001f;
            float targetMph = computeTargetMph(nowMs, nowUs);
            float alpha = dtMs / (SMOOTHING_TAU_MS + dtMs);
            float next = smoothedVelocityMph + (targetMph - smoothedVelocityMph) * alpha;

            // Ensure smooth, finite-time settle to exact 0.0 mph when stopped
            if (targetMph <= 0.0f && next > 0.0f) {
                float minDecay = 0.8f * (dtMs * 0.001f);
                if ((smoothedVelocityMph - next) < minDecay) {
                    next = smoothedVelocityMph - minDecay;
                }
                if (next < 0.02f) {
                    next = 0.0f;
                }
            }

            smoothedVelocityMph = next;
        }
    }

    float getVelocityMph() const {
        return smoothedVelocityMph;
    }

    void reset() {
        clearPulses();
        smoothedVelocityMph = 0.0f;
        lastFilterUs = micros();
    }

private:
    void clearPulses() {
        hasPulse = false;
        lastPeriodUs = 0;
        rawVelocityMph = 0.0f;
    }

    float computeTargetMph(unsigned long nowMs, unsigned long nowUs) {
        if (!hasPulse || lastPeriodUs == 0) {
            return 0.0f;
        }

        if ((nowMs - lastPulseMs) > STOP_TIMEOUT_MS) {
            clearPulses();
            return 0.0f;
        }

        // If time since the last magnet pass exceeds 1.125x the last period,
        // bound target speed by the ongoing revolution duration as the bike decelerates.
        unsigned long elapsedUs = nowUs - lastPulseUs;
        if (elapsedUs > (lastPeriodUs + (lastPeriodUs >> 3))) {
            float maxSpeedMps = (WHEEL_CIRCUMFERENCE_M * 1000000.0f) / static_cast<float>(elapsedUs);
            return maxSpeedMps * MPS_TO_MPH;
        }

        return rawVelocityMph;
    }

    uint8_t pin;
    uint8_t lastReading;
    bool hasPulse;
    unsigned long lastPulseMs;
    unsigned long lastPulseUs;
    unsigned long lastPeriodUs;
    unsigned long lastFilterUs;
    float rawVelocityMph;
    float smoothedVelocityMph;
};
