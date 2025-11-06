async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function highlightFunction(term) {
  if (!term) return;
  const styleId = "__gext_highlight_style__";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `mark.__gext_mark__{ background: yellow; padding: 0 .2em; }`;
    document.head.appendChild(style);
  }
  // remove previous marks first
  document.querySelectorAll("mark.__gext_mark__").forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });

  // Simple text walker highlighter
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const toMark = [];
  const termLower = term.toLowerCase();

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue.trim()) continue;
    const idx = node.nodeValue.toLowerCase().indexOf(termLower);
    if (idx !== -1) {
      toMark.push({ node, idx, len: term.length });
    }
  }

  for (const item of toMark) {
    const { node, idx, len } = item;
    const text = node.nodeValue;
    const before = document.createTextNode(text.slice(0, idx));
    const match = document.createElement("mark");
    match.className = "__gext_mark__";
    match.textContent = text.slice(idx, idx + len);
    const after = document.createTextNode(text.slice(idx + len));
    const frag = document.createDocumentFragment();
    frag.appendChild(before);
    frag.appendChild(match);
    frag.appendChild(after);
    node.parentNode.replaceChild(frag, node);
  }
}

function clearFunction() {
  document.querySelectorAll("mark.__gext_mark__").forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
}

function setStartDtOnPage(inputValue) {
  if (!inputValue) return false;

  // 1) 대상 input 찾기
  const el =
    document.querySelector('input[name="START_DT_STR"].i_calendar.datepicker-calendar') ||
    document.querySelector('input[name="START_DT_STR"]') ||
    document.querySelector('input[name="START_DT_STR"][readonly]');

  if (!el) return false;

  // 2) 입력값 정규화: "14:30" 같은 시간만 오면 기존 날짜와 합치기
  const trimmed = inputValue.trim();
  const timeOnlyMatch = trimmed.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  let finalStr = trimmed;

  if (timeOnlyMatch) {
    const current = el.value || "";
    // 현재 필드에 날짜가 있다면 그 날짜 + 새 시간으로 합침
    const datePartMatch = current.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (datePartMatch) {
      const datePart = datePartMatch[0]; // YYYY-MM-DD
      finalStr = `${datePart} ${trimmed}`;
    } else {
      // 날짜가 없다면 오늘 날짜를 붙여줌
      const d = new Date();
      const pad = n => (n < 10 ? "0" + n : "" + n);
      const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      finalStr = `${today} ${trimmed}`;
    }
  }

  // 3) readonly 잠시 해제 후 값 주입(프레임워크 대응)
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const prevReadOnly = el.readOnly;
  el.readOnly = false;

  if (nativeSetter) nativeSetter.call(el, finalStr);
  else el.value = finalStr;

  // 4) 이벤트 발사로 UI/바인딩 갱신
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  // 5) jQuery UI datepicker 연동(있을 때만)
  try {
    if (window.jQuery && typeof jQuery.fn.datepicker === "function") {
      // 가능한 한 Date로도 맞춰주기
      const parsed = (function parseToDate(s) {
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
        if (!m) return new Date(s);
        const [, Y, MM, DD, HH = "00", mm = "00", ss = "00"] = m;
        return new Date(+Y, +MM - 1, +DD, +HH, +mm, +ss);
      })(finalStr);
      if (!Number.isNaN(+parsed)) jQuery(el).datepicker("setDate", parsed);
    }
  } catch (_) { }

  // 6) 원상 복귀
  el.readOnly = prevReadOnly;

  return true;
}

