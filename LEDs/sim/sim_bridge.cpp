#include <Arduino.h>
#include <emscripten.h>
#include <string>

// Declarations from src/main.cpp
extern void setup();
extern void loop();

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
    // Step in 1ms increments so EVERY_N_MILLIS(20) and 50ms button debouncing
    // behave identically to hardware polling at >=1kHz.
    double target = g_sim_time_ms + delta_ms;
    while (g_sim_time_ms + 1.0 <= target) {
        g_sim_time_ms += 1.0;
        loop();
    }
    double rem = target - g_sim_time_ms;
    if (rem > 1e-6) {
        g_sim_time_ms = target;
        loop();
    }
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

} // extern "C"
