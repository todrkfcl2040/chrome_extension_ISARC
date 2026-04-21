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
const EDUCATION_OPEN_ALARM_NAME = 'educationOpenReserve';
const EDUCATION_OPEN_STORE_KEY = 'educationOpenReserve';
const EDUCATION_OPEN_EARLY_WAKEUP_MS = 1500;
const EDUCATION_OPEN_RETRY_MIN_MS = 250;
const TAB_LOAD_TIMEOUT_MS = 20000;
const LOGIN_KEEP_ALIVE_ALARM_NAME = 'loginKeepAlive';
const LOGIN_KEEP_ALIVE_STORE_KEY = 'loginKeepAlive';
const LOGIN_KEEP_ALIVE_DEFAULT_INTERVAL_MIN = 10;
const LOGIN_KEEP_ALIVE_URL = new URL('/myPage/hm/user/info', ISRC_BASE_URL).toString();
const ISRC_ORIGIN = new URL(ISRC_BASE_URL).origin;

const pad2 = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const formatDateTime = (d) =>
  `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parseDateTime = (value) => {
  if (!value) return null;

  const [datePart, timePart = '00:00:00'] = String(value).trim().split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour = 0, minute = 0, second = 0] = timePart.split(':').map(Number);

  if ([year, month, day, hour, minute, second].some((part) => Number.isNaN(part))) {
    return null;
  }

  return new Date(year, month - 1, day, hour, minute, second, 0);
};

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

const buildEducationOpenPlan = (clock, receiveStartText) => {
  const targetOpenDate = parseDateTime(receiveStartText);
  if (!targetOpenDate) {
    throw new Error(`Invalid education open time: ${receiveStartText}`);
  }

  const remainingMs = targetOpenDate.getTime() - clock.serverNowMs;
  const localAlarmAtMs = clock.localNowMs + Math.max(remainingMs - EDUCATION_OPEN_EARLY_WAKEUP_MS, 0);

  return {
    targetOpenMs: targetOpenDate.getTime(),
    targetOpenText: formatDateTime(targetOpenDate),
    localAlarmAtMs,
    remainingMs
  };
};

const getEducationOpenInfo = async (receiveStartText) => {
  const clock = await fetchServerClock();
  const plan = buildEducationOpenPlan(clock, receiveStartText);

  return {
    ok: true,
    headerValue: clock.headerValue,
    serverNowMs: clock.serverNowMs,
    serverNowText: formatDateTime(new Date(clock.serverNowMs)),
    targetOpenMs: plan.targetOpenMs,
    targetOpenText: plan.targetOpenText,
    localAlarmAtMs: plan.localAlarmAtMs,
    remainingMs: plan.remainingMs
  };
};

const getLoginKeepAliveIntervalMin = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return LOGIN_KEEP_ALIVE_DEFAULT_INTERVAL_MIN;
  return Math.max(1, Math.round(parsed));
};

const parseKeepAliveResponse = ({ response, bodyText }) => {
  const finalUrl = response.url || LOGIN_KEEP_ALIVE_URL;
  const hasSessionMarker = /logout_btn|\/user\/logout|sessionUser\s*=/.test(bodyText);
  const looksLikeLoginPage =
    /\/login\b/.test(finalUrl) || (bodyText.includes('로그인') && bodyText.includes('비밀번호'));

  if (hasSessionMarker) {
    return {
      ok: true,
      authenticated: true,
      message: '세션 유지 요청 성공'
    };
  }

  if (looksLikeLoginPage) {
    return {
      ok: false,
      authenticated: false,
      message: '로그인 세션이 만료된 것으로 보입니다.'
    };
  }

  return {
    ok: response.ok,
    authenticated: response.ok,
    message: response.ok ? `세션 유지 요청 응답 ${response.status}` : `세션 유지 요청 실패 (${response.status})`
  };
};

const ensureLoginKeepAliveTab = async (preferredTabId) => {
  if (preferredTabId) {
    try {
      const preferredTab = await chrome.tabs.get(preferredTabId);
      const preferredOrigin = new URL(preferredTab.url || '').origin;

      if (preferredOrigin === ISRC_ORIGIN) {
        await waitForTabComplete(preferredTab.id);
        return preferredTab;
      }
    } catch (_) {}
  }

  const createdTab = await chrome.tabs.create({
    url: LOGIN_KEEP_ALIVE_URL,
    active: false
  });

  return waitForTabComplete(createdTab.id);
};

const runLoginKeepAlive = async (preferredTabId) => {
  const tab = await ensureLoginKeepAliveTab(preferredTabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (keepAliveUrl) => {
      try {
        const response = await fetch(keepAliveUrl, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          redirect: 'follow'
        });
        const bodyText = await response.text();

        return {
          ok: true,
          response: {
            ok: response.ok,
            status: response.status,
            url: response.url || keepAliveUrl
          },
          bodyText
        };
      } catch (error) {
        return {
          ok: false,
          error: error.message
        };
      }
    },
    args: [LOGIN_KEEP_ALIVE_URL]
  });

  if (!result?.ok) {
    throw new Error(result?.error || '세션 유지 요청 실행에 실패했습니다.');
  }

  return {
    tabId: tab.id,
    ...parseKeepAliveResponse({
      response: result.response,
      bodyText: result.bodyText || ''
    })
  };
};

const storeLoginKeepAliveState = async (statePatch) => {
  const stored = await chrome.storage.local.get([LOGIN_KEEP_ALIVE_STORE_KEY]);
  const current = stored[LOGIN_KEEP_ALIVE_STORE_KEY] || {};

  await chrome.storage.local.set({
    [LOGIN_KEEP_ALIVE_STORE_KEY]: {
      ...current,
      ...statePatch
    }
  });
};

const normalizeEducationTargets = (value) => {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const deduped = new Map();

  source.forEach((education) => {
    if (!education?.EVENT_SKEY || !education?.ESCHED_SKEY || !education?.RECEIVE_START_DT_STR) return;
    deduped.set(String(education.ESCHED_SKEY), education);
  });

  return [...deduped.values()].sort(
    (a, b) =>
      (parseDateTime(a.RECEIVE_START_DT_STR)?.getTime() || 0) -
      (parseDateTime(b.RECEIVE_START_DT_STR)?.getTime() || 0)
  );
};

const buildQueuedEducationOpenState = (clock, educations) => {
  const normalized = normalizeEducationTargets(educations);
  if (!normalized.length) {
    throw new Error('No valid education open targets were provided.');
  }

  const futureTargets = normalized
    .map((education) => ({
      education,
      plan: buildEducationOpenPlan(clock, education.RECEIVE_START_DT_STR)
    }))
    .filter(({ plan }) => plan.remainingMs > 0)
    .sort((a, b) => a.plan.targetOpenMs - b.plan.targetOpenMs);

  if (!futureTargets.length) {
    throw new Error('All selected education open times have already passed.');
  }

  const nextTarget = futureTargets[0];

  return {
    educations: futureTargets.map(({ education }) => education),
    count: futureTargets.length,
    targetOpenMs: nextTarget.plan.targetOpenMs,
    targetOpenText: nextTarget.plan.targetOpenText,
    localAlarmAtMs: nextTarget.plan.localAlarmAtMs,
    equipmentName: nextTarget.education.EQUIP_NAME || nextTarget.education.NAME || ''
  };
};

const splitEducationQueueByDue = (clock, educations) => {
  const normalized = normalizeEducationTargets(educations);
  const planned = normalized
    .map((education) => ({
      education,
      plan: buildEducationOpenPlan(clock, education.RECEIVE_START_DT_STR)
    }))
    .sort((a, b) => a.plan.targetOpenMs - b.plan.targetOpenMs);

  return {
    due: planned.filter(({ plan }) => plan.remainingMs <= 0),
    future: planned.filter(({ plan }) => plan.remainingMs > 0)
  };
};

const waitForTabComplete = async (tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      throw new Error('예약에 사용할 탭을 찾지 못했습니다.');
    }

    if (tab.status === 'complete') {
      return tab;
    }

    await sleep(250);
  }

  throw new Error('예약 페이지 로드를 기다리다 시간이 초과되었습니다.');
};

const buildEducationReservationUrl = (education = {}) => {
  const reservationUrl = new URL('/hm/event/reservation/equip', ISRC_BASE_URL);
  reservationUrl.searchParams.set('EVENT_SKEY', education.EVENT_SKEY || '');
  reservationUrl.searchParams.set('ESCHED_SKEY', education.ESCHED_SKEY || '');
  reservationUrl.searchParams.set('EVENT_SUB_TYPE', education.EVENT_SUB_TYPE || 'RG');
  reservationUrl.searchParams.set('FLAG', 'GOTO');
  reservationUrl.searchParams.set('USER_SKEY', education.USER_SKEY || '');
  reservationUrl.searchParams.set('PLAN_AMOUNT', String(education.PLAN_AMOUNT || 0));
  reservationUrl.searchParams.set('STATUS', 'RE');
  return reservationUrl.toString();
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

const runEducationOpenReservation = async ({ tabId, education, emailConfig }) => {
  if (!tabId || !education?.EVENT_SKEY || !education?.ESCHED_SKEY) {
    throw new Error('교육 신청 정보가 올바르지 않습니다.');
  }

  const reservationUrl = buildEducationReservationUrl(education);

  await chrome.tabs.update(tabId, { url: reservationUrl });
  const tab = await waitForTabComplete(tabId);
  if (tab.url?.includes('/login')) {
    throw new Error('ISRC 로그인이 필요합니다. 로그인된 탭으로 다시 설정하세요.');
  }

  await ensureRelay(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content-helpers.js']
  });

  const [{ result: entryResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (options) => window.__gext?.clickEducationReserveEntry?.(options),
    args: [{ education }]
  });

  if (!entryResult?.ok) {
    throw new Error(entryResult?.error || '상세 페이지에서 신청 버튼을 찾지 못했습니다.');
  }

  await sleep(1000);
  tab = await waitForTabComplete(tabId);
  if (tab.url?.includes('/login')) {
    throw new Error('예약 단계에서 로그인 페이지로 이동했습니다.');
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content-helpers.js']
  });

  const [{ result: submitResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (options) => window.__gext?.submitEducationReservation?.(options),
    args: [{ education, emailConfig }]
  });

  if (!submitResult?.ok) {
    throw new Error(submitResult?.error || '예약 페이지에서 최종 신청 버튼을 찾지 못했습니다.');
  }

  return { ok: true, entryResult, submitResult };
};

const runEducationOpenReservationDirect = async ({ tabId, education, emailConfig, reservationConfig }) => {
  if (!tabId || !education?.EVENT_SKEY || !education?.ESCHED_SKEY) {
    throw new Error('교육 신청 정보가 올바르지 않습니다.');
  }

  let tab = await chrome.tabs.get(tabId);
  let tabOrigin = '';
  try {
    tabOrigin = new URL(tab.url || '').origin;
  } catch (_) {}

  if (tabOrigin !== new URL(ISRC_BASE_URL).origin) {
    await chrome.tabs.update(tabId, { url: ISRC_BASE_URL });
    tab = await waitForTabComplete(tabId);
  }

  if (tab.url?.includes('/login')) {
    throw new Error('ISRC 로그인이 필요합니다. 로그인한 탭으로 다시 설정하세요.');
  }

  await ensureRelay(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content-helpers.js']
  });

  const [{ result: submitResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (options) => window.__gext?.submitEducationReservation?.(options),
    args: [{ education, emailConfig, reservationConfig }]
  });

  if (!submitResult?.ok) {
    throw new Error(submitResult?.error || '예약 페이지에서 최종 신청 버튼을 찾지 못했습니다.');
  }

  return { ok: true, submitResult };
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MIDNIGHT_ALARM_NAME) return;

  (async () => {
    const stored = await chrome.storage.local.get([MIDNIGHT_STORE_KEY]);
    const data = stored[MIDNIGHT_STORE_KEY];
    if (!data) return;
    let shouldClearSchedule = true;

    try {
      const info = await getServerMidnightInfo();
      const remainingMs = data.nextServerMidnightMs - info.serverNowMs;

      if (remainingMs > 0) {
        shouldClearSchedule = false;
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
      if (shouldClearSchedule) {
        await chrome.storage.local.remove(MIDNIGHT_STORE_KEY);
        await chrome.alarms.clear(MIDNIGHT_ALARM_NAME);
      }
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== EDUCATION_OPEN_ALARM_NAME) return;

  (async () => {
    const stored = await chrome.storage.local.get([EDUCATION_OPEN_STORE_KEY]);
    const data = stored[EDUCATION_OPEN_STORE_KEY];
    if (!data?.educations?.length) return;
    let shouldClearSchedule = true;

    try {
      const clock = await fetchServerClock();
      const queue = splitEducationQueueByDue(clock, data.educations);

      if (!queue.due.length && queue.future.length) {
        const nextTarget = queue.future[0];
        shouldClearSchedule = false;
        chrome.alarms.create(EDUCATION_OPEN_ALARM_NAME, {
          when: Date.now() + Math.max(nextTarget.plan.remainingMs, EDUCATION_OPEN_RETRY_MIN_MS)
        });
        return;
      }

      for (const { education } of queue.due) {
        await runEducationOpenReservationDirect({
          tabId: data.tabId,
          education,
          emailConfig: data.emailConfig || {},
          reservationConfig: data.reservationConfig || {}
        });
      }

      if (queue.future.length) {
        const refreshedQueue = buildQueuedEducationOpenState(
          await fetchServerClock(),
          queue.future.map(({ education }) => education)
        );
        shouldClearSchedule = false;
        await chrome.storage.local.set({
          [EDUCATION_OPEN_STORE_KEY]: {
            tabId: data.tabId,
            educations: refreshedQueue.educations,
            emailConfig: data.emailConfig || {},
            reservationConfig: data.reservationConfig || {},
            targetOpenMs: refreshedQueue.targetOpenMs,
            targetOpenText: refreshedQueue.targetOpenText
          }
        });
        chrome.alarms.create(EDUCATION_OPEN_ALARM_NAME, {
          when: refreshedQueue.localAlarmAtMs
        });
      }
    } catch (error) {
      console.warn('[Background] Education open reservation failed.', error);
    } finally {
      if (shouldClearSchedule) {
        await chrome.storage.local.remove(EDUCATION_OPEN_STORE_KEY);
        await chrome.alarms.clear(EDUCATION_OPEN_ALARM_NAME);
      }
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LOGIN_KEEP_ALIVE_ALARM_NAME) return;

  (async () => {
    const stored = await chrome.storage.local.get([LOGIN_KEEP_ALIVE_STORE_KEY]);
    const data = stored[LOGIN_KEEP_ALIVE_STORE_KEY];
    if (!data?.active) return;

    const now = new Date();
    try {
      const result = await runLoginKeepAlive(data.tabId || null);
      if (!result.ok) {
        await chrome.alarms.clear(LOGIN_KEEP_ALIVE_ALARM_NAME);
        await storeLoginKeepAliveState({
          active: false,
          tabId: result.tabId || data.tabId || null,
          lastPingAtMs: now.getTime(),
          lastPingText: formatDateTime(now),
          lastMessage: result.message
        });
        return;
      }

      await storeLoginKeepAliveState({
        active: true,
        tabId: result.tabId || data.tabId || null,
        lastPingAtMs: now.getTime(),
        lastPingText: formatDateTime(now),
        lastMessage: result.message
      });
    } catch (error) {
      await storeLoginKeepAliveState({
        active: true,
        lastPingAtMs: now.getTime(),
        lastPingText: formatDateTime(now),
        lastMessage: `세션 유지 요청 오류: ${error.message}`
      });
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

  if (request.action === 'GET_EDUCATION_OPEN_RESERVE_INFO') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get([EDUCATION_OPEN_STORE_KEY]);
        const data = stored[EDUCATION_OPEN_STORE_KEY];

        if (!data?.educations?.length) {
          sendResponse({ ok: true, hasSchedule: false });
          return;
        }

        const nextEducation = data.educations[0];

        sendResponse({
          ok: true,
          hasSchedule: true,
          targetOpenText: data.targetOpenText,
          targetOpenMs: data.targetOpenMs,
          equipmentName: nextEducation?.EQUIP_NAME || nextEducation?.NAME || '',
          education: nextEducation,
          count: data.educations.length
        });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'GET_LOGIN_KEEP_ALIVE_INFO') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get([LOGIN_KEEP_ALIVE_STORE_KEY]);
        const data = stored[LOGIN_KEEP_ALIVE_STORE_KEY];

        if (!data) {
          sendResponse({
            ok: true,
            hasSchedule: false,
            intervalMinutes: LOGIN_KEEP_ALIVE_DEFAULT_INTERVAL_MIN
          });
          return;
        }

        sendResponse({
          ok: true,
          hasSchedule: Boolean(data.active),
          intervalMinutes: data.intervalMinutes || LOGIN_KEEP_ALIVE_DEFAULT_INTERVAL_MIN,
          lastPingAtMs: data.lastPingAtMs || null,
          lastPingText: data.lastPingText || '',
          lastMessage: data.lastMessage || ''
        });
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

  if (request.action === 'SCHEDULE_EDUCATION_OPEN_RESERVE') {
    (async () => {
      try {
        const data = request.data || {};
        const clock = await fetchServerClock();
        const queueState = buildQueuedEducationOpenState(clock, data.educations || data.education);

        await chrome.alarms.clear(EDUCATION_OPEN_ALARM_NAME);
        await chrome.storage.local.set({
          [EDUCATION_OPEN_STORE_KEY]: {
            tabId: data.tabId,
            educations: queueState.educations,
            emailConfig: data.emailConfig || {},
            reservationConfig: data.reservationConfig || {},
            targetOpenMs: queueState.targetOpenMs,
            targetOpenText: queueState.targetOpenText
          }
        });

        chrome.alarms.create(EDUCATION_OPEN_ALARM_NAME, { when: queueState.localAlarmAtMs });
        sendResponse({
          ok: true,
          count: queueState.count,
          targetOpenMs: queueState.targetOpenMs,
          targetOpenText: queueState.targetOpenText,
          equipmentName: queueState.equipmentName
        });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'START_LOGIN_KEEP_ALIVE') {
    (async () => {
      try {
        const data = request.data || {};
        const intervalMinutes = getLoginKeepAliveIntervalMin(data.intervalMinutes);
        const now = new Date();
        const result = await runLoginKeepAlive(data.tabId || null);

        if (!result.ok) {
          await chrome.alarms.clear(LOGIN_KEEP_ALIVE_ALARM_NAME);
          await storeLoginKeepAliveState({
            active: false,
            tabId: result.tabId || data.tabId || null,
            intervalMinutes,
            lastPingAtMs: now.getTime(),
            lastPingText: formatDateTime(now),
            lastMessage: result.message
          });
          sendResponse({ ok: false, error: result.message });
          return;
        }

        await chrome.alarms.clear(LOGIN_KEEP_ALIVE_ALARM_NAME);
        await chrome.storage.local.set({
          [LOGIN_KEEP_ALIVE_STORE_KEY]: {
            active: true,
            tabId: result.tabId || data.tabId || null,
            intervalMinutes,
            lastPingAtMs: now.getTime(),
            lastPingText: formatDateTime(now),
            lastMessage: result.message
          }
        });
        chrome.alarms.create(LOGIN_KEEP_ALIVE_ALARM_NAME, {
          delayInMinutes: intervalMinutes,
          periodInMinutes: intervalMinutes
        });

        sendResponse({
          ok: true,
          intervalMinutes,
          lastPingAtMs: now.getTime(),
          lastPingText: formatDateTime(now),
          lastMessage: result.message
        });
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

  if (request.action === 'CANCEL_EDUCATION_OPEN_RESERVE') {
    (async () => {
      await chrome.alarms.clear(EDUCATION_OPEN_ALARM_NAME);
      await chrome.storage.local.remove(EDUCATION_OPEN_STORE_KEY);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'STOP_LOGIN_KEEP_ALIVE') {
    (async () => {
      const stored = await chrome.storage.local.get([LOGIN_KEEP_ALIVE_STORE_KEY]);
      const current = stored[LOGIN_KEEP_ALIVE_STORE_KEY] || {};
      await chrome.alarms.clear(LOGIN_KEEP_ALIVE_ALARM_NAME);
      await chrome.storage.local.set({
        [LOGIN_KEEP_ALIVE_STORE_KEY]: {
          ...current,
          active: false,
          lastMessage: '사용자가 중지했습니다.'
        }
      });
      sendResponse({ ok: true });
    })();
    return true;
  }
});
