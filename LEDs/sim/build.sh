#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -d "${PROJECT_ROOT}/.pio/libdeps/nano/FastLED/src" ]]; then
  FASTLED_SRC="${PROJECT_ROOT}/.pio/libdeps/nano/FastLED/src"
elif [[ -d "${PROJECT_ROOT}/.pio/libdeps/uno/FastLED/src" ]]; then
  FASTLED_SRC="${PROJECT_ROOT}/.pio/libdeps/uno/FastLED/src"
else
  echo "Error: FastLED library not found under .pio/libdeps/. Run 'pio pkg install' first." >&2
  exit 1
fi

DIST_DIR="${SCRIPT_DIR}/dist"
CACHE_DIR="${DIST_DIR}/.cache"
FASTLED_LIB="${CACHE_DIR}/libfastled_wasm.a"

mkdir -p "${DIST_DIR}" "${CACHE_DIR}"

COMMON_FLAGS=(
  -std=gnu++17
  -O2
  -fpermissive
  -DFASTLED_USE_PROGMEM=0
  -I"${SCRIPT_DIR}/include"
  -I"${PROJECT_ROOT}/src"
  -I"${FASTLED_SRC}"
)

# Build and cache FastLED static archive once (pass --clean to force rebuild)
if [[ "${1:-}" == "--clean" ]] || [[ ! -f "${FASTLED_LIB}" ]]; then
  echo "Compiling FastLED WASM core archive (cached for fast incremental builds)..."
  FASTLED_SOURCES=(
    "${FASTLED_SRC}/FastLED.cpp"
    "${FASTLED_SRC}/bitswap.cpp"
    "${FASTLED_SRC}/cled_controller.cpp"
    "${FASTLED_SRC}/colorpalettes.cpp"
    "${FASTLED_SRC}/crgb.cpp"
    "${FASTLED_SRC}/hsv2rgb.cpp"
    "${FASTLED_SRC}/lib8tion.cpp"
    "${FASTLED_SRC}/noise.cpp"
    "${FASTLED_SRC}/power_mgt.cpp"
    "${FASTLED_SRC}/wiring.cpp"
    "${FASTLED_SRC}/fl/allocator.cpp"
    "${FASTLED_SRC}/fl/engine_events.cpp"
    "${FASTLED_SRC}/fl/fill.cpp"
    "${FASTLED_SRC}/fl/colorutils.cpp"
    "${FASTLED_SRC}/fl/rgbw.cpp"
  )
  OBJ_FILES=()
  for src in "${FASTLED_SOURCES[@]}"; do
    base="$(basename "${src}" .cpp)"
    obj="${CACHE_DIR}/${base}.o"
    em++ "${COMMON_FLAGS[@]}" -c "${src}" -o "${obj}"
    OBJ_FILES+=("${obj}")
  done
  emar rcs "${FASTLED_LIB}" "${OBJ_FILES[@]}"
fi

echo "Building WASM simulator from src/main.cpp..."
em++ "${COMMON_FLAGS[@]}" \
  "${PROJECT_ROOT}/src/main.cpp" \
  "${SCRIPT_DIR}/sim_bridge.cpp" \
  "${FASTLED_LIB}" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createLedSimModule \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","UTF8ToString"]' \
  -o "${DIST_DIR}/led_sim.js"

echo "Done! Generated:"
ls -lh "${DIST_DIR}/led_sim.js" "${DIST_DIR}/led_sim.wasm"
echo ""
echo "Serve with: python3 -m http.server 8000 --directory sim"
echo "Then open:  http://localhost:8000"
