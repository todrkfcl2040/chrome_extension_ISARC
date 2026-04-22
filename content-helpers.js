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
    lastAttemptAt: 0,
    loadedRouteSkey: null
  });

  const pad2 = (n) => String(n).padStart(2, '0');
  const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const formatDateTime = (d) =>
    `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const formatDateTimeSeconds = (d) =>
    `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  const parseDateTime = (value) => {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }
    if (value == null) return null;

    const text = String(value).trim();
    if (!text) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const parsed = new Date(`${text}T00:00:00`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const [datePart, timePart] = text.split(' ');
    if (timePart) {
      const [year, month, day] = datePart.split('-').map(Number);
      const [hour = 0, minute = 0] = timePart.split(':').map(Number);
      const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const roundUpToUnit = (date, unitMinutes) => {
    const rounded = new Date(date);
    if (rounded.getSeconds() > 0 || rounded.getMilliseconds() > 0) {
      rounded.setMinutes(rounded.getMinutes() + 1, 0, 0);
    } else {
      rounded.setSeconds(0, 0);
    }

    const remainder = rounded.getMinutes() % unitMinutes;
    const nextMinute = remainder === 0 ? rounded.getMinutes() : rounded.getMinutes() + (unitMinutes - remainder);

    if (nextMinute >= 60) {
      rounded.setHours(rounded.getHours() + 1, nextMinute % 60, 0, 0);
    } else {
      rounded.setMinutes(nextMinute, 0, 0);
    }

    return rounded;
  };

  const getFirstValue = (...values) => values.find((value) => value != null && String(value).trim() !== '');
  const getInputValue = (...selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.value ?? element?.getAttribute?.('value');
      if (value != null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };
  const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => {
      const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return map[char] || char;
    });
  const normalizeCalendarEntry = (entry = {}) => {
    const startValue = getFirstValue(
      entry.start,
      entry.START_DT_STR,
      entry.startDtStr,
      entry.startDate,
      entry.start_date,
      entry.extendedProps?.start,
      entry.extendedProps?.START_DT_STR
    );
    const endValue = getFirstValue(
      entry.end,
      entry.END_DT_STR,
      entry.endDtStr,
      entry.endDate,
      entry.end_date,
      entry.extendedProps?.end,
      entry.extendedProps?.END_DT_STR
    );
    const start = parseDateTime(startValue);
    const end = parseDateTime(endValue);

    if (!start || !end || +start >= +end) return null;
    return { start, end };
  };
  const waitFor = async (predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    }

    return null;
  };
  const getRouteRows = () =>
    Array.from(document.querySelectorAll('#runsheet_sche_list li[id^="runsheetListRow"]'));
  const getRouteRowBySubSkey = (runsheetSubSkey) => {
    if (!runsheetSubSkey) return null;

    return (
      document.getElementById(`runsheetListRow${runsheetSubSkey}`) ||
      getRouteRows().find((row) =>
        normalizeText(row.querySelector('[name="runsheetSubSkey"]')?.value) === String(runsheetSubSkey)
      ) ||
      null
    );
  };
  const getRouteRowValue = (row, name) => normalizeText(row?.querySelector(`[name="${name}"]`)?.value);
  const getRouteRowText = (row, selector) => normalizeText(row?.querySelector(selector)?.textContent);
  const getRequesterName = (row) => {
    const requesterNode = row?.querySelector('dt[name="requesterName"]');
    if (!requesterNode) return '';

    const clone = requesterNode.cloneNode(true);
    clone.querySelectorAll('a, button').forEach((element) => element.remove());
    return normalizeText(clone.textContent);
  };
  const findRouteReservationAction = (row) =>
    Array.from(row?.querySelectorAll('a, button, input[type=button], input[type=submit]') || []).find(
      (element) => {
        const text = normalizeText(element.textContent || element.value);
        const signature = normalizeText(
          `${element.getAttribute('href') || ''} ${element.getAttribute('onclick') || ''}`
        ).toLowerCase();
        return text.includes('장비예약') || signature.includes('setrouteview');
      }
    ) || null;
  const parseRouteActionArgs = (action, row) => {
    const source = `${action?.getAttribute('href') || ''} ${action?.getAttribute('onclick') || ''}`;
    const match = source.match(
      /setRouteView\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/
    );

    return {
      seq: match ? Number(String(match[1]).replace(/['"]/g, '').trim()) : null,
      runsheetSubSkey: match
        ? String(match[2]).replace(/['"]/g, '').trim()
        : String(row?.id || '').replace(/^runsheetListRow/, ''),
      reservSkey: match ? match[3] : '',
      reservStatus: match ? match[4] : ''
    };
  };
  const getLoadedRouteContext = (route = null) => {
    const container = document.querySelector('.step2_box');
    if (!container) return null;

    const startInput = container.querySelector('input[name="START_DT_STR"]');
    const endInput = container.querySelector('input[name="END_DT_STR"]');
    if (!startInput || !endInput) return null;

    const loadedEquipSkey = getFirstValue(
      container.querySelector('#EQUIP_SKEY')?.value,
      container.querySelector('[name="EQUIP_SKEY"]')?.value,
      window.$equipSkey
    );
    if (route?.equipSkey && loadedEquipSkey && String(loadedEquipSkey) !== String(route.equipSkey)) {
      return null;
    }

    return {
      container,
      startInput,
      endInput,
      equipSkey: loadedEquipSkey
    };
  };
  const buildRouteRowInfo = (row) => {
    const action = findRouteReservationAction(row);
    const actionArgs = parseRouteActionArgs(action, row);
    const workeSkey = getRouteRowValue(row, 'workeSkey');
    const routeName = getRouteRowValue(row, 'routeName');
    const equipName = getRouteRowValue(row, 'equipName');
    const requesterName = getRequesterName(row);
    const managerName = getRouteRowText(row, 'dt[name="managerName"]');
    const schedStatus = getRouteRowValue(row, 'schedStatus');
    const canReserve = Boolean(action);

    let reason = '';
    if (!canReserve) {
      reason = '장비예약 버튼이 없는 공정입니다.';
    } else if (!workeSkey) {
      reason = '작업자가 지정되지 않아 장비예약 상세를 열 수 없습니다.';
    }

    const labelParts = [];
    if (Number.isFinite(actionArgs.seq) && actionArgs.seq > 0) {
      labelParts.push(`${actionArgs.seq}.`);
    }
    if (routeName) labelParts.push(routeName);
    if (equipName) labelParts.push(`/ ${equipName}`);
    if (requesterName) labelParts.push(`/ 작업자 ${requesterName}`);

    return {
      runsheetSubSkey: actionArgs.runsheetSubSkey || String(row.id || '').replace(/^runsheetListRow/, ''),
      seq: actionArgs.seq,
      reservSkey: actionArgs.reservSkey,
      reservStatus: actionArgs.reservStatus,
      routeName,
      equipName,
      equipSkey: getRouteRowValue(row, 'equipSkey'),
      operSkey: getRouteRowValue(row, 'operSkey'),
      requesterName,
      managerName,
      workeSkey,
      schedStatus,
      canReserve,
      reason,
      label: normalizeText(labelParts.join(' ')),
      rowId: row.id || ''
    };
  };

  G.listReservationRoutes = function () {
    return {
      routes: getRouteRows().map((row) => buildRouteRowInfo(row)),
      loadedRouteSkey: state.loadedRouteSkey
    };
  };

  G.loadRouteReservationDetail = async function (opts = {}) {
    const runsheetSubSkey =
      typeof opts === 'object' ? opts.runsheetSubSkey || opts.routeId || opts.subSkey : opts;
    const row = getRouteRowBySubSkey(runsheetSubSkey);
    if (!row) {
      return { ok: false, error: '선택한 공정을 찾지 못했습니다.' };
    }

    const route = buildRouteRowInfo(row);
    if (!route.canReserve) {
      return { ok: false, error: route.reason || '장비예약 버튼이 없는 공정입니다.' };
    }
    if (!route.workeSkey) {
      return { ok: false, error: route.reason || '작업자를 지정해주세요.' };
    }

    const loadedContext = getLoadedRouteContext(route);
    if (loadedContext && String(state.loadedRouteSkey || '') === String(route.runsheetSubSkey)) {
      state.loadedRouteSkey = route.runsheetSubSkey;
      return { ok: true, route, reused: true };
    }

    if (typeof window.setRouteView !== 'function') {
      return { ok: false, error: '페이지의 장비예약 상세 로드 함수를 찾지 못했습니다.' };
    }

    const messages = [];
    const originalJAlert = window.jAlert;

    try {
      window.jAlert = function (_title, message) {
        messages.push(normalizeText(message || _title));
        return true;
      };

      window.setRouteView(route.seq, route.runsheetSubSkey, route.reservSkey || '', route.reservStatus || '');

      const result = await waitFor(() => {
        const context = getLoadedRouteContext(route);
        if (context) return { ok: true };
        if (messages.length) return { ok: false, error: messages[messages.length - 1] };
        return null;
      });

      if (!result?.ok) {
        return {
          ok: false,
          error: result?.error || messages[messages.length - 1] || '장비예약 상세를 불러오지 못했습니다.'
        };
      }

      state.loadedRouteSkey = route.runsheetSubSkey;
      return { ok: true, route };
    } finally {
      if (typeof originalJAlert === 'function') {
        window.jAlert = originalJAlert;
      } else {
        delete window.jAlert;
      }
    }
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
      case 'no_alternative_slots':
        return '지정 시간이 찼고, 같은 길이의 다른 빈 시간도 없습니다.';
      case 'no_reservable_fallback_slot':
        return '다른 빈 시간들을 모두 시도했지만 예약하지 못했습니다.';
      case 'stopped':
        return '자동 예약을 중지했습니다.';
      default:
        return '예약 시도가 실패했습니다.';
    }
  };

  const slotKey = (slot) => `${slot.start}|${slot.end}`;
  const getDurationMinutesFromSlot = (slot) =>
    Math.max(1, Math.round((parseDateTime(slot.end) - parseDateTime(slot.start)) / (60 * 1000)));
  const isStructuralReserveFailure = (reason) =>
    ['missing_request_function', 'request_failed', 'already_pending', 'missing_input_field', 'stopped'].includes(reason);

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

  G.fillSlotOnRoute = async function (slot, opts = {}) {
    const runsheetSubSkey = opts?.runsheetSubSkey || opts?.routeId || opts?.subSkey || null;
    if (runsheetSubSkey) {
      const loadResult = await G.loadRouteReservationDetail({ runsheetSubSkey });
      if (!loadResult?.ok) return loadResult;
    }

    return { ok: G.fillSlotOnPage(slot) };
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
      limit = null,
      runsheetSubSkey = null,
      routeId = null,
      subSkey = null
    } = opts;
    const maxSlots = typeof limit === 'number' && Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER;
    const targetRouteSkey = runsheetSubSkey || routeId || subSkey || null;

    if (targetRouteSkey) {
      const loadResult = await G.loadRouteReservationDetail({ runsheetSubSkey: targetRouteSkey });
      if (!loadResult?.ok) {
        return { slots: [], error: loadResult?.error || '장비예약 상세를 불러오지 못했습니다.' };
      }
    }

    const url = new URL(window.location.href);
    const equipSkey = getFirstValue(
      window.$equipSkey,
      getInputValue('#EQUIP_SKEY', '[name="EQUIP_SKEY"]'),
      url.searchParams.get('EQUIP_SKEY')
    );
    const requesterAuth = getFirstValue(
      window.$requesterAuth,
      getInputValue('#AUTH_TYPE', '[name="AUTH_TYPE"]')
    );
    const operSkey = getFirstValue(
      window.$operSkey,
      document.querySelector('[name="OPER_SKEY"]:checked')?.value,
      getInputValue('#OPER_SKEY', '[name="OPER_SKEY"]')
    );
    const timeUnit = getFirstValue(
      window.$timeUnit,
      getInputValue('#TIME_UNIT', '[name="TIME_UNIT"]'),
      10
    );
    const bookingType =
      typeof window.BOOKING_TYPE !== 'undefined' && window.BOOKING_TYPE
        ? window.BOOKING_TYPE
        : 'SU';
    const pickDay =
      dateStr ||
      (window.moment
        ? window.moment().format('YYYY-MM-DD')
        : new Date().toISOString().slice(0, 10));

    if (!equipSkey) {
      return { slots: [], error: '장비 정보를 찾지 못했습니다. 장비 예약 페이지에서 실행하세요.' };
    }
    if (typeof window.ajaxJsonResultCallNoLoading !== 'function') {
      return { slots: [], error: '예약 캘린더 조회 함수를 찾지 못했습니다.' };
    }

    const ajaxParams = {
      EQUIP_SKEY: equipSkey,
      START_DT_STR: pickDay,
      END_DT_STR: window.moment
        ? window.moment(pickDay).add(1, 'days').format('YYYY-MM-DD')
        : pickDay,
      AUTH_TYPE: requesterAuth,
      BOOKING_TYPE: bookingType,
      OPER_SKEY: operSkey,
      DUPICATE_RESERV_FLAG: window.$dupicateReservFlag,
      FLAG_NOT_OBSERVER: window.$flagNotObserver,
      FLAG_ALL_AUTH: window.$flagAllAuth,
      SCHED_KIND: window.$schedKind,
      RECESS_FLAG: window.$recessFlag,
      TIME_UNIT: timeUnit,
      lang: window.GB_LANG
    };

    let raw = [];
    try {
      const response = await new Promise((resolve) => {
        window.ajaxJsonResultCallNoLoading(
          '/hm/equipReservation/reservation/calendar/json',
          ajaxParams,
          resolve
        );
      });
      if (response?.success) {
        if (Array.isArray(response.data)) {
          raw = response.data;
        } else if (Array.isArray(response.rows)) {
          raw = response.rows;
        } else if (Array.isArray(response.data?.rows)) {
          raw = response.data.rows;
        }
      } else if (response && response.success === false) {
        return { slots: [], error: String(response.message || '예약 캘린더 조회에 실패했습니다.') };
      }
    } catch (error) {
      console.error('[GEXT] findFreeSlots failed:', error);
      return { slots: [], error: `예약 캘린더 조회 실패: ${error.message}` };
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

    const unitMinutes = Math.max(1, parseInt(String(timeUnit || '10'), 10));
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
      .map((entry) => normalizeCalendarEntry(entry))
      .filter(Boolean)
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
        if (slots.length >= maxSlots) return true;
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

    if (slots.length < maxSlots && cursor < dayEnd) pushSlotsInGap(cursor, dayEnd);
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

  const tryAlternativeSlots = async ({ failedSlot, dateStr, emailConfig }) => {
    const requestedStartMs = parseDateTime(failedSlot.start).getTime();
    const durationMin = getDurationMinutesFromSlot(failedSlot);
    const { slots } = await G.findFreeSlots({
      dateStr,
      durationMin,
      limit: Number.MAX_SAFE_INTEGER
    });

    const alternativeSlots = slots
      .filter((slot) => slotKey(slot) !== slotKey(failedSlot))
      .sort((a, b) => {
        const diffA = Math.abs(parseDateTime(a.start).getTime() - requestedStartMs);
        const diffB = Math.abs(parseDateTime(b.start).getTime() - requestedStartMs);
        if (diffA !== diffB) return diffA - diffB;
        return parseDateTime(a.start).getTime() - parseDateTime(b.start).getTime();
      });

    if (!alternativeSlots.length) {
      return { ok: false, reason: 'no_alternative_slots' };
    }

    for (let index = 0; index < alternativeSlots.length; index += 1) {
      if (state.stopRequested) {
        return { ok: false, reason: 'stopped' };
      }

      const alternativeSlot = alternativeSlots[index];
      G.updateStatus(
        `지정 시간이 차서 다른 빈 시간을 시도합니다. (${index + 1}/${alternativeSlots.length}) ${alternativeSlot.start}`
      );

      if (!G.fillSlotOnPage(alternativeSlot)) {
        return { ok: false, reason: 'missing_input_field' };
      }

      const result = await G.tryReserve(emailConfig || {}, alternativeSlot);
      if (result.ok) {
        return {
          ok: true,
          slot: alternativeSlot,
          usedFallback: true,
          attemptedCount: index + 1
        };
      }

      if (isStructuralReserveFailure(result.reason)) {
        return result;
      }
    }

    return {
      ok: false,
      reason: 'no_reservable_fallback_slot',
      attemptedCount: alternativeSlots.length
    };
  };

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const addDays = (date, amount) => {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
  };
  const setNativeFieldValue = (element, value) => {
    if (!element) return false;

    const nextValue = value == null ? '' : String(value);
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (setter) setter.call(element, nextValue);
    else element.value = nextValue;

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const withCapturedAlerts = async (fn) => {
    const messages = [];
    const originalAlert = window.alert;
    const originalJAlert = window.jAlert;

    window.alert = function (message) {
      messages.push(normalizeText(message));
      return true;
    };
    window.jAlert = function (title, message, callback) {
      messages.push(normalizeText(message || title));
      if (typeof callback === 'function') callback(true);
      return true;
    };

    try {
      const result = await fn(messages);
      return { result, messages };
    } finally {
      window.alert = originalAlert;
      if (typeof originalJAlert === 'function') {
        window.jAlert = originalJAlert;
      } else {
        delete window.jAlert;
      }
    }
  };
  const getActionText = (element) =>
    String(
      element?.textContent ||
        element?.value ||
        element?.getAttribute?.('aria-label') ||
        element?.getAttribute?.('title') ||
        ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  const getActionSignature = (element) =>
    [
      element?.id,
      element?.name,
      element?.href,
      element?.getAttribute?.('onclick'),
      element?.getAttribute?.('data-url'),
      element?.getAttribute?.('data-href'),
      element?.form?.action
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  const isVisibleAction = (element) =>
    Boolean(element && element.isConnected && !element.disabled && element.offsetParent !== null);
  const hasNegativeKeyword = (value) =>
    ['취소', '닫기', '목록', '이전', '뒤로', '검색', '새로고침', '중지', '삭제'].some((keyword) =>
      value.includes(keyword)
    );

  const findBestEducationAction = (mode) => {
    const actionables = Array.from(
      document.querySelectorAll('a, button, input[type=button], input[type=submit]')
    ).filter(isVisibleAction);

    let best = null;
    let bestScore = -1;

    actionables.forEach((element) => {
      const text = getActionText(element);
      const signature = getActionSignature(element);
      if (!text && !signature) return;
      if (hasNegativeKeyword(text) || hasNegativeKeyword(signature)) return;

      let score = 0;

      if (mode === 'entry') {
        if (
          signature.includes('/hm/event/reservation/equip') ||
          signature.includes('event/reservation/equip') ||
          signature.includes('event/reservation')
        ) {
          score += 100;
        }
        if (text.includes('신청')) score += 30;
        if (text.includes('예약')) score += 25;
        if (text.includes('접수')) score += 20;
      }

      if (mode === 'submit') {
        if (element.id === 'btnReservationSave' || element.id === 'btnSave') score += 100;
        if (signature.includes('save')) score += 40;
        if (signature.includes('submit')) score += 35;
        if (text.includes('저장')) score += 30;
        if (text.includes('신청')) score += 25;
        if (text.includes('예약')) score += 20;
        if (text.includes('접수')) score += 15;
        if (text.includes('확인')) score += 10;
      }

      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    });

    return bestScore > 0 ? best : null;
  };

  const withAutoConfirm = async (fn) => {
    const originalConfirm = window.confirm;
    const originalJConfirm = window.jConfirm;

    window.confirm = () => true;
    window.jConfirm = function (_title, _message, callback) {
      if (typeof callback === 'function') callback(true);
    };

    try {
      return await fn();
    } finally {
      window.confirm = originalConfirm;
      if (typeof originalJConfirm === 'function') {
        window.jConfirm = originalJConfirm;
      } else {
        delete window.jConfirm;
      }
    }
  };

  const withAutoDialogs = async (fn) => {
    const originalConfirm = window.confirm;
    const originalJConfirm = window.jConfirm;
    const originalJAlert = window.jAlert;
    const messages = [];

    const pushMessage = (value) => {
      const text = String(value || '').trim();
      if (text) messages.push(text);
    };

    window.confirm = () => true;
    window.jConfirm = function (_title, message, callback) {
      pushMessage(message);
      if (typeof callback === 'function') callback(true);
      return true;
    };
    window.jAlert = function (_title, message, callback) {
      pushMessage(message || _title);
      if (typeof callback === 'function') callback();
      return true;
    };

    try {
      return await fn({ messages });
    } finally {
      window.confirm = originalConfirm;
      if (typeof originalJConfirm === 'function') {
        window.jConfirm = originalJConfirm;
      } else {
        delete window.jConfirm;
      }
      if (typeof originalJAlert === 'function') {
        window.jAlert = originalJAlert;
      } else {
        delete window.jAlert;
      }
    }
  };

  const ISRC_ORIGIN = 'https://isrc.snu.ac.kr';
  const parseHtmlDocument = (html) => new DOMParser().parseFromString(html, 'text/html');
  const getDocValue = (doc, key) =>
    String(doc.querySelector(`#${key}`)?.value || doc.querySelector(`[name="${key}"]`)?.value || '').trim();
  const buildEducationReservationUrlInPage = (education = {}) => {
    const reservationUrl = new URL('/hm/event/reservation/equip', ISRC_ORIGIN);
    reservationUrl.searchParams.set('EVENT_SKEY', education.EVENT_SKEY || '');
    reservationUrl.searchParams.set('ESCHED_SKEY', education.ESCHED_SKEY || '');
    reservationUrl.searchParams.set('EVENT_SUB_TYPE', education.EVENT_SUB_TYPE || 'RG');
    reservationUrl.searchParams.set('FLAG', 'GOTO');
    reservationUrl.searchParams.set('USER_SKEY', education.USER_SKEY || '');
    reservationUrl.searchParams.set('PLAN_AMOUNT', String(education.PLAN_AMOUNT || 0));
    reservationUrl.searchParams.set('STATUS', 'RE');
    return reservationUrl.toString();
  };
  const resolveEducationContext = (education = {}) => {
    const url = new URL(window.location.href);
    return {
      EVENT_SKEY:
        education.EVENT_SKEY || getDocValue(document, 'EVENT_SKEY') || url.searchParams.get('EVENT_SKEY') || '',
      ESCHED_SKEY:
        education.ESCHED_SKEY || getDocValue(document, 'ESCHED_SKEY') || url.searchParams.get('ESCHED_SKEY') || '',
      EVENT_SUB_TYPE:
        education.EVENT_SUB_TYPE ||
        getDocValue(document, 'EVENT_SUB_TYPE') ||
        url.searchParams.get('EVENT_SUB_TYPE') ||
        'RG',
      USER_SKEY:
        education.USER_SKEY || getDocValue(document, 'USER_SKEY') || url.searchParams.get('USER_SKEY') || '',
      PLAN_AMOUNT:
        education.PLAN_AMOUNT ||
        getDocValue(document, 'AMOUNT') ||
        getDocValue(document, 'AMOUNT_OUT') ||
        url.searchParams.get('PLAN_AMOUNT') ||
        0,
      EQUIP_NAME: education.EQUIP_NAME || education.NAME || '',
      NAME: education.NAME || education.EQUIP_NAME || ''
    };
  };
  const loadEducationReservationDocument = async (educationContext) => {
    if (
      window.location.pathname.includes('/hm/event/reservation/equip') &&
      document.getElementById('eventReservEquipForm')
    ) {
      return { doc: document, source: 'current' };
    }

    const reservationUrl = buildEducationReservationUrlInPage(educationContext);
    const response = await fetch(reservationUrl, {
      credentials: 'include',
      cache: 'no-store'
    });

    if (response.redirected && response.url.includes('/login')) {
      throw new Error('로그인이 필요합니다.');
    }
    if (!response.ok) {
      throw new Error(`최종 신청 페이지 조회 실패 (${response.status})`);
    }

    const text = await response.text();
    const doc = parseHtmlDocument(text);
    if (!doc.getElementById('eventReservEquipForm')) {
      throw new Error('최종 신청 페이지에서 신청 폼을 찾지 못했습니다.');
    }

    return { doc, source: 'fetched' };
  };
  const postIsrcForm = async (path, params) => {
    const response = await fetch(new URL(path, ISRC_ORIGIN).toString(), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01'
      },
      body: new URLSearchParams(
        Object.entries(params || {}).map(([key, value]) => [key, value == null ? '' : String(value)])
      ).toString()
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(`서버 응답을 해석하지 못했습니다. (${response.status})`);
    }

    if (response.redirected && response.url.includes('/login')) {
      throw new Error('로그인이 필요합니다.');
    }
    if (!response.ok) {
      throw new Error(data?.message || data?.data || `요청 실패 (${response.status})`);
    }

    return data;
  };

  const isVisibleNode = (element) => {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return element.offsetParent !== null || style.position === 'fixed';
  };

  const getVisibleNodeBySelector = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector)).find((element) => isVisibleNode(element)) || null;

  const getAccountPopupRoot = (saveButton) =>
    saveButton?.closest('.window, .panel.window, .panel, .ui-dialog, .popup_wrap, [role="dialog"]') ||
    document;

  const tryPickFirstAccountOption = (root) => {
    const visibleChecked = getVisibleNodeBySelector(
      'input[type=radio]:checked, input[type=checkbox]:checked',
      root
    );
    if (visibleChecked) return true;

    const visibleChoice = getVisibleNodeBySelector(
      'input[type=radio]:not(:checked), input[type=checkbox]:not(:checked)',
      root
    );
    if (visibleChoice) {
      visibleChoice.click();
      return true;
    }

    const rowSelectors = ['.datagrid-row', 'tbody tr', '.grid-row', '.list li'];
    for (const selector of rowSelectors) {
      const row = Array.from(root.querySelectorAll(selector)).find((element) => {
        if (!isVisibleNode(element)) return false;
        if (element.closest('thead')) return false;
        return getActionText(element).length > 0;
      });

      if (row) {
        row.click();
        return true;
      }
    }

    return false;
  };

  const ensureEducationAccountCode = async ({ messages, reservationConfig }) => {
    const readAccountCode = () => String(document.getElementById('ACC_CODE')?.value || '').trim();
    const fixedAccountCode = String(reservationConfig?.fixedAccountCode || '').trim();
    if (fixedAccountCode) {
      const applied = setInputValue('#ACC_CODE', fixedAccountCode);
      const currentCode = readAccountCode();
      if (applied || currentCode) {
        return {
          ok: true,
          accountCode: currentCode || fixedAccountCode,
          source: 'fixed'
        };
      }
      return { ok: false, error: '고정 계정코드를 주입하지 못했습니다.' };
    }

    const existingCode = readAccountCode();
    if (existingCode) {
      return { ok: true, accountCode: existingCode, source: 'existing' };
    }

    const searchButton = document.getElementById('btnSearchAccount');
    if (!isVisibleAction(searchButton)) {
      return { ok: false, error: '계정 선택 버튼을 찾지 못했습니다.' };
    }

    const messageOffset = messages.length;
    let popupOpened = false;
    let selectionTried = false;
    let lastBlockingMessage = '';
    let lastSaveClickAt = 0;

    searchButton.click();

    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const currentCode = readAccountCode();
      if (currentCode) {
        return {
          ok: true,
          accountCode: currentCode,
          source: popupOpened ? 'popup' : 'existing'
        };
      }

      const saveButton = getVisibleNodeBySelector('#btnAccountSelectSave');
      if (saveButton) {
        popupOpened = true;
        const popupRoot = getAccountPopupRoot(saveButton);

        if (!selectionTried) {
          const picked = tryPickFirstAccountOption(popupRoot);
          if (picked) {
            selectionTried = true;
            await wait(250);
          }
        }

        if (Date.now() - lastSaveClickAt > 800) {
          saveButton.click();
          lastSaveClickAt = Date.now();
        }
      }

      const newMessages = messages.slice(messageOffset);
      const blockingMessage = [...newMessages]
        .reverse()
        .find((message) => message.includes('계정') || message.includes('선택') || message.includes('사용자'));
      if (blockingMessage) {
        lastBlockingMessage = blockingMessage;
      }

      await wait(300);
    }

    return {
      ok: false,
      error: lastBlockingMessage || '계정코드를 자동으로 선택하지 못했습니다.'
    };
  };

  G.clickEducationReserveEntry = async function () {
    G.createStatusOverlay();
    G.updateStatus('교육 신청 페이지 진입을 시도합니다.');

    if (window.location.pathname.includes('/login')) {
      return { ok: false, error: '로그인이 필요합니다.' };
    }

    return withAutoConfirm(async () => {
      const entryButton = findBestEducationAction('entry');
      if (!entryButton) {
        G.updateStatus('상세 페이지에서 신청 버튼을 찾지 못했습니다.');
        return { ok: false, error: '상세 페이지에서 신청 버튼을 찾지 못했습니다.' };
      }

      const clickedText = getActionText(entryButton) || '신청 버튼';
      entryButton.click();
      G.updateStatus(`상세 버튼 클릭: ${clickedText}`);
      return { ok: true, clickedText, path: window.location.pathname };
    });
  };

  G.submitEducationReservation = async function ({ education, emailConfig, reservationConfig } = {}) {
    G.createStatusOverlay();
    G.updateStatus('교육 신청 직접 요청을 시도합니다.');

    if (window.location.pathname.includes('/login')) {
      return { ok: false, error: '로그인이 필요합니다.' };
    }

    return withAutoDialogs(async ({ messages }) => {
      const educationContext = resolveEducationContext(education);
      if (!educationContext.EVENT_SKEY || !educationContext.ESCHED_SKEY) {
        G.updateStatus('신청에 필요한 교육 일정 정보를 찾지 못했습니다.');
        return { ok: false, error: '신청에 필요한 교육 일정 정보를 찾지 못했습니다.' };
      }

      const { doc, source } = await loadEducationReservationDocument(educationContext);

      const accountResult =
        source === 'current'
          ? await ensureEducationAccountCode({ messages, reservationConfig })
          : (() => {
              const fixedAccountCode = String(reservationConfig?.fixedAccountCode || '').trim();
              if (!fixedAccountCode) {
                return {
                  ok: false,
                  error: '고정 계정코드가 없어 직접 신청 요청을 보낼 수 없습니다.'
                };
              }
              return {
                ok: true,
                accountCode: fixedAccountCode,
                source: 'fixed'
              };
            })();

      if (!accountResult.ok) {
        G.updateStatus(accountResult.error);
        scheduleOverlayRemoval(5000);
        return { ok: false, error: accountResult.error };
      }
      const accountCode = accountResult.accountCode;

      const payload = {
        EQUIP_SKEY: getDocValue(doc, 'EQUIP_SKEY'),
        USER_SKEY: getDocValue(doc, 'USER_SKEY'),
        EVENT_TYPE: getDocValue(doc, 'EVENT_TYPE') || 'EDU08',
        EVENT_SUB_TYPE: getDocValue(doc, 'EVENT_SUB_TYPE') || educationContext.EVENT_SUB_TYPE || 'RG',
        ACC_CODE: accountCode,
        LECTURER_SKEY: getDocValue(doc, 'LECTURER_SKEY'),
        PLAN_AMOUNT:
          getDocValue(doc, 'AMOUNT') ||
          getDocValue(doc, 'AMOUNT_OUT') ||
          getDocValue(doc, 'PLAN_AMOUNT') ||
          educationContext.PLAN_AMOUNT ||
          0,
        EVENT_SKEY: getDocValue(doc, 'EVENT_SKEY') || educationContext.EVENT_SKEY,
        ESCHED_SKEY: getDocValue(doc, 'ESCHED_SKEY') || educationContext.ESCHED_SKEY,
        ACC_MANAGER: getDocValue(doc, 'ACC_MANAGER_SKEY'),
        STATUS: 'RE',
        NOTE: getDocValue(doc, 'NOTE')
      };

      const requiredCheckResponse = await postIsrcForm('/hm/event/check/equipEventRequired', {
        EQUIP_SKEY: payload.EQUIP_SKEY,
        USER_SKEY: payload.USER_SKEY,
        EVENT_TYPE: payload.EVENT_TYPE,
        EVENT_SUB_TYPE: payload.EVENT_SUB_TYPE,
        ACC_CODE: payload.ACC_CODE,
        LECTURER_SKEY: payload.LECTURER_SKEY,
        FLAG: 'REQ'
      });

      if (!requiredCheckResponse?.success) {
        const error =
          requiredCheckResponse?.data ||
          requiredCheckResponse?.message ||
          '신청 가능 여부 확인에 실패했습니다.';
        G.updateStatus(error);
        scheduleOverlayRemoval(5000);
        return { ok: false, error };
      }

      const insertResponse = await postIsrcForm('/hm/event/reservation/insert', payload);
      if (!insertResponse?.success) {
        const error =
          insertResponse?.message ||
          insertResponse?.data ||
          '교육 신청 요청이 실패했습니다.';
        G.updateStatus(error);
        scheduleOverlayRemoval(5000);
        return { ok: false, error };
      }

      const successMessage = '신청 되었습니다.';
      G.updateStatus('장비교육 신청을 완료했습니다.');
      scheduleOverlayRemoval(4000);

      if (emailConfig?.userEmail) {
        G.sendEmail(emailConfig, {
          start: educationContext.EQUIP_NAME || educationContext.NAME || '장비교육 신청 완료',
          end: successMessage
        });
      }

      return {
        ok: true,
        mode: 'direct_request',
        path: window.location.pathname,
        accountCode
      };
    });
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

  const isCleanRoomFormPage = () => window.location.pathname === '/hm/cleanRoom/form-n';
  const getCleanRoomRoot = () => document.querySelector('#page_clean_room_req');
  const getCleanRoomInput = (selector) => getCleanRoomRoot()?.querySelector(selector) || null;
  const getCleanRoomInputValue = (selector) => normalizeText(getCleanRoomInput(selector)?.value || '');
  const CLEAN_ROOM_FALLBACK_ROW = Object.freeze({
    locationInfo: 'c8',
    equipName: 'Wet station',
    useContents: '반도체 공정'
  });
  const CLEAN_ROOM_DEFAULT_ADVISOR_EMAIL = 'sooyeon.lee@snu.ac.kr';
  const enumerateDateRange = (startDate, endDate) => {
    const start = parseDateTime(`${startDate} 00:00:00`);
    const end = parseDateTime(`${endDate} 00:00:00`);
    if (!start || !end || start > end) return [];

    const dates = [];
    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      dates.push(formatDate(cursor));
    }
    return dates;
  };
  const computeCleanRoomUseWindow = (dateStr) => {
    const targetDate = parseDateTime(`${dateStr} 00:00:00`);
    if (!targetDate) return null;

    const dayOfWeek = targetDate.getDay();
    const holidays = Array.isArray(window.$holidays) ? window.$holidays : [];
    const isHoliday = holidays.includes(dateStr);
    const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;

    let startDt = `${dateStr} 00:00:00`;
    let endDt = `${dateStr} 23:59:59`;
    let useType = 'HD';
    let useTypeLabel = '공휴일';

    if (!isHoliday && isWeekday) {
      useType = 'NT';
      useTypeLabel = '평일';
      startDt = `${dateStr} 18:00:00`;
      const nextDate = addDays(targetDate, 1);
      nextDate.setHours(9, 0, 0, 0);
      endDt = formatDateTimeSeconds(nextDate);
    } else if (dayOfWeek === 0) {
      const nextDate = addDays(targetDate, 1);
      nextDate.setHours(9, 0, 0, 0);
      endDt = formatDateTimeSeconds(nextDate);
    }

    return {
      dateStr,
      useType,
      startDt,
      endDt,
      useTypeHtml: `<span style='font-weight :bold'>(${useTypeLabel})</span> ${startDt} ~ ${endDt}`
    };
  };
  const buildCleanRoomFallbackRow = (dateStr) => {
    const startDate = parseDateTime(`${dateStr} 18:00:00`);
    const endDate = addDays(parseDateTime(`${dateStr} 00:00:00`), 1);
    endDate.setHours(0, 0, 0, 0);

    return {
      reservSkey: '',
      equipSkey: '',
      operSkey: '',
      startDt: formatDateTimeSeconds(startDate),
      endDt: formatDateTimeSeconds(endDate),
      locationInfo: CLEAN_ROOM_FALLBACK_ROW.locationInfo,
      equipName: CLEAN_ROOM_FALLBACK_ROW.equipName,
      useContents: CLEAN_ROOM_FALLBACK_ROW.useContents
    };
  };
  const captureCleanRoomEquipmentRows = () =>
    Array.from(document.querySelectorAll('#equipListSelected .equipmentUsagePlanRow')).map((row) => {
      const useContentsInput = row.querySelector('input[name="useContents"]');
      return {
        reservSkey: normalizeText(row.querySelector('input[name="reservSkey"]')?.value || ''),
        equipSkey: normalizeText(row.querySelector('input[name="equipSkey"]')?.value || ''),
        operSkey: normalizeText(row.querySelector('input[name="operSkey"]')?.value || ''),
        startDt: normalizeText(row.querySelector('input[name="startDt"]')?.value || ''),
        endDt: normalizeText(row.querySelector('input[name="endDt"]')?.value || ''),
        locationInfo: normalizeText(row.querySelector('input[name="locationInfo"]')?.value || ''),
        equipName: normalizeText(row.querySelector('input[name="equipName"]')?.value || ''),
        useContents: useContentsInput
          ? normalizeText(useContentsInput.value)
          : normalizeText(row.querySelector('.t4')?.textContent || '')
      };
    });
  const ensureCleanRoomEquipmentRows = (template, targetDateStr) => {
    const container = document.querySelector('#equipListSelected');
    if (!container) {
      throw new Error('장비 사용 예정 내용 영역을 찾지 못했습니다.');
    }

    const existingRows = Array.from(container.querySelectorAll('.equipmentUsagePlanRow'));
    if (existingRows.length) return existingRows;

    template.rows.forEach((snapshot) => {
      const nextStartDt = snapshot.startDt
        ? shiftCleanRoomPlanDateTime(template.baseHopeDate, targetDateStr, snapshot.startDt)
        : '';
      const nextEndDt = snapshot.endDt
        ? shiftCleanRoomPlanDateTime(template.baseHopeDate, targetDateStr, snapshot.endDt)
        : '';

      const row = document.createElement('ul');
      row.className = 'equipmentUsagePlanRow';
      row.innerHTML = [
        `<input type="hidden" name="equipSkey" value="${escapeHtml(snapshot.equipSkey || '')}">`,
        `<input type="hidden" name="operSkey" value="${escapeHtml(snapshot.operSkey || '')}">`,
        '<input type="hidden" name="reservSkey" value="">',
        `<input type="hidden" name="startDt" value="${escapeHtml(nextStartDt)}">`,
        `<input type="hidden" name="endDt" value="${escapeHtml(nextEndDt)}">`,
        `<input type="hidden" name="locationInfo" value="${escapeHtml(snapshot.locationInfo || '')}">`,
        `<li class="t1">${escapeHtml(snapshot.locationInfo || '')}</li>`,
        `<li class="t2">${escapeHtml(nextStartDt)} ~ ${escapeHtml(nextEndDt)}</li>`,
        `<li class="t3"><input type="text" name="equipName" value="${escapeHtml(snapshot.equipName || '')}" style="width: 100%;"></li>`,
        `<li class="t4"><input type="text" name="useContents" value="${escapeHtml(snapshot.useContents || '')}" style="width: 100%;"></li>`,
        '<li class="t5"><a href="javascript:void(0)" class="btn_type11 deleteEquipBtn">삭제</a></li>'
      ].join('');
      container.appendChild(row);
    });

    return Array.from(container.querySelectorAll('.equipmentUsagePlanRow'));
  };
  const shiftCleanRoomPlanDateTime = (baseDateStr, targetDateStr, originalDateTime) => {
    if (!baseDateStr || !targetDateStr || !originalDateTime) return originalDateTime;

    const baseDate = parseDateTime(`${baseDateStr} 00:00:00`);
    const targetDate = parseDateTime(`${targetDateStr} 00:00:00`);
    const original = parseDateTime(originalDateTime);
    if (!baseDate || !targetDate || !original) return originalDateTime;

    const baseMidnight = new Date(baseDate);
    baseMidnight.setHours(0, 0, 0, 0);

    const originalMidnight = new Date(original);
    originalMidnight.setHours(0, 0, 0, 0);

    const dayOffset = Math.round((originalMidnight - baseMidnight) / (24 * 60 * 60 * 1000));
    const shiftedDate = addDays(targetDate, dayOffset);
    shiftedDate.setHours(original.getHours(), original.getMinutes(), original.getSeconds(), 0);
    return formatDateTimeSeconds(shiftedDate);
  };
  const applyCleanRoomEquipmentRows = (template, targetDateStr) => {
    const rows = ensureCleanRoomEquipmentRows(template, targetDateStr);
    if (rows.length !== template.rows.length) {
      throw new Error('장비 사용 예정 내용이 변경되어 일괄 신청을 계속할 수 없습니다.');
    }

    rows.forEach((row, index) => {
      const snapshot = template.rows[index];
      const reservSkeyInput = row.querySelector('input[name="reservSkey"]');
      const equipSkeyInput = row.querySelector('input[name="equipSkey"]');
      const operSkeyInput = row.querySelector('input[name="operSkey"]');
      const locationInfoInput = row.querySelector('input[name="locationInfo"]');
      const equipNameInput = row.querySelector('input[name="equipName"]');
      const useContentsInput = row.querySelector('input[name="useContents"]');
      const startDtInput = row.querySelector('input[name="startDt"]');
      const endDtInput = row.querySelector('input[name="endDt"]');
      const inlineStartInput = row.querySelector('.t2 input[name="startDt"]');
      const timeCell = row.querySelector('.t2');

      if (reservSkeyInput) setNativeFieldValue(reservSkeyInput, '');
      if (equipSkeyInput) setNativeFieldValue(equipSkeyInput, snapshot.equipSkey);
      if (operSkeyInput) setNativeFieldValue(operSkeyInput, snapshot.operSkey);
      if (locationInfoInput) setNativeFieldValue(locationInfoInput, snapshot.locationInfo);
      if (equipNameInput) setNativeFieldValue(equipNameInput, snapshot.equipName);
      if (useContentsInput) setNativeFieldValue(useContentsInput, snapshot.useContents);

      const nextStartDt = snapshot.startDt
        ? shiftCleanRoomPlanDateTime(template.baseHopeDate, targetDateStr, snapshot.startDt)
        : '';
      const nextEndDt = snapshot.endDt
        ? shiftCleanRoomPlanDateTime(template.baseHopeDate, targetDateStr, snapshot.endDt)
        : '';

      if (startDtInput) setNativeFieldValue(startDtInput, nextStartDt);
      if (endDtInput) setNativeFieldValue(endDtInput, nextEndDt);

      if (timeCell && !inlineStartInput) {
        timeCell.textContent = nextStartDt && nextEndDt ? `${nextStartDt} ~ ${nextEndDt}` : '';
      }
    });
  };
  const applyCleanRoomDateToPage = (template, targetDateStr) => {
    const useWindow = computeCleanRoomUseWindow(targetDateStr);
    if (!useWindow) {
      throw new Error('사용 시간을 계산하지 못했습니다.');
    }

    const hopeDtInput = getCleanRoomInput('input[name="hopeDt"]');
    const useTypeInput = getCleanRoomInput('#reqFrm input[name="useType"]');
    const startDtInput = getCleanRoomInput('#reqFrm input[name="startDt"]');
    const endDtInput = getCleanRoomInput('#reqFrm input[name="endDt"]');
    const useTypeLabel = getCleanRoomRoot()?.querySelector('li[name="useTypeNm"]');

    if (!hopeDtInput || !useTypeInput || !startDtInput || !endDtInput || !useTypeLabel) {
      throw new Error('청정실 신청 입력 필드를 찾지 못했습니다.');
    }

    setNativeFieldValue(hopeDtInput, targetDateStr);
    setNativeFieldValue(useTypeInput, useWindow.useType);
    setNativeFieldValue(startDtInput, useWindow.startDt);
    setNativeFieldValue(endDtInput, useWindow.endDt);
    useTypeLabel.innerHTML = useWindow.useTypeHtml;

    applyCleanRoomEquipmentRows(template, targetDateStr);
  };
  const ensureCleanRoomAdvisorEmail = () => {
    const advisorEmailInput = getCleanRoomInput('input[name="advisorEmail"]');
    if (!advisorEmailInput) return;

    const currentAdvisorEmail = normalizeText(advisorEmailInput.value || '');
    if (currentAdvisorEmail) return;

    const advisorEmailDefaultInput = getCleanRoomInput('input[name="advisorEmailDefault"]');
    const advisorEmailDefault = getCleanRoomInputValue('input[name="advisorEmailDefault"]');
    const requesterEmail = normalizeText(getCleanRoomRoot()?.querySelector('#reqUserEmail')?.textContent || '');
    const fallbackEmail = CLEAN_ROOM_DEFAULT_ADVISOR_EMAIL || advisorEmailDefault || requesterEmail;

    if (fallbackEmail) {
      if (advisorEmailDefaultInput && !advisorEmailDefault) {
        setNativeFieldValue(advisorEmailDefaultInput, fallbackEmail);
      }
      setNativeFieldValue(advisorEmailInput, fallbackEmail);
    }
  };
  const ensureCleanRoomAgreements = () => {
    ['#agree1', '#agree2'].forEach((selector) => {
      const checkbox = getCleanRoomInput(selector);
      if (!checkbox || checkbox.checked) return;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const captureCleanRoomBatchTemplate = (startDate) => {
    if (!isCleanRoomFormPage()) {
      return { ok: false, error: '현재 탭이 청정실 신청 페이지가 아닙니다. /hm/cleanRoom/form-n 페이지를 열어주세요.' };
    }
    if (typeof window.validate !== 'function' || typeof window.makeReqParam !== 'function') {
      return { ok: false, error: '청정실 신청 페이지의 검증 또는 저장 함수를 찾지 못했습니다.' };
    }
    if (typeof window.ajaxJsonResultCall !== 'function') {
      return { ok: false, error: '청정실 신청 AJAX 함수를 찾지 못했습니다.' };
    }

    if (getCleanRoomInputValue('#joinUserReqMstrSkey')) {
      return { ok: false, error: '신청현황 연동 상태에서는 날짜 범위 일괄 신청을 지원하지 않습니다.' };
    }

    const rows = captureCleanRoomEquipmentRows();
    const effectiveRows = rows.length ? rows : [buildCleanRoomFallbackRow(startDate)];
    if (!rows.length && !effectiveRows.length) {
      return { ok: false, error: '장비 사용 예정 내용이 없습니다. 현재 페이지에서 한 번 채운 뒤 다시 실행하세요.' };
    }

    return {
      ok: true,
      template: {
        baseHopeDate: getCleanRoomInputValue('input[name="hopeDt"]') || startDate,
        rows: effectiveRows
      }
    };
  };
  const validateCleanRoomPage = async () => {
    const captured = await withCapturedAlerts(() => window.validate());
    const isValid = Boolean(captured.result);
    return {
      ok: isValid,
      error: isValid ? '' : captured.messages[captured.messages.length - 1] || '페이지 검증에 실패했습니다.'
    };
  };
  const submitCleanRoomRequest = async (param) => {
    const captured = await withCapturedAlerts(
      () =>
        new Promise((resolve, reject) => {
          try {
            window.ajaxJsonResultCall('/hm/cleanRoom/apply/json', param, resolve);
          } catch (error) {
            reject(error);
          }
        })
    );

    return {
      response: captured.result,
      messages: captured.messages
    };
  };

  G.__deprecatedBatchApplyCleanRoomRequests = async function (opts = {}) {
    const startDate = normalizeText(opts.startDate || '');
    const endDate = normalizeText(opts.endDate || startDate);
    if (!startDate || !endDate) {
      return { ok: false, error: '시작일과 종료일이 필요합니다.', results: [] };
    }

    const dates = enumerateDateRange(startDate, endDate);
    if (!dates.length) {
      return { ok: false, error: '날짜 범위를 해석하지 못했습니다.', results: [] };
    }

    const capturedTemplate = captureCleanRoomBatchTemplate(startDate);
    if (!capturedTemplate.ok) {
      return { ok: false, error: capturedTemplate.error, results: [] };
    }

    const results = [];
    const template = capturedTemplate.template;

    for (let index = 0; index < dates.length; index += 1) {
      const dateStr = dates[index];

      try {
        applyCleanRoomDateToPage(template, dateStr);
        ensureCleanRoomAdvisorEmail();
        ensureCleanRoomAgreements();

        const validation = await validateCleanRoomPage();
        if (!validation.ok) {
          results.push({ date: dateStr, ok: false, error: validation.error });
          continue;
        }

        const param = window.makeReqParam();
        const response = await submitCleanRoomRequest(param);
        if (response?.success) {
          results.push({ date: dateStr, ok: true });
        } else {
          results.push({
            date: dateStr,
            ok: false,
            error: normalizeText(response?.message || response?.data || '신청에 실패했습니다.')
          });
        }
      } catch (error) {
        results.push({
          date: dateStr,
          ok: false,
          error: normalizeText(error?.message || '신청 중 오류가 발생했습니다.')
        });
      }

      if (index < dates.length - 1) {
        await wait(150);
      }
    }

    const successCount = results.filter((entry) => entry.ok).length;
    const failCount = results.length - successCount;
    return {
      ok: successCount > 0,
      successCount,
      failCount,
      totalCount: results.length,
      results,
      error: failCount ? '일부 날짜는 실패했습니다.' : ''
    };
  };

  G.batchApplyCleanRoomRequests = async function (opts = {}) {
    const startDate = normalizeText(opts.startDate || '');
    const endDate = normalizeText(opts.endDate || startDate);
    if (!startDate || !endDate) {
      return { ok: false, error: '시작일과 종료일이 필요합니다.', results: [] };
    }

    const dates = enumerateDateRange(startDate, endDate);
    if (!dates.length) {
      return { ok: false, error: '날짜 범위를 해석하지 못했습니다.', results: [] };
    }

    const capturedTemplate = captureCleanRoomBatchTemplate(startDate);
    if (!capturedTemplate.ok) {
      return { ok: false, error: capturedTemplate.error, results: [] };
    }

    const results = [];
    const template = capturedTemplate.template;

    for (let index = 0; index < dates.length; index += 1) {
      const dateStr = dates[index];

      try {
        applyCleanRoomDateToPage(template, dateStr);
        ensureCleanRoomAdvisorEmail();
        ensureCleanRoomAgreements();

        const validation = await validateCleanRoomPage();
        if (!validation.ok) {
          results.push({ date: dateStr, ok: false, error: validation.error });
          continue;
        }

        const param = window.makeReqParam();
        const submitResult = await submitCleanRoomRequest(param);
        const response = submitResult.response;

        if (response?.success) {
          results.push({ date: dateStr, ok: true });
        } else {
          results.push({
            date: dateStr,
            ok: false,
            error: normalizeText(
              response?.message ||
                response?.data ||
                submitResult.messages[submitResult.messages.length - 1] ||
                '신청에 실패했습니다.'
            )
          });
        }
      } catch (error) {
        results.push({
          date: dateStr,
          ok: false,
          error: normalizeText(error?.message || '신청 중 오류가 발생했습니다.')
        });
      }

      if (index < dates.length - 1) {
        await wait(150);
      }
    }

    const successCount = results.filter((entry) => entry.ok).length;
    const failCount = results.length - successCount;
    return {
      ok: successCount > 0,
      successCount,
      failCount,
      totalCount: results.length,
      results,
      error: failCount ? '일부 날짜는 실패했습니다.' : ''
    };
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

    let result = await G.tryReserve(emailConfig || {}, slot);
    let reservedSlot = slot;

    if (result.reason === 'save_button_timeout') {
      result = await tryAlternativeSlots({
        failedSlot: slot,
        dateStr,
        emailConfig: emailConfig || {}
      });
      if (result.ok && result.slot) {
        reservedSlot = result.slot;
      }
    }

    if (result.ok) {
      const emailSent = G.sendEmail(emailConfig || {}, reservedSlot);
      if (result.usedFallback) {
        G.updateStatus(
          emailSent
            ? `원래 시간이 차서 ${reservedSlot.start}로 대체 예약했고 이메일 전송을 요청했습니다.`
            : `원래 시간이 차서 ${reservedSlot.start}로 대체 예약했습니다.`
        );
      } else {
        G.updateStatus(
          emailSent
            ? `${reservedSlot.start} 예약 완료. 이메일 전송을 요청했습니다.`
            : `${reservedSlot.start} 예약을 완료했습니다.`
        );
      }
    } else {
      G.updateStatus(describeReserveFailure(result.reason));
    }

    scheduleOverlayRemoval(3000);
    return result;
  };
})();
