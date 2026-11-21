#include <Arduino.h>

#include <FastLED.h>

#include "effects.h"
#include "light_state.h"
#include "turn_signal.h"
#include "turn_signal_button.h"
#include "wheel_speed.h"

using namespace fl;

// // Configuration
#define LED_PIN     6
#define RIGHT_LEDS  4
#define FRONT_LEDS  8
#define NUM_LEDS    144
#define NUM_FRONT_LEDS 144
#define LED_TYPE    WS2815
#define COLOR_ORDER GRB
#define CHIPSET     WS2815

#define REAR_SIGNAL_TRANSISTOR_LEFT 9  
#define REAR_SIGNAL_TRANSISTOR_RIGHT 10

#define LEFT_BUTTON 2
#define RIGHT_BUTTON 3

#define HALL_SENSOR 7

#define DEFAULT_BRIGHTNESS 255

unsigned long lastTurnSignal = 0;
unsigned long turnSignalDuration = 3000;

// LED array
CRGB ledsLeft[NUM_LEDS];
CRGB ledsRight[NUM_LEDS];
CRGB ledsFront[NUM_FRONT_LEDS];

TurnSignal leftTurnSignal(NUM_LEDS, ledsLeft, REAR_SIGNAL_TRANSISTOR_LEFT);
TurnSignal rightTurnSignal(NUM_LEDS, ledsRight, REAR_SIGNAL_TRANSISTOR_RIGHT);
TurnSignalButton leftTurnSignalButton(LEFT_BUTTON);
TurnSignalButton rightTurnSignalButton(RIGHT_BUTTON);
WheelSpeedSensor wheelSpeed(HALL_SENSOR);
VelocityEffects velocityEffects;
EffectMode currentEffect = EffectMode::RAINBOW_COMET;

enum class SignalState {
  NONE,
  LEFT,
  RIGHT
};

SignalState currentSignal = SignalState::NONE;
unsigned long turnSignalEnd = 0;

void stopTurnSignal() {
  currentSignal = SignalState::NONE;
  FastLED.setBrightness(DEFAULT_BRIGHTNESS);
  leftTurnSignal.stop();
  rightTurnSignal.stop();
}

// Callback invoked on debounced press
void onLeftButtonPressed() {
  Serial.println(F("Callback: button press registered"));
  rightTurnSignal.stop();
  switch (currentSignal) {
    case SignalState::NONE:
      leftTurnSignal.start();
      currentSignal = SignalState::LEFT;
      break;
    case SignalState::RIGHT:
      stopTurnSignal();
      break;
  }
  turnSignalEnd = millis() + 5000UL; // 5 seconds
}

void onRightButtonPressed() {
  Serial.println(F("Callback: right button press registered"));
  leftTurnSignal.stop();
  switch (currentSignal) {
    case SignalState::NONE:
      rightTurnSignal.start();
      currentSignal = SignalState::RIGHT;
    break;
    case SignalState::LEFT:
      stopTurnSignal();
      break;
  }
  turnSignalEnd = millis() + 5000UL; // 5 seconds
}

void renderComet(int position) {
    fill_solid(ledsLeft, NUM_LEDS, CRGB::Black);
    fill_solid(ledsRight, NUM_LEDS, CRGB::Black);

    // comet
    int cometLength = NUM_LEDS / 10;
    int head = NUM_LEDS - 1 - position;
    for (int i = 0; i < cometLength; i++) {
        int ledIndex = head + i;
        if (ledIndex >= NUM_LEDS) {
            ledIndex -= NUM_LEDS;
        }
        if (ledIndex < NUM_LEDS) {
            uint8_t brightness = map(i, 0, cometLength - 1, 255, 0);
            ledsLeft[ledIndex] = CHSV(0, 0, brightness);
            ledsRight[ledIndex] = CHSV(0, 0, brightness);
        }
    }

    // rainbow tail
    int rainbowLength = NUM_LEDS * 3 / 8;
    for (int i = 0; i < rainbowLength; i++) {
        int ledIndex = head + cometLength + i - 1;
        if (ledIndex >= NUM_LEDS) {
            ledIndex -= NUM_LEDS;
        }
        if (ledIndex < NUM_LEDS) {
            uint8_t hue = map(i, 0, rainbowLength - 1, 0, 255);
            //map(i, 0, rainbowLength - 1, 128, 0);
            uint8_t brightness = constrain(inoise8(i * 20, millis() / 5), 0, 255);
            ledsLeft[ledIndex] = CHSV(hue, 255, brightness);
            ledsRight[ledIndex] = ledsLeft[ledIndex];
        }
    }
}

