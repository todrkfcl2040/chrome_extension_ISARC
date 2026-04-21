const ISRC_BASE_URL = 'https://isrc.snu.ac.kr';
const UPCOMING_EQUIP_EDU_ENDPOINT = `${ISRC_BASE_URL}/hm/event/equip/sched/list/json`;
const UPCOMING_EQUIP_EDU_PAGE_SIZE = 200;
const UPCOMING_EQUIP_EDU_LIMIT = 30;
const UPCOMING_EDUCATION_CHECKED_KEY = 'upcomingEducationCheckedIds';
const LOGIN_KEEP_ALIVE_INTERVAL_KEY = 'loginKeepAliveIntervalMin';
const LOGIN_KEEP_ALIVE_DEFAULT_INTERVAL_MIN = 10;
const CLEAN_ROOM_BATCH_MAX_LOG = 60;

const upcomingEducationMap = new Map();
const upcomingEducationCheckedIds = new Set();
let cachedReservationRoutes = [];

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

const pad2 = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const getValue = (id) => document.getElementById(id)?.value?.trim() || '';

const setText = (id, text) => {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
};

const setDisabled = (id, disabled) => {
  const element = document.getElementById(id);
  if (element) element.disabled = disabled;
};

const renderCleanRoomBatchResults = (results = []) => {
  const list = document.getElementById('cleanRoomBatchResultList');
  if (!list) return;

  if (!Array.isArray(results) || !results.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = '';
  results.slice(0, CLEAN_ROOM_BATCH_MAX_LOG).forEach((entry) => {
    const item = document.createElement('li');
    item.className = entry?.ok ? 'result-success' : 'result-fail';
    item.textContent = entry?.ok
      ? `${entry.date}: 신청 완료`
      : `${entry.date}: ${entry?.error || '신청 실패'}`;
    list.appendChild(item);
  });
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

const parseIsrcDateTime = (value) => {
  if (!value) return null;

  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getRemainingSeatsText = (education) => {
  const limit = Number(education.LIMIT_MAX);
  const reserved = Number(education.RESERVATION_CNT);

  if (Number.isFinite(limit) && Number.isFinite(reserved)) {
    return `${Math.max(limit - reserved, 0)} / ${limit}석`;
  }

  if (Number.isFinite(limit)) {
    return `${limit}석`;
  }

  return '정원 정보 없음';
};

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

const buildEducationOptionLabel = (education) => {
  const equipmentName = education.EQUIP_NAME || education.NAME || '장비교육';
  return `${education.RECEIVE_START_DT_STR} 오픈 · ${equipmentName}`;
};

const getCheckedUpcomingEducations = () =>
  [...upcomingEducationCheckedIds]
    .map((educationId) => upcomingEducationMap.get(educationId))
    .filter(Boolean)
    .sort((a, b) => parseIsrcDateTime(a.RECEIVE_START_DT_STR) - parseIsrcDateTime(b.RECEIVE_START_DT_STR));

const persistUpcomingEducationCheckedIds = () =>
  chrome.storage.local.set({
    [UPCOMING_EDUCATION_CHECKED_KEY]: [...upcomingEducationCheckedIds]
  });

const renderUpcomingEducationDetails = () => {
  const checkedEducations = getCheckedUpcomingEducations();
  const totalCount = upcomingEducationMap.size;

  if (!totalCount) {
    setText('upcomingEducationHint', '예정된 장비교육 신청 오픈이 없습니다.');
    setText('upcomingEducationMeta', '');
    return;
  }

  if (!checkedEducations.length) {
    setText('upcomingEducationHint', '체크된 항목만 자동으로 신청합니다. 목록에서 선택하세요.');
    setText('upcomingEducationMeta', `표시 중 ${totalCount}건`);
    return;
  }

  const firstEducation = checkedEducations[0];
  const equipmentName = firstEducation.EQUIP_NAME || firstEducation.NAME || '장비교육';

  if (checkedEducations.length === 1) {
    setText(
      'upcomingEducationHint',
      `${equipmentName} / 담당 ${firstEducation.OWNER_NAME || '-'} / 정원 ${getRemainingSeatsText(firstEducation)}`
    );
    setText(
      'upcomingEducationMeta',
      `신청 ${firstEducation.RECEIVE_START_DT_STR} ~ ${firstEducation.RECEIVE_END_DT_STR} | 교육 ${firstEducation.START_DT_STR} ~ ${firstEducation.END_DT_STR}`
    );
    return;
  }

  setText(
    'upcomingEducationHint',
    `${checkedEducations.length}건 선택됨 / 가장 빠른 오픈 ${firstEducation.RECEIVE_START_DT_STR} / ${equipmentName}`
  );
  setText(
    'upcomingEducationMeta',
    `표시 ${totalCount}건 | 선택 ${checkedEducations.length}건 | 가장 빠른 교육 ${firstEducation.START_DT_STR} ~ ${firstEducation.END_DT_STR}`
  );
};

const renderUpcomingEducationChecklist = (educations) => {
  const list = document.getElementById('upcomingEducationList');
  if (!list) return;

  upcomingEducationMap.clear();

  if (!educations.length) {
    upcomingEducationCheckedIds.clear();
    list.innerHTML = '<div class="education-checklist-empty">예정된 신청 오픈이 없습니다.</div>';
    persistUpcomingEducationCheckedIds();
    renderUpcomingEducationDetails();
    return;
  }

  const validIds = new Set();
  educations.forEach((education) => {
    const educationId = String(education.ESCHED_SKEY);
    validIds.add(educationId);
    upcomingEducationMap.set(educationId, education);
  });

  let changed = false;
  [...upcomingEducationCheckedIds].forEach((educationId) => {
    if (!validIds.has(educationId)) {
      upcomingEducationCheckedIds.delete(educationId);
      changed = true;
    }
  });

  list.innerHTML = educations
    .map((education) => {
      const educationId = String(education.ESCHED_SKEY);
      const title = buildEducationOptionLabel(education);
      const meta = `담당 ${education.OWNER_NAME || '-'} | 정원 ${getRemainingSeatsText(education)} | 교육 ${education.START_DT_STR} ~ ${education.END_DT_STR}`;

      return `
        <label class="education-check-item">
          <input type="checkbox" data-education-id="${escapeHtml(educationId)}" ${
            upcomingEducationCheckedIds.has(educationId) ? 'checked' : ''
          }>
          <span class="education-check-body">
            <span class="education-check-title">${escapeHtml(title)}</span>
            <span class="education-check-meta">${escapeHtml(meta)}</span>
          </span>
        </label>
      `;
    })
    .join('');

  if (changed) {
    persistUpcomingEducationCheckedIds();
  }
  renderUpcomingEducationDetails();
};

async function fetchUpcomingEquipEducationPage(baseYear, page) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('rows', String(UPCOMING_EQUIP_EDU_PAGE_SIZE));
  params.set('USER_VIEW', 'EQUIP');
  params.set('STATUS', 'A');
  params.set('EVENT_STATUS', 'A');
  params.set('EVENT_SUB_TYPE', 'RG');
  params.set('EVENT_TYPE', 'EDU08');
  params.set('BASE_YEAR', String(baseYear));
  params.append('excludeEquipFieldList', 'CRC');

  const response = await fetch(UPCOMING_EQUIP_EDU_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: params.toString(),
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`신청 오픈 목록 조회 실패 (${response.status})`);
  }

  return response.json();
}

async function fetchUpcomingEquipEducations() {
  const now = new Date();
  const yearsToCheck = [now.getFullYear(), now.getFullYear() + 1];
  const allRows = [];

  for (const year of yearsToCheck) {
    let page = 1;

    while (true) {
      const data = await fetchUpcomingEquipEducationPage(year, page);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const total = Number(data?.total || 0);

      allRows.push(...rows);

      if (!rows.length || page * UPCOMING_EQUIP_EDU_PAGE_SIZE >= total) {
        break;
      }

      page += 1;
    }
  }

  const deduped = new Map();
  allRows.forEach((row) => {
    const receiveStartAt = parseIsrcDateTime(row.RECEIVE_START_DT_STR);
    if (!receiveStartAt || receiveStartAt <= now) return;
    if (row.RECEIVE_STATUS === 'C' || row.RECEIVE_STATUS === 'N') return;

    deduped.set(String(row.ESCHED_SKEY), row);
  });

  return [...deduped.values()]
    .sort((a, b) => parseIsrcDateTime(a.RECEIVE_START_DT_STR) - parseIsrcDateTime(b.RECEIVE_START_DT_STR))
    .slice(0, UPCOMING_EQUIP_EDU_LIMIT);
}

async function refreshUpcomingEducationOptions() {
  try {
    setDisabled('refreshUpcomingEducationBtn', true);
    setText('upcomingEducationHint', '신청 오픈 목록을 불러오는 중입니다...');
    setText('upcomingEducationMeta', '');

    const educations = await fetchUpcomingEquipEducations();
    renderUpcomingEducationChecklist(educations);
  } catch (error) {
    const list = document.getElementById('upcomingEducationList');
    if (list) {
      list.innerHTML = '<div class="education-checklist-empty">신청 오픈 목록을 불러오지 못했습니다.</div>';
    }
    setText('upcomingEducationHint', `신청 오픈 조회 실패: ${error.message}`);
    setText('upcomingEducationMeta', '');
  } finally {
    setDisabled('refreshUpcomingEducationBtn', false);
  }
}

async function refreshEducationOpenReserveInfo() {
  try {
    const info = await sendRuntimeMessage({ action: 'GET_EDUCATION_OPEN_RESERVE_INFO' });
    if (!info?.ok) {
      setText('educationOpenReserveStatus', `신청 예약 상태 조회 실패: ${info?.error || '알 수 없는 오류'}`);
      return;
    }

    if (!info.hasSchedule) {
      setText('educationOpenReserveStatus', '');
      return;
    }

    setText(
      'educationOpenReserveStatus',
      `대기중: ${info.count || 1}건 / 다음 ${info.targetOpenText} 오픈 / ${info.equipmentName || '장비교육'}`
    );
  } catch (error) {
    setText('educationOpenReserveStatus', `신청 예약 상태 조회 실패: ${error.message}`);
  }
}

async function refreshLoginKeepAliveInfo() {
  try {
    const info = await sendRuntimeMessage({ action: 'GET_LOGIN_KEEP_ALIVE_INFO' });
    if (!info?.ok) {
      setText('loginKeepAliveStatus', `로그인 유지 상태 조회 실패: ${info?.error || '알 수 없는 오류'}`);
      return;
    }

    const intervalInput = document.getElementById('loginKeepAliveIntervalMin');
    if (intervalInput && info.intervalMinutes) {
      intervalInput.value = String(info.intervalMinutes);
    }

    if (!info.hasSchedule) {
      setText('loginKeepAliveStatus', info.lastMessage ? `중지됨: ${info.lastMessage}` : '');
      return;
    }

    const lastPingText = info.lastPingText ? ` / 마지막 ${info.lastPingText}` : '';
    const lastMessageText = info.lastMessage ? ` / ${info.lastMessage}` : '';
    setText('loginKeepAliveStatus', `작동 중: ${info.intervalMinutes}분 간격${lastPingText}${lastMessageText}`);
  } catch (error) {
    setText('loginKeepAliveStatus', `로그인 유지 상태 조회 실패: ${error.message}`);
  }
}

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

function getReservationConfig() {
  return {
    fixedAccountCode: getValue('educationFixedAccountCode')
  };
}

function getSelectedRouteId() {
  return getValue('freeSlotRoute') || '';
}

function buildReservationRouteLabel(route = {}) {
  if (route.label) return route.label;

  const parts = [];
  if (route.seq) parts.push(`${route.seq}.`);
  if (route.routeName) parts.push(route.routeName);
  if (route.equipName) parts.push(`/ ${route.equipName}`);
  if (route.requesterName) parts.push(`/ 작업자 ${route.requesterName}`);
  return parts.join(' ').trim() || `공정 ${route.runsheetSubSkey || ''}`.trim();
}

function renderReservationRouteOptions(routes = [], preferredValue = '') {
  const select = document.getElementById('freeSlotRoute');
  if (!select) return;

  cachedReservationRoutes = Array.isArray(routes) ? routes : [];
  const activeValue = String(preferredValue || select.value || '');
  const reservableCount = cachedReservationRoutes.filter((route) => route.canReserve && route.workeSkey).length;

  const options = ['<option value="">현재 상세 패널 사용</option>'];
  cachedReservationRoutes.forEach((route) => {
    const value = String(route.runsheetSubSkey || '');
    const disabled = !route.canReserve || !route.workeSkey;
    const disabledText = route.reason ? ` (${route.reason})` : '';

    options.push(
      `<option value="${escapeHtml(value)}" ${disabled ? 'disabled' : ''}>${escapeHtml(
        `${buildReservationRouteLabel(route)}${disabledText}`
      )}</option>`
    );
  });

  select.innerHTML = options.join('');

  const nextValue =
    activeValue &&
    cachedReservationRoutes.some(
      (route) => String(route.runsheetSubSkey || '') === activeValue && route.canReserve && route.workeSkey
    )
      ? activeValue
      : '';
  select.value = nextValue;

  if (!cachedReservationRoutes.length) {
    setText(
      'freeSlotRouteHint',
      '현재 탭에서 공정 목록을 찾지 못했습니다. 이미 장비예약 상세를 열어둔 상태라면 현재 상세 패널로 조회할 수 있습니다.'
    );
    return;
  }

  if (!reservableCount) {
    setText('freeSlotRouteHint', `공정 ${cachedReservationRoutes.length}건을 찾았지만 현재 예약 가능한 행은 없습니다.`);
    return;
  }

  setText('freeSlotRouteHint', `공정 ${cachedReservationRoutes.length}건 / 예약 가능한 장비예약 ${reservableCount}건`);
}

async function refreshReservationRoutes() {
  const select = document.getElementById('freeSlotRoute');
  if (!select) return;

  const previousValue = getSelectedRouteId();
  setDisabled('refreshRouteListBtn', true);
  select.disabled = true;
  setText('freeSlotRouteHint', '공정 목록을 불러오는 중...');

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error('활성 탭을 찾지 못했습니다.');
    }

    await ensureHelpers(tab.id);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => window.__gext?.listReservationRoutes?.() || { routes: [] }
    });

    renderReservationRouteOptions(result?.routes || [], previousValue || result?.loadedRouteSkey || '');
  } catch (error) {
    renderReservationRouteOptions([], '');
    setText('freeSlotRouteHint', `공정 목록 조회 실패: ${error.message}`);
  } finally {
    setDisabled('refreshRouteListBtn', false);
    select.disabled = false;
  }
}

