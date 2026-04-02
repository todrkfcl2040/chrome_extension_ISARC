/**
 * popup.js (시간 범위 제한 기능 추가 + UI 수정 반영)
 */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

const pad2 = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const getNextMidnight = () => {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
};
const getTargetDateForNextMidnight = () => {
  const d = getNextMidnight();
  // 자정 기준 오늘 포함 14일 => +13일
  d.setDate(d.getDate() + 13);
  return formatDate(d);
};

// 초기화: 저장된 '받을 이메일' 불러오기
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['userEmail'], (res) => {
    if (res.userEmail) {
      document.getElementById('userEmail').value = res.userEmail;
    }
  });

  const dateInput = document.getElementById('freeSlotDate');
  if (dateInput) {
    const today = new Date();
    const maxDate = new Date(today);
    // 2주 범위: 오늘 포함 14일
    maxDate.setDate(maxDate.getDate() + 13);
    dateInput.min = formatDate(today);
    dateInput.max = formatDate(maxDate);
  }

  const midnightTargetEl = document.getElementById('midnightTargetDate');
  if (midnightTargetEl) {
    midnightTargetEl.textContent = `예약 날짜: ${getTargetDateForNextMidnight()} (자정 오픈)`;
  }
});

async function ensureHelpers(tabId) {
  
  // ============================================================
  // [1] 중계자(Relay) 설치 (Isolated World)
  // ============================================================
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      if (window.__gext_relay_attached) return;
      
      window.addEventListener("message", (event) => {
        if (event.data && event.data.type === "GEXT_EMAIL_TRIGGER") {
          console.log("[Relay] 메인 페이지 -> 백그라운드 전송 요청 전달");
          chrome.runtime.sendMessage({
            action: "SEND_EMAIL_VIA_BACKGROUND",
            data: event.data.payload
          });
        }
      });
      
      window.__gext_relay_attached = true;
    }
  });

  // ============================================================
  // [2] 핵심 로직 설치 (Main World)
  // ============================================================
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      window.__gext = window.__gext || {};
      const G = window.__gext;

      // [UI] 상태창
      G.createStatusOverlay = function() {
        if (document.getElementById('__gext_status_panel')) return;
        const div = document.createElement('div');
        div.id = '__gext_status_panel';
        div.style.cssText = `position: fixed; bottom: 20px; right: 20px; width: 300px; background: rgba(0,0,0,0.8); color: #fff; padding: 15px; border-radius: 8px; z-index: 999999; font-size: 13px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: sans-serif;`;
        div.innerHTML = `<div style="font-weight:bold; margin-bottom:5px; color:#ffd700;">🤖 자동 예약 봇</div><div id="__gext_status_msg">대기 중...</div><button id="__gext_stop_btn" style="margin-top:8px; padding:4px 8px; cursor:pointer;">중지</button>`;
        document.body.appendChild(div);
        document.getElementById('__gext_stop_btn').onclick = () => G.stopLoop();
      };
      G.updateStatus = (msg) => { const el = document.getElementById('__gext_status_msg'); if (el) el.textContent = msg; };
      G.removeStatusOverlay = () => { document.getElementById('__gext_status_panel')?.remove(); };

      // [Util] 유틸리티
      const pad = n => (n < 10 ? "0" + n : "" + n);
      const parse = (s) => { if(!s) return new Date(); const [d, t] = s.split(" "); if(!t) return new Date(s); const [Y, M, D] = d.split("-").map(Number); const [h, m] = t.split(":").map(Number); return new Date(Y, M - 1, D, h, m, 0, 0); };
      const roundUpToUnit = (date, unitMin) => { const d = new Date(date); const up = Math.ceil(d.getMinutes() / unitMin) * unitMin; if (up >= 60) d.setHours(d.getHours() + 1, up % 60, 0, 0); else d.setMinutes(up, 0, 0); return d; };
      const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

      // [Core] 빈 시간 찾기 (여기가 핵심 수정됨)
      G.findFreeSlots = async function (opts) {
        // preferBefore 파라미터 추가됨
        const { durationMin = 60, dateStr = null, preferAfter = null, preferBefore = null, limit = 30 } = opts || {};
        
        const BOOKING = (typeof window.BOOKING_TYPE !== 'undefined' && window.BOOKING_TYPE) ? window.BOOKING_TYPE : "SU";
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
        try {
          if (typeof window.ajaxJsonResultCallNoLoading === "function") {
            const res = await new Promise(resolve => {
              window.ajaxJsonResultCallNoLoading('/hm/equipReservation/reservation/calendar/json', ajaxParams, resolve);
            });
            if (res && res.success) raw = res.data || [];
          }
        } catch(e) { console.error(e); }

        if (!raw.length) return { slots: [] };

        const dayStr = dateStr || (raw[0]?.start?.slice(0, 10) || pickDay);
        const dayStart = parse(`${dayStr} 00:00`);
        let dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

        // ★ [추가됨] 종료 시간 제한 (preferBefore) 적용
        if (preferBefore && /^\d{2}:\d{2}$/.test(preferBefore)) {
            const [hh, mm] = preferBefore.split(":").map(Number);
            const limit = new Date(dayStart);
            limit.setHours(hh, mm, 0, 0);
            // 하루의 끝(dayEnd)을 사용자가 지정한 시간으로 앞당김
            if (limit > dayStart) dayEnd = limit;
        }

        const busy = raw.map(e => ({ start: parse(e.start), end: parse(e.end) }))
          .filter(x => +x.start < +x.end).sort((a, b) => +a.start - +b.start);

        const merged = [];
        for (const b of busy) {
          if (!merged.length || b.start > merged[merged.length - 1].end) merged.push({ ...b });
          else if (b.end > merged[merged.length - 1].end) merged[merged.length - 1].end = b.end;
        }

        const unit = Math.max(1, parseInt(window.$timeUnit || "10", 10));
        const now = new Date();
        let searchStart = now > dayStart ? new Date(now) : new Date(dayStart);
        
        // 시작 시간 제한 (preferAfter) 적용
        if (preferAfter && /^\d{2}:\d{2}$/.test(preferAfter)) {
          const [hh, mm] = preferAfter.split(":").map(Number);
          const after = new Date(dayStart); after.setHours(hh, mm, 0, 0);
          if (after > searchStart) searchStart = after;
        }
        
        searchStart = roundUpToUnit(searchStart, unit);
        const slots = [];
        let cursor = new Date(searchStart);

        const pushSlotsInGap = (gapStart, gapEnd) => {
          let s = roundUpToUnit(gapStart, unit);
          // dayEnd(사용자 지정 종료시간)를 넘어가면 추가하지 않음
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
              // cursor부터 바쁜 시간 시작 전까지가 빈 틈
              if (pushSlotsInGap(cursor, bStart)) break; 
          }
          
          if (cursor < bEnd) cursor = new Date(bEnd);
          
          // 사용자가 지정한 종료 시간(dayEnd)에 도달하면 탐색 중단
          if (cursor >= dayEnd) break;
        }
        
        // 마지막 바쁜 시간 이후 ~ 하루 끝(또는 지정 종료시간) 사이의 틈 확인
        if (slots.length < limit && cursor < dayEnd) pushSlotsInGap(cursor, dayEnd);
        
        return { slots };
      };

      // [Core] 입력값 채우기
      const setInputVal = (selector, v) => {
        const $ = window.jQuery;
        const $reserv = window.$reserv || ($ && $(".reserv_time_wrap"));
        let el;
        if (typeof selector === 'string') {
             el = ($reserv && $reserv.find(selector)[0]) || document.querySelector(selector);
        } else { el = selector; }
        if(!el) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        const prev = el.readOnly; el.readOnly = false;
        setter ? setter.call(el, v) : el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        try { window.jQuery && window.jQuery(el).data("datepicker")?.selectDate?.(new Date(v)); } catch (_) { }
        el.readOnly = prev;
      };

      G.fillSlotOnPage = function (slot) {
        setInputVal('input[name=START_DT_STR]', slot.start);
        setInputVal('input[name=END_DT_STR]', slot.end);
        try {
          window.$selectStart = new Date(slot.start);
          window.$selectEnd = new Date(slot.end);
          typeof window.setDateDay === 'function' && window.setDateDay(true);
          typeof window.overlapCheck === 'function' && window.overlapCheck();
        } catch (_) { }
        return true;
      };

      G.setStartDtOnPage = function(v) { 
        if(!v) return; if(v.indexOf('-') === -1) { const today = new Date().toISOString().slice(0,10); v = `${today} ${v.trim()}`; }
        setInputVal('input[name=START_DT_STR]', v); 
      };
      G.setEndDtOnPage = function(v) { 
        if(!v) return; if(v.indexOf('-') === -1) { const today = new Date().toISOString().slice(0,10); v = `${today} ${v.trim()}`; }
        setInputVal('input[name=END_DT_STR]', v); 
      };

      // ============================================================
      // ★ 이메일 전송 (백그라운드 위임)
      // ============================================================
      G.sendEmail = function(config, slotData) {
        const { serviceId, templateId, publicKey, userEmail } = config || {};
        
        if (!serviceId || !templateId || !publicKey) {
          G.updateStatus("⚠️ 이메일 설정이 누락되었습니다.");
          return;
        }

        G.updateStatus(`📧 ${userEmail || '지정된 주소'}로 전송 요청...`);

        window.postMessage({
          type: "GEXT_EMAIL_TRIGGER",
          payload: {
            service_id: serviceId,
            template_id: templateId,
            user_id: publicKey,
            template_params: {
              title: "자동 예약 완료 알림",
              message: "예약이 성공적으로 완료되었습니다!",
              start_time: slotData.start,
              end_time: slotData.end,
              timestamp: new Date().toLocaleString(),
              my_name: "예약 봇",
              to_email: userEmail 
            }
          }
        }, "*");
        
        G.updateStatus(`✅ 예약 및 전송 요청 완료! (${userEmail})`);
      };

      // 예약 시도
      G.tryReserve = function(emailConfig, currentSlot) {
        G.updateStatus("🚀 예약 확정 시도...");
        window.jConfirm = function(title, msg, callback) { if (callback) callback(true); };

        if (typeof window.requestReservation === "function") {
          window.requestReservation();
        } else {
          return false;
        }

        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          const btnSave = document.getElementById("btnReservationSave");
          
          if (btnSave && btnSave.offsetParent !== null) {
            btnSave.click();
            clearInterval(interval);
            G.stopLoop(); 

            // 성공 시 메일 발송
            G.updateStatus("✅ 저장 완료! 메일 발송 중...");
            G.sendEmail(emailConfig, currentSlot);

          } else if (attempts > 20) { 
            clearInterval(interval);
            G.updateStatus("⚠️ 버튼 타임아웃");
          }
        }, 500);
        return true;
      };

      // 루프
      G.timerId = null;
      G.lastFilledKey = null;

      G.startLoop = function(opts) {
        if (G.timerId) return;
        
        const { emailConfig } = opts;
        G.createStatusOverlay();
        G.updateStatus("탐색 시작...");
        G.lastFilledKey = null; 

        const tick = async () => {
          try {
            const { slots } = await G.findFreeSlots(opts);
            if (slots && slots.length > 0) {
              const first = slots[0];
              const key = `${first.start}|${first.end}`;
              
              if (G.lastFilledKey !== key) {
                G.updateStatus(`발견! ${first.start} 예약 시도...`);
                G.fillSlotOnPage(first);
                G.tryReserve(emailConfig, first);
                G.lastFilledKey = key; 
              } else {
                G.updateStatus(`대기 중... (빈 슬롯 ${slots.length}개)`);
              }
            } else {
               const t = new Date();
               G.updateStatus(`빈 자리 찾는 중... (${t.toLocaleTimeString()})`);
            }
          } catch (e) {
            console.error(e);
            G.updateStatus("오류 발생");
          }
        };
        tick(); 
        G.timerId = setInterval(tick, 5000); 
      };

      G.stopLoop = function() {
        if (G.timerId) {
          clearInterval(G.timerId);
          G.timerId = null;
        }
        G.updateStatus("⛔ 스캔 중지됨");
        setTimeout(() => G.removeStatusOverlay(), 3000);
      };
    }
  });
}