function setEndDtOnPage(inputValue) {
  if (!inputValue) return false;

  const el =
    document.querySelector('input[name="END_DT_STR"].i_calendar.datepicker-calendar') ||
    document.querySelector('input[name="END_DT_STR"]') ||
    document.querySelector('input[name="END_DT_STR"][readonly]');

  if (!el) return false;

  const trimmed = inputValue.trim();
  const timeOnlyMatch = trimmed.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  let finalStr = trimmed;

  if (timeOnlyMatch) {
    const current = el.value || "";
    const datePartMatch = current.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (datePartMatch) {
      const datePart = datePartMatch[0];
      finalStr = `${datePart} ${trimmed}`;
    } else {
      const d = new Date();
      const pad = n => (n < 10 ? "0" + n : "" + n);
      const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      finalStr = `${today} ${trimmed}`;
    }
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const prevReadOnly = el.readOnly;
  el.readOnly = false;

  if (nativeSetter) nativeSetter.call(el, finalStr);
  else el.value = finalStr;

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  try {
    if (window.jQuery && typeof jQuery.fn.datepicker === "function") {
      const parsed = (function parseToDate(s) {
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
        if (!m) return new Date(s);
        const [, Y, MM, DD, HH = "00", mm = "00", ss = "00"] = m;
        return new Date(+Y, +MM - 1, +DD, +HH, +mm, +ss);
      })(finalStr);
      if (!Number.isNaN(+parsed)) jQuery(el).datepicker("setDate", parsed);
    }
  } catch (_) { }

  el.readOnly = prevReadOnly;
  return true;
}


/**
 * 해당 날짜의 예약을 조회해 "첫 번째로 가능한 빈 구간"을 찾아
 * START_DT_STR / END_DT_STR를 자동으로 채운다.
 *
 * @param {Object} opts
 * @param {number} opts.durationMin   원하는 사용 시간(분) 예: 60
 * @param {string} [opts.dateStr]     대상 날짜 "YYYY-MM-DD". 없으면 선택된 달력/입력/오늘 순으로 결정
 * @param {string} [opts.preferAfter] 우선 탐색 시작시각 "HH:mm" (예: "13:00")
 */
async function autoFillFreeSlot(opts = {}) {
  const {
    durationMin = 60,
    dateStr = null,
    preferAfter = null
  } = opts;

  // 0) 유틸
  const pad = n => (n < 10 ? "0" + n : "" + n);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const roundUpToUnit = (date, unitMin) => {
    const d = new Date(date);
    const m = d.getMinutes();
    const up = Math.ceil(m / unitMin) * unitMin;
    if (up >= 60) {
      d.setHours(d.getHours() + 1, up % 60, 0, 0);
    } else {
      d.setMinutes(up, 0, 0);
    }
    return d;
  };

  // 1) 대상 날짜 결정
  let targetDate; // Date at 00:00 of target day
  const fromStartInput = (function () {
    const v = $reserv?.find?.('[name=START_DT_STR]')?.val?.();
    if (v && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    return null;
  })();

  const fromMonthPicker = (function () {
    try {
      const dp = $("#d_datepicker").datepicker().data('datepicker');
      const sel = dp?.selectedDates?.[0];
      if (sel) return `${sel.getFullYear()}-${pad(sel.getMonth() + 1)}-${pad(sel.getDate())}`;
    } catch (_) { }
    return null;
  })();

  const dayStr = dateStr || fromMonthPicker || fromStartInput || moment(new Date()).format("YYYY-MM-DD");
  targetDate = new Date(`${dayStr} 00:00`);

  // 2) 서버에서 “해당 하루”의 예약 목록 가져오기 (페이지가 쓰는 파라미터 그대로)
  const BOOKING = (function () {
    if (typeof BOOKING_TYPE !== 'undefined' && BOOKING_TYPE) return BOOKING_TYPE;
    if ("Y" !== "N") return "SU";
    if ("Y" !== "N") return "RE";
    return "";
  })();

  const ajaxParams = {
    "EQUIP_SKEY": $equipSkey,
    "START_DT_STR": moment(targetDate).format('YYYY-MM-DD'),
    "END_DT_STR": moment(targetDate).add(1, 'days').format('YYYY-MM-DD'),
    "AUTH_TYPE": $requesterAuth,
    "BOOKING_TYPE": BOOKING,
    "OPER_SKEY": $operSkey,
    "DUPICATE_RESERV_FLAG": $dupicateReservFlag,
    "FLAG_NOT_OBSERVER": $flagNotObserver,
    "FLAG_ALL_AUTH": $flagAllAuth,
    "SCHED_KIND": $schedKind,
    "RECESS_FLAG": $recessFlag,
    "TIME_UNIT": $timeUnit,
    "lang": GB_LANG
  };

  const fetchCalendar = () => new Promise((resolve, reject) => {
    if (typeof ajaxJsonResultCallNoLoading === "function") {
      ajaxJsonResultCallNoLoading('/hm/equipReservation/reservation/calendar/json', ajaxParams, resolve);
    } else {
      // 폴백: 일반 AJAX
      $.ajax({
        url: '/hm/equipReservation/reservation/calendar/json',
        method: 'POST',
        data: ajaxParams,
        success: data => resolve(data),
        error: (_, __, err) => reject(err)
      });
    }
  });

  const res = await fetchCalendar();
  if (!res || res.success !== true) {
    console.error("예약 조회 실패", res);
    alert("예약 목록을 불러오지 못했습니다.");
    return false;
  }

  // 3) 바쁜 구간 목록 만들기
  //    서버에서 오는 obj.data의 start/end를 Date로 변환
  const busy = (res.data || []).map(e => {
    // 일부 달력 데이터는 연도가 빠질 수 있으므로 기존 함수가 있다면 재사용
    try {
      if (typeof datetimeParserStringToDateFixYear === "function") {
        // startYear: 대상 연도
        return {
          start: datetimeParserStringToDateFixYear(targetDate.getFullYear(), e.start),
          end: datetimeParserStringToDateFixYear(targetDate.getFullYear(), e.end)
        };
      }
    } catch (_) { }
    // 일반 파서로 폴백
    return { start: new Date(e.start), end: new Date(e.end) };
  }).filter(x => !isNaN(+x.start) && !isNaN(+x.end))
    .sort((a, b) => +a.start - +b.start);

  // 4) 탐색 기준 시간대 정의
  const unit = Math.max(1, parseInt($timeUnit || "10", 10)); // 분 단위
  // 오늘이면 "지금 이후"로, preferAfter가 있으면 그 시각 이후로
  let searchStart = new Date(targetDate);
  if (moment().format("YYYY-MM-DD") === dayStr) {
    searchStart = new Date(); // 현재 이후
  }
  if (preferAfter && /^\d{2}:\d{2}$/.test(preferAfter)) {
    const [hh, mm] = preferAfter.split(":").map(Number);
    const pick = new Date(targetDate); pick.setHours(hh, mm, 0, 0);
    if (pick > searchStart) searchStart = pick;
  }
  // 단위 격자에 맞춰 반올림
  searchStart = roundUpToUnit(searchStart, unit);

  const dayEnd = new Date(targetDate); dayEnd.setDate(dayEnd.getDate() + 1); // 다음날 00:00

  // 5) 빈 구간 계산
  //    boundaries: [searchStart, dayEnd]에서 busy를 빼면서 gaps 구함
  let cursor = new Date(searchStart);
  let chosen = null;

  for (const b of busy) {
    const bStart = new Date(Math.max(+b.start, +searchStart));
    const bEnd = new Date(Math.min(+b.end, +dayEnd));
    if (bEnd <= searchStart) continue; // 전혀 영향 없음
    // gap: [cursor, bStart)
    if (cursor < bStart) {
      const gapStart = roundUpToUnit(cursor, unit);
      const gapEnd = new Date(bStart);
      // gap 안에서 단위 격자에 맞는 시작을 찾아 durationMin 만큼 넣을 수 있나 체크
      if (+gapStart + durationMin * 60 * 1000 <= +gapEnd) {
        chosen = { start: gapStart, end: new Date(+gapStart + durationMin * 60 * 1000) };
        break;
      }
    }
    if (cursor < bEnd) cursor = new Date(bEnd);
    if (cursor >= dayEnd) break;
  }
  // 바쁜 구간 뒤에도 남았는지 확인
  if (!chosen && cursor < dayEnd) {
    const gapStart = roundUpToUnit(cursor, unit);
    const gapEnd = dayEnd;
    if (+gapStart + durationMin * 60 * 1000 <= +gapEnd) {
      chosen = { start: gapStart, end: new Date(+gapStart + durationMin * 60 * 1000) };
    }
  }

  if (!chosen) {
    alert("요청하신 길이의 빈 시간이 없습니다. 다른 시간 또는 기간으로 시도해보세요.");
    return false;
  }

  // 6) 입력칸 채우기 + 달력/검증 로직 연동
  const $start = $reserv.find('input[name=START_DT_STR]');
  const $end = $reserv.find('input[name=END_DT_STR]');
  const startStr = fmt(chosen.start);
  const endStr = fmt(chosen.end);

  const setVal = ($el, v) => {
    const el = $el.get(0);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const prev = el.readOnly; el.readOnly = false;
    nativeSetter ? nativeSetter.call(el, v) : el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try { $el.data("datepicker")?.selectDate?.(new Date(v)); } catch (_) { }
    el.readOnly = prev;
  };

  setVal($start, startStr);
  setVal($end, endStr);

  // 페이지의 기존 동작과 동기화
  try {
    $selectStart = new Date(startStr);
    $selectEnd = new Date(endStr);
    setDateDay(true);           // 달력 반영
    overlapCheck();             // 중복 경고 갱신
  } catch (_) { }

  return true;
}


/**
 * 해당 날짜의 예약을 조회해 빈 구간 목록을 계산해 반환
 * @param {Object} opts
 * @param {number} opts.durationMin   원하는 사용 시간(분) 예: 60
 * @param {string} [opts.dateStr]     대상 날짜 "YYYY-MM-DD"
 * @param {string} [opts.preferAfter] 우선 탐색 시작시각 "HH:mm"
 * @param {number} [opts.limit=20]    최대 몇 개까지 보여줄지
 * @returns {{slots: Array<{start:string,end:string}>}}
 */
// 빈 시간 계산기: 백엔드 응답(data[])을 그대로 받아 처리
async function findFreeSlots(opts = {}) {
  const {
    durationMin = 60,
    dateStr = null,          // 특정 날짜만 보고 싶으면 YYYY-MM-DD. 없으면 응답의 날짜로 자동 추정
    preferAfter = null,      // "HH:mm" 이후로만
    limit = 30,
    preFetched = null        // ★ 백엔드에서 받은 data 배열 그대로
  } = opts;

  const pad = n => (n < 10 ? "0" + n : "" + n);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parse = (s) => {
    // "YYYY-MM-DD HH:mm" 확정 포맷
    const [d, t] = s.split(" ");
    const [Y, M, D] = d.split("-").map(Number);
    const [h, m] = t.split(":").map(Number);
    return new Date(Y, M - 1, D, h, m, 0, 0);
  };
  const roundUpToUnit = (date, unitMin) => {
    const d = new Date(date);
    const up = Math.ceil(d.getMinutes() / unitMin) * unitMin;
    if (up >= 60) d.setHours(d.getHours() + 1, up % 60, 0, 0);
    else d.setMinutes(up, 0, 0);
    return d;
  };

  // 0) 데이터 소스 확보
  let raw = Array.isArray(preFetched) ? preFetched : [];
  if (!raw.length) {
    // 백업: 페이지 함수로 직접 호출(있을 때만)
    const pickDay = dateStr || (window.moment ? moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10));
    const BOOKING = (function () {
      if (typeof BOOKING_TYPE !== 'undefined' && BOOKING_TYPE) return BOOKING_TYPE;
      if ("Y" !== "N") return "SU";
      if ("Y" !== "N") return "RE";
      return "";
    })();
    const ajaxParams = {
      "EQUIP_SKEY": window.$equipSkey,
      "START_DT_STR": pickDay,
      "END_DT_STR": window.moment ? moment(pickDay).add(1, 'days').format('YYYY-MM-DD') : pickDay,
      "AUTH_TYPE": window.$requesterAuth,
      "BOOKING_TYPE": BOOKING,
      "OPER_SKEY": window.$operSkey,
      "DUPICATE_RESERV_FLAG": window.$dupicateReservFlag,
      "FLAG_NOT_OBSERVER": window.$flagNotObserver,
      "FLAG_ALL_AUTH": window.$flagAllAuth,
      "SCHED_KIND": window.$schedKind,
      "RECESS_FLAG": window.$recessFlag,
      "TIME_UNIT": window.$timeUnit,
      "lang": window.GB_LANG
    };
    if (typeof window.ajaxJsonResultCallNoLoading === "function") {
      const res = await new Promise(resolve => {
        window.ajaxJsonResultCallNoLoading('/hm/equipReservation/reservation/calendar/json', ajaxParams, resolve);
      });
      if (res && res.success) raw = res.data || [];
    }
  }
  if (!raw.length) return { slots: [] };

  // 1) 대상 날짜 결정
  const firstStartStr = raw[0]?.start;
  const inferredDay = firstStartStr ? firstStartStr.slice(0, 10) : (window.moment ? moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10));
  const dayStr = dateStr || inferredDay;
  const dayStart = parse(`${dayStr} 00:00`);
  let dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  // 2) 바쁜 구간 정규화(정렬 + 머지)
  const busy = raw
    .map(e => ({ start: parse(e.start), end: parse(e.end) }))
    .filter(x => +x.start < +x.end)
    .sort((a, b) => +a.start - +b.start);

  const merged = [];
  for (const b of busy) {
    if (!merged.length || b.start > merged[merged.length - 1].end) {
      merged.push({ ...b });
    } else {
      // overlap
      if (b.end > merged[merged.length - 1].end) merged[merged.length - 1].end = b.end;
    }
  }

  // 3) 탐색 시작 시각: 현재 이후
  const unit = Math.max(1, parseInt(window.$timeUnit || "10", 10));
  const now = new Date();
  let searchStart = now > dayStart ? new Date(now) : new Date(dayStart);

  // 옵션으로 "HH:mm" 이후 강제 시프트
  if (preferAfter && /^\d{2}:\d{2}$/.test(preferAfter)) {
    const [hh, mm] = preferAfter.split(":").map(Number);
    const after = new Date(dayStart); after.setHours(hh, mm, 0, 0);
    if (after > searchStart) searchStart = after;
  }

  // 4) 허용 범위 클리핑
  if (window.$defaultDate instanceof Date && searchStart < window.$defaultDate) {
    searchStart = new Date(window.$defaultDate);
  }
  if (window.$maxDate instanceof Date && dayEnd > window.$maxDate) {
    dayEnd = new Date(window.$maxDate);
  }

  // 격자 정렬
  searchStart = roundUpToUnit(searchStart, unit);

  // 5) gap 계산
  const slots = [];
  let cursor = new Date(searchStart);

  const pushSlotsInGap = (gapStart, gapEnd) => {
    let s = roundUpToUnit(gapStart, unit);
    while (+s + durationMin * 60 * 1000 <= +gapEnd) {
      const e = new Date(+s + durationMin * 60 * 1000);
      slots.push({ start: fmt(s), end: fmt(e) });
      if (slots.length >= limit) return true;
      s = new Date(+s + unit * 60 * 1000); // 시작 후보를 격자 단위로 이동해 여러 후보 생성
    }
    return false;
  };

  for (const b of merged) {
    // 오늘/해당일 범위와 교집합만 고려
    const bStart = new Date(Math.max(+b.start, +dayStart));
    const bEnd = new Date(Math.min(+b.end, +dayEnd));
    if (bEnd <= searchStart) continue;
    if (cursor < bStart) {
      if (pushSlotsInGap(cursor, bStart)) break;
    }
    if (cursor < bEnd) cursor = new Date(bEnd);
    if (cursor >= dayEnd) break;
  }
  if (slots.length < limit && cursor < dayEnd) {
    pushSlotsInGap(cursor, dayEnd);
  }

  // 디버그가 필요하면 주석 해제
  // console.log('[FreeSlots]', { merged, searchStart, dayEnd, unit, durationMin, slots });

  return { slots };
}