function getLoginKeepAliveIntervalMin() {
  const parsed = parseInt(getValue('loginKeepAliveIntervalMin') || String(LOGIN_KEEP_ALIVE_DEFAULT_INTERVAL_MIN), 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return LOGIN_KEEP_ALIVE_DEFAULT_INTERVAL_MIN;
  }
  return Math.max(1, parsed);
}

function persistPopupState() {
  chrome.storage.local.set({
    userEmail: getValue('userEmail'),
    educationFixedAccountCode: getValue('educationFixedAccountCode'),
    [LOGIN_KEEP_ALIVE_INTERVAL_KEY]: getLoginKeepAliveIntervalMin(),
    [UPCOMING_EDUCATION_CHECKED_KEY]: [...upcomingEducationCheckedIds]
  });
}

async function refreshMidnightReserveInfo() {
  try {
    const info = await sendRuntimeMessage({ action: 'GET_MIDNIGHT_RESERVE_INFO' });
    if (!info?.ok) {
      setText('midnightTargetDate', '서버 시간 확인 중...');
      return;
    }

    setText(
      'midnightTargetDate',
      `예약 날짜: ${info.targetDateStr} (서버 자정 ${info.nextServerMidnightText} 기준)`
    );
  } catch (error) {
    setText('midnightTargetDate', `서버 시간 조회 실패: ${error.message}`);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const storedState = await new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'userEmail',
        'educationFixedAccountCode',
        LOGIN_KEEP_ALIVE_INTERVAL_KEY,
        UPCOMING_EDUCATION_CHECKED_KEY
      ],
      resolve
    );
  });

  const {
    userEmail,
    educationFixedAccountCode,
    [LOGIN_KEEP_ALIVE_INTERVAL_KEY]: loginKeepAliveIntervalMin,
    [UPCOMING_EDUCATION_CHECKED_KEY]: storedCheckedEducationIds = []
  } = storedState;

  if (userEmail) {
    const emailInput = document.getElementById('userEmail');
    if (emailInput) emailInput.value = userEmail;
  }
  if (educationFixedAccountCode) {
    const accountCodeInput = document.getElementById('educationFixedAccountCode');
    if (accountCodeInput) accountCodeInput.value = educationFixedAccountCode;
  }
  if (loginKeepAliveIntervalMin) {
    const intervalInput = document.getElementById('loginKeepAliveIntervalMin');
    if (intervalInput) intervalInput.value = String(loginKeepAliveIntervalMin);
  }
  if (Array.isArray(storedCheckedEducationIds)) {
    storedCheckedEducationIds.forEach((educationId) => {
      if (educationId) upcomingEducationCheckedIds.add(String(educationId));
    });
  }

  const dateInput = document.getElementById('freeSlotDate');
  if (dateInput) {
    const today = new Date();
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + 13);
    dateInput.min = formatDate(today);
    dateInput.max = formatDate(maxDate);
  }

  const cleanRoomBatchStartDateInput = document.getElementById('cleanRoomBatchStartDate');
  const cleanRoomBatchEndDateInput = document.getElementById('cleanRoomBatchEndDate');
  if (cleanRoomBatchStartDateInput && cleanRoomBatchEndDateInput) {
    const today = formatDate(new Date());
    cleanRoomBatchStartDateInput.min = today;
    cleanRoomBatchEndDateInput.min = today;
    if (!cleanRoomBatchStartDateInput.value) cleanRoomBatchStartDateInput.value = today;
    if (!cleanRoomBatchEndDateInput.value) cleanRoomBatchEndDateInput.value = today;

    cleanRoomBatchStartDateInput.addEventListener('change', () => {
      if (!cleanRoomBatchEndDateInput.value || cleanRoomBatchEndDateInput.value < cleanRoomBatchStartDateInput.value) {
        cleanRoomBatchEndDateInput.value = cleanRoomBatchStartDateInput.value;
      }
      cleanRoomBatchEndDateInput.min = cleanRoomBatchStartDateInput.value || today;
    });
  }

  document.getElementById('upcomingEducationList')?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-education-id]');
    if (!checkbox) return;

    const educationId = String(checkbox.dataset.educationId || '');
    if (!educationId) return;

    if (checkbox.checked) {
      upcomingEducationCheckedIds.add(educationId);
    } else {
      upcomingEducationCheckedIds.delete(educationId);
    }

    persistUpcomingEducationCheckedIds();
    renderUpcomingEducationDetails();
  });

  document.getElementById('refreshUpcomingEducationBtn')?.addEventListener('click', () => {
    refreshUpcomingEducationOptions();
  });
  document.getElementById('refreshRouteListBtn')?.addEventListener('click', () => {
    refreshReservationRoutes();
  });

  document.getElementById('educationOpenReserveStartBtn')?.addEventListener('click', async () => {
    const educations = getCheckedUpcomingEducations();
    if (!educations.length) {
      setText('educationOpenReserveStatus', '신청 오픈 일정에서 자동 신청할 항목을 체크하세요.');
      return;
    }

    persistPopupState();

    const tab = await getActiveTab();
    if (!tab?.id) {
      setText('educationOpenReserveStatus', '활성 탭을 찾지 못했습니다.');
      return;
    }

    try {
      const info = await sendRuntimeMessage({
        action: 'SCHEDULE_EDUCATION_OPEN_RESERVE',
        data: {
          tabId: tab.id,
          educations,
          emailConfig: getEmailConfig(),
          reservationConfig: getReservationConfig()
        }
      });

      if (!info?.ok) {
        setText('educationOpenReserveStatus', `신청 예약 설정 실패: ${info?.error || '알 수 없는 오류'}`);
        return;
      }

      setText(
        'educationOpenReserveStatus',
        `대기 설정 완료: ${info.count || educations.length}건 / 다음 ${info.targetOpenText} 오픈 / ${info.equipmentName || '장비교육'}`
      );
    } catch (error) {
      setText('educationOpenReserveStatus', `신청 예약 설정 실패: ${error.message}`);
    }
  });

  document.getElementById('educationOpenReserveCancelBtn')?.addEventListener('click', async () => {
    try {
      await sendRuntimeMessage({ action: 'CANCEL_EDUCATION_OPEN_RESERVE' });
      setText('educationOpenReserveStatus', '신청 오픈 예약 대기를 취소했습니다.');
    } catch (error) {
      setText('educationOpenReserveStatus', `신청 예약 취소 실패: ${error.message}`);
    }
  });

  document.getElementById('loginKeepAliveStartBtn')?.addEventListener('click', async () => {
    persistPopupState();

    try {
      const tab = await getActiveTab();
      const info = await sendRuntimeMessage({
        action: 'START_LOGIN_KEEP_ALIVE',
        data: {
          tabId: tab?.id || null,
          intervalMinutes: getLoginKeepAliveIntervalMin()
        }
      });

      if (!info?.ok) {
        setText('loginKeepAliveStatus', `로그인 유지 시작 실패: ${info?.error || '알 수 없는 오류'}`);
        return;
      }

      const lastPingText = info.lastPingText ? ` / 마지막 ${info.lastPingText}` : '';
      setText('loginKeepAliveStatus', `작동 중: ${info.intervalMinutes}분 간격${lastPingText}`);
    } catch (error) {
      setText('loginKeepAliveStatus', `로그인 유지 시작 실패: ${error.message}`);
    }
  });

  document.getElementById('loginKeepAliveStopBtn')?.addEventListener('click', async () => {
    try {
      await sendRuntimeMessage({ action: 'STOP_LOGIN_KEEP_ALIVE' });
      setText('loginKeepAliveStatus', '로그인 유지를 중지했습니다.');
    } catch (error) {
      setText('loginKeepAliveStatus', `로그인 유지 중지 실패: ${error.message}`);
    }
  });

  setText('midnightTargetDate', '서버 시간 확인 중...');

  await Promise.all([
    refreshUpcomingEducationOptions(),
    refreshReservationRoutes(),
    refreshEducationOpenReserveInfo(),
    refreshLoginKeepAliveInfo(),
    refreshMidnightReserveInfo()
  ]);
});

