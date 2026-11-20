#include <Arduino.h>
#include <algorithm>
#include <cmath>
#include <emscripten.h>
#include <string>

#include "wheel_speed.h"

// Declarations from src/main.cpp
extern void setup();
extern void loop();
extern WheelSpeedSensor wheelSpeed;

SimSerialPort SimSerial;

#ifdef Serial
#undef Serial
#endif
// Stub Serial instance expected if any FastLED translation unit references it
SerialEmulation Serial;

namespace {

constexpr int MAX_PINS = 32;
constexpr int MAX_LEDS_PER_STRIP = 512;

int g_pin_mode[MAX_PINS] = {0};
int g_pin_digital_out[MAX_PINS] = {0};
int g_pin_external_in[MAX_PINS] = {0};
bool g_pin_external_set[MAX_PINS] = {false};
int g_pin_analog_out[MAX_PINS] = {0};

uint8_t g_strip_rgb[MAX_PINS][MAX_LEDS_PER_STRIP * 3] = {{0}};
int g_strip_len[MAX_PINS] = {0};

double g_sim_time_ms = 0.0;
uint32_t g_show_count = 0;
std::string g_serial_line_buf;

// Simulated 26" rear wheel spoke magnet (radius = 200mm, tire outer radius = 335mm)
constexpr int HALL_SENSOR_PIN = 7;
constexpr double WHEEL_CIRCUMFERENCE_M = 2.0 * 3.14159265358979323846 * 0.335;
constexpr double MPH_TO_MPS = 0.44704;
// ~18mm effective Hall trigger arc along the 2*pi*200mm (1256.6mm) spoke magnet path
constexpr double MAGNET_TRIGGER_ARC_FRAC = 18.0 / (2.0 * 3.14159265358979323846 * 200.0);
// Realistic cargo bike acceleration & braking rates
constexpr double MAX_ACCEL_MPH_PER_S = 4.2;
constexpr double MAX_DECEL_MPH_PER_S = 6.5;

double g_target_wheel_mph = 0.0;
double g_actual_wheel_mph = 0.0;
double g_wheel_phase = 0.25; // Start away from sensor (sensor at phase 0.0)
bool g_wheel_magnet_active = false;

void advance_simulated_wheel(double dt_ms) {
    if (dt_ms <= 0.0) return;

    double diff = g_target_wheel_mph - g_actual_wheel_mph;
    if (std::fabs(diff) > 1e-6) {
        double dt_s = dt_ms / 1000.0;
        double base_rate = (diff > 0.0) ? MAX_ACCEL_MPH_PER_S : MAX_DECEL_MPH_PER_S;
        // Smooth ease-out within 1.8 mph of target
        double ease = std::min(1.0, std::fabs(diff) / 1.8);
        double rate = std::max(0.6, base_rate * ease);
        double max_step = rate * dt_s;
        if (std::fabs(diff) <= max_step) {
            g_actual_wheel_mph = g_target_wheel_mph;
        } else {
            g_actual_wheel_mph += (diff > 0.0 ? max_step : -max_step);
        }
    }

    if (g_actual_wheel_mph <= 0.0) {
        g_actual_wheel_mph = 0.0;
        g_wheel_magnet_active = false;
        return;
    }

    double speed_mps = g_actual_wheel_mph * MPH_TO_MPS;
    double revs_per_ms = (speed_mps / WHEEL_CIRCUMFERENCE_M) / 1000.0;
    double d_phase = revs_per_ms * dt_ms;
    double next_phase = g_wheel_phase + d_phase;
    bool crossed_sensor = (next_phase >= 1.0);
    g_wheel_phase = std::fmod(next_phase, 1.0);
    g_wheel_magnet_active = crossed_sensor || (g_wheel_phase < MAGNET_TRIGGER_ARC_FRAC);
}

} // namespace