/**
 * start/end 문자열을 받아 두 입력칸을 채우고 페이지 상태를 동기화
 * @param {{start:string, end:string}} slot
 */
function fillSlotOnPage(slot) {
  if (!slot || !slot.start || !slot.end) return false;

  const $start = $reserv.find('input[name=START_DT_STR]');
  const $end = $reserv.find('input[name=END_DT_STR]');

  const setVal = ($el, v) => {
    const el = $el.get(0);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const prev = el.readOnly; el.readOnly = false;
    nativeSetter ? nativeSetter.call(el, v) : el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try { $el.data("datepicker")?.selectDate?.(new Date(v)); } catch (_) { }
    el.readOnly = prev;
  };

  setVal($start, slot.start);
  setVal($end, slot.end);

  try {
    $selectStart = new Date(slot.start);
    $selectEnd = new Date(slot.end);
    setDateDay(true);
    overlapCheck();
  } catch (_) { }

  return true;
}

// ========================================
// 5초 간격 자동 스캔(팝업 타이머 방식)
// ========================================
let __popupAutoScanTimer = null;
let __lastFilledKey = null; // ← 추가: 최근 채운 슬롯 키(중복 방지)

async function startAutoScanFromPopup() {
  const durationMin = parseInt(document.getElementById('freeSlotDuration')?.value || '60', 10);
  const dateStr = document.getElementById('freeSlotDate')?.value?.trim() || null;
  const preferAfter = document.getElementById('freeSlotAfter')?.value?.trim() || null;
  const statusEl = document.getElementById('autoScanStatus');

  const tab = await getActiveTab();
  if (!tab?.id) {
    if (statusEl) statusEl.textContent = '활성 탭을 찾을 수 없어요.';
    return;
  }

  // 이미 실행 중이면 중복 방지
  if (__popupAutoScanTimer) {
    if (statusEl) statusEl.textContent = '이미 자동 스캔 중입니다.';
    return;
  }

  const intervalMs = 5000;      // 5초 주기
  const hardStopMs = 15 * 60 * 1000; // 최대 15분 보호 타임아웃(원하면 조절)
  const t0 = Date.now();
  if (statusEl) statusEl.textContent = '자동 스캔 시작…';

const tick = async () => {
  if (Date.now() - t0 > hardStopMs) {
    stopAutoScanFromPopup();
    if (statusEl) statusEl.textContent = '자동 스캔 종료(최대 시간 초과)';
    return;
  }

  try {
    await ensureHelpers(tab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (opts) => window.__gext.findFreeSlots(opts),
      args: [{ durationMin, dateStr, preferAfter, limit: 50 }]
    });

    const slots = result?.slots || [];
    // ✨ 모든 슬롯을 팝업 리스트에 그리기
    await renderSlotList(slots, tab.id);

    // 첫 슬롯 자동 채움은 그대로 유지(옵션)
    const first = slots[0];
    if (first) {
      const key = `${first.start}|${first.end}`;
      if (__lastFilledKey !== key) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (slot) => window.__gext.fillSlotOnPage(slot),
          args: [first]
        });
        __lastFilledKey = key;
        if (statusEl) statusEl.textContent = `슬롯 채움: ${first.start} ~ ${first.end} (전체 ${slots.length}개, 계속 감시 중)`;
      } else {
        if (statusEl) statusEl.textContent = `변화 없음(총 ${slots.length}개). 계속 감시 중… ${new Date().toLocaleTimeString()}`;
      }
    } else {
      if (statusEl) statusEl.textContent = `빈 슬롯 0개. 계속 감시 중… ${new Date().toLocaleTimeString()}`;
    }
  } catch (e) {
    console.error('[AutoScan tick error]', e);
    if (statusEl) statusEl.textContent = '오류 발생. 콘솔을 확인하세요.';
  }
};


  // 즉시 1회 실행 후 주기 실행
  await tick();
  __popupAutoScanTimer = setInterval(tick, intervalMs);
}