// 이벤트 핸들러
document.getElementById('autoScanStartBtn')?.addEventListener('click', async () => {
  const durationMin = parseInt(document.getElementById('freeSlotDuration')?.value || '60', 10);
  const dateStr = document.getElementById('freeSlotDate')?.value?.trim() || null;
  const preferAfter = document.getElementById('freeSlotAfter')?.value?.trim() || null;
  
  // ★ 추가됨: 이전(Before) 시간 읽기
  const preferBefore = document.getElementById('freeSlotBefore')?.value?.trim() || null;
  
  const emailServiceId = document.getElementById('emailServiceId')?.value?.trim();
  const emailTemplateId = document.getElementById('emailTemplateId')?.value?.trim();
  const emailPublicKey = document.getElementById('emailPublicKey')?.value?.trim();
  const userEmail = document.getElementById('userEmail')?.value?.trim();
  
  const statusEl = document.getElementById('autoScanStatus');
  
  chrome.storage.local.set({ userEmail });

  const tab = await getActiveTab();
  if (!tab?.id) return;

  await ensureHelpers(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (opts) => window.__gext.startLoop(opts),
    args: [{ 
      durationMin, 
      dateStr, 
      preferAfter, 
      preferBefore, // 전달
      limit: 10,
      emailConfig: { 
        serviceId: emailServiceId, 
        templateId: emailTemplateId, 
        publicKey: emailPublicKey,
        userEmail: userEmail
      } 
    }]
  });

  if (statusEl) statusEl.textContent = '✅ 가동됨';
});

