chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'highlightSelection',
    title: 'Highlight selection',
    contexts: ['selection']
  });
});

function highlightFunction(term) {
  if (!term) return;

  const styleId = '__gext_highlight_style__';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = 'mark.__gext_mark__{ background: yellow; padding: 0 .2em; }';
    document.head.appendChild(style);
  }

  document.querySelectorAll('mark.__gext_mark__').forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const matches = [];
  const lowerTerm = term.toLowerCase();

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue.trim()) continue;
    const index = node.nodeValue.toLowerCase().indexOf(lowerTerm);
    if (index !== -1) matches.push({ node, index, length: term.length });
  }

  for (const match of matches) {
    const { node, index, length } = match;
    const text = node.nodeValue;
    const before = document.createTextNode(text.slice(0, index));
    const marked = document.createElement('mark');
    const after = document.createTextNode(text.slice(index + length));
    const fragment = document.createDocumentFragment();

    marked.className = '__gext_mark__';
    marked.textContent = text.slice(index, index + length);

    fragment.appendChild(before);
    fragment.appendChild(marked);
    fragment.appendChild(after);
    node.parentNode.replaceChild(fragment, node);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'highlightSelection' || !info.selectionText || !tab?.id) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: highlightFunction,
    args: [info.selectionText]
  });
});

const ISRC_BASE_URL = 'https://isrc.snu.ac.kr/';
const MIDNIGHT_ALARM_NAME = 'midnightReserve';
const MIDNIGHT_STORE_KEY = 'midnightReserve';
const MIDNIGHT_OFFSET_DAYS = 13;
const MIDNIGHT_EARLY_WAKEUP_MS = 1500;
const MIDNIGHT_RETRY_MIN_MS = 250;

