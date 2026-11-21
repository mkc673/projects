# Bike LEDs — WebAssembly Simulator

Runs the exact firmware in `../src/main.cpp` (+ FastLED 3.10.3) compiled to WebAssembly via Emscripten (`em++`), with virtual Arduino GPIO pins and HTML5 Canvas rendering.

## Build & Run

From the project root:

```bash
./sim/build.sh
python3 -m http.server 8000 --directory sim
```

Then open **http://localhost:8000** in your browser.

Whenever you edit `src/main.cpp` or any header in `src/`, re-run `./sim/build.sh` and refresh the page.

## Controls & Pin Mapping

| Control | Shortcut | Simulated Pin | Behavior |
|---|---|---|---|
| **Left Turn Signal** | `A` or `←` | `D2` (`INPUT_PULLUP`) | Pulls `D2` `LOW` through `TurnSignalButton` (50ms debounce) |
| **Right Turn Signal** | `D` or `→` | `D3` (`INPUT_PULLUP`) | Pulls `D3` `LOW` through `TurnSignalButton` (50ms debounce) |
| **Rear Wheel Speed Slider** | — | `D7` (`INPUT_PULLUP`) | Spins the 26" rear wheel (`0–30 mph`) and pulses `D7` `LOW` on each spoke-magnet pass |
| **Left WS2815 Strip** | — | `D6` | 144 GRB pixels along bottom-left of cargo box |
| **Front Arch WS2815 Strip** | — | `D8` | 144 GRB pixels wrapping the front white frame arch |
| **Right WS2815 Strip** | — | `D4` | 144 GRB pixels along bottom-right of cargo box |
| **Rear Transistors** | — | `D9` / `D10` | Displays `analogWrite()` PWM duty cycle (`0–255`) |
| **Pause / Resume** | `Space` | — | Freezes simulated `millis()` clock (`+20ms` steps 1 frame) |
| **Reset MCU** | `R` | — | Re-instantiates a fresh WASM MCU state and runs `setup()` |
