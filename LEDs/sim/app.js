(() => {
  const PINS = {
    LEFT_BUTTON: 2,
    RIGHT_BUTTON: 3,
    RIGHT_STRIP: 4,
    LEFT_STRIP: 6,
    HALL_SENSOR: 7,
    REAR_LEFT_PWM: 9,
    REAR_RIGHT_PWM: 10,
  };

  // Minimum low pulse (ms of simulated time) so quick trackpad taps cross
  // TurnSignalButton's 50ms hardware debounce window sampled every 20ms.
  const MIN_BUTTON_HOLD_MS = 90;

  const canvas = document.getElementById('ledCanvas');
  const ctx = canvas.getContext('2d');

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const layoutSelect = document.getElementById('layoutSelect');
  const speedSelect = document.getElementById('speedSelect');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const stepBtn = document.getElementById('stepBtn');
  const resetBtn = document.getElementById('resetBtn');

  const leftTurnBtn = document.getElementById('leftTurnBtn');
  const rightTurnBtn = document.getElementById('rightTurnBtn');
  const wheelSpeedSlider = document.getElementById('wheelSpeedSlider');
  const wheelSpeedLabel = document.getElementById('wheelSpeedLabel');
  const wheelSpeedFill = document.getElementById('wheelSpeedFill');
  const wheelSpeedGhost = document.getElementById('wheelSpeedGhost');
  const estSpeedLabel = document.getElementById('estSpeedLabel');
  const estSpeedFill = document.getElementById('estSpeedFill');
  const estSpeedThumb = document.getElementById('estSpeedThumb');

  const statMillis = document.getElementById('statMillis');
  const statBrightness = document.getElementById('statBrightness');
  const statShowHz = document.getElementById('statShowHz');
  const statFrames = document.getElementById('statFrames');

  const pinEls = {
    2: document.getElementById('pinD2'),
    3: document.getElementById('pinD3'),
    7: document.getElementById('pinD7'),
    9: document.getElementById('pinD9'),
    10: document.getElementById('pinD10'),
  };

  const serialLog = document.getElementById('serialLog');
  const collapseSerial = document.getElementById('collapseSerial');
  const clearSerialBtn = document.getElementById('clearSerialBtn');

  let wasm = null;
  let api = null;
  let running = true;
  let lastWallTime = null;
  let groundDistanceMeters = 0;

  // Interactive centered camera zoom state (mouse wheel, trackpad pinch, touch pinch)
  const MIN_ZOOM = 0.18;
  const camera = { zoom: 1.0 };
  let pinchPrevDist = null;
  let isTouchPinching = false;
  let lastWheelZoomWall = 0;
  let lastCameraWall = null;

  // Show-rate estimation
  let lastRateCheckWall = performance.now();
  let lastShowCount = 0;
  let measuredShowHz = 0;

  // Button hold states (supporting both continuous press and quick tap minimum hold)
  const buttonState = {
    [PINS.LEFT_BUTTON]: { pointerDown: false, keyDown: false, releaseAtSimMs: 0, el: leftTurnBtn },
    [PINS.RIGHT_BUTTON]: { pointerDown: false, keyDown: false, releaseAtSimMs: 0, el: rightTurnBtn },
  };

  // Serial log state
  const MAX_SERIAL_ENTRIES = 120;
  let lastSerialItem = null;

  function appendSerialLine(text, simMs) {
    if (collapseSerial.checked && lastSerialItem && lastSerialItem.text === text) {
      lastSerialItem.count++;
      lastSerialItem.tsEl.textContent = `[${(simMs / 1000).toFixed(2)}s]`;
      lastSerialItem.countEl.style.display = 'inline-block';
      lastSerialItem.countEl.textContent = `×${lastSerialItem.count}`;
      return;
    }

    const row = document.createElement('div');
    row.className = 'serial-entry';

    const tsEl = document.createElement('span');
    tsEl.className = 'serial-ts';
    tsEl.textContent = `[${(simMs / 1000).toFixed(2)}s]`;

    const msgEl = document.createElement('span');
    msgEl.className = 'serial-msg';
    msgEl.textContent = text;

    const countEl = document.createElement('span');
    countEl.className = 'serial-count';
    countEl.style.display = 'none';

    row.appendChild(tsEl);
    row.appendChild(msgEl);
    row.appendChild(countEl);

    const stickToBottom = serialLog.scrollHeight - serialLog.scrollTop - serialLog.clientHeight < 36;
    serialLog.appendChild(row);

    while (serialLog.childElementCount > MAX_SERIAL_ENTRIES) {
      serialLog.removeChild(serialLog.firstElementChild);
    }

    if (stickToBottom) {
      serialLog.scrollTop = serialLog.scrollHeight;
    }

    lastSerialItem = { text, count: 1, tsEl, countEl };
  }

  clearSerialBtn.addEventListener('click', () => {
    serialLog.innerHTML = '';
    lastSerialItem = null;
  });

  function syncInputPins() {
    if (!api) return;
    const nowSim = api.millis();

    for (const pin of [PINS.LEFT_BUTTON, PINS.RIGHT_BUTTON]) {
      const st = buttonState[pin];
      const active = st.pointerDown || st.keyDown || nowSim < st.releaseAtSimMs;
      api.setInputPin(pin, active ? 0 : 1); // INPUT_PULLUP: 0 = pressed, 1 = idle
      st.el.classList.toggle('pressed', active);
    }
  }

  function wireMomentaryButton(pin) {
    const st = buttonState[pin];
    const el = st.el;

    const press = (e) => {
      e.preventDefault();
      st.pointerDown = true;
      if (api) {
        st.releaseAtSimMs = api.millis() + MIN_BUTTON_HOLD_MS;
      }
      syncInputPins();
    };

    const release = () => {
      st.pointerDown = false;
      syncInputPins();
    };

    el.addEventListener('pointerdown', press);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }

  wireMomentaryButton(PINS.LEFT_BUTTON);
  wireMomentaryButton(PINS.RIGHT_BUTTON);

  function updateWheelSliderVisuals(estMphOverride = null) {
    const maxMph = parseFloat(wheelSpeedSlider.max) || 30;
    const targetMph = parseFloat(wheelSpeedSlider.value) || 0;
    const actualMph = api && api.getActualWheelSpeedMph ? api.getActualWheelSpeedMph() : 0;
    const estMph =
      estMphOverride !== null
        ? estMphOverride
        : api && api.getEstimatedVelocityMph
          ? api.getEstimatedVelocityMph()
          : 0;

    const actualPct = Math.max(0, Math.min(100, (actualMph / maxMph) * 100));
    const targetPct = Math.max(0, Math.min(100, (targetMph / maxMph) * 100));

    wheelSpeedFill.style.width = `${actualPct}%`;
    // Faint preview band when accelerating toward a higher target
    wheelSpeedGhost.style.width = targetPct > actualPct ? `${targetPct}%` : '0%';

    if (Math.abs(actualMph - targetMph) > 0.05) {
      wheelSpeedLabel.textContent = `${actualMph.toFixed(1)} → ${targetMph.toFixed(1)} mph`;
    } else if (targetMph > 0) {
      wheelSpeedLabel.textContent = `${actualMph.toFixed(1)} mph`;
    } else {
      wheelSpeedLabel.textContent = '0.0 mph (Stopped)';
    }

    // Update aligned read-only MCU Estimated Speed slider-like bar immediately below
    const estFrac = Math.max(0, Math.min(1, estMph / maxMph));
    const estPct = estFrac * 100;
    const moving = estMph > 0.01;

    estSpeedFill.style.width = `${estPct}%`;
    estSpeedThumb.style.left = `calc(8px + (100% - 16px) * ${estFrac})`;
    estSpeedThumb.classList.toggle('moving', moving);
    estSpeedLabel.classList.toggle('moving', moving);

    const err = estMph - actualMph;
    if (moving || actualMph > 0.05) {
      const sign = err >= 0 ? '+' : '';
      estSpeedLabel.textContent = `${estMph.toFixed(1)} mph (${sign}${err.toFixed(1)})`;
    } else {
      estSpeedLabel.textContent = '0.0 mph';
    }
  }

  function syncWheelSpeed() {
    const targetMph = parseFloat(wheelSpeedSlider.value) || 0;
    if (api && api.setWheelSpeedMph) {
      api.setWheelSpeedMph(targetMph);
    }
    updateWheelSliderVisuals();
  }

  wheelSpeedSlider.addEventListener('input', syncWheelSpeed);

  // Keyboard controls
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.repeat) return;

    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      buttonState[PINS.LEFT_BUTTON].keyDown = true;
      if (api) buttonState[PINS.LEFT_BUTTON].releaseAtSimMs = api.millis() + MIN_BUTTON_HOLD_MS;
      syncInputPins();
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      buttonState[PINS.RIGHT_BUTTON].keyDown = true;
      if (api) buttonState[PINS.RIGHT_BUTTON].releaseAtSimMs = api.millis() + MIN_BUTTON_HOLD_MS;
      syncInputPins();
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      resetSimulation();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      buttonState[PINS.LEFT_BUTTON].keyDown = false;
      syncInputPins();
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      buttonState[PINS.RIGHT_BUTTON].keyDown = false;
      syncInputPins();
    }
  });

  function togglePlayPause() {
    running = !running;
    playPauseBtn.textContent = running ? '⏸ Pause' : '▶ Resume';
    lastWallTime = null;
  }

  function bootModule() {
    return createLedSimModule({
      onSerialLine(line, simMs) {
        appendSerialLine(line, simMs);
      },
    }).then((mod) => {
      wasm = mod;
      api = {
        init: mod.cwrap('sim_init', null, []),
        step: mod.cwrap('sim_step', null, ['number']),
        setInputPin: mod.cwrap('sim_set_input_pin', null, ['number', 'number']),
        getPinDigital: mod.cwrap('sim_get_pin_digital', 'number', ['number']),
        getPinAnalog: mod.cwrap('sim_get_pin_analog', 'number', ['number']),
        getStripRgb: mod.cwrap('sim_get_strip_rgb', 'number', ['number']),
        getStripLen: mod.cwrap('sim_get_strip_len', 'number', ['number']),
        getBrightness: mod.cwrap('sim_get_brightness', 'number', []),
        getShowCount: mod.cwrap('sim_get_show_count', 'number', []),
        getEstimatedVelocityMph: mod.cwrap('sim_get_estimated_velocity_mph', 'number', []),
        setWheelSpeedMph: mod.cwrap('sim_set_wheel_speed_mph', null, ['number']),
        getActualWheelSpeedMph: mod.cwrap('sim_get_actual_wheel_speed_mph', 'number', []),
        getWheelPhase: mod.cwrap('sim_get_wheel_phase', 'number', []),
        millis: mod.cwrap('millis', 'number', []),
      };

      api.init();
      syncInputPins();
      syncWheelSpeed();
      lastShowCount = api.getShowCount();
      lastRateCheckWall = performance.now();
      measuredShowHz = 0;
    });
  }

  function advanceSimulation(simDeltaMs) {
    const v0 = api.getActualWheelSpeedMph ? api.getActualWheelSpeedMph() : 0;
    syncInputPins();
    api.step(simDeltaMs);
    syncInputPins();
    const v1 = api.getActualWheelSpeedMph ? api.getActualWheelSpeedMph() : 0;
    const avgMps = ((v0 + v1) * 0.5) * 0.44704;
    groundDistanceMeters += avgMps * (simDeltaMs / 1000);
  }

  function resetSimulation() {
    if (!api) return;
    buttonState[PINS.LEFT_BUTTON].releaseAtSimMs = 0;
    buttonState[PINS.RIGHT_BUTTON].releaseAtSimMs = 0;
    lastSerialItem = null;
    serialLog.innerHTML = '';
    lastWallTime = null;
    groundDistanceMeters = 0;
    bootModule().then(() => {
      renderFrame();
    });
  }

  playPauseBtn.addEventListener('click', togglePlayPause);
  stepBtn.addEventListener('click', () => {
    if (!api) return;
    if (running) togglePlayPause();
    advanceSimulation(20.0);
    renderFrame();
  });
  resetBtn.addEventListener('click', resetSimulation);

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(380, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { w, h };
  }

  window.addEventListener('resize', () => {
    if (api) renderFrame();
  });

  function getBikeViewportMetrics(w, h, mode) {
    if (mode === 'side') {
      const bikeRealLenM = 2.68;
      const padLeft = Math.max(88, w * 0.11);
      const padRight = Math.max(44, w * 0.06);
      const maxBikeW = Math.max(320, w - padLeft - padRight);
      const maxBikeH = Math.max(200, h * 0.56);
      const pxPerMeter = Math.min(maxBikeW / bikeRealLenM, maxBikeH / 1.18);
      const totalBikePx = bikeRealLenM * pxPerMeter;
      const xOrigin = (w - totalBikePx) * 0.5 + 22;
      const groundY = Math.min(h - 72, Math.max(h * 0.72, 260));

      const leftEdge = xOrigin - 64; // Includes pivoted rear < turn signal
      const rightEdge = xOrigin + totalBikePx + 10; // Front tire outer edge
      const topEdge = groundY - 1.06 * pxPerMeter - 8; // Top of handlebars
      const bottomEdge = groundY + 24; // Tire contact + under-box label

      const bikeW = Math.max(1, rightEdge - leftEdge);
      const bikeH = Math.max(1, bottomEdge - topEdge);
      const maxFitZoom = Math.max(0.5, Math.min((w - 20) / bikeW, (h - 48) / bikeH));

      return {
        bikeCx: (leftEdge + rightEdge) * 0.5,
        bikeCy: (topEdge + bottomEdge) * 0.5,
        maxFitZoom,
      };
    }

    if (mode === 'bike') {
      const yTop = 34;
      const yBottom = h - 38;
      const boxRearHalfW = Math.min(96, Math.max(62, w * 0.125));
      const bikeW = (boxRearHalfW + 36) * 2;
      const bikeH = Math.max(1, yBottom + 16 - yTop);
      const maxFitZoom = Math.max(0.5, Math.min((w - 24) / bikeW, (h - 48) / bikeH));

      return {
        bikeCx: w * 0.5,
        bikeCy: (yTop + yBottom + 16) * 0.5,
        maxFitZoom,
      };
    }

    // Parallel strips view
    return {
      bikeCx: w * 0.5,
      bikeCy: h * 0.5,
      maxFitZoom: 1.0,
    };
  }

  function resetCamera() {
    camera.zoom = 1.0;
    if (api) renderFrame();
  }

  function applyCenteredZoomFactor(factor) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const { maxFitZoom } = getBikeViewportMetrics(w, h, layoutSelect.value);

    const rawNext = camera.zoom * factor;
    if (rawNext <= maxFitZoom) {
      camera.zoom = Math.max(MIN_ZOOM, rawNext);
    } else {
      // Allow brief elastic overshoot if user zooms in past viewport fit,
      // then spring smoothly back out to maxFitZoom once gesture relaxes.
      const excess = rawNext - maxFitZoom;
      const maxOvershoot = maxFitZoom * 0.45;
      camera.zoom = maxFitZoom + (maxOvershoot * excess) / (excess + maxOvershoot);
    }
    if (api) renderFrame();
  }

  function getVisibleWorldBounds(w, h, bikeCx, bikeCy) {
    return {
      left: bikeCx - (w * 0.5) / camera.zoom,
      right: bikeCx + (w * 0.5) / camera.zoom,
      top: bikeCy - (h * 0.5) / camera.zoom,
      bottom: bikeCy + (h * 0.5) / camera.zoom,
    };
  }

  layoutSelect.addEventListener('change', () => {
    resetCamera();
  });

  // Mouse wheel + desktop trackpad pinch-to-zoom (always centered on bike)
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 120;
      const sensitivity = e.ctrlKey ? 0.01 : 0.0018;
      const factor = Math.exp(-dy * sensitivity);
      lastWheelZoomWall = performance.now();
      applyCenteredZoomFactor(factor);
    },
    { passive: false }
  );

  // Double-click canvas to reset zoom to 100%
  canvas.addEventListener('dblclick', () => {
    resetCamera();
  });

  // Touchscreen 2-finger pinch-to-zoom (centered on bike)
  canvas.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [t0, t1] = e.touches;
        pinchPrevDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        isTouchPinching = true;
      }
    },
    { passive: false }
  );

  canvas.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [t0, t1] = e.touches;
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        if (pinchPrevDist && pinchPrevDist > 4) {
          applyCenteredZoomFactor(dist / pinchPrevDist);
        }
        pinchPrevDist = dist;
        isTouchPinching = true;
      }
    },
    { passive: false }
  );

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      pinchPrevDist = null;
      isTouchPinching = false;
    }
  });
  canvas.addEventListener('touchcancel', () => {
    pinchPrevDist = null;
    isTouchPinching = false;
  });

  function readStripBytes(pin) {
    const len = api.getStripLen(pin) || 144;
    const ptr = api.getStripRgb(pin);
    if (!ptr) return { len, bytes: new Uint8Array(len * 3) };
    return {
      len,
      bytes: wasm.HEAPU8.subarray(ptr, ptr + len * 3),
    };
  }

  function drawGlowingPixel(x, y, radius, r, g, b) {
    const maxCh = Math.max(r, g, b);
    if (maxCh <= 2) {
      ctx.fillStyle = '#141923';
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.82, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Soft additive bloom halo
    const alpha = (maxCh / 255) * 0.42;
    const glowR = radius * 3.2;
    const grad = ctx.createRadialGradient(x, y, radius * 0.2, x, y, glowR);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Bright LED die core
    const coreR = Math.min(255, r + 45);
    const coreG = Math.min(255, g + 45);
    const coreB = Math.min(255, b + 45);
    ctx.fillStyle = `rgb(${coreR}, ${coreG}, ${coreB})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawChevronTurnStrip(
    cx,
    cy,
    dir,
    size,
    label,
    pwmValue,
    labelOffsetY = null,
    scaleX = 1.0
  ) {
    // dir = -1 => '<' pointing left; dir = +1 => '>' pointing right
    const intensity = Math.max(0, Math.min(1, pwmValue / 255));
    const apexX = cx + dir * (size * 0.52 * scaleX);
    const openX = cx - dir * (size * 0.48 * scaleX);
    const armH = size * 0.68;

    const topPt = { x: openX, y: cy - armH };
    const midPt = { x: apexX, y: cy };
    const botPt = { x: openX, y: cy + armH };

    // Wide ambient amber bloom when lit
    if (intensity > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bloomR = size * 1.65;
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, bloomR);
      grad.addColorStop(0, `rgba(255, 145, 0, ${0.55 * intensity})`);
      grad.addColorStop(0.5, `rgba(245, 115, 0, ${0.22 * intensity})`);
      grad.addColorStop(1, 'rgba(245, 115, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, bloomR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Backing LED strip channel shaped like < or >
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#141b28';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(topPt.x, topPt.y);
    ctx.lineTo(midPt.x, midPt.y);
    ctx.lineTo(botPt.x, botPt.y);
    ctx.stroke();

    ctx.strokeStyle = intensity > 0.04 ? `rgba(245, 158, 11, ${0.35 + 0.65 * intensity})` : '#29364f';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Discrete SMD LED emitters along upper and lower arms of the < or > strip
    const ledsPerArm = 7;
    const dotRadius = Math.max(1.9, size * 0.095);
    const r = Math.round(255 * intensity);
    const g = Math.round(128 * intensity);
    const b = Math.round(6 * intensity);

    ctx.save();
    if (intensity > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
    }
    for (let i = 0; i <= ledsPerArm; i++) {
      const t = i / ledsPerArm;
      const ux = topPt.x + (midPt.x - topPt.x) * t;
      const uy = topPt.y + (midPt.y - topPt.y) * t;
      drawGlowingPixel(ux, uy, dotRadius, r, g, b);

      if (i > 0) {
        const lx = midPt.x + (botPt.x - midPt.x) * t;
        const ly = midPt.y + (botPt.y - midPt.y) * t;
        drawGlowingPixel(lx, ly, dotRadius, r, g, b);
      }
    }
    ctx.restore();

    if (label) {
      ctx.fillStyle = intensity > 0.05 ? '#fbbf24' : '#7b8ca6';
      ctx.font = '10.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const ly = labelOffsetY !== null ? labelOffsetY : cy + armH + 16;
      ctx.fillText(`${label} (${Math.round(intensity * 100)}%)`, cx, ly);
    }
  }

  function drawGroundGrid(w, h, cx, pxPerMeter, bounds) {
    const minorMeters = 0.5; // 0.5m cells, 2.0m major lines (4 cells), 4.0m color bands (8 cells)
    const cellPx = Math.max(24, pxPerMeter * minorMeters);
    const actualMph = api && api.getActualWheelSpeedMph ? api.getActualWheelSpeedMph() : 0;
    // Fade fine 0.5m lines at high speeds so they never temporal-alias at 60 FPS
    const fineFade = Math.max(0.18, 1 - Math.max(0, actualMph - 10) / 18);

    const totalCells = groundDistanceMeters / minorMeters;
    const wholeCells = Math.floor(totalCells);
    const offsetPx = (totalCells - wholeCells) * cellPx;

    const viewW = bounds.right - bounds.left;
    const startRow = Math.floor((bounds.top - offsetPx) / cellPx) - 2;
    const endRow = Math.ceil((bounds.bottom - offsetPx) / cellPx) + 2;

    ctx.save();

    // 1. Wide 4.0m (8-cell) alternating background color bands so high speeds never strobe
    for (let row = startRow; row <= endRow; row++) {
      const y = row * cellPx + offsetPx;
      const worldRow = row - wholeCells;
      const bandIdx = Math.floor(worldRow / 8);
      const isAltBand = ((bandIdx % 2) + 2) % 2 === 1;
      const isMilestoneBand = ((bandIdx % 4) + 4) % 4 === 0;

      if (isMilestoneBand) {
        ctx.fillStyle = 'rgba(20, 48, 74, 0.34)';
      } else if (isAltBand) {
        ctx.fillStyle = 'rgba(24, 36, 58, 0.30)';
      } else {
        ctx.fillStyle = 'rgba(9, 13, 22, 0.25)';
      }
      ctx.fillRect(bounds.left, y, viewW, cellPx + 0.75);

      // Painted bike-lane dashed centerline (1.5m dash every 4.0m off to each side of bike)
      const inBandCell = ((worldRow % 8) + 8) % 8;
      if (inBandCell < 3) {
        ctx.fillStyle = 'rgba(148, 184, 228, 0.22)';
        const laneOffset = Math.min(185, Math.max(125, w * 0.22));
        ctx.fillRect(cx - laneOffset - 3, y, 6, cellPx + 0.75);
        ctx.fillRect(cx + laneOffset - 3, y, 6, cellPx + 0.75);
      }
    }

    // 2. Vertical grid lines centered around bike axis
    const minCol = Math.floor((bounds.left - cx) / cellPx) - 1;
    const maxCol = Math.ceil((bounds.right - cx) / cellPx) + 1;
    for (let col = minCol; col <= maxCol; col++) {
      const x = Math.round(cx + col * cellPx) + 0.5;
      const isMajor = Math.abs(col) % 4 === 0;
      ctx.lineWidth = isMajor ? 1.4 : 1;
      ctx.strokeStyle = isMajor
        ? 'rgba(96, 178, 245, 0.28)'
        : `rgba(71, 145, 214, ${(0.14 * fineFade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x, bounds.top);
      ctx.lineTo(x, bounds.bottom);
      ctx.stroke();
    }

    // 3. Horizontal scrolling grid lines + 5m distance stencils
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    for (let row = startRow; row <= endRow; row++) {
      const y = row * cellPx + offsetPx;
      const worldRow = row - wholeCells;
      const mod4 = ((worldRow % 4) + 4) % 4;
      const mod10 = ((worldRow % 10) + 10) % 10; // Every 5.0 meters
      const isMajor = mod4 === 0;

      ctx.lineWidth = mod10 === 0 ? 1.8 : isMajor ? 1.35 : 1;
      ctx.strokeStyle =
        mod10 === 0
          ? 'rgba(125, 211, 252, 0.44)'
          : isMajor
            ? 'rgba(96, 178, 245, 0.28)'
            : `rgba(71, 145, 214, ${(0.15 * fineFade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(bounds.left, y);
      ctx.lineTo(bounds.right, y);
      ctx.stroke();

      if (mod10 === 0) {
        const metersMark = Math.abs(Math.round(-worldRow * minorMeters));
        ctx.fillStyle = 'rgba(125, 211, 252, 0.45)';
        ctx.fillText(`${metersMark}m`, cx - Math.min(230, w * 0.28), y - 5);
      }
    }

    ctx.restore();
  }

  function drawBikeLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight, hallLow, bounds) {
    const cx = w / 2;
    const yTop = 34;
    const yBottom = h - 38;
    const bikeLen = Math.max(360, yBottom - yTop);

    // Key longitudinal stations along the Riese & Müller Load 75
    const fwTop = yTop + bikeLen * 0.01;
    const fwBot = yTop + bikeLen * 0.145;
    const fwCy = (fwTop + fwBot) / 2;

    const boxTop = yTop + bikeLen * 0.16;
    const boxBot = yTop + bikeLen * 0.555;
    const boxH = boxBot - boxTop;

    const cockpitY = yTop + bikeLen * 0.585;
    const saddleY = yTop + bikeLen * 0.74;

    const rwTop = yTop + bikeLen * 0.775;
    const rwBot = yTop + bikeLen * 0.975;

    // 1:1 physical ground scale based on R&M Load 75 total length (~2.68 m)
    const pxPerMeter = (rwBot - fwTop) / 2.68;
    drawGroundGrid(w, h, cx, pxPerMeter, bounds);

    const rackTop = yTop + bikeLen * 0.805;
    const rackBot = yTop + bikeLen * 0.965;

    // Tapered front cargo box widths (narrower nose, wider cockpit bulkhead)
    const boxFrontHalfW = Math.min(68, Math.max(44, w * 0.088));
    const boxRearHalfW = Math.min(96, Math.max(62, w * 0.125));
    const boxCornerMidY = boxTop + boxH * 0.22;

    const boxHalfWidthAt = (t) => {
      // Smooth Load 75 sidewall flare from nose (t=0) to shoulder/bulkhead (t=1)
      const eased = 1 - Math.pow(1 - t, 1.45);
      return boxFrontHalfW + (boxRearHalfW - boxFrontHalfW) * eased;
    };

    ctx.save();

    // 1. Steering linkage rod (characteristic Load 75 right-side tie rod)
    ctx.strokeStyle = '#243147';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx + 11, fwCy + 6);
    ctx.lineTo(cx + 22, boxTop + 14);
    ctx.lineTo(cx + 14, cockpitY);
    ctx.stroke();

    // 2. 20" Front wheel + fender
    ctx.fillStyle = '#121824';
    ctx.strokeStyle = '#2c3b57';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(cx - 8, fwTop, 16, fwBot - fwTop, 8);
    ctx.fill();
    ctx.stroke();

    // Front fork crown
    ctx.strokeStyle = '#334463';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - 11, fwCy - 6);
    ctx.lineTo(cx - 11, boxTop + 4);
    ctx.moveTo(cx + 11, fwCy - 6);
    ctx.lineTo(cx + 11, boxTop + 4);
    ctx.stroke();

    // 3. Load 75 Front Cargo Box (EPP tub + outer tubular frame)
    ctx.beginPath();
    ctx.moveTo(cx - boxFrontHalfW + 8, boxTop);
    ctx.lineTo(cx + boxFrontHalfW - 8, boxTop);
    ctx.quadraticCurveTo(cx + boxFrontHalfW + 2, boxTop, cx + boxHalfWidthAt(0.22), boxCornerMidY);
    ctx.lineTo(cx + boxRearHalfW, boxBot - 8);
    ctx.quadraticCurveTo(cx + boxRearHalfW, boxBot, cx + boxRearHalfW - 10, boxBot);
    ctx.lineTo(cx - boxRearHalfW + 10, boxBot);
    ctx.quadraticCurveTo(cx - boxRearHalfW, boxBot, cx - boxRearHalfW, boxBot - 8);
    ctx.lineTo(cx - boxHalfWidthAt(0.22), boxCornerMidY);
    ctx.quadraticCurveTo(cx - boxFrontHalfW - 2, boxTop, cx - boxFrontHalfW + 8, boxTop);
    ctx.closePath();
    ctx.fillStyle = '#0e1420';
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#27354f';
    ctx.stroke();

    // Inner cargo box recessed floor & bench seat detail
    const inset = 11;
    ctx.strokeStyle = '#192336';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(
      cx - boxFrontHalfW + inset,
      boxTop + inset,
      (boxFrontHalfW - inset) * 2,
      boxH - inset * 2,
      8
    );
    ctx.stroke();

    // Bench seat & footwell divider inside Load 75 box
    const benchY = boxBot - boxH * 0.28;
    ctx.fillStyle = '#131b2b';
    ctx.strokeStyle = '#202c42';
    ctx.beginPath();
    ctx.roundRect(cx - boxRearHalfW + 16, benchY, (boxRearHalfW - 16) * 2, boxH * 0.20, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#3e4f69';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LOAD 75 CARGO BOX', cx, boxTop + boxH * 0.42);

    // 4. Main frame spine, cockpit handlebars & saddle
    ctx.strokeStyle = '#2a3954';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, boxBot);
    ctx.lineTo(cx, rwTop + 14);
    ctx.stroke();

    // Swept handlebars + left/right thumb button indicators
    const barHalfW = boxRearHalfW * 0.88;
    ctx.strokeStyle = '#3b4e70';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(cx - barHalfW, cockpitY + 10);
    ctx.quadraticCurveTo(cx - barHalfW * 0.45, cockpitY - 5, cx, cockpitY);
    ctx.quadraticCurveTo(cx + barHalfW * 0.45, cockpitY - 5, cx + barHalfW, cockpitY + 10);
    ctx.stroke();

    // Handlebar grips
    ctx.strokeStyle = '#1c2536';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - barHalfW, cockpitY + 10);
    ctx.lineTo(cx - barHalfW + 18, cockpitY + 5);
    ctx.moveTo(cx + barHalfW, cockpitY + 10);
    ctx.lineTo(cx + barHalfW - 18, cockpitY + 5);
    ctx.stroke();

    // Highlight thumb switches on handlebars when D2 / D3 are pressed
    const d2Pressed = api.getPinDigital(PINS.LEFT_BUTTON) === 0;
    const d3Pressed = api.getPinDigital(PINS.RIGHT_BUTTON) === 0;
    ctx.fillStyle = d2Pressed ? '#f59e0b' : '#334463';
    ctx.beginPath();
    ctx.arc(cx - barHalfW + 21, cockpitY + 4, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = d3Pressed ? '#f59e0b' : '#334463';
    ctx.beginPath();
    ctx.arc(cx + barHalfW - 21, cockpitY + 4, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Rider saddle
    ctx.fillStyle = '#1a2334';
    ctx.strokeStyle = '#334463';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, saddleY - 16);
    ctx.quadraticCurveTo(cx + 16, saddleY + 8, cx + 12, saddleY + 18);
    ctx.quadraticCurveTo(cx, saddleY + 15, cx - 12, saddleY + 18);
    ctx.quadraticCurveTo(cx - 16, saddleY + 8, cx, saddleY - 16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 5. 26" Rear wheel + Rear Cargo Rack + Spoke Magnet Hall Sensor (D7)
    ctx.fillStyle = '#121824';
    ctx.strokeStyle = '#2c3b57';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(cx - 9, rwTop, 18, rwBot - rwTop, 9);
    ctx.fill();
    ctx.stroke();

    // Hall sensor (Pin D7) mounted on rear stay beside 26" rear wheel spoke magnet
    const hallX = cx - 16;
    const hallY = rwTop + 12;
    ctx.fillStyle = hallLow ? '#38bdf8' : '#28354d';
    ctx.beginPath();
    ctx.arc(hallX, hallY, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hallLow ? '#38bdf8' : '#5c6d87';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(hallLow ? 'MAGNET! (D7)' : 'D7 HALL', hallX - 7, hallY + 3);

    // Rear rack frame & crossbars
    const rackHalfW = 24;
    ctx.strokeStyle = '#384b6b';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(cx - rackHalfW, rackTop, rackHalfW * 2, rackBot - rackTop, 5);
    ctx.stroke();

    ctx.lineWidth = 1.8;
    for (let r = 1; r <= 3; r++) {
      const ry = rackTop + ((rackBot - rackTop) * r) / 4;
      ctx.beginPath();
      ctx.moveTo(cx - rackHalfW, ry);
      ctx.lineTo(cx + rackHalfW, ry);
      ctx.stroke();
    }
    ctx.restore();

    // 6. Front Cargo Box Side LED Strips (144 LEDs each on D6 & D4)
    // Wiring: LED 0 at rear bulkhead near controller/cockpit, LED 143 at front nose.
    const count = leftStrip.len;
    const stripMargin = 5;
    const stripSpanH = boxH - 10;
    const ledRadius = Math.max(1.6, Math.min(3.0, (stripSpanH / count) * 0.65));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      // t = 0 at front nose of cargo box, t = 1 at rear bulkhead of cargo box
      const t = i / (count - 1);
      const idx = count - 1 - i;
      const y = boxTop + 5 + t * stripSpanH;
      const halfW = boxHalfWidthAt(t) + stripMargin;

      const lx = cx - halfW;
      const rx = cx + halfW;

      const bIdx = idx * 3;
      drawGlowingPixel(
        lx,
        y,
        ledRadius,
        leftStrip.bytes[bIdx],
        leftStrip.bytes[bIdx + 1],
        leftStrip.bytes[bIdx + 2]
      );
      drawGlowingPixel(
        rx,
        y,
        ledRadius,
        rightStrip.bytes[bIdx],
        rightStrip.bytes[bIdx + 1],
        rightStrip.bytes[bIdx + 2]
      );
    }
    ctx.restore();

    // Cargo box strip annotations & index endpoints
    const frontIdxLabel = String(count - 1);
    const rearIdxLabel = '0';
    ctx.fillStyle = '#52627a';
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`#${frontIdxLabel}`, cx - boxFrontHalfW - 12, boxTop + 10);
    ctx.fillText(`#${rearIdxLabel}`, cx - boxRearHalfW - 12, boxBot - 4);
    ctx.textAlign = 'left';
    ctx.fillText(`#${frontIdxLabel}`, cx + boxFrontHalfW + 12, boxTop + 10);
    ctx.fillText(`#${rearIdxLabel}`, cx + boxRearHalfW + 12, boxBot - 4);

    ctx.fillStyle = '#8b9bb4';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('ledsLeft[144] · D6', cx - boxRearHalfW - 14, boxTop + boxH * 0.5);
    ctx.textAlign = 'left';
    ctx.fillText('D4 · ledsRight[144]', cx + boxRearHalfW + 14, boxTop + boxH * 0.5);

    // 7. Rear Rack < and > Turn Signal LED Strips (D9 Left, D10 Right)
    const chevronCy = (rackTop + rackBot) / 2 + 4;
    const chevronSize = 24;
    const chevronOffset = rackHalfW + 24;

    // Mounting brackets from rear rack to < and > strips
    ctx.strokeStyle = '#2c3b57';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - rackHalfW, chevronCy);
    ctx.lineTo(cx - chevronOffset + 8, chevronCy);
    ctx.moveTo(cx + rackHalfW, chevronCy);
    ctx.lineTo(cx + chevronOffset - 8, chevronCy);
    ctx.stroke();

    drawChevronTurnStrip(cx - chevronOffset, chevronCy, -1, chevronSize, 'D9 <', pwmLeft);
    drawChevronTurnStrip(cx + chevronOffset, chevronCy, +1, chevronSize, '> D10', pwmRight);
  }

  function drawSideGroundGrid(w, h, groundY, pxPerMeter, bounds) {
    const minorMeters = 0.5; // 0.5m cells, 2.0m major lines, 4.0m color bands
    const cellPx = Math.max(24, pxPerMeter * minorMeters);
    const actualMph = api && api.getActualWheelSpeedMph ? api.getActualWheelSpeedMph() : 0;
    const fineFade = Math.max(0.16, 1 - Math.max(0, actualMph - 10) / 18);

    // Bike faces right (+x), so ground scrolls leftward (-x)
    const totalCells = groundDistanceMeters / minorMeters;
    const wholeCells = Math.floor(totalCells);
    const offsetPx = (totalCells - wholeCells) * cellPx;

    const skyTop = Math.min(0, bounds.top);
    const roadBottom = Math.max(h, bounds.bottom);
    const baseRoadDepth = Math.max(60, h - groundY);
    const totalRoadDepth = Math.max(baseRoadDepth, roadBottom - groundY);
    const viewW = bounds.right - bounds.left;

    ctx.save();

    // 1. Alternating 4.0m (8-cell) vertical backdrop bands + grid above groundY
    const startCol = Math.floor((bounds.left + offsetPx) / cellPx) - 4;
    const endCol = Math.ceil((bounds.right + offsetPx) / cellPx) + 4;
    for (let col = startCol; col <= endCol; col++) {
      const x = col * cellPx - offsetPx;
      const worldCol = col + wholeCells;
      const bandIdx = Math.floor(worldCol / 8);
      const isAltBand = ((bandIdx % 2) + 2) % 2 === 1;
      if (isAltBand) {
        ctx.fillStyle = 'rgba(24, 38, 62, 0.18)';
        ctx.fillRect(x, skyTop, cellPx + 0.75, groundY - skyTop);
      }

      const mod4 = ((worldCol % 4) + 4) % 4;
      const mod10 = ((worldCol % 10) + 10) % 10;
      const isMajor = mod4 === 0;
      ctx.lineWidth = mod10 === 0 ? 1.5 : isMajor ? 1.2 : 1;
      ctx.strokeStyle =
        mod10 === 0
          ? 'rgba(125, 211, 252, 0.30)'
          : isMajor
            ? 'rgba(96, 178, 245, 0.18)'
            : `rgba(71, 145, 214, ${(0.09 * fineFade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x, skyTop);
      ctx.lineTo(x, groundY);
      ctx.stroke();
    }

    // 2. Foreshortened perspective road plane underneath the tires (groundY .. roadBottom)
    const roadGrad = ctx.createLinearGradient(0, groundY, 0, roadBottom);
    roadGrad.addColorStop(0, 'rgba(14, 22, 36, 0.95)');
    roadGrad.addColorStop(1, 'rgba(7, 11, 18, 0.99)');
    ctx.fillStyle = roadGrad;
    ctx.fillRect(bounds.left - 200, groundY, viewW + 400, totalRoadDepth);

    // Alternating 4.0m shaded asphalt perspective quads + painted dashed lane stripes!
    const centerX = w * 0.5;
    const slopePerPx = (0.32) / baseRoadDepth; // Consistent perspective fan angle at any zoom
    const projAtY = (xTop, y) => {
      const dy = y - groundY;
      return xTop + (xTop - centerX) * slopePerPx * dy;
    };
    const dashTopY = groundY + baseRoadDepth * 0.38;
    const dashBotY = groundY + baseRoadDepth * 0.48;

    for (let col = startCol - 4; col <= endCol + 4; col++) {
      const x0 = col * cellPx - offsetPx;
      const x1 = (col + 1) * cellPx - offsetPx;
      const worldCol = col + wholeCells;
      const bandIdx = Math.floor(worldCol / 8);
      const isAltBand = ((bandIdx % 2) + 2) % 2 === 1;
      const isMilestoneBand = ((bandIdx % 4) + 4) % 4 === 0;

      ctx.fillStyle = isMilestoneBand
        ? 'rgba(30, 64, 98, 0.42)'
        : isAltBand
          ? 'rgba(28, 44, 70, 0.38)'
          : 'rgba(10, 15, 26, 0.25)';
      ctx.beginPath();
      ctx.moveTo(x0, groundY);
      ctx.lineTo(x1 + 0.6, groundY);
      ctx.lineTo(projAtY(x1 + 0.6, roadBottom), roadBottom);
      ctx.lineTo(projAtY(x0, roadBottom), roadBottom);
      ctx.closePath();
      ctx.fill();

      // Bold highway/bike-lane centerline dash (1.5m dash + 2.5m gap = 8-cell cycle)
      const inBand = ((worldCol % 8) + 8) % 8;
      if (inBand < 3) {
        ctx.fillStyle = 'rgba(226, 232, 240, 0.48)';
        ctx.beginPath();
        ctx.moveTo(projAtY(x0, dashTopY), dashTopY);
        ctx.lineTo(projAtY(x1 + 0.5, dashTopY), dashTopY);
        ctx.lineTo(projAtY(x1 + 0.5, dashBotY), dashBotY);
        ctx.lineTo(projAtY(x0, dashBotY), dashBotY);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Horizon / tire contact line
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.48)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(bounds.left, groundY);
    ctx.lineTo(bounds.right, groundY);
    ctx.stroke();

    // Transverse scrolling road grid lines + 5m painted road distance markers
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    for (let col = startCol - 4; col <= endCol + 4; col++) {
      const xTop = col * cellPx - offsetPx;
      const xBot = projAtY(xTop, roadBottom);
      const worldCol = col + wholeCells;
      const mod4 = ((worldCol % 4) + 4) % 4;
      const mod10 = ((worldCol % 10) + 10) % 10;
      const isMajor = mod4 === 0;

      ctx.lineWidth = mod10 === 0 ? 2.0 : isMajor ? 1.5 : 1;
      ctx.strokeStyle =
        mod10 === 0
          ? 'rgba(125, 211, 252, 0.55)'
          : isMajor
            ? 'rgba(96, 178, 245, 0.34)'
            : `rgba(71, 145, 214, ${(0.16 * fineFade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(xTop, groundY);
      ctx.lineTo(xBot, roadBottom);
      ctx.stroke();

      if (mod10 === 0 && worldCol >= 0) {
        const meters = Math.round(worldCol * minorMeters);
        const labelY = groundY + baseRoadDepth * 0.82;
        ctx.fillStyle = 'rgba(148, 197, 244, 0.62)';
        ctx.fillText(`${meters}m`, projAtY(xTop, labelY) + 5, labelY);
      }
    }

    ctx.restore();
  }

  function drawSideWheel(cx, cy, outerR, tireThick, rotationRad, spokeCount = 12) {
    const rimR = Math.max(8, outerR - tireThick);

    ctx.save();
    // Spokes
    ctx.strokeStyle = '#25334b';
    ctx.lineWidth = 1.25;
    for (let s = 0; s < spokeCount; s++) {
      const a = rotationRad + (s * Math.PI * 2) / spokeCount;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * rimR, cy + Math.sin(a) * rimR);
      ctx.stroke();
    }

    // Disc brake rotor
    ctx.strokeStyle = '#31425f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR * 0.26, 0, Math.PI * 2);
    ctx.stroke();

    // Inner rim
    ctx.strokeStyle = '#3c5073';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, rimR, 0, Math.PI * 2);
    ctx.stroke();

    // Rubber tire
    ctx.strokeStyle = '#151c2a';
    ctx.lineWidth = tireThick;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - tireThick * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Outer tire highlight edge
    ctx.strokeStyle = '#2e3e5c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.stroke();

    // Hub
    ctx.fillStyle = '#475e85';
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBikeSideLayout(w, h, rightStrip, pwmLeft, pwmRight, hallLow, bounds) {
    // Riese & Müller Load 75 facing RIGHT (+x), 2.68 m total length
    const bikeRealLenM = 2.68;
    const padLeft = Math.max(88, w * 0.11);
    const padRight = Math.max(44, w * 0.06);
    const maxBikeW = Math.max(320, w - padLeft - padRight);
    const maxBikeH = Math.max(200, h * 0.56);
    const pxPerMeter = Math.min(maxBikeW / bikeRealLenM, maxBikeH / 1.18);

    const totalBikePx = bikeRealLenM * pxPerMeter;
    const xOrigin = (w - totalBikePx) * 0.5 + 22; // Shifted slightly right to leave room for pivoted rear turn signals
    const groundY = Math.min(h - 72, Math.max(h * 0.72, 260));

    const mx = (metersFromRear) => xOrigin + metersFromRear * pxPerMeter;
    const my = (metersAboveGround) => groundY - metersAboveGround * pxPerMeter;

    // 1. Moving ground grid underneath
    drawSideGroundGrid(w, h, groundY, pxPerMeter, bounds);

    ctx.save();

    // Wheel coordinates & rotation phases
    const rearR = 0.335 * pxPerMeter;
    const rearHubX = mx(0.335);
    const rearHubY = groundY - rearR;

    const frontR = 0.255 * pxPerMeter;
    const frontHubX = mx(2.68 - 0.255);
    const frontHubY = groundY - frontR;

    const rearWheelPhase = api.getWheelPhase ? api.getWheelPhase() : 0;
    const sensorAngle = -Math.PI * 0.68; // Aligned along the rear seatstay
    const rearRotRad = sensorAngle + rearWheelPhase * Math.PI * 2;
    const frontRotRad = (groundDistanceMeters / (2 * Math.PI * 0.255)) * Math.PI * 2;

    // 2. Draw 26" Rear Wheel & 20" Front Wheel
    drawSideWheel(rearHubX, rearHubY, rearR, Math.max(6, pxPerMeter * 0.052), rearRotRad, 12);
    drawSideWheel(frontHubX, frontHubY, frontR, Math.max(5.5, pxPerMeter * 0.05), frontRotRad, 10);

    // Fenders (mudguards) hugging rear & front wheels
    ctx.strokeStyle = '#2b3a54';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(rearHubX, rearHubY, rearR + 5, -Math.PI * 0.96, -Math.PI * 0.14);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(frontHubX, frontHubY, frontR + 5, -Math.PI * 0.92, -Math.PI * 0.12);
    ctx.stroke();

    // Spoke magnet on 26" rear wheel (200mm from hub center)
    const magRadiusPx = 0.2 * pxPerMeter;
    const magX = rearHubX + Math.cos(rearRotRad) * magRadiusPx;
    const magY = rearHubY + Math.sin(rearRotRad) * magRadiusPx;
    ctx.fillStyle = hallLow ? '#7dd3fc' : '#94a3b8';
    ctx.beginPath();
    ctx.arc(magX, magY, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // 3. Load 75 Frame, Swingarm, Bosch Mid-Drive, Saddle, Steerer & Cargo Bed
    const bbX = mx(0.84);
    const bbY = my(0.285);
    const saddleTopX = mx(0.62);
    const saddleTopY = my(0.95);
    const steererBotX = mx(1.29);
    const steererBotY = my(0.26);
    const stemTopX = mx(1.20);
    const stemTopY = my(1.03);
    const headTubeTopX = mx(2.33);
    const headTubeTopY = my(0.54);
    const headTubeBotX = mx(2.36);
    const headTubeBotY = my(0.39);

    // Right-side steering linkage rod under cargo box (signature Load 75 detail)
    ctx.strokeStyle = '#334666';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(steererBotX + 3, my(0.22));
    ctx.lineTo(frontHubX - 8, my(0.235));
    ctx.stroke();

    // Rear swingarm (chainstay + seatstay) & main frame tubes
    ctx.strokeStyle = '#2d3d59';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    // Chainstay + Seatstay
    ctx.moveTo(rearHubX, rearHubY);
    ctx.lineTo(bbX, bbY);
    ctx.lineTo(mx(0.73), my(0.62));
    ctx.closePath();
    // Seat tube
    ctx.moveTo(bbX, bbY);
    ctx.lineTo(saddleTopX + 4, saddleTopY + 6);
    // Mid-frame boom to cargo bulkhead
    ctx.moveTo(bbX, bbY);
    ctx.lineTo(steererBotX, steererBotY);
    ctx.moveTo(mx(0.75), my(0.58));
    ctx.lineTo(mx(1.26), my(0.67));
    // Steerer column
    ctx.moveTo(steererBotX, steererBotY);
    ctx.lineTo(stemTopX, stemTopY);
    // Low cargo bed chassis rail + front headtube/fork
    ctx.moveTo(steererBotX, steererBotY);
    ctx.lineTo(mx(2.13), my(0.29));
    ctx.lineTo(headTubeBotX, headTubeBotY);
    ctx.moveTo(headTubeTopX, headTubeTopY);
    ctx.lineTo(frontHubX, frontHubY);
    ctx.stroke();

    // Fixed Hall sensor (D7) on rear seatstay aligned at r = 200mm
    const hallX = rearHubX + Math.cos(sensorAngle) * magRadiusPx;
    const hallY = rearHubY + Math.sin(sensorAngle) * magRadiusPx;
    ctx.fillStyle = hallLow ? '#38bdf8' : '#293852';
    ctx.strokeStyle = hallLow ? '#bae6fd' : '#475e85';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(hallX, hallY, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = hallLow ? '#38bdf8' : '#6c7f9c';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(hallLow ? 'MAGNET! (D7)' : 'D7 HALL', hallX - 8, hallY - 4);

    // Bosch motor housing at bottom bracket
    ctx.fillStyle = '#182132';
    ctx.strokeStyle = '#384b6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(bbX, bbY, 15, 11, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Saddle (side profile)
    ctx.fillStyle = '#1a2334';
    ctx.strokeStyle = '#3b4e70';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(saddleTopX - 18, saddleTopY);
    ctx.quadraticCurveTo(saddleTopX + 2, saddleTopY + 5, saddleTopX + 22, saddleTopY + 1);
    ctx.quadraticCurveTo(saddleTopX + 12, saddleTopY + 9, saddleTopX - 16, saddleTopY + 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Swept handlebar + right grip & D3 button indicator
    ctx.strokeStyle = '#3f5478';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(stemTopX, stemTopY);
    ctx.quadraticCurveTo(stemTopX - 6, stemTopY - 8, stemTopX - 22, stemTopY - 3);
    ctx.stroke();
    const d3Pressed = api.getPinDigital(PINS.RIGHT_BUTTON) === 0;
    ctx.fillStyle = d3Pressed ? '#f59e0b' : '#384b6b';
    ctx.beginPath();
    ctx.arc(stemTopX - 18, stemTopY - 4, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // 4. Load 75 Front Cargo Box (Right Side Panel)
    const boxRearTop = { x: mx(1.26), y: my(0.69) };
    const boxFrontTop = { x: mx(2.20), y: my(0.58) };
    const boxFrontBot = { x: mx(2.13), y: my(0.30) };
    const boxRearBot = { x: mx(1.30), y: my(0.265) };

    ctx.fillStyle = '#0f1624';
    ctx.strokeStyle = '#2c3c59';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(boxRearTop.x, boxRearTop.y);
    ctx.lineTo(boxFrontTop.x, boxFrontTop.y);
    ctx.lineTo(boxFrontBot.x, boxFrontBot.y);
    ctx.lineTo(boxRearBot.x, boxRearBot.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Tubular spaceframe upper & middle rails on side of Load 75 box
    const midRear = {
      x: (boxRearTop.x + boxRearBot.x) * 0.5,
      y: (boxRearTop.y + boxRearBot.y) * 0.5,
    };
    const midFront = {
      x: (boxFrontTop.x + boxFrontBot.x) * 0.5,
      y: (boxFrontTop.y + boxFrontBot.y) * 0.5,
    };
    ctx.strokeStyle = '#1e2a40';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(midRear.x + 6, midRear.y);
    ctx.lineTo(midFront.x - 6, midFront.y);
    ctx.stroke();

    ctx.fillStyle = '#3e4f69';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'LOAD 75 CARGO BOX (RIGHT SIDE)',
      (boxRearTop.x + boxFrontTop.x) * 0.5,
      (boxRearTop.y + boxFrontBot.y) * 0.5 - 8
    );

    // 5. Right Side Cargo Box LED Strip ONLY (ledsRight[144] on D4, mounted along bottom of box)
    // #0 at rear cockpit bulkhead -> #143 at front nose of the box
    const count = rightStrip.len;
    const stripRearX = boxRearBot.x + 4;
    const stripRearY = boxRearBot.y + 2;
    const stripFrontX = boxFrontBot.x - 4;
    const stripFrontY = boxFrontBot.y + 2;
    const stripSpanPx = Math.hypot(stripFrontX - stripRearX, stripFrontY - stripRearY);
    const ledRadius = Math.max(1.6, Math.min(3.1, (stripSpanPx / count) * 0.65));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Subtle underglow reflection cast onto the road directly beneath the bottom-mounted strip
    for (let i = 0; i < count; i += 6) {
      const t = i / (count - 1);
      const x = stripRearX + (stripFrontX - stripRearX) * t;
      const bIdx = i * 3;
      const r = rightStrip.bytes[bIdx];
      const g = rightStrip.bytes[bIdx + 1];
      const b = rightStrip.bytes[bIdx + 2];
      const maxCh = Math.max(r, g, b);
      if (maxCh > 8) {
        const reflAlpha = (maxCh / 255) * 0.11;
        const grad = ctx.createRadialGradient(x, groundY + 4, 2, x, groundY + 4, 34);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${reflAlpha})`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(x, groundY + 4, 34, 11, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (let i = 0; i < count; i++) {
      // i = 0 (#0) at rear bulkhead -> i = 143 (#143) at front nose
      const t = i / (count - 1);
      const x = stripRearX + (stripFrontX - stripRearX) * t;
      const y = stripRearY + (stripFrontY - stripRearY) * t;
      const bIdx = i * 3;
      drawGlowingPixel(
        x,
        y,
        ledRadius,
        rightStrip.bytes[bIdx],
        rightStrip.bytes[bIdx + 1],
        rightStrip.bytes[bIdx + 2]
      );
    }
    ctx.restore();

    // Strip endpoint & pin labels along bottom of cargo box
    ctx.fillStyle = '#52627a';
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('#0', stripRearX + 2, stripRearY - 10);
    ctx.textAlign = 'right';
    ctx.fillText(`#${count - 1}`, stripFrontX - 2, stripFrontY - 10);
    ctx.fillStyle = '#8b9bb4';
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      'ledsRight[144] · Pin D4',
      (stripRearX + stripFrontX) * 0.5,
      (stripRearY + stripFrontY) * 0.5 + 22
    );

    // 6. Rear Cargo Rack + Pivoted Rear Turn Signals (< D9 and > D10)
    const rackFrontX = mx(0.50);
    const rackTailX = mx(0.08);
    const rackY = my(0.73);

    ctx.strokeStyle = '#384b6b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    // Top carrier deck
    ctx.moveTo(rackTailX, rackY);
    ctx.lineTo(rackFrontX, rackY);
    ctx.lineTo(mx(0.68), my(0.65));
    // Stays down to rear axle
    ctx.moveTo(rackTailX + 10, rackY);
    ctx.lineTo(rearHubX - 4, rearHubY - 4);
    ctx.moveTo(rackFrontX - 6, rackY);
    ctx.lineTo(rearHubX + 6, rearHubY - 4);
    ctx.stroke();

    // Slight 3D pivot plate at the back of the rear rack showing BOTH < (left) and > (right) turn strips
    const pivotCenterX = rackTailX - 24;
    const pivotCenterY = rackY + 2;
    const leftSigX = pivotCenterX - 18;
    const leftSigY = pivotCenterY - 8;
    const rightSigX = pivotCenterX + 10;
    const rightSigY = pivotCenterY + 6;

    // Angled rear-rack tailbar connecting left (<) and right (>) brackets in 3/4 pivot
    ctx.fillStyle = '#121927';
    ctx.strokeStyle = '#2f405e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rackTailX, rackY);
    ctx.lineTo(rightSigX + 8, rightSigY);
    ctx.moveTo(leftSigX - 8, leftSigY - 12);
    ctx.lineTo(rightSigX + 10, rightSigY - 12);
    ctx.lineTo(rightSigX + 10, rightSigY + 13);
    ctx.lineTo(leftSigX - 8, leftSigY + 13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    // Draw foreshortened < (farther/left, D9) and > (nearer/right, D10) on the pivoted rear plate
    drawChevronTurnStrip(leftSigX, leftSigY, -1, 18, 'D9 <', pwmLeft, leftSigY - 20, 0.72);
    drawChevronTurnStrip(rightSigX, rightSigY, +1, 20, '> D10', pwmRight, rightSigY + 28, 0.78);
  }

  function drawLinearStripsLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight) {
    const padX = 36;
    const usableW = Math.max(200, w - padX * 2);
    const count = leftStrip.len;
    const spacing = usableW / count;
    const radius = Math.max(1.6, Math.min(4.2, spacing * 0.46));

    const yLeft = h * 0.27;
    const yRight = h * 0.53;

    // Backing PCBs
    ctx.fillStyle = '#111622';
    ctx.strokeStyle = '#232e45';
    ctx.lineWidth = 1;
    for (const y of [yLeft, yRight]) {
      ctx.beginPath();
      ctx.roundRect(padX - 10, y - 14, usableW + 20, 28, 6);
      ctx.fill();
      ctx.stroke();
    }

    // Labels & index ticks
    ctx.fillStyle = '#8b9bb4';
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Front Box Left:  ledsLeft[144]  — Pin D6 (WS2815 GRB)', padX - 6, yLeft - 24);
    ctx.fillText('Front Box Right: ledsRight[144] — Pin D4 (WS2815 GRB)', padX - 6, yRight - 24);

    ctx.fillStyle = '#52627a';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let tick = 0; tick < count; tick += 16) {
      const x = padX + (tick + 0.5) * spacing;
      ctx.fillText(String(tick), x, yLeft + 28);
      ctx.fillText(String(tick), x, yRight + 28);
    }
    const lastTickX = padX + (count - 0.5) * spacing;
    ctx.fillText(String(count - 1), lastTickX, yLeft + 28);
    ctx.fillText(String(count - 1), lastTickX, yRight + 28);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const x = padX + (i + 0.5) * spacing;
      const bIdx = i * 3;
      drawGlowingPixel(
        x,
        yLeft,
        radius,
        leftStrip.bytes[bIdx],
        leftStrip.bytes[bIdx + 1],
        leftStrip.bytes[bIdx + 2]
      );
      drawGlowingPixel(
        x,
        yRight,
        radius,
        rightStrip.bytes[bIdx],
        rightStrip.bytes[bIdx + 1],
        rightStrip.bytes[bIdx + 2]
      );
    }
    ctx.restore();

    // Rear rack < and > chevron turn strips below
    const lampY = h * 0.81;
    drawChevronTurnStrip(w * 0.36, lampY, -1, 28, 'Rear Rack Left < · D9', pwmLeft);
    drawChevronTurnStrip(w * 0.64, lampY, +1, 28, 'Rear Rack Right > · D10', pwmRight);
  }

  function updateTelemetryUI(pwmLeft, pwmRight, estMph) {
    const ms = api.millis();
    const brightness = api.getBrightness();
    const showCount = api.getShowCount();

    updateWheelSliderVisuals(estMph);

    statMillis.textContent = `${(ms / 1000).toFixed(2)} s`;
    statBrightness.textContent = `${brightness} / 255`;
    statShowHz.textContent = `${measuredShowHz.toFixed(0)} Hz`;
    statFrames.textContent = showCount.toLocaleString();

    const d2 = api.getPinDigital(PINS.LEFT_BUTTON);
    pinEls[2].textContent = d2 === 0 ? 'LOW (Pressed)' : 'HIGH (Idle)';
    pinEls[2].className = `pin-val ${d2 === 0 ? 'low' : 'high'}`;

    const d3 = api.getPinDigital(PINS.RIGHT_BUTTON);
    pinEls[3].textContent = d3 === 0 ? 'LOW (Pressed)' : 'HIGH (Idle)';
    pinEls[3].className = `pin-val ${d3 === 0 ? 'low' : 'high'}`;

    const d7 = api.getPinDigital(PINS.HALL_SENSOR);
    pinEls[7].textContent = d7 === 0 ? 'LOW (Magnet!)' : 'HIGH (Clear)';
    pinEls[7].className = `pin-val ${d7 === 0 ? 'low' : 'high'}`;

    pinEls[9].textContent = `PWM ${pwmLeft} (${Math.round((pwmLeft / 255) * 100)}%)`;
    pinEls[9].className = `pin-val ${pwmLeft > 0 ? 'low' : 'high'}`;

    pinEls[10].textContent = `PWM ${pwmRight} (${Math.round((pwmRight / 255) * 100)}%)`;
    pinEls[10].className = `pin-val ${pwmRight > 0 ? 'low' : 'high'}`;
  }

  function renderFrame() {
    if (!api) return;
    const { w, h } = resizeCanvas();
    ctx.clearRect(0, 0, w, h);

    const leftStrip = readStripBytes(PINS.LEFT_STRIP);
    const rightStrip = readStripBytes(PINS.RIGHT_STRIP);
    const pwmLeft = api.getPinAnalog(PINS.REAR_LEFT_PWM);
    const pwmRight = api.getPinAnalog(PINS.REAR_RIGHT_PWM);
    const hallLow = api.getPinDigital(PINS.HALL_SENSOR) === 0;
    const estMph = api.getEstimatedVelocityMph ? api.getEstimatedVelocityMph() : 0;

    const mode = layoutSelect.value;
    const { bikeCx, bikeCy } = getBikeViewportMetrics(w, h, mode);
    const bounds = getVisibleWorldBounds(w, h, bikeCx, bikeCy);

    ctx.save();
    ctx.translate(w * 0.5, h * 0.5);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-bikeCx, -bikeCy);

    if (mode === 'strips') {
      drawLinearStripsLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight);
    } else if (mode === 'side') {
      drawBikeSideLayout(w, h, rightStrip, pwmLeft, pwmRight, hallLow, bounds);
    } else {
      drawBikeLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight, hallLow, bounds);
    }
    ctx.restore();

    // Screen-space vignette, orientation header, and zoom badge
    if (mode !== 'strips') {
      ctx.save();
      const vignette = ctx.createRadialGradient(
        w * 0.5,
        h * 0.52,
        Math.min(w, h) * 0.36,
        w * 0.5,
        h * 0.52,
        Math.max(w, h) * 0.82
      );
      vignette.addColorStop(0, 'rgba(7, 9, 14, 0)');
      vignette.addColorStop(1, 'rgba(7, 9, 14, 0.42)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = '#6c7f9c';
      ctx.font = '600 10.5px system-ui, sans-serif';
      ctx.textAlign = 'center';
      if (mode === 'side') {
        ctx.fillText('R&M LOAD 75 · RIGHT SIDE PROFILE   ▶ FRONT', w * 0.5, 20);
      } else {
        ctx.fillText('▲ FRONT · R&M LOAD 75', w * 0.5, 19);
        ctx.fillText('▼ REAR RACK', w * 0.5, h - 11);
      }
      ctx.restore();
    }

    if (Math.abs(camera.zoom - 1.0) > 0.01) {
      ctx.save();
      const zoomText = `${Math.round(camera.zoom * 100)}% · Double-click to reset`;
      ctx.font = '600 10.5px ui-monospace, monospace';
      const pillW = ctx.measureText(zoomText).width + 20;
      const pillX = w - pillW - 14;
      const pillY = 12;
      ctx.fillStyle = 'rgba(19, 27, 42, 0.86)';
      ctx.strokeStyle = '#2d3d59';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, 24, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.fillText(zoomText, pillX + 10, pillY + 15.5);
      ctx.restore();
    }

    updateTelemetryUI(pwmLeft, pwmRight, estMph);
  }

  function updateCameraSpringBack(nowWall) {
    if (lastCameraWall === null) lastCameraWall = nowWall;
    const dt = Math.max(0, Math.min(100, nowWall - lastCameraWall));
    lastCameraWall = nowWall;

    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const { maxFitZoom } = getBikeViewportMetrics(w, h, layoutSelect.value);

    // If zoomed in so the bike exceeds the viewport, smoothly zoom back out once gesture relaxes
    const wheelIdle = nowWall - lastWheelZoomWall > 90;
    if (!isTouchPinching && wheelIdle && camera.zoom > maxFitZoom) {
      const ease = 1 - Math.exp(-dt * 0.014);
      camera.zoom += (maxFitZoom - camera.zoom) * ease;
      if (camera.zoom - maxFitZoom < 0.002) {
        camera.zoom = maxFitZoom;
      }
    }
  }

  function animationTick(nowWall) {
    updateCameraSpringBack(nowWall);

    if (api && running) {
      if (lastWallTime === null) lastWallTime = nowWall;
      const wallDelta = Math.max(0, Math.min(100, nowWall - lastWallTime));
      lastWallTime = nowWall;

      const speed = parseFloat(speedSelect.value) || 1.0;
      advanceSimulation(wallDelta * speed);

      const elapsedRateWindow = nowWall - lastRateCheckWall;
      if (elapsedRateWindow >= 500) {
        const currentShows = api.getShowCount();
        measuredShowHz = ((currentShows - lastShowCount) * 1000) / elapsedRateWindow;
        lastShowCount = currentShows;
        lastRateCheckWall = nowWall;
      }

      renderFrame();
    } else if (api) {
      renderFrame();
    }

    requestAnimationFrame(animationTick);
  }

  // Boot the Emscripten module
  bootModule()
    .then(() => {
      statusDot.classList.add('ready');
      statusText.textContent = 'Running src/main.cpp + FastLED 3.10.3 in WebAssembly';

      renderFrame();
      requestAnimationFrame(animationTick);
    })
    .catch((err) => {
      console.error('Failed to initialize WASM simulator:', err);
      statusText.textContent = `Error loading WASM: ${err.message || err}`;
    });
})();
