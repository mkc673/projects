#pragma once

#include "fl/stdint.h"
#include "crgb.h"
#include "eorder.h"
#include "fl/namespace.h"
#include "pixel_controller.h"
#include "pixel_iterator.h"

extern "C" {
void sim_begin_strip_frame(int data_pin, int num_leds);
void sim_set_strip_pixel(int data_pin, int index, uint8_t r, uint8_t g, uint8_t b);
void sim_end_strip_frame(int data_pin);
}

FASTLED_NAMESPACE_BEGIN

#define FASTLED_HAS_CLOCKLESS 1

template <int DATA_PIN, int T1, int T2, int T3, EOrder RGB_ORDER = RGB,
          int XTRA0 = 0, bool FLIP = false, int WAIT_TIME = 0>
class ClocklessController : public CPixelLEDController<RGB_ORDER> {
public:
    virtual void init() {}

protected:
    virtual void showPixels(PixelController<RGB_ORDER>& pixels) {
        pixels.disableColorAdjustment();
        PixelController<RGB> pixels_rgb = pixels;
        auto iterator = pixels_rgb.as_iterator(fl::RgbwInvalid());
        int count = static_cast<int>(iterator.size());
        sim_begin_strip_frame(DATA_PIN, count);
        int idx = 0;
        while (iterator.has(1)) {
            uint8_t r, g, b;
            iterator.loadAndScaleRGB(&r, &g, &b);
            sim_set_strip_pixel(DATA_PIN, idx++, r, g, b);
            iterator.advanceData();
        }
        sim_end_strip_frame(DATA_PIN);
    }
};

FASTLED_NAMESPACE_END
