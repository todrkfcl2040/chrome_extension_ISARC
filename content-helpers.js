(() => {
  window.__gext = window.__gext || {};
  const G = window.__gext;

  const LOOP_INTERVAL_MS = 5000;
  const SAVE_WAIT_INTERVAL_MS = 500;
  const SAVE_WAIT_MAX_ATTEMPTS = 20;
  const RETRY_COOLDOWN_MS = 15000;

  const state = G.__loopState || (G.__loopState = {
    loopTimerId: null,
    reserveWaitId: null,
    overlayTimerId: null,
    stopRequested: false,
    tickInFlight: false,
    reservationPending: false,
    restoreConfirm: null,
    lastAttemptKey: null,
    lastAttemptAt: 0
  });

  const pad2 = (n) => String(n).padStart(2, '0');
  const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const formatDateTime = (d) =>
    `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  const parseDateTime = (value) => {
    if (!value) return new Date();
    const [datePart, timePart] = value.split(' ');
    if (!timePart) return new Date(value);

    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  };

  const roundUpToUnit = (date, unitMinutes) => {
    const rounded = new Date(date);
    const nextMinute = Math.ceil(rounded.getMinutes() / unitMinutes) * unitMinutes;

    if (nextMinute >= 60) {
      rounded.setHours(rounded.getHours() + 1, nextMinute % 60, 0, 0);
    } else {
      rounded.setMinutes(nextMinute, 0, 0);
    }

    return rounded;
  };

  const clearLoopTimer = () => {
    if (state.loopTimerId) {
      clearTimeout(state.loopTimerId);
      state.loopTimerId = null;
    }
  };

  const clearReserveWait = () => {
    if (state.reserveWaitId) {
      clearInterval(state.reserveWaitId);
      state.reserveWaitId = null;
    }
    if (typeof state.restoreConfirm === 'function') {
      state.restoreConfirm();
      state.restoreConfirm = null;
    }
    state.reservationPending = false;
  };

  const scheduleOverlayRemoval = (delayMs = 3000) => {
    if (state.overlayTimerId) clearTimeout(state.overlayTimerId);
    state.overlayTimerId = window.setTimeout(() => {
      state.overlayTimerId = null;
      G.removeStatusOverlay();
    }, delayMs);
  };

  const describeReserveFailure = (reason) => {
    switch (reason) {
      case 'missing_request_function':
        return '페이지의 예약 함수를 찾지 못했습니다.';
      case 'request_failed':
        return '예약 요청 중 오류가 발생했습니다.';
      case 'save_button_timeout':
        return '저장 버튼을 찾지 못해 다음 주기에 다시 확인합니다.';
      case 'already_pending':
        return '이전 예약 시도가 아직 진행 중입니다.';
      case 'stopped':
        return '자동 예약을 중지했습니다.';
      default:
        return '예약 시도가 실패했습니다.';
    }
  };

  const setInputValue = (selector, value) => {
    const $ = window.jQuery;
    const $reserv = window.$reserv || ($ && $('.reserv_time_wrap'));
    const element =
      typeof selector === 'string'
        ? ($reserv && $reserv.find(selector)[0]) || document.querySelector(selector)
        : selector;

    if (!element) return false;

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const prevReadOnly = element.readOnly;

    element.readOnly = false;
    if (setter) setter.call(element, value);
    else element.value = value;

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    try {
      window.jQuery && window.jQuery(element).data('datepicker')?.selectDate?.(new Date(value));
    } catch (_) {}

    element.readOnly = prevReadOnly;
    return true;
  };

  G.createStatusOverlay = function () {
    if (state.overlayTimerId) {
      clearTimeout(state.overlayTimerId);
      state.overlayTimerId = null;
    }

    const existing = document.getElementById('__gext_status_panel');
    if (existing) return existing;

    const panel = document.createElement('div');
    panel.id = '__gext_status_panel';
    panel.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'right:20px',
      'width:300px',
      'background:rgba(0,0,0,0.85)',
      'color:#fff',
      'padding:15px',
      'border-radius:8px',
      'z-index:999999',
      'font-size:13px',
      'box-shadow:0 4px 6px rgba(0,0,0,0.3)',
      'font-family:sans-serif'
    ].join(';');
    panel.innerHTML = [
      '<div style="font-weight:bold; margin-bottom:5px; color:#ffe27a;">자동 예약</div>',
      '<div id="__gext_status_msg">대기 중...</div>',
      '<button id="__gext_stop_btn" style="margin-top:8px; padding:4px 8px; cursor:pointer;">중지</button>'
    ].join('');

    document.body.appendChild(panel);
    document.getElementById('__gext_stop_btn')?.addEventListener('click', () => {
      G.stopLoop('자동 예약을 중지했습니다.');
    });

    return panel;
  };

  G.updateStatus = function (message) {
    const el = document.getElementById('__gext_status_msg');
    if (el) el.textContent = message;
  };

  G.removeStatusOverlay = function () {
    document.getElementById('__gext_status_panel')?.remove();
  };

  G.fillSlotOnPage = function (slot) {
    const startOk = setInputValue('input[name=START_DT_STR]', slot.start);
    const endOk = setInputValue('input[name=END_DT_STR]', slot.end);

    try {
      window.$selectStart = new Date(slot.start);
      window.$selectEnd = new Date(slot.end);
      if (typeof window.setDateDay === 'function') window.setDateDay(true);
      if (typeof window.overlapCheck === 'function') window.overlapCheck();
    } catch (_) {}

    return startOk && endOk;
  };

  G.setStartDtOnPage = function (value) {
    if (!value) return false;
    const normalized =
      value.includes('-') ? value : `${new Date().toISOString().slice(0, 10)} ${value.trim()}`;
    return setInputValue('input[name=START_DT_STR]', normalized);
  };

  G.setEndDtOnPage = function (value) {
    if (!value) return false;
    const normalized =
      value.includes('-') ? value : `${new Date().toISOString().slice(0, 10)} ${value.trim()}`;
    return setInputValue('input[name=END_DT_STR]', normalized);
  };

  G.sendEmail = function (config, slotData) {
    const { serviceId, templateId, publicKey, userEmail } = config || {};

    if (!serviceId || !templateId || !publicKey || !userEmail) {
      G.updateStatus('예약은 완료됐지만 이메일 설정이 없어 알림을 건너뜁니다.');
      return false;
    }

    window.postMessage(
      {
        type: 'GEXT_EMAIL_TRIGGER',
        payload: {
          service_id: serviceId,
          template_id: templateId,
          user_id: publicKey,
          template_params: {
            title: '자동 예약 완료 알림',
            message: '예약 시도가 완료되었습니다.',
            start_time: slotData.start,
            end_time: slotData.end,
            timestamp: new Date().toLocaleString(),
            my_name: '자동 예약',
            to_email: userEmail
          }
        }
      },
      '*'
    );

    G.updateStatus(`예약 완료. ${userEmail} 로 이메일 전송을 요청했습니다.`);
    return true;
  };

  G.findFreeSlots = async function (opts = {}) {
    const {
      durationMin = 60,
      dateStr = null,
      preferAfter = null,
      preferBefore = null,
      limit = 30
    } = opts;

    const bookingType =
      typeof window.BOOKING_TYPE !== 'undefined' && window.BOOKING_TYPE
        ? window.BOOKING_TYPE
        : 'SU';
    const pickDay =
      dateStr ||
      (window.moment
        ? window.moment().format('YYYY-MM-DD')
        : new Date().toISOString().slice(0, 10));

    const ajaxParams = {
      EQUIP_SKEY: window.$equipSkey,
      START_DT_STR: pickDay,
      END_DT_STR: window.moment
        ? window.moment(pickDay).add(1, 'days').format('YYYY-MM-DD')
        : pickDay,
      AUTH_TYPE: window.$requesterAuth,
      BOOKING_TYPE: bookingType,
      OPER_SKEY: window.$operSkey,
      DUPICATE_RESERV_FLAG: window.$dupicateReservFlag,
      FLAG_NOT_OBSERVER: window.$flagNotObserver,
      FLAG_ALL_AUTH: window.$flagAllAuth,
      SCHED_KIND: window.$schedKind,
      RECESS_FLAG: window.$recessFlag,
      TIME_UNIT: window.$timeUnit,
      lang: window.GB_LANG
    };

    let raw = [];
    try {
      if (typeof window.ajaxJsonResultCallNoLoading === 'function') {
        const response = await new Promise((resolve) => {
          window.ajaxJsonResultCallNoLoading(
            '/hm/equipReservation/reservation/calendar/json',
            ajaxParams,
            resolve
          );
        });
        if (response?.success && Array.isArray(response.data)) {
          raw = response.data;
        }
      }
    } catch (error) {
      console.error('[GEXT] findFreeSlots failed:', error);
    }

    const dayStart = parseDateTime(`${pickDay} 00:00`);
    let dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    if (preferBefore && /^\d{2}:\d{2}$/.test(preferBefore)) {
      const [hour, minute] = preferBefore.split(':').map(Number);
      const preferredEnd = new Date(dayStart);
      preferredEnd.setHours(hour, minute, 0, 0);
      if (preferredEnd > dayStart) dayEnd = preferredEnd;
    }

    const unitMinutes = Math.max(1, parseInt(window.$timeUnit || '10', 10));
    let searchStart = new Date(Math.max(Date.now(), dayStart.getTime()));

    if (preferAfter && /^\d{2}:\d{2}$/.test(preferAfter)) {
      const [hour, minute] = preferAfter.split(':').map(Number);
      const preferredStart = new Date(dayStart);
      preferredStart.setHours(hour, minute, 0, 0);
      if (preferredStart > searchStart) searchStart = preferredStart;
    }

    searchStart = roundUpToUnit(searchStart, unitMinutes);
    if (searchStart >= dayEnd) return { slots: [] };

    const busy = raw
      .map((entry) => ({
        start: parseDateTime(entry.start),
        end: parseDateTime(entry.end)
      }))
      .filter((entry) => +entry.start < +entry.end)
      .sort((a, b) => +a.start - +b.start);

    const merged = [];
    for (const entry of busy) {
      if (!merged.length || entry.start > merged[merged.length - 1].end) {
        merged.push({ ...entry });
      } else if (entry.end > merged[merged.length - 1].end) {
        merged[merged.length - 1].end = entry.end;
      }
    }

    const slots = [];
    const pushSlotsInGap = (gapStart, gapEnd) => {
      let cursor = roundUpToUnit(gapStart, unitMinutes);

      while (+cursor + durationMin * 60 * 1000 <= +gapEnd) {
        const end = new Date(+cursor + durationMin * 60 * 1000);
        slots.push({ start: formatDateTime(cursor), end: formatDateTime(end) });
        if (slots.length >= limit) return true;
        cursor = new Date(+cursor + unitMinutes * 60 * 1000);
      }

      return false;
    };

    let cursor = new Date(searchStart);
    for (const entry of merged) {
      const busyStart = new Date(Math.max(+entry.start, +dayStart));
      const busyEnd = new Date(Math.min(+entry.end, +dayEnd));

      if (busyEnd <= searchStart) continue;
      if (cursor < busyStart && pushSlotsInGap(cursor, busyStart)) return { slots };
      if (cursor < busyEnd) cursor = new Date(busyEnd);
      if (cursor >= dayEnd) return { slots };
    }

    if (slots.length < limit && cursor < dayEnd) pushSlotsInGap(cursor, dayEnd);
    return { slots };
  };

  G.tryReserve = function (emailConfig, currentSlot) {
    if (state.reservationPending) {
      return Promise.resolve({ ok: false, reason: 'already_pending' });
    }

    if (typeof window.requestReservation !== 'function') {
      G.updateStatus('페이지의 예약 함수를 찾지 못했습니다.');
      return Promise.resolve({ ok: false, reason: 'missing_request_function' });
    }

    const originalConfirm = window.jConfirm;
    state.reservationPending = true;
    state.restoreConfirm = () => {
      window.jConfirm = originalConfirm;
    };
    G.updateStatus(`예약 확정 시도 중... (${currentSlot.start})`);

    try {
      window.jConfirm = function (_title, _message, callback) {
        if (typeof callback === 'function') callback(true);
      };
      window.requestReservation();
    } catch (error) {
      clearReserveWait();
      state.reservationPending = false;
      console.error('[GEXT] requestReservation failed:', error);
      G.updateStatus('예약 요청 중 오류가 발생했습니다.');
      return Promise.resolve({ ok: false, reason: 'request_failed' });
    }

    return new Promise((resolve) => {
      let attempts = 0;

      const finish = (result) => {
        clearReserveWait();
        resolve(result);
      };

      state.reserveWaitId = window.setInterval(() => {
        if (state.stopRequested) {
          finish({ ok: false, reason: 'stopped' });
          return;
        }

        attempts += 1;
        const saveButton = document.getElementById('btnReservationSave');
        const isVisible = saveButton && saveButton.offsetParent !== null;

        if (isVisible) {
          try {
            saveButton.click();
            finish({ ok: true });
          } catch (error) {
            console.error('[GEXT] save button click failed:', error);
            finish({ ok: false, reason: 'request_failed' });
          }
          return;
        }

        if (attempts >= SAVE_WAIT_MAX_ATTEMPTS) {
          finish({ ok: false, reason: 'save_button_timeout' });
        }
      }, SAVE_WAIT_INTERVAL_MS);
    });
  };

  G.stopLoop = function (message = '자동 예약을 중지했습니다.', options = {}) {
    const { removeOverlay = true, delayMs = 3000 } = options;

    state.stopRequested = true;
    state.tickInFlight = false;
    clearLoopTimer();
    clearReserveWait();

    if (message) G.updateStatus(message);

    if (removeOverlay) {
      scheduleOverlayRemoval(delayMs);
    } else if (state.overlayTimerId) {
      clearTimeout(state.overlayTimerId);
      state.overlayTimerId = null;
    }
  };

  G.startLoop = function (opts = {}) {
    G.stopLoop(null, { removeOverlay: false });

    state.stopRequested = false;
    state.tickInFlight = false;
    state.lastAttemptKey = null;
    state.lastAttemptAt = 0;

    G.createStatusOverlay();
    G.updateStatus('자동 예약 탐색을 시작했습니다.');

    const tick = async () => {
      if (state.stopRequested || state.tickInFlight) return;
      state.tickInFlight = true;

      try {
        const { slots } = await G.findFreeSlots(opts);

        if (!slots.length) {
          G.updateStatus(`조건에 맞는 빈 시간이 없습니다. (${new Date().toLocaleTimeString()})`);
          return;
        }

        if (state.reservationPending) {
          G.updateStatus('예약 저장 버튼을 기다리는 중입니다.');
          return;
        }

        const firstSlot = slots[0];
        const attemptKey = `${firstSlot.start}|${firstSlot.end}`;
        const elapsed = Date.now() - state.lastAttemptAt;

        if (state.lastAttemptKey === attemptKey && elapsed < RETRY_COOLDOWN_MS) {
          G.updateStatus(`같은 슬롯 재시도 대기 중... (${firstSlot.start})`);
          return;
        }

        state.lastAttemptKey = attemptKey;
        state.lastAttemptAt = Date.now();

        G.updateStatus(`빈 시간 발견: ${firstSlot.start}`);
        if (!G.fillSlotOnPage(firstSlot)) {
          G.updateStatus('예약 입력 필드를 찾지 못했습니다.');
          return;
        }

        const result = await G.tryReserve(opts.emailConfig || {}, firstSlot);
        if (result.ok) {
          const emailSent = G.sendEmail(opts.emailConfig || {}, firstSlot);
          G.stopLoop(
            emailSent
              ? '예약을 완료했고 이메일 전송을 요청했습니다.'
              : '예약을 완료했습니다.',
            { delayMs: 3000 }
          );
          return;
        }

        if (!state.stopRequested) {
          G.updateStatus(describeReserveFailure(result.reason));
        }
      } catch (error) {
        console.error('[GEXT] auto booking loop failed:', error);
        G.updateStatus('자동 예약 중 오류가 발생했습니다.');
      } finally {
        state.tickInFlight = false;
        if (!state.stopRequested) {
          state.loopTimerId = window.setTimeout(tick, LOOP_INTERVAL_MS);
        }
      }
    };

    tick();
    return true;
  };

  G.reserveExactSlot = async function (opts = {}) {
    const { dateStr, startTime, endTime, emailConfig } = opts;
    if (!dateStr || !startTime || !endTime) {
      G.createStatusOverlay();
      G.updateStatus('시작/종료 시간이 필요합니다.');
      scheduleOverlayRemoval(3000);
      return { ok: false, reason: 'missing_time_range' };
    }

    G.stopLoop(null, { removeOverlay: false });
    state.stopRequested = false;

    const slot = {
      start: `${dateStr} ${startTime}`,
      end: `${dateStr} ${endTime}`
    };

    G.createStatusOverlay();
    G.updateStatus(`자정 예약 시도: ${slot.start} ~ ${slot.end}`);

    if (!G.fillSlotOnPage(slot)) {
      G.updateStatus('예약 입력 필드를 찾지 못했습니다.');
      scheduleOverlayRemoval(3000);
      return { ok: false, reason: 'missing_input_field' };
    }

    const result = await G.tryReserve(emailConfig || {}, slot);
    if (result.ok) {
      G.sendEmail(emailConfig || {}, slot);
    } else {
      G.updateStatus(describeReserveFailure(result.reason));
    }

    scheduleOverlayRemoval(3000);
    return result;
  };
})();
