#pragma once

// Pull in FastLED first so its internal WASM/stub Arduino.h is processed cleanly
// before we install our interactive GPIO & Serial overrides for sketch code.
#include <FastLED.h>

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

extern "C" {
void sim_pinMode(int pin, int mode);
int sim_digitalRead(int pin);
void sim_digitalWrite(int pin, int val);
void sim_analogWrite(int pin, int val);
void sim_serial_write_str(const char* s);
void sim_serial_write_newline();
}

class SimSerialPort {
public:
    void begin(unsigned long) {}
    void end() {}

    void print(const char* s) {
        if (s) sim_serial_write_str(s);
    }
    void print(char c) {
        char buf[2] = {c, '\0'};
        sim_serial_write_str(buf);
    }
    void print(int v) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%d", v);
        sim_serial_write_str(buf);
    }
    void print(unsigned int v) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%u", v);
        sim_serial_write_str(buf);
    }
    void print(long v) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%ld", v);
        sim_serial_write_str(buf);
    }
    void print(unsigned long v) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%lu", v);
        sim_serial_write_str(buf);
    }
    void print(double v, int digits = 2) {
        char buf[64];
        snprintf(buf, sizeof(buf), "%.*f", digits, v);
        sim_serial_write_str(buf);
    }

    void println() {
        sim_serial_write_newline();
    }
    template <typename T>
    void println(T v) {
        print(v);
        sim_serial_write_newline();
    }
};

extern SimSerialPort SimSerial;

using u8 = uint8_t;
using u16 = uint16_t;
using u32 = uint32_t;

#ifdef constrain
#undef constrain
#endif
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))

#ifdef pinMode
#undef pinMode
#endif
#define pinMode sim_pinMode

#ifdef digitalRead
#undef digitalRead
#endif
#define digitalRead sim_digitalRead

#ifdef digitalWrite
#undef digitalWrite
#endif
#define digitalWrite sim_digitalWrite

#ifdef analogWrite
#undef analogWrite
#endif
#define analogWrite sim_analogWrite

#ifdef Serial
#undef Serial
#endif
#define Serial SimSerial