void setup() {
    Serial.begin(9600);
    Serial.println(F("Starting up!"));
    // Initialize FastLED
    FastLED.addLeds<LED_TYPE, LED_PIN, COLOR_ORDER>(ledsLeft, NUM_LEDS);
    FastLED.addLeds<LED_TYPE, RIGHT_LEDS, COLOR_ORDER>(ledsRight, NUM_LEDS);
    FastLED.addLeds<LED_TYPE, FRONT_LEDS, COLOR_ORDER>(ledsFront, NUM_FRONT_LEDS);
    FastLED.setBrightness(DEFAULT_BRIGHTNESS);
    fill_solid(ledsFront, NUM_FRONT_LEDS, CRGB::Black);
    // FastLED.setGammaFunction(::GammaCorrect);

    leftTurnSignalButton.setCallback(onLeftButtonPressed);
    rightTurnSignalButton.setCallback(onRightButtonPressed);

    wheelSpeed.begin();

    // fill_rainbow(leds, NUM_LEDS, 0, 7);
    // int rainbowLength = NUM_LEDS / 3;
        // fill_rainbow(ledsRight, rainbowLength, 0, 256/rainbowLength);
        // fill_rainbow(leds, rainbowLength, -20, -256/rainbowLength);
        
        // FastLED.show();
}

LightState breathe() {
  LightState state;
  uint8_t value = beatsin8(25, 0, 255);
  uint8_t minBrightness = 40;
  uint8_t brightness = map(value, 0, 255, minBrightness, 255);
  uint8_t hue = map(brightness, minBrightness, 255, 160, 210);
  uint8_t middleWidth = map(value, 0, 255, 3 * NUM_LEDS / 4, NUM_LEDS / 5);
  state.color = CHSV(hue, 123, brightness);
  state.gradientLength = (NUM_LEDS - middleWidth) / 2;
  state.start = state.gradientLength;
  state.length = NUM_LEDS - state.gradientLength * 2;
  return state;
}

void render(LightState& state) {
  fill_solid(ledsLeft, NUM_LEDS, 0);
  fill_solid(ledsLeft + state.start, state.length, state.color);
  for (int i = 0; i < state.gradientLength; i++) {
    uint8_t ledBrightness = map(i, 0, state.gradientLength, 0, state.color.v);

    CHSV color = CHSV(state.color.h, state.color.s, ledBrightness);
    ledsLeft[i] = color;
    ledsLeft[NUM_LEDS - i - 1] = color;
  }
  memcpy(ledsRight, ledsLeft, NUM_LEDS * sizeof(CRGB));
}

void loop() {
  wheelSpeed.update();

  EVERY_N_MILLIS(20) {
    rightTurnSignalButton.update();
    leftTurnSignalButton.update();

    float currentMph = wheelSpeed.getVelocityMph();
    velocityEffects.stepPhysics(currentMph, NUM_LEDS);

    // If a turn signal is active, render it and skip other animations
    if (currentSignal != SignalState::NONE) {
      if (millis() < turnSignalEnd) {
        if (currentSignal == SignalState::LEFT) {
          leftTurnSignal.render();
        } else if (currentSignal == SignalState::RIGHT) {
          rightTurnSignal.render();
        }
      } else {
        stopTurnSignal();
      }
    } else if (currentEffect == EffectMode::RAINBOW_COMET) {
      renderComet((millis() / 10) % NUM_LEDS);
    } else {
      velocityEffects.renderEffect(currentEffect, ledsLeft, ledsRight, NUM_LEDS, currentMph);
    }

    // Front arch strip stays off for now
    fill_solid(ledsFront, NUM_FRONT_LEDS, CRGB::Black);

    FastLED.show();
  }
}