async function ensureHelpers(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (window.__gext) return;  // 이미 주입됨
      window.__gext = {};

      // 공통 유틸
      const pad = n => (n < 10 ? "0" + n : "" + n);
      const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const parse = (s) => { const [d, t] = s.split(" "); const [Y, M, D] = d.split("-").map(Number); const [h, m] = t.split(":").map(Number); return new Date(Y, M - 1, D, h, m, 0, 0); };
      const roundUpToUnit = (date, unitMin) => {
        const d = new Date(date);
        const up = Math.ceil(d.getMinutes() / unitMin) * unitMin;
        if (up >= 60) d.setHours(d.getHours() + 1, up % 60, 0, 0); else d.setMinutes(up, 0, 0);
        return d;
      };

      // 하이라이트
      window.__gext.highlight = function (term) {
        if (!term) return;
        const styleId = "__gext_highlight_style__";
        if (!document.getElementById(styleId)) {
          const style = document.createElement("style");
          style.id = styleId;
          style.textContent = `mark.__gext_mark__{ background: yellow; padding: 0 .2em; }`;
          document.head.appendChild(style);
        }
        document.querySelectorAll("mark.__gext_mark__").forEach(m => {
          const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize();
        });
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        const toMark = [];
        const termLower = term.toLowerCase();
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.nodeValue.trim()) continue;
          const idx = node.nodeValue.toLowerCase().indexOf(termLower);
          if (idx !== -1) toMark.push({ node, idx, len: term.length });
        }
        for (const { node, idx, len } of toMark) {
          const text = node.nodeValue;
          const before = document.createTextNode(text.slice(0, idx));
          const match = document.createElement("mark");
          match.className = "__gext_mark__";
          match.textContent = text.slice(idx, idx + len);
          const after = document.createTextNode(text.slice(idx + len));
          const frag = document.createDocumentFragment();
          frag.appendChild(before); frag.appendChild(match); frag.appendChild(after);
          node.parentNode.replaceChild(frag, node);
        }
      };
      window.__gext.clear = function () {
        document.querySelectorAll("mark.__gext_mark__").forEach(m => {
          const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize();
        });
      };

      // 입력 채우기
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        const prev = el.readOnly; el.readOnly = false;
        setter ? setter.call(el, v) : el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        try { window.jQuery && window.jQuery(el).data("datepicker")?.selectDate?.(new Date(v)); } catch (_) { }
        el.readOnly = prev;
      };
      window.__gext.setStartDtOnPage = function (inputValue) {
        if (!inputValue) return false;
        const el = document.querySelector('input[name="START_DT_STR"].i_calendar.datepicker-calendar')
          || document.querySelector('input[name="START_DT_STR"]')
          || document.querySelector('input[name="START_DT_STR"][readonly]');
        if (!el) return false;
        const trimmed = inputValue.trim();
        const m = trimmed.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
        let finalStr = trimmed;
        if (m) {
          const current = el.value || "";
          const dm = current.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (dm) finalStr = `${dm[0]} ${trimmed}`;
          else {
            const d = new Date(); const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            finalStr = `${today} ${trimmed}`;
          }
        }
        setVal(el, finalStr);
        try {
          if (window.jQuery && typeof jQuery.fn.datepicker === "function") {
            const m = finalStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
            const parsed = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : new Date(finalStr);
            if (!Number.isNaN(+parsed)) jQuery(el).datepicker("setDate", parsed);
          }
        } catch (_) { }
        return true;
      };
      window.__gext.setEndDtOnPage = function (inputValue) {
        if (!inputValue) return false;
        const el = document.querySelector('input[name="END_DT_STR"].i_calendar.datepicker-calendar')
          || document.querySelector('input[name="END_DT_STR"]')
          || document.querySelector('input[name="END_DT_STR"][readonly]');
        if (!el) return false;
        const trimmed = inputValue.trim();
        const m = trimmed.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
        let finalStr = trimmed;
        if (m) {
          const current = el.value || "";
          const dm = current.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (dm) finalStr = `${dm[0]} ${trimmed}`;
          else {
            const d = new Date(); const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            finalStr = `${today} ${trimmed}`;
          }
        }
        setVal(el, finalStr);
        try {
          if (window.jQuery && typeof jQuery.fn.datepicker === "function") {
            const m = finalStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
            const parsed = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : new Date(finalStr);
            if (!Number.isNaN(+parsed)) jQuery(el).datepicker("setDate", parsed);
          }
        } catch (_) { }
        return true;
      };

      // 슬롯 채우기
      window.__gext.fillSlotOnPage = function (slot) {
        const $ = window.jQuery;
        const $reserv = window.$reserv || ($ && $(".reserv_time_wrap"));
        const startEl = ($reserv && $reserv.find('input[name=START_DT_STR]')[0]) || document.querySelector('input[name="START_DT_STR"]');
        const endEl = ($reserv && $reserv.find('input[name=END_DT_STR]')[0]) || document.querySelector('input[name="END_DT_STR"]');
        if (startEl && endEl) {
          setVal(startEl, slot.start);
          setVal(endEl, slot.end);
        }
        try {
          window.$selectStart = new Date(slot.start);
          window.$selectEnd = new Date(slot.end);
          typeof window.setDateDay === 'function' && window.setDateDay(true);
          typeof window.overlapCheck === 'function' && window.overlapCheck();
        } catch (_) { }
        return true;
      };

      // 빈 시간 계산(백엔드 조회 포함)
      window.__gext.findFreeSlots = async function (opts) {
        const { durationMin = 60, dateStr = null, preferAfter = null, limit = 30 } = opts || {};

        const BOOKING = (function () {
          if (typeof window.BOOKING_TYPE !== 'undefined' && window.BOOKING_TYPE) return window.BOOKING_TYPE;
          if ("Y" !== "N") return "SU";
          if ("Y" !== "N") return "RE";
          return "";
        })();
        const pickDay = dateStr || (window.moment ? moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10));
        const ajaxParams = {
          "EQUIP_SKEY": window.$equipSkey,
          "START_DT_STR": pickDay,
          "END_DT_STR": window.moment ? moment(pickDay).add(1, 'days').format('YYYY-MM-DD') : pickDay,
          "AUTH_TYPE": window.$requesterAuth,
          "BOOKING_TYPE": BOOKING,
          "OPER_SKEY": window.$operSkey,
          "DUPICATE_RESERV_FLAG": window.$dupicateReservFlag,
          "FLAG_NOT_OBSERVER": window.$flagNotObserver,
          "FLAG_ALL_AUTH": window.$flagAllAuth,
          "SCHED_KIND": window.$schedKind,
          "RECESS_FLAG": window.$recessFlag,
          "TIME_UNIT": window.$timeUnit,
          "lang": window.GB_LANG
        };

        let raw = [];
        if (typeof window.ajaxJsonResultCallNoLoading === "function") {
          const res = await new Promise(resolve => {
            window.ajaxJsonResultCallNoLoading('/hm/equipReservation/reservation/calendar/json', ajaxParams, resolve);
          });
          if (res && res.success) raw = res.data || [];
        }
        if (!raw.length) return { slots: [] };

        const dayStr = dateStr || (raw[0]?.start?.slice(0, 10) || pickDay);
        const dayStart = parse(`${dayStr} 00:00`);
        let dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

        const busy = raw.map(e => ({ start: parse(e.start), end: parse(e.end) }))
          .filter(x => +x.start < +x.end)
          .sort((a, b) => +a.start - +b.start);

        const merged = [];
        for (const b of busy) {
          if (!merged.length || b.start > merged[merged.length - 1].end) merged.push({ ...b });
          else if (b.end > merged[merged.length - 1].end) merged[merged.length - 1].end = b.end;
        }

        const unit = Math.max(1, parseInt(window.$timeUnit || "10", 10));
        const now = new Date();
        let searchStart = now > dayStart ? new Date(now) : new Date(dayStart);

        if (preferAfter && /^\d{2}:\d{2}$/.test(preferAfter)) {
          const [hh, mm] = preferAfter.split(":").map(Number);
          const after = new Date(dayStart); after.setHours(hh, mm, 0, 0);
          if (after > searchStart) searchStart = after;
        }
        if (window.$defaultDate instanceof Date && searchStart < window.$defaultDate) searchStart = new Date(window.$defaultDate);
        if (window.$maxDate instanceof Date && dayEnd > window.$maxDate) dayEnd = new Date(window.$maxDate);
        searchStart = roundUpToUnit(searchStart, unit);

        const slots = [];
        let cursor = new Date(searchStart);

        const pushSlotsInGap = (gapStart, gapEnd) => {
          let s = roundUpToUnit(gapStart, unit);
          while (+s + durationMin * 60 * 1000 <= +gapEnd) {
            const e = new Date(+s + durationMin * 60 * 1000);
            slots.push({ start: fmt(s), end: fmt(e) });
            if (slots.length >= limit) return true;
            s = new Date(+s + unit * 60 * 1000);
          }
          return false;
        };

        for (const b of merged) {
          const bStart = new Date(Math.max(+b.start, +dayStart));
          const bEnd = new Date(Math.min(+b.end, +dayEnd));
          if (bEnd <= searchStart) continue;
          if (cursor < bStart) {
            if (pushSlotsInGap(cursor, bStart)) break;
          }
          if (cursor < bEnd) cursor = new Date(bEnd);
          if (cursor >= dayEnd) break;
        }
        if (slots.length < limit && cursor < dayEnd) pushSlotsInGap(cursor, dayEnd);
        return { slots };
      };
    }
  });
}