document.getElementById('findFreeSlotBtn')?.addEventListener('click', async () => {
  const durationMin = parseInt(getValue('freeSlotDuration') || '60', 10);
  const dateStr = getValue('freeSlotDate') || null;
  const preferAfter = getValue('freeSlotAfter') || null;
  const preferBefore = getValue('freeSlotBefore') || null;
  const runsheetSubSkey = getSelectedRouteId() || null;
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
    args: [{ durationMin, dateStr, preferAfter, preferBefore, limit: 30, runsheetSubSkey }]
  });

  const slots = result?.slots || [];
  list.innerHTML = '';

  if (result?.error) {
    list.innerHTML = `<li>${result.error}</li>`;
    return;
  }

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
        func: (selectedSlot, routeSkey) =>
          window.__gext.fillSlotOnRoute(selectedSlot, { runsheetSubSkey: routeSkey }),
        args: [slot, runsheetSubSkey]
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
  const runsheetSubSkey = getSelectedRouteId() || null;

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
        runsheetSubSkey,
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

  setText('autoScanStatus', '중지 명령을 보냈습니다.');
});

document.getElementById('cleanRoomBatchApplyBtn')?.addEventListener('click', async () => {
  const startDate = getValue('cleanRoomBatchStartDate');
  const endDate = getValue('cleanRoomBatchEndDate') || startDate;

  if (!startDate || !endDate) {
    setText('cleanRoomBatchStatus', '시작일과 종료일을 입력하세요.');
    return;
  }

  if (startDate > endDate) {
    setText('cleanRoomBatchStatus', '종료일은 시작일보다 빠를 수 없습니다.');
    return;
  }

  renderCleanRoomBatchResults([]);
  setText('cleanRoomBatchStatus', '청정실 일괄 신청을 실행하는 중...');
  setDisabled('cleanRoomBatchApplyBtn', true);

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error('활성 탭을 찾지 못했습니다.');
    }

    await ensureHelpers(tab.id);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (options) => window.__gext?.batchApplyCleanRoomRequests?.(options),
      args: [{ startDate, endDate }]
    });

    if (!result) {
      throw new Error('청정실 일괄 신청 응답이 없습니다.');
    }

    renderCleanRoomBatchResults(result.results || []);

    if (!result.ok && !result.results?.length) {
      setText('cleanRoomBatchStatus', `일괄 신청 실패: ${result.error || '알 수 없는 오류'}`);
      return;
    }

    const successCount = Number(result.successCount || 0);
    const failCount = Number(result.failCount || 0);
    const totalCount = Number(result.totalCount || successCount + failCount);
    const summary = totalCount
      ? `일괄 신청 완료: ${successCount}건 성공 / ${failCount}건 실패`
      : '처리할 날짜가 없습니다.';
    const suffix = result.error ? ` (${result.error})` : '';
    setText('cleanRoomBatchStatus', `${summary}${suffix}`);
  } catch (error) {
    setText('cleanRoomBatchStatus', `일괄 신청 실패: ${error.message}`);
  } finally {
    setDisabled('cleanRoomBatchApplyBtn', false);
  }
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

  try {
    const info = await sendRuntimeMessage({
      action: 'SCHEDULE_MIDNIGHT_RESERVE',
      data: {
        tabId: tab.id,
        startTime,
        endTime,
        emailConfig: getEmailConfig()
      }
    });

    if (!info?.ok) {
      setText('midnightReserveStatus', `설정 실패: ${info?.error || '알 수 없는 오류'}`);
      return;
    }

    setText(
      'midnightReserveStatus',
      `대기 설정 완료: 서버 ${info.nextServerMidnightText} (대상 ${info.targetDateStr})`
    );
    setText(
      'midnightTargetDate',
      `예약 날짜: ${info.targetDateStr} (서버 자정 ${info.nextServerMidnightText} 기준)`
    );
  } catch (error) {
    setText('midnightReserveStatus', `설정 실패: ${error.message}`);
  }
});

document.getElementById('midnightReserveCancelBtn')?.addEventListener('click', async () => {
  try {
    await sendRuntimeMessage({ action: 'CANCEL_MIDNIGHT_RESERVE' });
    setText('midnightReserveStatus', '자정 예약 대기를 취소했습니다.');
    refreshMidnightReserveInfo();
  } catch (error) {
    setText('midnightReserveStatus', `취소 실패: ${error.message}`);
  }
});
