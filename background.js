chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "highlightSelection",
    title: "Highlight selection",
    contexts: ["selection"]
  });
});

/**
 * START_DT_STR 필드에 날짜/시간을 채워 넣는다.
 * @param {string|Date} value  예: "2025-11-06 14:30" 또는 new Date()
 * @param {Object} [opts]
 * @param {string} [opts.format="YYYY-MM-DD HH:mm"]  Date 객체를 문자열로 바꿀 때의 포맷
 */
function setStartDt(value, opts = {}) {
  const format = opts.format || "YYYY-MM-DD HH:mm";

  // 1) 타깃 요소 찾기
  const el =
    document.querySelector('input[name="START_DT_STR"].i_calendar.datepicker-calendar') ||
    document.querySelector('input[name="START_DT_STR"]');
  if (!el) return false;

  // 2) 문자열 만들기
  const str = typeof value === "string" ? value : formatDate(value, format);

  // 3) React 등 프레임워크 대응: 네이티브 setter로 값 주입
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const prevReadOnly = el.readOnly;
  el.readOnly = false; // readonly라도 값 주입 위해 잠시 해제

  if (nativeSetter) {
    nativeSetter.call(el, str);
  } else {
    el.value = str;
  }

  // 4) 이벤트 발사: input → change
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  // 5) jQuery UI datepicker가 있으면 setDate까지 맞춰주기
  try {
    if (window.jQuery && typeof jQuery.fn.datepicker === "function") {
      // 문자열을 Date로 대충 파싱. 필요시 커스텀 파서로 교체 가능
      const d = parseDateFromString(str);
      if (d) jQuery(el).datepicker("setDate", d);
    }
  } catch (e) {
    // 조용히 패스
  }

  // 6) 원래 상태 복원
  el.readOnly = prevReadOnly;
  return true;

  // ===== helpers =====
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function formatDate(date, fmt) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(+d)) throw new Error("Invalid Date");
    const Y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    return fmt
      .replace("YYYY", Y)
      .replace("MM", M)
      .replace("DD", D)
      .replace("HH", h)
      .replace("mm", m)
      .replace("ss", s);
  }
  function parseDateFromString(s) {
    // 가장 흔한 "YYYY-MM-DD HH:mm[:ss]" 형태를 우선 지원
    const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return new Date(s); // 브라우저 파서에 위임
    const [_, Y, MM, DD, HH = "00", mm = "00", ss = "00"] = m;
    return new Date(+Y, +MM - 1, +DD, +HH, +mm, +ss);
  }
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


