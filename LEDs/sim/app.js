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
  const flipDirection = document.getElementById('flipDirection');
  const speedSelect = document.getElementById('speedSelect');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const stepBtn = document.getElementById('stepBtn');
  const resetBtn = document.getElementById('resetBtn');

  const leftTurnBtn = document.getElementById('leftTurnBtn');
  const rightTurnBtn = document.getElementById('rightTurnBtn');
  const hallBtn = document.getElementById('hallBtn');
  const hallLatchToggle = document.getElementById('hallLatchToggle');
  const hallBtnMeta = document.getElementById('hallBtnMeta');

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

  // Show-rate estimation
  let lastRateCheckWall = performance.now();
  let lastShowCount = 0;
  let measuredShowHz = 0;

  // Button hold states (supporting both continuous press and quick tap minimum hold)
  const buttonState = {
    [PINS.LEFT_BUTTON]: { pointerDown: false, keyDown: false, releaseAtSimMs: 0, el: leftTurnBtn },
    [PINS.RIGHT_BUTTON]: { pointerDown: false, keyDown: false, releaseAtSimMs: 0, el: rightTurnBtn },
  };

  const hallState = {
    pointerDown: false,
    keyDown: false,
    latched: false,
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

    const hallActive = hallState.pointerDown || hallState.keyDown || hallState.latched;
    api.setInputPin(PINS.HALL_SENSOR, hallActive ? 0 : 1);
    hallBtn.classList.toggle('pressed', hallActive);
    hallBtnMeta.textContent = hallActive
      ? 'Pin D7 · LOW (Magnet Detected!)'
      : 'Pin D7 · HIGH (No Magnet)';
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

  hallBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (hallLatchToggle.checked) {
      hallState.latched = !hallState.latched;
    } else {
      hallState.pointerDown = true;
    }
    syncInputPins();
  });

  window.addEventListener('pointerup', () => {
    if (hallState.pointerDown) {
      hallState.pointerDown = false;
      syncInputPins();
    }
  });

  hallLatchToggle.addEventListener('change', () => {
    if (!hallLatchToggle.checked) {
      hallState.latched = false;
      syncInputPins();
    }
  });

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
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      if (hallLatchToggle.checked) {
        hallState.latched = !hallState.latched;
      } else {
        hallState.keyDown = true;
      }
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
    } else if (e.key === 'm' || e.key === 'M') {
      hallState.keyDown = false;
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
        millis: mod.cwrap('millis', 'number', []),
      };

      api.init();
      syncInputPins();
      lastShowCount = api.getShowCount();
      lastRateCheckWall = performance.now();
      measuredShowHz = 0;
    });
  }

  function resetSimulation() {
    if (!api) return;
    buttonState[PINS.LEFT_BUTTON].releaseAtSimMs = 0;
    buttonState[PINS.RIGHT_BUTTON].releaseAtSimMs = 0;
    lastSerialItem = null;
    serialLog.innerHTML = '';
    lastWallTime = null;
    bootModule().then(() => {
      renderFrame();
    });
  }

  playPauseBtn.addEventListener('click', togglePlayPause);
  stepBtn.addEventListener('click', () => {
    if (!api) return;
    if (running) togglePlayPause();
    syncInputPins();
    api.step(20.0);
    syncInputPins();
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

  function drawChevronTurnStrip(cx, cy, dir, size, label, pwmValue, labelOffsetY = null) {
    // dir = -1 => '<' pointing left; dir = +1 => '>' pointing right
    const intensity = Math.max(0, Math.min(1, pwmValue / 255));
    const apexX = cx + dir * (size * 0.52);
    const openX = cx - dir * (size * 0.48);
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

  function drawBikeLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight, hallLow) {
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

    // Orientation labels
    ctx.fillStyle = '#5c6d87';
    ctx.font = '600 10.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('▲ FRONT · R&M LOAD 75', cx, 19);
    ctx.fillText('▼ REAR RACK', cx, h - 11);

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

    // Hall sensor (Pin D7) on wheel
    const hallX = cx - 20;
    const hallY = fwCy;
    ctx.fillStyle = hallLow ? '#38bdf8' : '#28354d';
    ctx.beginPath();
    ctx.arc(hallX, hallY, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hallLow ? '#38bdf8' : '#5c6d87';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(hallLow ? 'MAGNET! (D7)' : 'D7 HALL', hallX - 8, hallY + 3);

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

    // 5. 26" Rear wheel + Rear Cargo Rack
    ctx.fillStyle = '#121824';
    ctx.strokeStyle = '#2c3b57';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(cx - 9, rwTop, 18, rwBot - rwTop, 9);
    ctx.fill();
    ctx.stroke();

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
    // Default wiring: LED 0 at rear bulkhead near controller/cockpit, LED 143 at front nose
    // (so the white comet head leads at the front of the box and trails rainbow rearward).
    const flip = flipDirection.checked;
    const count = leftStrip.len;
    const stripMargin = 5;
    const stripSpanH = boxH - 10;
    const ledRadius = Math.max(1.6, Math.min(3.0, (stripSpanH / count) * 0.65));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      // t = 0 at front nose of cargo box, t = 1 at rear bulkhead of cargo box
      const t = i / (count - 1);
      const idx = flip ? i : count - 1 - i;
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
    const frontIdxLabel = flip ? '0' : String(count - 1);
    const rearIdxLabel = flip ? String(count - 1) : '0';
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

  function drawLinearStripsLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight) {
    const padX = 36;
    const usableW = Math.max(200, w - padX * 2);
    const count = leftStrip.len;
    const flip = flipDirection.checked;
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
      const dispIdx = flip ? count - 1 - tick : tick;
      const x = padX + (tick + 0.5) * spacing;
      ctx.fillText(String(dispIdx), x, yLeft + 28);
      ctx.fillText(String(dispIdx), x, yRight + 28);
    }
    const lastTickX = padX + (count - 0.5) * spacing;
    ctx.fillText(String(flip ? 0 : count - 1), lastTickX, yLeft + 28);
    ctx.fillText(String(flip ? 0 : count - 1), lastTickX, yRight + 28);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const idx = flip ? count - 1 - i : i;
      const x = padX + (i + 0.5) * spacing;
      const bIdx = idx * 3;
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

  function updateTelemetryUI(pwmLeft, pwmRight) {
    const ms = api.millis();
    const brightness = api.getBrightness();
    const showCount = api.getShowCount();

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

    if (layoutSelect.value === 'strips') {
      drawLinearStripsLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight);
    } else {
      drawBikeLayout(w, h, leftStrip, rightStrip, pwmLeft, pwmRight, hallLow);
    }

    updateTelemetryUI(pwmLeft, pwmRight);
  }

  function animationTick(nowWall) {
    if (api && running) {
      if (lastWallTime === null) lastWallTime = nowWall;
      const wallDelta = Math.max(0, Math.min(100, nowWall - lastWallTime));
      lastWallTime = nowWall;

      const speed = parseFloat(speedSelect.value) || 1.0;
      syncInputPins();
      api.step(wallDelta * speed);
      syncInputPins();

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