document.getElementById('autoScanStopBtn')?.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if(!tab?.id) return;
  await ensureHelpers(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => window.__gext?.stopLoop()
  });
  const statusEl = document.getElementById('autoScanStatus');
  if (statusEl) statusEl.textContent = '중지 명령 전송됨.';
});

document.getElementById("fillStartDtBtn")?.addEventListener("click", async () => {
  const val = document.getElementById("startDtInput").value;
  const tab = await getActiveTab();
  if(tab?.id) {
    await ensureHelpers(tab.id);
    chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: (v) => window.__gext.setStartDtOnPage(v), args: [val] });
  }
});

document.getElementById("fillEndDtBtn")?.addEventListener("click", async () => {
  const val = document.getElementById("endDtInput").value;
  const tab = await getActiveTab();
  if(tab?.id) {
    await ensureHelpers(tab.id);
    chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: (v) => window.__gext.setEndDtOnPage(v), args: [val] });
  }
});

document.getElementById("findFreeSlotBtn")?.addEventListener("click", async () => {
  const durationMin = parseInt(document.getElementById("freeSlotDuration").value || "60", 10);
  const dateStr = document.getElementById("freeSlotDate").value.trim() || null;
  const preferAfter = document.getElementById("freeSlotAfter").value.trim() || null;
  const preferBefore = document.getElementById("freeSlotBefore").value.trim() || null; // 추가
  
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await ensureHelpers(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'MAIN',
    func: (opts) => window.__gext.findFreeSlots(opts),
    args: [{ durationMin, dateStr, preferAfter, preferBefore, limit: 30 }]
  });
  const list = document.getElementById("freeSlotList");
  list.innerHTML = "";
  const slots = result?.slots || [];
  if (slots.length === 0) { list.innerHTML = `<li>조건에 맞는 빈 시간이 없습니다.</li>`; return; }
  slots.forEach((s, i) => {
    const li = document.createElement("li");
    li.style.cursor = "pointer"; li.style.padding = "4px 0";
    li.textContent = `${i + 1}. ${s.start}  ~  ${s.end}`;
    li.addEventListener("click", async () => {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: (slot) => window.__gext.fillSlotOnPage(slot), args: [s]
      });
    });
    list.appendChild(li);
  });
});

