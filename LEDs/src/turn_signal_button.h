#pragma once

#include <Arduino.h>

class TurnSignalButton {
    public:
    using Callback = void(*)();

    TurnSignalButton(uint8_t _pin, Callback cb = nullptr) {
        pin = _pin;
        pinMode(pin, INPUT_PULLUP);
        lastReading = digitalRead(pin);
        stableState = lastReading;
        lastDebounceTime = 0;
        callback = cb;
    }

    // Call frequently from loop(); invokes callback when a press is detected (debounced)
    void update() {
        uint8_t reading = digitalRead(pin);

        if (reading != lastReading) {
            lastDebounceTime = millis();
        }

        if ((millis() - lastDebounceTime) > debounceDelay) {
            if (reading != stableState) {
                stableState = reading;
                // INPUT_PULLUP: pressed == LOW
                if (stableState == LOW) {
                    Serial.println(F("Button pressed"));
                    if (callback) callback();
                }
            }
        }

        lastReading = reading;
    }

    void setCallback(Callback cb) {
        callback = cb;
    }

    private:
    uint8_t pin;
    uint8_t lastReading;
    uint8_t stableState;
    unsigned long lastDebounceTime;
    const unsigned long debounceDelay = 50;
    Callback callback;
};