const pad2 = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const formatDateTime = (d) =>
  `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const getTargetDateStr = (baseDate) => {
  const target = new Date(baseDate);
  target.setDate(target.getDate() + MIDNIGHT_OFFSET_DAYS);
  return formatDate(target);
};

const ensureRelay = async (tabId) => {
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
};

const fetchServerClock = async () => {
  const requestStartedAt = Date.now();
  let response;

  try {
    response = await fetch(ISRC_BASE_URL, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'omit'
    });
  } catch (_) {
    response = await fetch(ISRC_BASE_URL, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit'
    });
  }

  const requestFinishedAt = Date.now();
  const headerValue = response.headers.get('date');
  if (!headerValue) {
    throw new Error('ISRC response is missing a Date header.');
  }

  const headerMs = Date.parse(headerValue);
  if (Number.isNaN(headerMs)) {
    throw new Error(`Invalid ISRC Date header: ${headerValue}`);
  }

  const midpointLocalMs = requestStartedAt + Math.round((requestFinishedAt - requestStartedAt) / 2);
  const offsetMs = headerMs - midpointLocalMs;
  const localNowMs = Date.now();

  return {
    offsetMs,
    serverNowMs: localNowMs + offsetMs,
    localNowMs,
    headerValue
  };
};

const buildServerMidnightPlan = (clock) => {
  const serverNow = new Date(clock.serverNowMs);
  const nextServerMidnight = new Date(serverNow);
  nextServerMidnight.setHours(24, 0, 0, 0);

  const remainingMs = nextServerMidnight.getTime() - clock.serverNowMs;
  const localAlarmAtMs = clock.localNowMs + Math.max(remainingMs - MIDNIGHT_EARLY_WAKEUP_MS, 0);

  return {
    serverNowMs: clock.serverNowMs,
    serverNowText: formatDateTime(serverNow),
    nextServerMidnightMs: nextServerMidnight.getTime(),
    nextServerMidnightText: formatDateTime(nextServerMidnight),
    localAlarmAtMs,
    targetDateStr: getTargetDateStr(nextServerMidnight)
  };
};

const getServerMidnightInfo = async () => {
  const clock = await fetchServerClock();
  const plan = buildServerMidnightPlan(clock);

  return {
    ok: true,
    headerValue: clock.headerValue,
    serverNowMs: plan.serverNowMs,
    serverNowText: plan.serverNowText,
    nextServerMidnightMs: plan.nextServerMidnightMs,
    nextServerMidnightText: plan.nextServerMidnightText,
    localAlarmAtMs: plan.localAlarmAtMs,
    targetDateStr: plan.targetDateStr
  };
};

const runMidnightReservation = async ({ tabId, targetDateStr, startTime, endTime, emailConfig }) => {
  if (!tabId || !targetDateStr || !startTime || !endTime) return;

  await ensureRelay(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content-helpers.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (options) => window.__gext?.reserveExactSlot?.(options),
    args: [{ dateStr: targetDateStr, startTime, endTime, emailConfig }]
  });
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MIDNIGHT_ALARM_NAME) return;

  (async () => {
    const stored = await chrome.storage.local.get([MIDNIGHT_STORE_KEY]);
    const data = stored[MIDNIGHT_STORE_KEY];
    if (!data) return;

    try {
      const info = await getServerMidnightInfo();
      const remainingMs = data.nextServerMidnightMs - info.serverNowMs;

      if (remainingMs > 0) {
        chrome.alarms.create(MIDNIGHT_ALARM_NAME, {
          when: Date.now() + Math.max(remainingMs, MIDNIGHT_RETRY_MIN_MS)
        });
        return;
      }

      await runMidnightReservation({
        tabId: data.tabId,
        targetDateStr: getTargetDateStr(new Date(info.serverNowMs)),
        startTime: data.startTime,
        endTime: data.endTime,
        emailConfig: data.emailConfig || {}
      });
    } catch (error) {
      console.warn('[Background] Server time sync failed during midnight run. Falling back to stored target date.', error);
      await runMidnightReservation({
        tabId: data.tabId,
        targetDateStr: data.targetDateStr,
        startTime: data.startTime,
        endTime: data.endTime,
        emailConfig: data.emailConfig || {}
      });
    } finally {
      await chrome.storage.local.remove(MIDNIGHT_STORE_KEY);
      await chrome.alarms.clear(MIDNIGHT_ALARM_NAME);
    }
  })();
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'SEND_EMAIL_VIA_BACKGROUND') {
    console.log('[Background] 이메일 전송 시작:', request.data?.template_params?.to_email);

    fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.data)
    })
      .then((response) => {
        if (response.ok) {
          console.log('[Background] 전송 성공');
        } else {
          response.text().then((text) => console.error('[Background] 전송 실패:', text));
        }
      })
      .catch((error) => {
        console.error('[Background] 네트워크 오류:', error);
      });

    return false;
  }

  if (request.action === 'GET_MIDNIGHT_RESERVE_INFO') {
    (async () => {
      try {
        sendResponse(await getServerMidnightInfo());
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'SCHEDULE_MIDNIGHT_RESERVE') {
    (async () => {
      try {
        const data = request.data || {};
        const info = await getServerMidnightInfo();

        await chrome.alarms.clear(MIDNIGHT_ALARM_NAME);
        await chrome.storage.local.set({
          [MIDNIGHT_STORE_KEY]: {
            tabId: data.tabId,
            startTime: data.startTime,
            endTime: data.endTime,
            emailConfig: data.emailConfig || {},
            targetDateStr: info.targetDateStr,
            nextServerMidnightMs: info.nextServerMidnightMs
          }
        });

        chrome.alarms.create(MIDNIGHT_ALARM_NAME, { when: info.localAlarmAtMs });
        sendResponse(info);
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'CANCEL_MIDNIGHT_RESERVE') {
    (async () => {
      await chrome.alarms.clear(MIDNIGHT_ALARM_NAME);
      await chrome.storage.local.remove(MIDNIGHT_STORE_KEY);
      sendResponse({ ok: true });
    })();
    return true;
  }
});
