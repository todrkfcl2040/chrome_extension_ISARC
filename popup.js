async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

const pad2 = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const getNextMidnight = () => {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  return next;
};

const getTargetDateForNextMidnight = () => {
  const target = getNextMidnight();
  target.setDate(target.getDate() + 13);
  return formatDate(target);
};

const getValue = (id) => document.getElementById(id)?.value?.trim() || '';
const setText = (id, text) => {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
};

const sendRuntimeMessage = (message) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });

const validateTimeWindow = (after, before) => {
  if (after && before && after >= before) {
    return '시작 시간은 종료 시간보다 빨라야 합니다.';
  }
  return null;
};

async function ensureRelay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      if (window.__gext_relay_attached) return;

      window.addEventListener('message', (event) => {
        if (event.data?.type !== 'GEXT_EMAIL_TRIGGER') return;
        chrome.runtime.sendMessage({
          action: 'SEND_EMAIL_VIA_BACKGROUND',
          data: event.data.payload
        });
      });

      window.__gext_relay_attached = true;
    }
  });
}

async function ensureHelpers(tabId) {
  await ensureRelay(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content-helpers.js']
  });
}

function getEmailConfig() {
  return {
    serviceId: getValue('emailServiceId'),
    templateId: getValue('emailTemplateId'),
    publicKey: getValue('emailPublicKey'),
    userEmail: getValue('userEmail')
  };
}

function persistPopupState() {
  chrome.storage.local.set({ userEmail: getValue('userEmail') });
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['userEmail'], ({ userEmail }) => {
    if (userEmail) {
      const emailInput = document.getElementById('userEmail');
      if (emailInput) emailInput.value = userEmail;
    }
  });

  const dateInput = document.getElementById('freeSlotDate');
  if (dateInput) {
    const today = new Date();
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + 13);
    dateInput.min = formatDate(today);
    dateInput.max = formatDate(maxDate);
  }

  setText('midnightTargetDate', `예약 날짜: ${getTargetDateForNextMidnight()} (자정 오픈)`);
});

document.getElementById('findFreeSlotBtn')?.addEventListener('click', async () => {
  const durationMin = parseInt(getValue('freeSlotDuration') || '60', 10);
  const dateStr = getValue('freeSlotDate') || null;
  const preferAfter = getValue('freeSlotAfter') || null;
  const preferBefore = getValue('freeSlotBefore') || null;
  const list = document.getElementById('freeSlotList');

  if (!list) return;

  const invalidWindowMessage = validateTimeWindow(preferAfter, preferBefore);
  if (invalidWindowMessage) {
    list.innerHTML = `<li>${invalidWindowMessage}</li>`;
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    list.innerHTML = '<li>활성 탭을 찾지 못했습니다.</li>';
    return;
  }

  await ensureHelpers(tab.id);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (options) => window.__gext.findFreeSlots(options),
    args: [{ durationMin, dateStr, preferAfter, preferBefore, limit: 30 }]
  });

  const slots = result?.slots || [];
  list.innerHTML = '';

  if (!slots.length) {
    list.innerHTML = '<li>조건에 맞는 빈 시간이 없습니다.</li>';
    return;
  }

  slots.forEach((slot, index) => {
    const item = document.createElement('li');
    item.style.cursor = 'pointer';
    item.style.padding = '4px 0';
    item.textContent = `${index + 1}. ${slot.start} ~ ${slot.end}`;
    item.addEventListener('click', async () => {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (selectedSlot) => window.__gext.fillSlotOnPage(selectedSlot),
        args: [slot]
      });
    });
    list.appendChild(item);
  });
});

document.getElementById('autoScanStartBtn')?.addEventListener('click', async () => {
  const durationMin = parseInt(getValue('freeSlotDuration') || '60', 10);
  const dateStr = getValue('freeSlotDate') || null;
  const preferAfter = getValue('freeSlotAfter') || null;
  const preferBefore = getValue('freeSlotBefore') || null;

  const invalidWindowMessage = validateTimeWindow(preferAfter, preferBefore);
  if (invalidWindowMessage) {
    setText('autoScanStatus', invalidWindowMessage);
    return;
  }

  persistPopupState();

  const tab = await getActiveTab();
  if (!tab?.id) {
    setText('autoScanStatus', '활성 탭을 찾지 못했습니다.');
    return;
  }

  await ensureHelpers(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (options) => window.__gext.startLoop(options),
    args: [
      {
        durationMin,
        dateStr,
        preferAfter,
        preferBefore,
        limit: 10,
        emailConfig: getEmailConfig()
      }
    ]
  });

  setText('autoScanStatus', '자동 예약을 시작했습니다.');
});

document.getElementById('autoScanStopBtn')?.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setText('autoScanStatus', '활성 탭을 찾지 못했습니다.');
    return;
  }

  await ensureHelpers(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => window.__gext?.stopLoop('자동 예약을 중지했습니다.')
  });

  setText('autoScanStatus', '중지 명령을 전송했습니다.');
});

document.getElementById('midnightReserveStartBtn')?.addEventListener('click', async () => {
  const startTime = getValue('midnightStartTime');
  const endTime = getValue('midnightEndTime');

  if (!startTime || !endTime) {
    setText('midnightReserveStatus', '시작/종료 시간을 입력하세요.');
    return;
  }

  if (startTime >= endTime) {
    setText('midnightReserveStatus', '종료 시간은 시작 시간보다 늦어야 합니다.');
    return;
  }

  persistPopupState();

  const tab = await getActiveTab();
  if (!tab?.id) {
    setText('midnightReserveStatus', '활성 탭을 찾지 못했습니다.');
    return;
  }

  const nextMidnight = getNextMidnight();
  const targetDateStr = getTargetDateForNextMidnight();

  try {
    await sendRuntimeMessage({
      action: 'SCHEDULE_MIDNIGHT_RESERVE',
      data: {
        tabId: tab.id,
        alarmAt: nextMidnight.getTime(),
        startTime,
        endTime,
        emailConfig: getEmailConfig()
      }
    });

    setText(
      'midnightReserveStatus',
      `대기 설정 완료: ${formatDate(nextMidnight)} 00:00 (대상 ${targetDateStr})`
    );
  } catch (error) {
    setText('midnightReserveStatus', `설정 실패: ${error.message}`);
  }
});

document.getElementById('midnightReserveCancelBtn')?.addEventListener('click', async () => {
  try {
    await sendRuntimeMessage({ action: 'CANCEL_MIDNIGHT_RESERVE' });
    setText('midnightReserveStatus', '자정 예약을 취소했습니다.');
  } catch (error) {
    setText('midnightReserveStatus', `취소 실패: ${error.message}`);
  }
});