document.getElementById("midnightReserveStartBtn")?.addEventListener("click", async () => {
  const startTime = document.getElementById("midnightStartTime")?.value;
  const endTime = document.getElementById("midnightEndTime")?.value;
  const statusEl = document.getElementById("midnightReserveStatus");

  if (!startTime || !endTime) {
    if (statusEl) statusEl.textContent = "시작/종료 시간을 입력하세요.";
    return;
  }
  if (startTime >= endTime) {
    if (statusEl) statusEl.textContent = "종료 시간은 시작 시간보다 늦어야 합니다.";
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    if (statusEl) statusEl.textContent = "활성 탭을 찾지 못했습니다.";
    return;
  }

  const emailServiceId = document.getElementById('emailServiceId')?.value?.trim();
  const emailTemplateId = document.getElementById('emailTemplateId')?.value?.trim();
  const emailPublicKey = document.getElementById('emailPublicKey')?.value?.trim();
  const userEmail = document.getElementById('userEmail')?.value?.trim();
  chrome.storage.local.set({ userEmail });

  const nextMidnight = getNextMidnight();
  const targetDateStr = getTargetDateForNextMidnight();
  const alarmAt = nextMidnight.getTime();

  if (statusEl) statusEl.textContent = "자정 예약 대기 설정 중...";
  await chrome.runtime.sendMessage({
    action: "SCHEDULE_MIDNIGHT_RESERVE",
    data: {
      tabId: tab.id,
      alarmAt,
      startTime,
      endTime,
      emailConfig: {
        serviceId: emailServiceId,
        templateId: emailTemplateId,
        publicKey: emailPublicKey,
        userEmail
      }
    }
  });

  const midnightDateStr = formatDate(nextMidnight);
  if (statusEl) statusEl.textContent = `대기 설정 완료: ${midnightDateStr} 00:00 (대상 ${targetDateStr})`;
});

document.getElementById("midnightReserveCancelBtn")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("midnightReserveStatus");
  await chrome.runtime.sendMessage({ action: "CANCEL_MIDNIGHT_RESERVE" });
  if (statusEl) statusEl.textContent = "자정 예약이 취소되었습니다.";
});
