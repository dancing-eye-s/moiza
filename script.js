(() => {
  "use strict";

  const APP = document.getElementById("app");
  const SHEET_ROOT = document.getElementById("sheet-root");
  const TOAST_ROOT = document.getElementById("toast-root");
  const BRAND_ICON = "/assets/moiza-go/moiza_go_icon_venn.png";

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function sanitizeFilename(name) {
    return (
      String(name || "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[\/\\:*?"<>|]/g, "") || "moiza-go"
    );
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Touch pointer events are implicitly captured by the element a drag
  // started on — unlike mouse, sibling cells never receive "pointerenter"
  // while a finger slides across them. Attaching the drag listener to the
  // container and resolving the cell under the pointer via elementFromPoint
  // is the only way drag-to-paint works on a real phone.
  function attachDragPaint(container, cellSelector, handlers) {
    let dragging = false;
    let value = null;
    let lastCell = null;

    function cellAt(x, y) {
      const el = document.elementFromPoint(x, y);
      return el ? el.closest(cellSelector) : null;
    }

    function paint(cell) {
      if (!cell || !container.contains(cell) || cell === lastCell) return;
      lastCell = cell;
      handlers.onPaint(cell, value);
    }

    container.addEventListener("pointerdown", (e) => {
      const cell = e.target.closest(cellSelector);
      if (!cell) return;
      e.preventDefault();
      try {
        container.setPointerCapture(e.pointerId);
      } catch {
        /* no active pointer to capture (e.g. synthetic events); dragging still works via document fallback below */
      }
      dragging = true;
      value = !handlers.isActive(cell);
      lastCell = null;
      paint(cell);
    });

    container.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      e.preventDefault();
      paint(cellAt(e.clientX, e.clientY));
    });

    function end() {
      if (!dragging) return;
      dragging = false;
      value = null;
      lastCell = null;
      handlers.onCommit();
    }

    container.addEventListener("pointerup", end);
    container.addEventListener("pointercancel", end);
  }

  function showToast(message) {
    TOAST_ROOT.innerHTML = "";
    const el = document.createElement("div");
    el.className = "save-toast";
    el.textContent = message;
    TOAST_ROOT.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, 1800);
  }

  async function api(method, path, body) {
    const response = await fetch(`/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || "요청 중 문제가 생겼어요.";
      throw new Error(message);
    }
    return payload;
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------

  function navigate(path) {
    history.pushState(null, "", path);
    render();
    window.scrollTo(0, 0);
  }

  window.addEventListener("popstate", render);

  function render() {
    const parts = location.pathname.split("/").filter(Boolean);
    closeSheet();

    if (parts.length === 0) return renderHome();
    if (parts[0] === "create") return renderCreate();
    if (parts[0] === "e" && parts[1] && parts[2] === "result") return renderResult(parts[1]);
    if (parts[0] === "e" && parts[1]) return renderEventPage(parts[1]);
    renderHome();
  }

  // ---------------------------------------------------------------------
  // Bottom sheet
  // ---------------------------------------------------------------------

  function closeSheet() {
    SHEET_ROOT.innerHTML = "";
  }

  function openSheet(innerHtml, onMount) {
    SHEET_ROOT.innerHTML = `
      <div class="sheet-backdrop" id="sheet-backdrop"></div>
      <div class="bottom-sheet" id="bottom-sheet" role="dialog" aria-modal="true">
        <div class="sheet-handle"></div>
        <button class="sheet-close" id="sheet-close" type="button" aria-label="닫기">×</button>
        ${innerHtml}
      </div>
    `;
    requestAnimationFrame(() => {
      document.getElementById("sheet-backdrop").classList.add("show");
      document.getElementById("bottom-sheet").classList.add("show");
    });
    document.getElementById("sheet-backdrop").addEventListener("click", closeSheet);
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    if (onMount) onMount();
  }

  // ---------------------------------------------------------------------
  // Share sheet (feature 1)
  // ---------------------------------------------------------------------

  function shareMessageWithUrl(text, url) {
    const cleanText = String(text || "").trim();
    return cleanText.includes(url) ? cleanText : `${cleanText}\n${url}`.trim();
  }

  function openShareSheet({ title, text, url, imageUrl, filePromise, fileName, primaryButtonTitle = "시간 선택하러 가기" }) {
    const kakaoAvailable = Boolean(window.Kakao && window.Kakao.isInitialized && window.Kakao.isInitialized());

    openSheet(
      `
      <div class="sheet-title">카톡 메시지 만들기</div>
      <p class="sheet-desc">공유할 문구를 수정한 뒤 복사하거나 카카오톡으로 보낼 수 있어요.</p>
      <textarea class="share-textarea" id="share-text">${escapeHtml(text)}</textarea>
      <button class="share-option" id="share-copy" type="button">
        <div class="icon">🔗</div>
        <div class="text">문구 복사</div>
      </button>
      ${
        kakaoAvailable
          ? `<button class="share-option" id="share-kakao" type="button"><div class="icon">💬</div><div class="text">카카오톡으로 공유</div></button>`
          : ""
      }
      <button class="share-option" id="share-native" type="button">
        <div class="icon">📤</div>
        <div class="text">다른 앱으로 공유</div>
      </button>
    `,
      () => {
        const textInput = document.getElementById("share-text");
        const currentText = () => textInput.value.trim() || text;

        document.getElementById("share-copy").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(shareMessageWithUrl(currentText(), url));
            showToast("공유 문구가 복사됐어요");
          } catch {
            showToast("복사에 실패했어요");
          }
          closeSheet();
        });

        const kakaoBtn = document.getElementById("share-kakao");
        if (kakaoBtn) {
          kakaoBtn.addEventListener("click", () => {
            window.Kakao.Share.sendDefault({
              objectType: "feed",
              content: {
                title,
                description: currentText(),
                imageUrl: imageUrl || `${location.origin}${BRAND_ICON}`,
                link: { webUrl: url, mobileWebUrl: url },
              },
              buttons: [{ title: primaryButtonTitle, link: { webUrl: url, mobileWebUrl: url } }],
            });
            closeSheet();
          });
        }

        document.getElementById("share-native").addEventListener("click", async () => {
          closeSheet();
          const shareData = { title, text: shareMessageWithUrl(currentText(), url), url };

          try {
            if (filePromise && navigator.canShare) {
              const file = await filePromise();
              if (file && navigator.canShare({ files: [file] })) {
                await navigator.share({ ...shareData, files: [file] });
                return;
              }
            }
            if (navigator.share) {
              await navigator.share(shareData);
              return;
            }
            await navigator.clipboard.writeText(shareMessageWithUrl(currentText(), url));
            showToast("이 브라우저는 공유를 지원하지 않아 링크를 복사했어요");
          } catch (err) {
            if (err?.name !== "AbortError") showToast("공유에 실패했어요");
          }
        });
      },
    );
  }

  // ---------------------------------------------------------------------
  // Home (S1)
  // ---------------------------------------------------------------------

  function renderHome() {
    APP.innerHTML = `
      <div class="screen home-screen">
        <div class="home-brand">
          <img class="home-logo" src="${BRAND_ICON}" alt="" />
        </div>

        <section class="home-hero">
          <div class="home-copy">
            <p class="home-kicker">모임 시간 조율</p>
            <h1>각자 되는 시간만 고르면<br/>만날 시간이 바로 보여요</h1>
            <p>카톡에서 흩어진 답변을 모으지 말고, 링크 하나로 후보 시간을 정리하세요.</p>
          </div>

          <div class="home-preview" aria-hidden="true">
            <div class="preview-top">
              <div>
                <span class="preview-label">이번 주 저녁 모임</span>
                <strong>가장 많이 되는 시간</strong>
              </div>
              <span class="preview-count">5명</span>
            </div>
            <div class="preview-best">
              <span>목</span>
              <strong>19:30</strong>
              <em>전원 가능</em>
            </div>
            <div class="preview-grid">
              ${["월", "화", "수", "목"].map((d, i) => `<div class="preview-day ${i === 3 ? "hot" : ""}"><span>${d}</span><b></b><b></b><b></b></div>`).join("")}
            </div>
            <div class="preview-people">
              ${["민", "서", "준", "아"].map((n) => `<span>${n}</span>`).join("")}
              <strong>+1</strong>
            </div>
          </div>
        </section>

        <div class="home-flow" aria-label="모이자고 사용 흐름">
          <div>
            <span>1</span>
            <strong>후보 만들기</strong>
          </div>
          <div>
            <span>2</span>
            <strong>링크 공유</strong>
          </div>
          <div>
            <span>3</span>
            <strong>시간 확정</strong>
          </div>
        </div>
      </div>
      <div class="cta-bar">
        <button class="cta" id="start-btn">새 일정 만들기</button>
      </div>
    `;
    document.getElementById("start-btn").addEventListener("click", () => {
      resetCreateState();
      navigate("/create");
    });
  }

  // ---------------------------------------------------------------------
  // Create funnel (S2-S6)
  // ---------------------------------------------------------------------

  const TIME_OPTIONS = (() => {
    const opts = [];
    for (let h = 0; h < 25; h += 1) {
      opts.push(`${pad2(h % 24)}:00`);
    }
    return opts;
  })();

  const DAY_KEYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const DAY_LABELS = { SUN: "일", MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토" };

  const createState = {
    step: 1,
    name: "",
    expectedCount: "",
    mode: "dates",
    dates: new Set(),
    days: new Set(),
    timeStart: "09:00",
    timeEnd: "22:00",
    slotMinutes: 30,
    deadlineEnabled: false,
    deadlineDate: "",
    deadlineHour: "18",
    deadlineMinute: "00",
    notifyEmail: "",
    submitting: false,
    calendarMonth: (() => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth(), 1);
    })(),
  };

  function resetCreateState() {
    createState.step = 1;
    createState.name = "";
    createState.expectedCount = "";
    createState.mode = "dates";
    createState.dates = new Set();
    createState.days = new Set();
    createState.timeStart = "09:00";
    createState.timeEnd = "22:00";
    createState.slotMinutes = 30;
    createState.deadlineEnabled = false;
    createState.deadlineDate = "";
    createState.deadlineHour = "18";
    createState.deadlineMinute = "00";
    createState.notifyEmail = "";
    createState.submitting = false;
  }

  function renderCreate() {
    renderCreateStep();
  }

  function topbar(progressPct, onBack) {
    return `
      <div class="topbar">
        <button class="back" id="back-btn" aria-label="돌아가기">←</button>
        <div class="brand"><img src="${BRAND_ICON}" alt="" /></div>
      </div>
      ${progressPct != null ? `<div class="progress"><div style="width:${progressPct}%"></div></div>` : ""}
    `;
  }

  function bindBack(handler) {
    document.getElementById("back-btn").addEventListener("click", handler);
  }

  function renderCreateStep() {
    const step = createState.step;
    if (step === 1) return renderCreateStep1();
    if (step === 2) return renderCreateStep2();
    if (step === 3) return renderCreateStep3();
    if (step === 4) return renderCreateStep4();
  }

  function renderCreateStep1() {
    APP.innerHTML = `
      ${topbar(16)}
      <div class="screen">
        <h1 class="headline">모임 이름이<br/>뭐예요?</h1>
        <p class="sub">공유할 때 함께 보여질 기본 정보예요</p>
        <label class="label" for="name-input">모임 이름</label>
        <input class="field" id="name-input" placeholder="예: 7월 팀 회식" maxlength="50" value="${escapeHtml(createState.name)}" />
        <label class="label" for="expected-count-input" style="margin-top:22px;">예상 인원</label>
        <input class="field-sm expected-count-field" id="expected-count-input" type="number" inputmode="numeric" min="1" max="999" placeholder="예: 6" value="${escapeHtml(createState.expectedCount)}" />
      </div>
      <div class="cta-bar"><button class="cta" id="next-btn" ${createState.name.trim() ? "" : "disabled"}>다음</button></div>
    `;
    bindBack(() => navigate("/"));
    const input = document.getElementById("name-input");
    const expectedInput = document.getElementById("expected-count-input");
    const nextBtn = document.getElementById("next-btn");
    input.addEventListener("input", () => {
      createState.name = input.value;
      nextBtn.disabled = !input.value.trim();
    });
    expectedInput.addEventListener("input", () => {
      createState.expectedCount = expectedInput.value.replace(/[^\d]/g, "").slice(0, 3);
      expectedInput.value = createState.expectedCount;
    });
    input.focus();
    nextBtn.addEventListener("click", () => {
      createState.name = input.value.trim();
      createState.expectedCount = expectedInput.value.trim();
      if (!createState.name) return;
      createState.step = 2;
      renderCreateStep();
    });
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function renderCalendar() {
    const month = createState.calendarMonth;
    const year = month.getFullYear();
    const mIndex = month.getMonth();
    const firstDow = new Date(year, mIndex, 1).getDay();
    const totalDays = daysInMonth(year, mIndex);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let cells = "";
    for (let i = 0; i < firstDow; i += 1) cells += `<span class="day disabled" aria-hidden="true"></span>`;
    for (let d = 1; d <= totalDays; d += 1) {
      const dateObj = new Date(year, mIndex, d);
      const key = `${year}-${pad2(mIndex + 1)}-${pad2(d)}`;
      const isPast = dateObj < today;
      const selected = createState.dates.has(key);
      cells += `<button type="button" class="day ${isPast ? "disabled" : ""} ${selected ? "selected" : ""}" data-date="${key}" aria-label="${year}년 ${mIndex + 1}월 ${d}일" aria-pressed="${selected}" ${isPast ? "disabled" : ""}>${d}</button>`;
    }

    return `
      <div class="calendar">
        <div class="calendar-head">
          <button id="cal-prev" aria-label="이전 달">‹</button>
          <span>${year}년 ${mIndex + 1}월</span>
          <button id="cal-next" aria-label="다음 달">›</button>
        </div>
        <div class="calendar-grid">
          ${["일", "월", "화", "수", "목", "금", "토"].map((d) => `<div class="dow">${d}</div>`).join("")}
          ${cells}
        </div>
      </div>
    `;
  }

  function bindCalendar(rerender) {
    document.getElementById("cal-prev").addEventListener("click", () => {
      const m = createState.calendarMonth;
      createState.calendarMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1);
      rerender();
    });
    document.getElementById("cal-next").addEventListener("click", () => {
      const m = createState.calendarMonth;
      createState.calendarMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      rerender();
    });

    const gridEl = document.querySelector(".calendar-grid");
    attachDragPaint(gridEl, ".day", {
      isActive: (cell) => createState.dates.has(cell.dataset.date),
      onPaint: (cell, value) => {
        if (!cell.dataset.date) return;
        if (value) createState.dates.add(cell.dataset.date);
        else createState.dates.delete(cell.dataset.date);
        cell.classList.toggle("selected", value);
        cell.setAttribute("aria-pressed", String(value));
      },
      onCommit: updateNextButtonState,
    });
  }

  function updateNextButtonState() {
    const btn = document.getElementById("next-btn");
    if (!btn) return;
    const valid = createState.mode === "dates" ? createState.dates.size > 0 : createState.days.size > 0;
    btn.disabled = !valid;
  }

  function renderCreateStep2() {
    const isDates = createState.mode === "dates";
    APP.innerHTML = `
      ${topbar(32)}
      <div class="screen">
        <h1 class="headline">언제 모일까요?</h1>
        <p class="sub">후보 날짜를 선택해주세요</p>
        <div class="segmented">
          <button class="${isDates ? "active" : ""}" data-mode="dates" aria-pressed="${isDates}">특정 날짜</button>
          <button class="${!isDates ? "active" : ""}" data-mode="days" aria-pressed="${!isDates}">요일로 정하기</button>
        </div>
        ${isDates ? renderCalendar() : `<div class="chip-row" id="day-chips">${DAY_KEYS.map((k) => `<button type="button" class="chip ${createState.days.has(k) ? "active" : ""}" data-day="${k}" aria-pressed="${createState.days.has(k)}">${DAY_LABELS[k]}</button>`).join("")}</div>`}
      </div>
      <div class="cta-bar"><button class="cta" id="next-btn">다음</button></div>
    `;
    bindBack(() => {
      createState.step = 1;
      renderCreateStep();
    });

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        createState.mode = btn.dataset.mode;
        renderCreateStep2();
      });
    });

    if (isDates) {
      bindCalendar(() => renderCreateStep2());
    } else {
      document.querySelectorAll("[data-day]").forEach((chip) => {
        chip.addEventListener("click", () => {
          const key = chip.dataset.day;
          if (createState.days.has(key)) createState.days.delete(key);
          else createState.days.add(key);
          chip.classList.toggle("active");
          chip.setAttribute("aria-pressed", String(createState.days.has(key)));
          updateNextButtonState();
        });
      });
    }

    updateNextButtonState();
    document.getElementById("next-btn").addEventListener("click", () => {
      const valid = createState.mode === "dates" ? createState.dates.size > 0 : createState.days.size > 0;
      if (!valid) return;
      createState.step = 3;
      renderCreateStep();
    });
  }

  function renderCreateStep3() {
    APP.innerHTML = `
      ${topbar(48)}
      <div class="screen">
        <h1 class="headline">어떤 시간대가<br/>괜찮을까요?</h1>
        <p class="sub">이 범위 안에서 시간을 고를 수 있어요</p>
        <div class="time-row">
          <label class="sr-only" for="time-start">시작 시간</label>
          <select id="time-start">${TIME_OPTIONS.slice(0, 24)
            .map((t) => `<option value="${t}" ${t === createState.timeStart ? "selected" : ""}>${t}</option>`)
            .join("")}</select>
          <span style="color:var(--navy-soft)">부터</span>
        </div>
        <div class="time-row">
          <label class="sr-only" for="time-end">종료 시간</label>
          <select id="time-end">${TIME_OPTIONS.slice(1)
            .map((t) => `<option value="${t}" ${t === createState.timeEnd ? "selected" : ""}>${t}</option>`)
            .join("")}</select>
          <span style="color:var(--navy-soft)">까지</span>
        </div>
        <label class="label" style="margin-top:12px;">선택 단위</label>
        <div class="chip-row">
          ${[15, 30, 60]
            .map((m) => `<button type="button" class="chip ${createState.slotMinutes === m ? "active" : ""}" data-slot="${m}" aria-pressed="${createState.slotMinutes === m}">${m}분</button>`)
            .join("")}
        </div>
      </div>
      <div class="cta-bar"><button class="cta" id="next-btn">다음</button></div>
    `;
    bindBack(() => {
      createState.step = 2;
      renderCreateStep();
    });

    const startSel = document.getElementById("time-start");
    const endSel = document.getElementById("time-end");
    startSel.addEventListener("change", () => (createState.timeStart = startSel.value));
    endSel.addEventListener("change", () => (createState.timeEnd = endSel.value));

    document.querySelectorAll("[data-slot]").forEach((chip) => {
      chip.addEventListener("click", () => {
        createState.slotMinutes = Number(chip.dataset.slot);
        document.querySelectorAll("[data-slot]").forEach((c) => {
          c.classList.toggle("active", c === chip);
          c.setAttribute("aria-pressed", String(c === chip));
        });
      });
    });

    document.getElementById("next-btn").addEventListener("click", () => {
      if (createState.timeStart >= createState.timeEnd) {
        showToast("종료 시간은 시작 시간보다 늦어야 해요");
        return;
      }
      createState.step = 4;
      renderCreateStep();
    });
  }

  function renderCreateStep4() {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    const hourOptions = Array.from({ length: 24 }, (_, hour) => pad2(hour));
    const minuteOptions = Array.from({ length: 60 }, (_, minute) => pad2(minute));
    APP.innerHTML = `
      ${topbar(75)}
      <div class="screen">
        <h1 class="headline">마감일을<br/>정해둘까요?</h1>
        <p class="sub">마감되면 결과를 이메일로 보내드려요</p>
        <div class="toggle-row">
          <div>
            <div class="title">조율 마감 설정</div>
            <div class="desc">선택 사항이에요</div>
          </div>
          <button type="button" class="switch ${createState.deadlineEnabled ? "on" : ""}" id="deadline-switch" role="switch" aria-checked="${createState.deadlineEnabled}" aria-label="조율 마감 설정"><span class="knob"></span></button>
        </div>
        <div id="deadline-fields" style="display:${createState.deadlineEnabled ? "block" : "none"}">
          <label class="label" for="deadline-date">마감 날짜</label>
          <input class="field-sm deadline-date-field" type="date" id="deadline-date" min="${todayKey}" value="${createState.deadlineDate}" />
          <fieldset class="deadline-time-fieldset">
            <legend class="label">마감 시간</legend>
            <div class="deadline-time-row">
              <label class="deadline-select-wrap" for="deadline-hour">
                <span>시</span>
                <select class="field-sm" id="deadline-hour">${hourOptions.map((hour) => `<option value="${hour}" ${hour === createState.deadlineHour ? "selected" : ""}>${hour}</option>`).join("")}</select>
              </label>
              <span class="deadline-colon" aria-hidden="true">:</span>
              <label class="deadline-select-wrap" for="deadline-minute">
                <span>분</span>
                <select class="field-sm" id="deadline-minute">${minuteOptions.map((minute) => `<option value="${minute}" ${minute === createState.deadlineMinute ? "selected" : ""}>${minute}</option>`).join("")}</select>
              </label>
            </div>
          </fieldset>
          <label class="label" for="notify-email">결과 받을 이메일</label>
          <input class="field-sm" type="email" id="notify-email" placeholder="you@example.com" value="${createState.notifyEmail}" />
        </div>
      </div>
      <div class="cta-bar"><button class="cta" id="next-btn">다음</button></div>
    `;
    bindBack(() => {
      createState.step = 3;
      renderCreateStep();
    });

    const switchEl = document.getElementById("deadline-switch");
    const fields = document.getElementById("deadline-fields");
    switchEl.addEventListener("click", () => {
      createState.deadlineEnabled = !createState.deadlineEnabled;
      switchEl.classList.toggle("on", createState.deadlineEnabled);
      switchEl.setAttribute("aria-checked", String(createState.deadlineEnabled));
      fields.style.display = createState.deadlineEnabled ? "block" : "none";
    });
    document.getElementById("deadline-date").addEventListener("input", (e) => (createState.deadlineDate = e.target.value));
    document.getElementById("deadline-hour").addEventListener("change", (e) => (createState.deadlineHour = e.target.value));
    document.getElementById("deadline-minute").addEventListener("change", (e) => (createState.deadlineMinute = e.target.value));
    document.getElementById("notify-email").addEventListener("input", (e) => (createState.notifyEmail = e.target.value));

    document.getElementById("next-btn").addEventListener("click", () => {
      if (createState.deadlineEnabled && (!createState.deadlineDate || !createState.notifyEmail)) {
        showToast("마감 일시와 이메일을 모두 입력해주세요");
        return;
      }
      if (createState.deadlineEnabled) {
        const deadline = new Date(`${createState.deadlineDate}T${createState.deadlineHour}:${createState.deadlineMinute}`);
        if (deadline.getTime() <= Date.now()) {
          showToast("마감 일시는 현재보다 늦게 설정해주세요");
          return;
        }
      }
      submitEvent();
    });
  }

  async function submitEvent() {
    if (createState.submitting) return;
    createState.submitting = true;
    const submitBtn = document.getElementById("next-btn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "일정 만드는 중…";
    }

    try {
      const payload = {
        name: createState.name,
        expectedCount: createState.expectedCount ? Number(createState.expectedCount) : null,
        mode: createState.mode,
        dates: createState.mode === "dates" ? [...createState.dates].sort() : [...createState.days],
        timeStart: createState.timeStart,
        timeEnd: createState.timeEnd,
        slotMinutes: createState.slotMinutes,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul",
        deadlineAt: createState.deadlineEnabled
          ? new Date(`${createState.deadlineDate}T${createState.deadlineHour}:${createState.deadlineMinute}`).toISOString()
          : "",
        notifyEmail: createState.deadlineEnabled ? createState.notifyEmail : "",
      };
      const { eventId, ownerToken } = await api("POST", "/events", payload);
      localStorage.setItem(ownerStorageKey(eventId), ownerToken);
      navigate(`/e/${eventId}?created=1`);
    } catch (err) {
      showToast(err.message);
      createState.submitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "다음";
      }
    }
  }

  // ---------------------------------------------------------------------
  // Invitation canvas (S13, feature 2)
  // ---------------------------------------------------------------------

  function invitationDataUrl(canvas) {
    const qualities = [0.82, 0.68, 0.52, 0.4];
    for (const quality of qualities) {
      const dataUrl = canvas.toDataURL("image/webp", quality);
      if (dataUrl.length <= 44000) return dataUrl;
    }

    const compact = document.createElement("canvas");
    compact.width = 720;
    compact.height = 720;
    compact.getContext("2d").drawImage(canvas, 0, 0, compact.width, compact.height);
    for (const quality of [0.42, 0.3, 0.2]) {
      const dataUrl = compact.toDataURL("image/webp", quality);
      if (dataUrl.length <= 44000) return dataUrl;
    }

    const fallback = document.createElement("canvas");
    fallback.width = 480;
    fallback.height = 480;
    fallback.getContext("2d").drawImage(canvas, 0, 0, fallback.width, fallback.height);
    return fallback.toDataURL("image/webp", 0.24);
  }

  function openInvitationCanvas({ initialImage = "", onSave }) {
    const overlay = document.createElement("div");
    overlay.className = "invitation-editor";
    overlay.innerHTML = `
      <div class="invitation-editor-shell">
        <div class="topbar">
          <button class="back" id="canvas-close" aria-label="그리기 닫기">×</button>
          <div class="brand">확정 일정 공유 이미지</div>
        </div>
        <div class="drawing-screen">
          <div class="canvas-wrap"><canvas id="invite-canvas" aria-label="공유 이미지 그리기 영역"></canvas></div>
          <div class="pen-tools" aria-label="그리기 도구">
            <div class="pen-colors">
              <button type="button" class="pen-color black active" data-color="#191F28" aria-label="검정색" aria-pressed="true"></button>
              <button type="button" class="pen-color coral" data-color="#FF6B4A" aria-label="코랄색" aria-pressed="false"></button>
              <button type="button" class="pen-color yellow" data-color="#F3B61F" aria-label="노란색" aria-pressed="false"></button>
              <button type="button" class="pen-color blue" data-color="#3478F6" aria-label="파란색" aria-pressed="false"></button>
              <button type="button" class="pen-color green" data-color="#00A86B" aria-label="초록색" aria-pressed="false"></button>
            </div>
            <div class="pen-actions">
              <button type="button" class="icon-btn" id="undo-btn" title="실행 취소" aria-label="실행 취소">↶</button>
              <button type="button" class="icon-btn" id="clear-btn" title="전체 지우기" aria-label="전체 지우기">⌫</button>
            </div>
          </div>
        </div>
        <div class="cta-bar"><button class="cta" id="canvas-done">저장하고 공유 준비</button></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector("#invite-canvas");
    const SIZE = 1080;
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    let color = "#191F28";
    let strokes = [];
    let currentStroke = null;
    let baseImage = null;

    function redraw() {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, SIZE, SIZE);
      if (baseImage) ctx.drawImage(baseImage, 0, 0, SIZE, SIZE);
      strokes.forEach((stroke) => {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.beginPath();
        stroke.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      });
    }

    if (initialImage) {
      const image = new Image();
      image.addEventListener("load", () => {
        baseImage = image;
        redraw();
      });
      image.src = initialImage;
    }

    function pointFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * SIZE;
      const y = ((e.clientY - rect.top) / rect.height) * SIZE;
      return { x, y };
    }

    canvas.addEventListener("pointerdown", (e) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* no active pointer to capture (e.g. synthetic events) */
      }
      currentStroke = { color, width: 6, points: [pointFromEvent(e)] };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!currentStroke) return;
      currentStroke.points.push(pointFromEvent(e));
      redraw();
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = currentStroke.width;
      ctx.beginPath();
      currentStroke.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    });
    function endStroke() {
      if (currentStroke && currentStroke.points.length > 1) strokes.push(currentStroke);
      currentStroke = null;
    }
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);

    overlay.querySelectorAll(".pen-color").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        color = swatch.dataset.color;
        overlay.querySelectorAll(".pen-color").forEach((s) => {
          const active = s === swatch;
          s.classList.toggle("active", active);
          s.setAttribute("aria-pressed", String(active));
        });
      });
    });

    overlay.querySelector("#undo-btn").addEventListener("click", () => {
      strokes.pop();
      redraw();
    });

    overlay.querySelector("#clear-btn").addEventListener("click", () => {
      if ((strokes.length || baseImage) && !confirm("전체 지울까요?")) return;
      strokes = [];
      baseImage = null;
      redraw();
    });

    overlay.querySelector("#canvas-close").addEventListener("click", () => overlay.remove());

    overlay.querySelector("#canvas-done").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "저장하는 중…";
      try {
        await onSave(invitationDataUrl(canvas));
        overlay.remove();
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
        button.textContent = "저장하고 공유 준비";
      }
    });
  }

  // ---------------------------------------------------------------------
  // Event page: landing (S8) / join (S9) / grid (S10-S11)
  // ---------------------------------------------------------------------

  const eventPageState = {
    eventId: null,
    data: null,
    myParticipantId: null,
    myName: null,
    mySlots: null,
    activeDateIndex: 0,
    activeTab: "mine",
    pollTimer: null,
    ownerToken: null,
  };

  function participantStorageKey(eventId) {
    return `moiza-go:participant:${eventId}`;
  }

  function ownerStorageKey(eventId) {
    return `moiza-go:owner:${eventId}`;
  }

  async function renderEventPage(eventId) {
    APP.innerHTML = `<div class="screen"><div class="empty-state"><div class="venn-spinner"><span></span><span></span><span></span></div>불러오는 중이에요…</div></div>`;

    let data;
    try {
      data = await api("GET", `/events/${eventId}`);
    } catch (err) {
      return renderExpired();
    }

    eventPageState.eventId = eventId;
    eventPageState.data = data;
    eventPageState.ownerToken = localStorage.getItem(ownerStorageKey(eventId));

    if (data.event.status === "confirmed" && !location.search.includes("manage=1")) {
      return renderResult(eventId);
    }

    const saved = JSON.parse(localStorage.getItem(participantStorageKey(eventId)) || "null");
    if (saved) {
      eventPageState.myParticipantId = saved.participantId;
      eventPageState.myName = saved.name;
      const mine = data.participants.find((p) => p.participantId === saved.participantId);
      eventPageState.mySlots = mine ? [...mine.slots] : new Array(data.grid.total).fill(0);
      return renderGridScreen();
    }

    renderLanding();
  }

  function eventDateRangeSummary(event) {
    if (!event.dates.length) return "";
    if (event.mode === "days") {
      const labels = { SUN: "일", MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토" };
      return event.dates.map((d) => labels[d] || d).join(", ") + "요일";
    }
    const first = event.dates[0];
    const last = event.dates[event.dates.length - 1];
    return event.dates.length === 1 ? first : `${first} ~ ${last}`;
  }

  function eventCandidateSummary(event, max = 5) {
    if (!event.dates.length) return "";
    if (event.mode === "days") return eventDateRangeSummary(event);
    const shown = event.dates.slice(0, max);
    const suffix = event.dates.length > max ? ` 외 ${event.dates.length - max}일` : "";
    return `${shown.join(", ")}${suffix}`;
  }

  function eventShareText(event) {
    const lines = [
      `"${event.name}" 모임 시간을 조율하고 있어요.`,
      event.expectedCount ? `예상 인원: ${event.expectedCount}명` : "",
      `후보 날짜: ${eventCandidateSummary(event)}`,
      `후보 시간: ${event.timeStart}–${event.timeEnd} (${event.slotMinutes}분 단위)`,
      "가능한 시간을 선택해주세요.",
    ].filter(Boolean);
    return lines.join("\n");
  }

  function dDayBadge(deadlineAt) {
    if (!deadlineAt) return "";
    const diffMs = new Date(deadlineAt).getTime() - Date.now();
    const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffMs <= 0) return `<div class="badge warn">마감됨</div>`;
    return `<div class="badge warn">D-${days}</div>`;
  }

  function renderLanding() {
    const { event, participants, invitationImage } = eventPageState.data;
    const justCreated = location.search.includes("created=1");

    APP.innerHTML = `
      ${topbar(null)}
      <div class="screen event-hero">
        ${justCreated ? `<div class="badge success">일정이 만들어졌어요!</div>` : ""}
        ${invitationImage ? `<div class="invitation-preview"><img src="${invitationImage}" /></div>` : ""}
        <h1 class="headline">${escapeHtml(event.name)}</h1>
        <p class="sub">${escapeHtml(eventDateRangeSummary(event))}</p>
        ${dDayBadge(event.deadlineAt)}
        <div class="stat-row">
          <div class="stat-card"><div class="num">${event.expectedCount ? `${participants.length}/${event.expectedCount}` : participants.length}</div><div class="lbl">${event.expectedCount ? "응답/예상" : "참여자"}</div></div>
          <div class="stat-card"><div class="num">${event.timeStart}–${event.timeEnd}</div><div class="lbl">시간대</div></div>
        </div>
      </div>
      <div class="cta-bar">
        <button class="cta" id="join-cta">${event.status === "confirmed" ? "확정 일정 보기" : "시간 선택하기"}</button>
        <button type="button" class="skip-link" id="share-link">공유하기</button>
      </div>
    `;
    bindBack(() => navigate("/"));
    document.getElementById("join-cta").addEventListener("click", () => {
      if (event.status === "confirmed") navigate(`/e/${eventPageState.eventId}/result`);
      else renderJoinForm();
    });
    document.getElementById("share-link").addEventListener("click", () => shareEvent(event));
  }

  function shareEvent(event) {
    const url = `${location.origin}/e/${eventPageState.eventId}`;
    const text = eventShareText(event);
    openShareSheet({
      title: `모이자고 · ${event.name}`,
      text,
      url,
      imageUrl: `${location.origin}${BRAND_ICON}`,
      fileName: `${sanitizeFilename(event.name)}.png`,
      filePromise: () => renderEventShareImage(event),
    });
  }

  async function renderEventShareImage(event) {
    const SIZE = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#fff7ed";
    ctx.fillRect(0, 0, SIZE, 360);

    ctx.fillStyle = "#F2664A";
    ctx.font = "bold 34px sans-serif";
    ctx.fillText("MOIZA-GO", 72, 104);

    ctx.fillStyle = "#1E2A3B";
    ctx.font = "bold 62px sans-serif";
    ctx.fillText(event.name, 72, 190, SIZE - 144);

    ctx.fillStyle = "#8B95A1";
    ctx.font = "30px sans-serif";
    ctx.fillText("가능한 시간을 선택해주세요", 72, 250);

    const items = [
      ["예상 인원", event.expectedCount ? `${event.expectedCount}명` : "미정"],
      ["후보 날짜", eventCandidateSummary(event, 4)],
      ["후보 시간", `${event.timeStart}–${event.timeEnd}`],
      ["선택 단위", `${event.slotMinutes}분`],
    ];

    let y = 460;
    items.forEach(([label, value]) => {
      ctx.fillStyle = "#8B95A1";
      ctx.font = "bold 28px sans-serif";
      ctx.fillText(label, 72, y);
      ctx.fillStyle = "#1E2A3B";
      ctx.font = "bold 38px sans-serif";
      ctx.fillText(value, 72, y + 50, SIZE - 144);
      y += 130;
    });

    ctx.fillStyle = "#F2664A";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("링크에서 바로 응답하기", 72, SIZE - 86);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new File([blob], `${sanitizeFilename(event.name)}_초대.png`, { type: "image/png" });
  }

  function renderJoinForm() {
    const { event } = eventPageState.data;
    APP.innerHTML = `
      ${topbar(null)}
      <div class="screen">
        <h1 class="headline">누구신가요?</h1>
        <p class="sub">거주지와 희망 지역은 중간 장소 계산에만 사용되고 일정과 함께 30일 뒤 삭제돼요.</p>
        <input class="field" id="join-name" placeholder="이름" maxlength="20" style="margin-bottom:20px;" />
        <label class="label" for="join-address">거주지 (선택)</label>
        <input class="field-sm" id="join-address" placeholder="예: 홍대입구, 강남역, 잠실" style="width:100%; margin-bottom:14px;" />
        <label class="label" for="join-preferred-area">희망 지역 (선택)</label>
        <input class="field-sm" id="join-preferred-area" placeholder="예: 신촌이나 종로 선호" style="width:100%; margin-bottom:14px;" />
        <label class="label" for="join-password">비밀번호 (선택)</label>
        <input class="field-sm" id="join-password" type="password" placeholder="다시 수정하려면 설정하세요" />
      </div>
      <div class="cta-bar"><button class="cta" id="join-btn" disabled>확인</button></div>
    `;
    bindBack(renderLanding);

    const nameInput = document.getElementById("join-name");
    const btn = document.getElementById("join-btn");
    nameInput.addEventListener("input", () => (btn.disabled = !nameInput.value.trim()));
    nameInput.focus();

    btn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const password = document.getElementById("join-password").value;
      const address = document.getElementById("join-address").value.trim();
      const preferredArea = document.getElementById("join-preferred-area").value.trim();
      if (!name) return;
      btn.disabled = true;
      btn.textContent = address || preferredArea ? "위치 확인 중…" : "참여 중…";

      try {
        const { participantId } = await api("POST", `/events/${eventPageState.eventId}/join`, { name, password, address, preferredArea });
        localStorage.setItem(participantStorageKey(eventPageState.eventId), JSON.stringify({ participantId, name }));
        eventPageState.data = await api("GET", `/events/${eventPageState.eventId}`);
        eventPageState.myParticipantId = participantId;
        eventPageState.myName = name;
        const total = eventPageState.data.grid.total;
        const existing = eventPageState.data.participants.find((p) => p.participantId === participantId);
        eventPageState.mySlots = existing ? [...existing.slots] : new Array(total).fill(0);
        renderGridScreen();
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
        btn.textContent = "확인";
      }
    });
  }

  function renderExpired() {
    APP.innerHTML = `
      ${topbar(null)}
      <div class="screen">
        <div class="empty-state">
          <div class="venn-spinner"><span></span><span></span><span></span></div>
          <p style="font-weight:700; color:var(--navy); margin-bottom:6px;">기간이 지나 삭제된 일정이에요</p>
          <p class="sub">모이자고는 생성 30일 후 자동으로 데이터를 삭제해요</p>
        </div>
      </div>
      <div class="cta-bar"><button class="cta" id="new-btn">새 일정 만들기</button></div>
    `;
    bindBack(() => navigate("/"));
    document.getElementById("new-btn").addEventListener("click", () => {
      resetCreateState();
      navigate("/create");
    });
  }

  // --- Grid screen (S10 my time / S11 group heatmap) ---

  function slotIndex(grid, colIndex, rowIndex) {
    return colIndex * grid.perDay + rowIndex;
  }

  function visibleColumnCount() {
    return eventPageState.activeTab === "group" ? eventPageState.data.grid.columns.length : 3;
  }

  function clampActiveDateIndex(grid) {
    const count = visibleColumnCount();
    const maxStart = Math.max(0, grid.columns.length - count);
    eventPageState.activeDateIndex = Math.min(Math.max(0, eventPageState.activeDateIndex), maxStart);
  }

  function visibleColumnIndexes(grid) {
    clampActiveDateIndex(grid);
    const count = visibleColumnCount();
    return grid.columns.slice(eventPageState.activeDateIndex, eventPageState.activeDateIndex + count).map((_, i) => eventPageState.activeDateIndex + i);
  }

  function compactDateLabel(label) {
    return String(label || "").replace(/\s+/g, "").replace(/^\d+\//, "");
  }

  function heatLevel(count, total) {
    if (total <= 0 || count <= 0) return 0;
    const ratio = count / total;
    if (ratio >= 1) return 4;
    if (ratio >= 0.75) return 3;
    if (ratio >= 0.5) return 2;
    return 1;
  }

  function renderPlaceCard({ compact = false } = {}) {
    const recommendation = eventPageState.data.placeRecommendation;
    const suggestions = eventPageState.data.placeSuggestions || [];
    const peopleWithArea = (eventPageState.data.participants || []).filter((p) => p.hasLocation).length;
    const canSuggestPlace = eventPageState.data.event?.status !== "confirmed";

    return `
      <section class="place-card ${compact ? "compact" : ""}">
        <div class="place-card-head">
          <div>
            <div class="place-eyebrow">장소 추천</div>
            <h2>${escapeHtml(recommendation?.area || "장소 정보 입력 대기")}</h2>
          </div>
          ${canSuggestPlace ? `<button class="mini-btn" id="${compact ? "result-place-add" : "place-add"}">추천하기</button>` : ""}
        </div>
        <p>${escapeHtml(recommendation?.reason || "참여자의 거주지와 희망 지역을 바탕으로 중간 지점을 추천해요.")}</p>
        ${
          recommendation?.suggestions?.length
            ? `<div class="place-chip-row">${recommendation.suggestions.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
            : ""
        }
        <div class="place-meta">${peopleWithArea}명이 지역 정보를 입력했어요 · ${suggestions.length}개 장소 추천</div>
        ${recommendation?.unresolvedCount ? `<div class="place-warning">좌표를 찾지 못한 입력 ${recommendation.unresolvedCount}개는 계산에서 제외됐어요.</div>` : ""}
        ${
          suggestions.length
            ? `<div class="place-list">
                ${suggestions
                  .slice(0, compact ? 3 : 6)
                  .map(
                    (place) => `
                    <div class="place-item">
                      <strong>${escapeHtml(place.name || place.area)}</strong>
                      <span>${escapeHtml([place.area, place.participantName ? `${place.participantName} 추천` : ""].filter(Boolean).join(" · "))}</span>
                      ${place.note ? `<p>${escapeHtml(place.note)}</p>` : ""}
                    </div>
                  `,
                  )
                  .join("")}
              </div>`
            : ""
        }
        ${recommendation?.usesOpenStreetMap ? `<div class="map-credit">지도 데이터 © OpenStreetMap contributors</div>` : ""}
      </section>
    `;
  }

  function bindPlaceButtons() {
    ["place-add", "result-place-add"].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.addEventListener("click", openPlaceSheet);
    });
  }

  function openPlaceSheet() {
    openSheet(
      `
      <div class="sheet-title">장소 추천하기</div>
      <p class="sheet-desc">모임에 어울리는 지역이나 장소를 남겨주세요.</p>
      <label class="label" for="place-name">장소명</label>
      <input class="field-sm" id="place-name" placeholder="예: 성수역 근처 식당" style="width:100%; margin-bottom:12px;" />
      <label class="label" for="place-area">지역</label>
      <input class="field-sm" id="place-area" placeholder="예: 성수, 종로, 강남" style="width:100%; margin-bottom:12px;" />
      <label class="label" for="place-note">메모</label>
      <textarea class="share-textarea short" id="place-note" placeholder="교통, 분위기, 추천 이유를 적어주세요."></textarea>
      <button class="cta" id="place-save">추천 남기기</button>
    `,
      () => {
        document.getElementById("place-save").addEventListener("click", async () => {
          const name = document.getElementById("place-name").value.trim();
          const area = document.getElementById("place-area").value.trim();
          const note = document.getElementById("place-note").value.trim();
          if (!name && !area) return showToast("장소명이나 지역을 입력해주세요");

          try {
            await api("POST", `/events/${eventPageState.eventId}/places`, {
              participantId: eventPageState.myParticipantId,
              participantName: eventPageState.myName,
              name,
              area,
              note,
            });
            const data = await api("GET", `/events/${eventPageState.eventId}`);
            eventPageState.data = data;
            closeSheet();
            showToast("장소 추천이 저장됐어요");
            if (location.pathname.endsWith("/result")) renderResult(eventPageState.eventId);
            else renderGridScreen();
          } catch (err) {
            showToast(err.message);
          }
        });
      },
    );
  }

  function openConfirmSheet() {
    const { bestTimes = [], placeRecommendation, placeSuggestions = [] } = eventPageState.data;
    if (!bestTimes.length) return showToast("가능 시간이 입력된 뒤 확정할 수 있어요");

    const defaultPlaceName = "";
    const defaultPlaceArea = placeRecommendation?.area || "";
    openSheet(
      `
      <div class="sheet-title">일정 확정하기</div>
      <p class="sheet-desc">확정하면 더 이상 참여 시간을 수정할 수 없어요.</p>
      <label class="label" for="confirm-time">확정 시간</label>
      <select class="field-sm confirm-select" id="confirm-time">
        ${bestTimes.map((time, index) => `<option value="${index}">${escapeHtml(`${time.date} ${time.startLabel}–${time.endLabel} · ${time.count}/${time.total}명`)}</option>`).join("")}
      </select>
      <label class="label" for="confirm-place-preset">장소 추천 불러오기</label>
      <select class="field-sm confirm-select" id="confirm-place-preset">
        <option value="auto">자동 추천 · ${escapeHtml(placeRecommendation?.area || "미정")}</option>
        ${placeSuggestions.map((place, index) => `<option value="${index}">${escapeHtml(place.name || place.area)}${place.participantName ? ` · ${escapeHtml(place.participantName)} 추천` : ""}</option>`).join("")}
      </select>
      <label class="label" for="confirm-place-name">장소명</label>
      <input class="field-sm" id="confirm-place-name" value="${escapeHtml(defaultPlaceName)}" placeholder="예: 청춘산장" />
      <label class="label" for="confirm-place-area">지역</label>
      <input class="field-sm" id="confirm-place-area" value="${escapeHtml(defaultPlaceArea)}" placeholder="예: 북한산우이역" />
      <button class="cta" id="confirm-save">이 일정으로 확정</button>
    `,
      () => {
        const preset = document.getElementById("confirm-place-preset");
        const nameInput = document.getElementById("confirm-place-name");
        const areaInput = document.getElementById("confirm-place-area");
        preset.addEventListener("change", () => {
          if (preset.value === "auto") {
            nameInput.value = "";
            areaInput.value = placeRecommendation?.area || "";
            return;
          }
          const place = placeSuggestions[Number(preset.value)];
          nameInput.value = place?.name || "";
          areaInput.value = place?.area || "";
        });

        document.getElementById("confirm-save").addEventListener("click", async () => {
          const button = document.getElementById("confirm-save");
          const time = bestTimes[Number(document.getElementById("confirm-time").value)];
          button.disabled = true;
          button.textContent = "확정 중…";
          try {
            await flushAvailability();
            await api("POST", `/events/${eventPageState.eventId}/confirm`, {
              ownerToken: eventPageState.ownerToken,
              date: time.dateKey,
              startLabel: time.startLabel,
              endLabel: time.endLabel,
              placeName: nameInput.value.trim(),
              placeArea: areaInput.value.trim(),
            });
            closeSheet();
            navigate(`/e/${eventPageState.eventId}/result`);
          } catch (err) {
            showToast(err.message);
            button.disabled = false;
            button.textContent = "이 일정으로 확정";
          }
        });
      },
    );
  }

  function renderGridScreen() {
    stopPolling();
    const { event, grid } = eventPageState.data;
    clampActiveDateIndex(grid);

    APP.innerHTML = `
      ${topbar(null)}
      <div class="screen" style="padding-bottom:8px;">
        <h1 class="headline" style="font-size:20px; margin-bottom:2px;">${escapeHtml(event.name)}</h1>
        <p class="sub" style="margin-bottom:14px;">${
          eventPageState.activeTab === "group"
            ? "모두의 시간을 한눈에 확인하세요"
            : `${escapeHtml(eventPageState.myName)}님, 가능한 시간을 칠해주세요`
        }</p>
        <div class="segmented">
          <button class="${eventPageState.activeTab === "mine" ? "active" : ""}" data-tab="mine" aria-pressed="${eventPageState.activeTab === "mine"}">내 시간</button>
          <button class="${eventPageState.activeTab === "group" ? "active" : ""}" data-tab="group" aria-pressed="${eventPageState.activeTab === "group"}">모두의 시간</button>
        </div>
        ${
          eventPageState.activeTab === "mine"
            ? `<div class="grid-tabs" id="date-tabs">
                ${grid.columns.map((c, i) => `<button class="${i >= eventPageState.activeDateIndex && i < eventPageState.activeDateIndex + visibleColumnCount() ? "active" : ""}" data-col="${i}" aria-pressed="${i >= eventPageState.activeDateIndex && i < eventPageState.activeDateIndex + visibleColumnCount()}">${c.label}</button>`).join("")}
              </div>`
            : `<div class="grid-summary">${grid.columns.length}일 전체 집계 · ${event.timeStart}–${event.timeEnd}</div>`
        }
        <div id="grid-container"></div>
        ${renderPlaceCard()}
      </div>
      <div class="cta-bar grid-cta">
        ${eventPageState.ownerToken && eventPageState.activeTab === "group" && event.status !== "confirmed" ? `<button class="cta" id="confirm-btn">일정 확정하기</button>` : ""}
        <button class="cta ghost" id="share-btn">공유하기</button>
      </div>
    `;
    bindBack(async () => {
      await flushAvailability();
      stopPolling();
      renderLanding();
    });

    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.tab === "group") await flushAvailability();
        eventPageState.activeTab = btn.dataset.tab;
        clampActiveDateIndex(eventPageState.data.grid);
        if (eventPageState.activeTab === "group") refreshAndRenderGrid(true);
        else renderGridScreen();
      });
    });

    document.querySelectorAll("#date-tabs [data-col]").forEach((btn) => {
      btn.addEventListener("click", () => {
        eventPageState.activeDateIndex = Number(btn.dataset.col);
        clampActiveDateIndex(eventPageState.data.grid);
        renderGridBody();
        document.querySelectorAll("#date-tabs [data-col]").forEach((b) => {
          const col = Number(b.dataset.col);
          b.classList.toggle("active", col >= eventPageState.activeDateIndex && col < eventPageState.activeDateIndex + visibleColumnCount());
          b.setAttribute("aria-pressed", String(col >= eventPageState.activeDateIndex && col < eventPageState.activeDateIndex + visibleColumnCount()));
        });
      });
    });

    document.getElementById("share-btn").addEventListener("click", () => shareEvent(event));
    const confirmButton = document.getElementById("confirm-btn");
    if (confirmButton) confirmButton.addEventListener("click", openConfirmSheet);
    bindPlaceButtons();

    renderGridBody();
    if (eventPageState.activeTab === "group") startPolling();
  }

  function renderGridBody() {
    const container = document.getElementById("grid-container");
    if (!container) return;
    const { grid, participants } = eventPageState.data;
    const columnIndexes = visibleColumnIndexes(grid);
    const gridStyle = `--visible-days:${columnIndexes.length}`;
    const headerClass = eventPageState.activeTab === "group" ? "slot-header group-overview-header" : "slot-header";
    const header = `
      <div class="${headerClass}" style="${gridStyle}">
        <div class="slot-time" aria-hidden="true"></div>
        ${columnIndexes.map((colIndex) => `<div class="slot-date">${eventPageState.activeTab === "group" ? compactDateLabel(grid.columns[colIndex].label) : grid.columns[colIndex].label}</div>`).join("")}
      </div>
    `;

    if (eventPageState.activeTab === "mine") {
      container.innerHTML = `
        ${header}
        <div class="slot-grid multi-day-grid" id="my-grid" style="${gridStyle}">
          ${grid.rows
            .map(
              (row) => `
            <div class="slot-row">
              <div class="slot-time">${row.label}</div>
              ${columnIndexes
                .map((colIndex) => {
                  const active = Boolean(eventPageState.mySlots[slotIndex(grid, colIndex, row.index)]);
                  return `<button type="button" class="slot-cell ${active ? "active" : ""}" data-col="${colIndex}" data-row="${row.index}" aria-label="${escapeHtml(`${grid.columns[colIndex].label} ${row.label}`)}" aria-pressed="${active}"></button>`;
                })
                .join("")}
            </div>
          `,
            )
            .join("")}
        </div>
      `;
      attachMyGridDrag();
      return;
    }

    // Group heatmap
    const total = participants.length;
    const best = eventPageState.data.bestTimes || [];

    container.innerHTML = `
      ${
        best.length
          ? `<div class="best-card">
              <div class="title">✨ 가장 많이 겹치는 시간</div>
              ${best
                .map(
                  (b, i) => `
                <div class="best-item">
                  <div class="info"><span class="rank">${i + 1}</span><span class="datetime">${escapeHtml(b.date)} ${b.startLabel}–${b.endLabel}</span></div>
                  <span class="count">${b.count}/${b.total}</span>
                </div>
              `,
                )
                .join("")}
            </div>`
          : ""
      }
      <div class="grid-legend">
        <span>0명</span>
        <div class="legend-scale"><span style="background:var(--surface)"></span><span style="background:#fbdcd4"></span><span style="background:#f7b3a3"></span><span style="background:#f28a72"></span><span style="background:var(--heart)"></span></div>
        <span>${total}명</span>
      </div>
      ${header}
      <div class="slot-grid multi-day-grid group-overview-grid" id="group-grid" style="${gridStyle}">
        ${grid.rows
          .map(
            (row) => `
            <div class="slot-row">
              <div class="slot-time">${row.label}</div>
              ${columnIndexes
                .map((colIndex) => {
                  const idx = slotIndex(grid, colIndex, row.index);
                  const count = participants.filter((p) => p.slots[idx]).length;
                  return `<button type="button" class="slot-cell heat-${heatLevel(count, total)}" data-col="${colIndex}" data-row="${row.index}" data-count="${count}" aria-label="${escapeHtml(`${grid.columns[colIndex].label} ${row.label}, ${count}명 가능`)}">${count || ""}</button>`;
                })
                .join("")}
            </div>
          `,
          )
          .join("")}
      </div>
    `;

    document.querySelectorAll("#group-grid .slot-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const rowIndex = Number(cell.dataset.row);
        const colIndex = Number(cell.dataset.col);
        const idx = slotIndex(grid, colIndex, rowIndex);
        const available = participants.filter((p) => p.slots[idx]);
        const unavailable = participants.filter((p) => !p.slots[idx]);
        openSheet(`
          <div class="sheet-title">${grid.columns[colIndex].label} ${grid.rows[rowIndex].label}</div>
          <div class="attendee-list">
            ${available.map((p) => `<div class="attendee-row"><span class="dot yes"></span>${escapeHtml(p.name)}</div>`).join("")}
            ${unavailable.map((p) => `<div class="attendee-row"><span class="dot no"></span>${escapeHtml(p.name)}</div>`).join("")}
          </div>
        `);
      });
    });
  }

  function attachMyGridDrag() {
    const grid = document.getElementById("my-grid");
    if (!grid) return;
    let touched = false;

    attachDragPaint(grid, ".slot-cell", {
      isActive: (cell) => cell.classList.contains("active"),
      onPaint: (cell, value) => {
        const rowIndex = Number(cell.dataset.row);
        const colIndex = Number(cell.dataset.col);
        const idx = slotIndex(eventPageState.data.grid, colIndex, rowIndex);
        eventPageState.mySlots[idx] = value ? 1 : 0;
        cell.classList.toggle("active", value);
        cell.setAttribute("aria-pressed", String(value));
        touched = true;
      },
      onCommit: () => {
        if (touched) persistAvailability();
        touched = false;
      },
    });

    grid.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      const cell = event.target.closest(".slot-cell");
      if (!cell) return;
      const rowIndex = Number(cell.dataset.row);
      const colIndex = Number(cell.dataset.col);
      const idx = slotIndex(eventPageState.data.grid, colIndex, rowIndex);
      const value = !eventPageState.mySlots[idx];
      eventPageState.mySlots[idx] = value ? 1 : 0;
      cell.classList.toggle("active", value);
      cell.setAttribute("aria-pressed", String(value));
      persistAvailability();
    });
  }

  let saveTimer = null;
  let pendingSlots = null;
  let saveWorker = null;

  function persistAvailability() {
    pendingSlots = [...eventPageState.mySlots];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => runAvailabilitySave(), 250);
  }

  async function runAvailabilitySave() {
    if (saveWorker || !pendingSlots) return saveWorker;
    saveWorker = (async () => {
      try {
        while (pendingSlots) {
          const slots = pendingSlots;
          pendingSlots = null;
          await api("PUT", `/events/${eventPageState.eventId}/availability`, {
            participantId: eventPageState.myParticipantId,
            slots,
          });
        }
        showToast("저장됐어요");
      } catch {
        showToast("저장에 실패했어요. 다시 시도해주세요");
      } finally {
        saveWorker = null;
        if (pendingSlots) runAvailabilitySave();
      }
    })();
    return saveWorker;
  }

  async function flushAvailability() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (pendingSlots) await runAvailabilitySave();
    if (saveWorker) await saveWorker;
  }

  async function refreshAndRenderGrid(forceGroupTab) {
    try {
      const data = await api("GET", `/events/${eventPageState.eventId}`);
      eventPageState.data = data;
      if (forceGroupTab) eventPageState.activeTab = "group";
      renderGridScreen();
    } catch {
      /* keep last known state on transient failure */
    }
  }

  function startPolling() {
    stopPolling();
    eventPageState.pollTimer = setInterval(async () => {
      if (eventPageState.activeTab !== "group") return;
      try {
        const data = await api("GET", `/events/${eventPageState.eventId}`);
        eventPageState.data = data;
        renderGridBody();
      } catch {
        /* ignore transient poll errors */
      }
    }, 10000);
  }

  function stopPolling() {
    if (eventPageState.pollTimer) clearInterval(eventPageState.pollTimer);
    eventPageState.pollTimer = null;
  }

  // ---------------------------------------------------------------------
  // Result page (S12)
  // ---------------------------------------------------------------------

  async function renderResult(eventId) {
    APP.innerHTML = `<div class="screen"><div class="empty-state"><div class="venn-spinner"><span></span><span></span><span></span></div>불러오는 중이에요…</div></div>`;

    let data;
    try {
      data = await api("GET", `/events/${eventId}`);
    } catch {
      return renderExpired();
    }

    const { event, participants, bestTimes } = data;
    eventPageState.eventId = eventId;
    eventPageState.data = data;
    eventPageState.ownerToken = localStorage.getItem(ownerStorageKey(eventId));
    const resultUrl = `${location.origin}/e/${eventId}/result`;
    const confirmed = event.status === "confirmed" && event.confirmation;
    const confirmedDate = confirmed
      ? data.grid.columns.find((column) => column.key === event.confirmation.date)?.label || event.confirmation.date
      : "";
    const responseLabel = event.expectedCount ? `${participants.length}/${event.expectedCount}명 응답` : `${participants.length}명 응답`;

    APP.innerHTML = `
      ${topbar(null)}
      <div class="screen">
        <h1 class="headline">${escapeHtml(event.name)}<br/>${confirmed ? "일정이 확정됐어요" : "현재 집계예요"}</h1>
        <p class="sub">${responseLabel}</p>
        ${
          confirmed
            ? `<section class="confirmed-card">
                <div class="confirmed-label">확정 일정</div>
                <strong>${escapeHtml(confirmedDate)} ${event.confirmation.startLabel}–${event.confirmation.endLabel}</strong>
                ${event.confirmation.placeName || event.confirmation.placeArea ? `<span>${escapeHtml([event.confirmation.placeName, event.confirmation.placeArea].filter(Boolean).join(" · "))}</span>` : ""}
              </section>`
            : `<div class="status-notice">아직 확정 전이에요. 현재 응답을 기준으로 보여드려요.</div>`
        }
        ${
          bestTimes.length
            ? `<div class="best-card">
                <div class="title">${confirmed ? "응답 집계" : "가장 많이 겹치는 시간"}</div>
                ${bestTimes
                  .map(
                    (b, i) => `
                  <div class="best-item">
                    <div class="info"><span class="rank">${i + 1}</span><span class="datetime">${escapeHtml(b.date)} ${b.startLabel}–${b.endLabel}</span></div>
                    <span class="count">${b.count}/${b.total}</span>
                  </div>
                `,
                  )
                  .join("")}
              </div>`
            : `<p class="sub">아직 겹치는 시간이 없어요</p>`
        }
        <label class="label">참여자</label>
        <div class="attendee-list">
          ${participants.map((p) => `<div class="attendee-row"><span class="dot yes"></span>${escapeHtml(p.name)}</div>`).join("")}
        </div>
        ${renderPlaceCard({ compact: true })}
        ${confirmed && data.invitationImage ? `<div class="result-invitation-preview"><img src="${data.invitationImage}" alt="확정 일정 공유 이미지" /></div>` : ""}
      </div>
      <div class="cta-bar result-actions">
        ${
          confirmed && eventPageState.ownerToken
            ? `<button class="cta ghost" id="draw-invitation-btn">${data.invitationImage ? "공유 이미지 다시 그리기" : "공유 이미지 그리기"}</button>`
            : ""
        }
        <button class="cta" id="share-text-btn">${confirmed ? "확정 일정 공유하기" : "현재 집계 공유하기"}</button>
      </div>
    `;
    bindBack(() => navigate(`/e/${eventId}?manage=1`));

    const drawInvitationButton = document.getElementById("draw-invitation-btn");
    if (drawInvitationButton) {
      drawInvitationButton.addEventListener("click", () => {
        openInvitationCanvas({
          initialImage: data.invitationImage,
          onSave: async (imageDataUrl) => {
            await api("PUT", `/events/${eventId}/invitation`, {
              ownerToken: eventPageState.ownerToken,
              imageDataUrl,
            });
            showToast("공유 이미지를 저장했어요");
            await renderResult(eventId);
          },
        });
      });
    }

    document.getElementById("share-text-btn").addEventListener("click", () => {
      const top = bestTimes[0];
      const summary = top ? `${top.date} ${top.startLabel}–${top.endLabel} (${top.count}/${top.total}명)` : "아직 겹치는 시간이 없어요";
      const suggestedPlaces = (data.placeSuggestions || [])
        .slice(0, 2)
        .map((place) => place.name || place.area)
        .filter(Boolean)
        .join(", ");
      const text = confirmed
        ? `"${event.name}" 일정이 확정됐어요.\n확정 시간: ${confirmedDate} ${event.confirmation.startLabel}–${event.confirmation.endLabel}${
            event.confirmation.placeName || event.confirmation.placeArea
              ? `\n확정 장소: ${[event.confirmation.placeName, event.confirmation.placeArea].filter(Boolean).join(" · ")}`
              : ""
          }`
        : `"${event.name}" 현재 집계예요.\n가장 많이 겹치는 시간: ${summary}${
            data.placeRecommendation?.area && data.placeRecommendation.area !== "장소 정보 입력 대기"
              ? `\n중간지점 추천: ${data.placeRecommendation.area}`
              : ""
          }${suggestedPlaces ? `\n참여자 장소 추천: ${suggestedPlaces}` : ""}`;
      openShareSheet({
        title: `모이자고 · ${event.name} ${confirmed ? "확정 일정" : "현재 집계"}`,
        text,
        url: resultUrl,
        filePromise: () =>
          confirmed && data.invitationImage
            ? dataUrlToFile(data.invitationImage, `${sanitizeFilename(event.name)}_확정일정.webp`)
            : renderResultImage(
                event,
                confirmed
                  ? [
                      {
                        date: confirmedDate,
                        startLabel: event.confirmation.startLabel,
                        endLabel: event.confirmation.endLabel,
                        count: participants.length,
                        total: participants.length,
                      },
                    ]
                  : bestTimes,
              ),
        primaryButtonTitle: confirmed ? "확정 일정 보기" : "현재 집계 보기",
      });
    });
    bindPlaceButtons();
  }

  async function dataUrlToFile(dataUrl, fileName) {
    const blob = await fetch(dataUrl).then((response) => response.blob());
    return new File([blob], fileName, { type: blob.type || "image/webp" });
  }

  async function renderResultImage(event, bestTimes) {
    const SIZE = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#1E2A3B";
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 56px sans-serif";
    ctx.fillText(event.name, 60, 140, SIZE - 120);

    ctx.fillStyle = "#F2664A";
    ctx.font = "bold 32px sans-serif";
    ctx.fillText("일정 조율 결과", 60, 200);

    let y = 320;
    bestTimes.slice(0, 3).forEach((b, i) => {
      ctx.fillStyle = "#F2664A";
      ctx.beginPath();
      ctx.arc(90, y - 12, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1E2A3B";
      ctx.font = "bold 26px sans-serif";
      ctx.fillText(String(i + 1), 80, y - 3);

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 34px sans-serif";
      ctx.fillText(`${b.date} ${b.startLabel}–${b.endLabel}`, 140, y);
      ctx.fillStyle = "#8B95A1";
      ctx.font = "28px sans-serif";
      ctx.fillText(`${b.count}/${b.total}명 가능`, 140, y + 40);
      y += 110;
    });

    ctx.fillStyle = "#8B95A1";
    ctx.font = "24px sans-serif";
    ctx.fillText("모이자고 (MOIZA-GO)", 60, SIZE - 60);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new File([blob], `${sanitizeFilename(event.name)}_결과.png`, { type: "image/png" });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  render();
})();