async function renderSlotList(slots, tabId) {
  const list = document.getElementById("freeSlotList");
  if (!list) return;

  list.innerHTML = "";
  if (!slots || slots.length === 0) {
    list.innerHTML = `<li>해당 조건에서 빈 시간이 없습니다.</li>`;
    return;
  }

  // 중복 제거(같은 키 start|end 기준)
  const seen = new Set();
  const unique = [];
  for (const s of slots) {
    const k = `${s.start}|${s.end}`;
    if (!seen.has(k)) { seen.add(k); unique.push(s); }
  }

  unique.forEach((s, i) => {
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.textContent = `${i + 1}. ${s.start}  ~  ${s.end}`;
    li.addEventListener("click", async () => {
      await ensureHelpers(tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (slot) => window.__gext.fillSlotOnPage(slot),
        args: [s]
      });
    });
    list.appendChild(li);
  });
}


function stopAutoScanFromPopup() {
  const statusEl = document.getElementById('autoScanStatus');
  if (__popupAutoScanTimer) {
    clearInterval(__popupAutoScanTimer);
    __popupAutoScanTimer = null;
  }
  __lastFilledKey = null; // ← 추가: 중단 시 최근 키 초기화
  if (statusEl) statusEl.textContent = '자동 스캔 중지됨';
}

