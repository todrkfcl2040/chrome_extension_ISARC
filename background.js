// background.js

// 1. 기존 하이라이터 및 초기화 리스너
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "highlightSelection",
    title: "Highlight selection",
    contexts: ["selection"]
  });
});

function highlightFunction(term) {
  if (!term) return;
  const styleId = "__gext_highlight_style__";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `mark.__gext_mark__{ background: yellow; padding: 0 .2em; }`;
    document.head.appendChild(style);
  }
  document.querySelectorAll("mark.__gext_mark__").forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const toMark = [];
  const termLower = term.toLowerCase();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue.trim()) continue;
    const idx = node.nodeValue.toLowerCase().indexOf(termLower);
    if (idx !== -1) toMark.push({node, idx, len: term.length});
  }
  for (const item of toMark) {
    const {node, idx, len} = item;
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "highlightSelection" && info.selectionText && tab?.id) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: highlightFunction,
      args: [info.selectionText]
    });
  }
});

const MIDNIGHT_ALARM_NAME = 'midnightReserve';
const MIDNIGHT_STORE_KEY = 'midnightReserve';
// 2주 범위: 오늘 포함 14일 -> 자정 기준 날짜 + 13일
const MIDNIGHT_OFFSET_DAYS = 13;

const pad2 = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
        if (event.data && event.data.type === 'GEXT_EMAIL_TRIGGER') {
          chrome.runtime.sendMessage({
            action: 'SEND_EMAIL_VIA_BACKGROUND',
            data: event.data.payload
          });
        }
      });
      window.__gext_relay_attached = true;
    }
  });
};

const runMidnightReservation = async (data) => {
  if (!data?.tabId) return;
  const tabId = data.tabId;
  const startTime = data.startTime;
  const endTime = data.endTime;
  const emailConfig = data.emailConfig || {};
  if (!startTime || !endTime) return;

  try {
    const dateStr = getTargetDateStr(new Date());
    await ensureRelay(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content-helpers.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (opts) => window.__gext?.reserveExactSlot?.(opts),
      args: [{ dateStr, startTime, endTime, emailConfig }]
    });
  } catch (err) {
    console.error('[Background] Midnight reservation failed:', err);
  }
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MIDNIGHT_ALARM_NAME) return;
  (async () => {
    const stored = await chrome.storage.local.get([MIDNIGHT_STORE_KEY]);
    const data = stored[MIDNIGHT_STORE_KEY];
    if (!data) return;
    await runMidnightReservation(data);
    await chrome.storage.local.remove(MIDNIGHT_STORE_KEY);
    await chrome.alarms.clear(MIDNIGHT_ALARM_NAME);
  })();
});

// 2. ★ [추가됨] 이메일 전송 리스너 (CSP 보안 우회용) ★
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SEND_EMAIL_VIA_BACKGROUND') {
    console.log('[Background] 이메일 전송 시작:', request.data.to_email);

    fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.data)
    })
    .then(response => {
      if (response.ok) {
        console.log('[Background] 전송 성공');
      } else {
        response.text().then(text => console.error('[Background] 전송 실패:', text));
      }
    })
    .catch(error => {
      console.error('[Background] 네트워크 오류:', error);
    });

    return true; // 비동기 응답 처리
  }

  if (request.action === 'SCHEDULE_MIDNIGHT_RESERVE') {
    (async () => {
      const data = request.data || {};
      await chrome.alarms.clear(MIDNIGHT_ALARM_NAME);
      await chrome.storage.local.set({ [MIDNIGHT_STORE_KEY]: data });
      if (data.alarmAt) {
        chrome.alarms.create(MIDNIGHT_ALARM_NAME, { when: data.alarmAt });
      }
      sendResponse({ ok: true });
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
