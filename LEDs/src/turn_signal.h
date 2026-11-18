#pragma once

#include <Arduino.h>

#include <FastLED.h>

using namespace fl;

const int MODE_FADE_IN = 0;
const int MODE_FULL = 1;
const int MODE_FADE_OUT = 2;
const int MODE_OFF = 3;
int DURATIONS[] = {
    60,
    250,
    256,
    250};

int mode = MODE_FADE_IN;

class TurnSignal
{
private:
    unsigned long modeStart = 0;
    int scale255(int val, int valmax)
    {
        return 256 * val / valmax;
    }
    CRGB* leds;
    uint8_t numLeds;
    int signalPin;

public:
    TurnSignal(uint8_t _numLeds, CRGB* _leds, int _signalPin) {
        numLeds = _numLeds;
        leds = _leds;
        signalPin = _signalPin;
        pinMode(signalPin, OUTPUT);
    }

    void start()
    {
        modeStart = millis();
        fill_solid(leds, numLeds, CHSV(HUE_ORANGE - 10, 255, 255));
    }

    void stop() {
        analogWrite(signalPin, 0);
        fill_solid(leds, numLeds, 0);
    }

    void render();
};

void TurnSignal::render()
{

    int delta = millis() - modeStart;

    if (delta >= DURATIONS[mode])
    {
        mode = (mode + 1) % 4;
        modeStart = millis();
        delta = 0;
    }

    const int duration = DURATIONS[mode];

    // int color = HUE_ORANGE + 5;// + 25;
    uint8_t value = 255;
    switch (mode)
    {
    case MODE_FADE_IN:
        value = scale255(delta, duration);
    
        // fill_solid(leds, numLeds, CHSV(color, 255, scale255(delta, duration)));
        // fill_solid(leds, numLeds, CHSV(color, 255, 255));
        break;
    // case MODE_FULL:
    // FastLED.setBrightness(255);
        // fill_solid(leds, numLeds, CHSV(color, 255, 255));
        // break;
    case MODE_FADE_OUT:
    value = 255 -scale255(delta, duration);
    // fill_solid(leds, numLeds, CHSV(color, 255, 255));
    // fill_solid(leds, numLeds, CHSV(color, 255, scale255(delta, -duration)));
        break;
    case MODE_OFF:
    value = 0;
        // fill_solid(leds, numLeds, 0);
        break;
    }
    FastLED.setBrightness(value);
    analogWrite(signalPin, value);
}
