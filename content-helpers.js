(() => {
  window.__gext = window.__gext || {};
  const G = window.__gext;
  if (G.__midnightHelpersInstalled) return;
  G.__midnightHelpersInstalled = true;

  G.createStatusOverlay = G.createStatusOverlay || function () {
    if (document.getElementById('__gext_status_panel')) return;
    const div = document.createElement('div');
    div.id = '__gext_status_panel';
    div.style.cssText = 'position: fixed; bottom: 20px; right: 20px; width: 300px; background: rgba(0,0,0,0.85); color: #fff; padding: 15px; border-radius: 8px; z-index: 999999; font-size: 13px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: sans-serif;';
    div.innerHTML = '<div style="font-weight:bold; margin-bottom:5px; color:#ffe27a;">자정 오픈 예약</div><div id="__gext_status_msg">대기 중...</div>';
    document.body.appendChild(div);
  };

  G.updateStatus = G.updateStatus || function (msg) {
    const el = document.getElementById('__gext_status_msg');
    if (el) el.textContent = msg;
  };

  G.removeStatusOverlay = G.removeStatusOverlay || function () {
    document.getElementById('__gext_status_panel')?.remove();
  };

  const setInputVal = (selector, v) => {
    const $ = window.jQuery;
    const $reserv = window.$reserv || ($ && $(".reserv_time_wrap"));
    let el;
    if (typeof selector === 'string') {
      el = ($reserv && $reserv.find(selector)[0]) || document.querySelector(selector);
    } else {
      el = selector;
    }
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const prev = el.readOnly;
    el.readOnly = false;
    setter ? setter.call(el, v) : (el.value = v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      window.jQuery && window.jQuery(el).data('datepicker')?.selectDate?.(new Date(v));
    } catch (_) {}
    el.readOnly = prev;
  };

  G.fillSlotOnPage = G.fillSlotOnPage || function (slot) {
    setInputVal('input[name=START_DT_STR]', slot.start);
    setInputVal('input[name=END_DT_STR]', slot.end);
    try {
      window.$selectStart = new Date(slot.start);
      window.$selectEnd = new Date(slot.end);
      typeof window.setDateDay === 'function' && window.setDateDay(true);
      typeof window.overlapCheck === 'function' && window.overlapCheck();
    } catch (_) {}
    return true;
  };

  G.sendEmail = G.sendEmail || function (config, slotData) {
    const { serviceId, templateId, publicKey, userEmail } = config || {};
    if (!serviceId || !templateId || !publicKey) {
      G.updateStatus('이메일 설정이 누락되었습니다.');
      return;
    }

    G.updateStatus(`이메일 전송 요청 중... (${userEmail || '지정된 주소'})`);

    window.postMessage({
      type: 'GEXT_EMAIL_TRIGGER',
      payload: {
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        template_params: {
          title: '자정 오픈 예약 알림',
          message: '예약 시도가 완료되었습니다.',
          start_time: slotData.start,
          end_time: slotData.end,
          timestamp: new Date().toLocaleString(),
          my_name: '자동 예약',
          to_email: userEmail
        }
      }
    }, '*');
  };

  G.tryReserve = G.tryReserve || function (emailConfig, currentSlot) {
    G.updateStatus('예약 확정 시도 중...');
    window.jConfirm = function (title, msg, callback) { if (callback) callback(true); };

    if (typeof window.requestReservation === 'function') {
      window.requestReservation();
    } else {
      G.updateStatus('예약 함수가 없습니다.');
      return false;
    }

    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const btnSave = document.getElementById('btnReservationSave');
      if (btnSave && btnSave.offsetParent !== null) {
        btnSave.click();
        clearInterval(interval);
        G.updateStatus('예약 완료! 이메일 전송 중...');
        G.sendEmail(emailConfig, currentSlot);
        setTimeout(() => G.removeStatusOverlay(), 3000);
      } else if (attempts > 20) {
        clearInterval(interval);
        G.updateStatus('예약 버튼을 찾지 못했습니다.');
        setTimeout(() => G.removeStatusOverlay(), 3000);
      }
    }, 500);

    return true;
  };

  G.reserveExactSlot = function (opts) {
    const { dateStr, startTime, endTime, emailConfig } = opts || {};
    if (!dateStr || !startTime || !endTime) {
      G.updateStatus('시간 범위 입력이 필요합니다.');
      return false;
    }

    const slot = {
      start: `${dateStr} ${startTime}`,
      end: `${dateStr} ${endTime}`
    };

    G.createStatusOverlay();
    G.updateStatus(`자정 예약 시도: ${slot.start} ~ ${slot.end}`);
    G.fillSlotOnPage(slot);
    G.tryReserve(emailConfig, slot);
    return true;
  };
})();