EM_JS(void, js_emit_serial_line, (const char* line, uint32_t ms), {
    if (typeof Module !== 'undefined' && typeof Module.onSerialLine === 'function') {
        Module.onSerialLine(UTF8ToString(line), ms >>> 0);
    }
});

extern "C" {

// --- Arduino timing overrides ---

EMSCRIPTEN_KEEPALIVE uint32_t millis() {
    return static_cast<uint32_t>(g_sim_time_ms);
}

EMSCRIPTEN_KEEPALIVE uint32_t micros() {
    return static_cast<uint32_t>(g_sim_time_ms * 1000.0);
}

EMSCRIPTEN_KEEPALIVE void delay(int ms) {
    if (ms > 0) {
        g_sim_time_ms += static_cast<double>(ms);
    }
}

EMSCRIPTEN_KEEPALIVE void delayMicroseconds(int us) {
    if (us > 0) {
        g_sim_time_ms += static_cast<double>(us) / 1000.0;
    }
}

EMSCRIPTEN_KEEPALIVE void yield() {}

// --- Virtual GPIO & Serial hooks ---

void sim_pinMode(int pin, int mode) {
    if (pin < 0 || pin >= MAX_PINS) return;
    g_pin_mode[pin] = mode;
    if (mode == INPUT_PULLUP && !g_pin_external_set[pin]) {
        g_pin_external_in[pin] = HIGH;
    }
}

int sim_digitalRead(int pin) {
    if (pin < 0 || pin >= MAX_PINS) return LOW;
    if (g_pin_mode[pin] == OUTPUT) {
        return g_pin_digital_out[pin];
    }
    if (pin == HALL_SENSOR_PIN && g_wheel_magnet_active) {
        return LOW;
    }
    if (!g_pin_external_set[pin] && g_pin_mode[pin] == INPUT_PULLUP) {
        return HIGH;
    }
    return g_pin_external_in[pin];
}

void sim_digitalWrite(int pin, int val) {
    if (pin < 0 || pin >= MAX_PINS) return;
    g_pin_digital_out[pin] = val ? HIGH : LOW;
    g_pin_analog_out[pin] = val ? 255 : 0;
}

void sim_analogWrite(int pin, int val) {
    if (pin < 0 || pin >= MAX_PINS) return;
    if (val < 0) val = 0;
    if (val > 255) val = 255;
    g_pin_analog_out[pin] = val;
    g_pin_digital_out[pin] = (val >= 128) ? HIGH : LOW;
}

void sim_serial_write_str(const char* s) {
    if (!s) return;
    while (*s) {
        if (*s == '\n') {
            js_emit_serial_line(g_serial_line_buf.c_str(), millis());
            g_serial_line_buf.clear();
        } else if (*s != '\r') {
            g_serial_line_buf.push_back(*s);
        }
        ++s;
    }
}

void sim_serial_write_newline() {
    js_emit_serial_line(g_serial_line_buf.c_str(), millis());
    g_serial_line_buf.clear();
}

// --- Clockless strip capture hooks ---

void sim_begin_strip_frame(int data_pin, int num_leds) {
    if (data_pin < 0 || data_pin >= MAX_PINS) return;
    if (num_leds > MAX_LEDS_PER_STRIP) num_leds = MAX_LEDS_PER_STRIP;
    g_strip_len[data_pin] = num_leds;
}

void sim_set_strip_pixel(int data_pin, int index, uint8_t r, uint8_t g, uint8_t b) {
    if (data_pin < 0 || data_pin >= MAX_PINS) return;
    if (index < 0 || index >= MAX_LEDS_PER_STRIP) return;
    int base = index * 3;
    g_strip_rgb[data_pin][base + 0] = r;
    g_strip_rgb[data_pin][base + 1] = g;
    g_strip_rgb[data_pin][base + 2] = b;
}

void sim_end_strip_frame(int data_pin) {
    if (data_pin == 6) {
        // Count once per left-strip latch (FastLED.show())
        g_show_count++;
    }
}

// --- Exported WebAssembly control & inspection API ---

EMSCRIPTEN_KEEPALIVE void sim_init() {
    for (int i = 0; i < MAX_PINS; ++i) {
        g_pin_mode[i] = INPUT;
        g_pin_digital_out[i] = LOW;
        g_pin_external_in[i] = HIGH; // Pullup-friendly default
        g_pin_external_set[i] = false;
        g_pin_analog_out[i] = 0;
        g_strip_len[i] = 0;
    }
    g_sim_time_ms = 0.0;
    g_show_count = 0;
    g_serial_line_buf.clear();
    g_actual_wheel_mph = 0.0;
    g_wheel_phase = 0.25;
    g_wheel_magnet_active = false;

    setup();
    // Avoid microsecond spin-wait inside CFastLED::show() in simulated time
    FastLED.setMaxRefreshRate(0, false);
    // Run initial tick so initial strip state is populated
    loop();
}

EMSCRIPTEN_KEEPALIVE void sim_step(double delta_ms) {
    if (delta_ms <= 0.0) {
        loop();
        return;
    }
    // Cap single frame jump so tab backgrounding doesn't stall
    if (delta_ms > 250.0) {
        delta_ms = 250.0;
    }
    // Step in 1ms increments so EVERY_N_MILLIS(20), Hall sensor pulses, and 50ms
    // button debouncing behave identically to hardware polling at >=1kHz.
    double target = g_sim_time_ms + delta_ms;
    while (g_sim_time_ms + 1.0 <= target) {
        g_sim_time_ms += 1.0;
        advance_simulated_wheel(1.0);
        loop();
    }
    double rem = target - g_sim_time_ms;
    if (rem > 1e-6) {
        g_sim_time_ms = target;
        advance_simulated_wheel(rem);
        loop();
    }
}

EMSCRIPTEN_KEEPALIVE void sim_set_wheel_speed_mph(double mph) {
    g_target_wheel_mph = (mph > 0.0) ? mph : 0.0;
}

EMSCRIPTEN_KEEPALIVE double sim_get_actual_wheel_speed_mph() {
    return g_actual_wheel_mph;
}

EMSCRIPTEN_KEEPALIVE double sim_get_wheel_phase() {
    return g_wheel_phase;
}

EMSCRIPTEN_KEEPALIVE void sim_set_input_pin(int pin, int level) {
    if (pin < 0 || pin >= MAX_PINS) return;
    g_pin_external_set[pin] = true;
    g_pin_external_in[pin] = level ? HIGH : LOW;
}

EMSCRIPTEN_KEEPALIVE int sim_get_pin_digital(int pin) {
    return sim_digitalRead(pin);
}

EMSCRIPTEN_KEEPALIVE int sim_get_pin_analog(int pin) {
    if (pin < 0 || pin >= MAX_PINS) return 0;
    return g_pin_analog_out[pin];
}

EMSCRIPTEN_KEEPALIVE int sim_get_pin_mode(int pin) {
    if (pin < 0 || pin >= MAX_PINS) return 0;
    return g_pin_mode[pin];
}

EMSCRIPTEN_KEEPALIVE const uint8_t* sim_get_strip_rgb(int data_pin) {
    if (data_pin < 0 || data_pin >= MAX_PINS) return nullptr;
    return g_strip_rgb[data_pin];
}

EMSCRIPTEN_KEEPALIVE int sim_get_strip_len(int data_pin) {
    if (data_pin < 0 || data_pin >= MAX_PINS) return 0;
    return g_strip_len[data_pin];
}

EMSCRIPTEN_KEEPALIVE int sim_get_brightness() {
    return static_cast<int>(FastLED.getBrightness());
}

EMSCRIPTEN_KEEPALIVE uint32_t sim_get_show_count() {
    return g_show_count;
}

EMSCRIPTEN_KEEPALIVE double sim_get_estimated_velocity_mph() {
    return static_cast<double>(wheelSpeed.getVelocityMph());
}

} // extern "C"