// 버튼 바인딩(없으면 조용히 스킵)
document.getElementById('autoScanStartBtn')?.addEventListener('click', startAutoScanFromPopup);
document.getElementById('autoScanStopBtn')?.addEventListener('click', stopAutoScanFromPopup);


document.getElementById("findFreeSlotBtn").addEventListener("click", async () => {
  const durationMin = parseInt(document.getElementById("freeSlotDuration").value || "60", 10);
  const dateStr = document.getElementById("freeSlotDate").value.trim() || null;
  const preferAfter = document.getElementById("freeSlotAfter").value.trim() || null;

  const tab = await getActiveTab();
  if (!tab?.id) return;

  await ensureHelpers(tab.id);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (opts) => window.__gext.findFreeSlots(opts),
    args: [{ durationMin, dateStr, preferAfter, limit: 30 }]
  });


  const list = document.getElementById("freeSlotList");
  list.innerHTML = "";

  const slots = result?.slots || [];
  if (slots.length === 0) {
    list.innerHTML = `<li>해당 조건에서 빈 시간이 없습니다.</li>`;
    return;
  }

  // 목록 렌더링
  slots.forEach((s, i) => {
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.textContent = `${i + 1}. ${s.start}  ~  ${s.end}`;
    li.addEventListener("click", async () => {
      await ensureHelpers(tab.id);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (slot) => window.__gext.fillSlotOnPage(slot),
        args: [s]
      });
    });

    list.appendChild(li);
  });
});



document.getElementById("fillStartDtBtn").addEventListener("click", async () => {
  const val = document.getElementById("startDtInput").value.trim();
  if (!val) return;
  const tab = await getActiveTab(); if (!tab?.id) return;
  await ensureHelpers(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (v) => window.__gext.setStartDtOnPage(v),
    args: [val]
  });
});

document.getElementById("fillEndDtBtn").addEventListener("click", async () => {
  const val = document.getElementById("endDtInput").value.trim();
  if (!val) return;
  const tab = await getActiveTab(); if (!tab?.id) return;
  await ensureHelpers(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (v) => window.__gext.setEndDtOnPage(v),
    args: [val]
  });
});
