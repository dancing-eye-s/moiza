(() => {
  "use strict";

  const APP = document.getElementById("app");
  const SHEET_ROOT = document.getElementById("sheet-root");
  const TOAST_ROOT = document.getElementById("toast-root");
  const BRAND_ICON = "assets/moiza/moiza_icon_venn.png";
  const BRAND_WORDMARK = "assets/moiza/moiza_wordmark.png";

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
        .replace(/[\/\\:*?"<>|]/g, "") || "moiza"
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
      <div class="bottom-sheet" id="bottom-sheet">
        <div class="sheet-handle"></div>
        ${innerHtml}
      </div>
    `;
    requestAnimationFrame(() => {
      document.getElementById("sheet-backdrop").classList.add("show");
      document.getElementById("bottom-sheet").classList.add("show");
    });
    document.getElementById("sheet-backdrop").addEventListener("click", closeSheet);
    if (onMount) onMount();
  }

  // ---------------------------------------------------------------------
  // Share sheet (feature 1)
  // ---------------------------------------------------------------------

  function openShareSheet({ title, text, url, imageUrl, filePromise, fileName }) {
    const kakaoAvailable = Boolean(window.Kakao && window.Kakao.isInitialized && window.Kakao.isInitialized());

    openSheet(
      `
      <div class="sheet-title">공유하기</div>
      <div class="share-option" id="share-copy">
        <div class="icon">🔗</div>
        <div class="text">링크 복사</div>
      </div>
      ${
        kakaoAvailable
          ? `<div class="share-option" id="share-kakao"><div class="icon">💬</div><div class="text">카카오톡으로 공유</div></div>`
          : ""
      }
      <div class="share-option" id="share-native">
        <div class="icon">📤</div>
        <div class="text">다른 앱으로 공유</div>
      </div>
    `,
      () => {
        document.getElementById("share-copy").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(`${text}\n${url}`);
            showToast("링크가 복사됐어요");
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
                description: text,
                imageUrl: imageUrl || `${location.origin}/${BRAND_ICON}`,
                link: { webUrl: url, mobileWebUrl: url },
              },
              buttons: [{ title: "시간 선택하러 가기", link: { webUrl: url, mobileWebUrl: url } }],
            });
            closeSheet();
          });
        }

        document.getElementById("share-native").addEventListener("click", async () => {
          closeSheet();
          const shareData = { title, text: `${text}\n${url}`, url };

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
            await navigator.clipboard.writeText(`${text}\n${url}`);
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
          <img class="home-wordmark" src="${BRAND_WORDMARK}" alt="MOIZA" />
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

        <div class="home-flow" aria-label="모이자 사용 흐름">
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
    deadlineAt: "",
    notifyEmail: "",
    invitationImage: null,
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
    createState.deadlineAt = "";
    createState.notifyEmail = "";
    createState.invitationImage = null;
  }

  function renderCreate() {
    renderCreateStep();
  }

  function topbar(progressPct, onBack) {
    return `
      <div class="topbar">
        <button class="back" id="back-btn">←</button>
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
    if (step === 5) return renderCreateStep5();
  }

  function renderCreateStep1() {
    APP.innerHTML = `
      ${topbar(16)}
      <div class="screen">
        <h1 class="headline">모임 이름이<br/>뭐예요?</h1>
        <p class="sub">공유할 때 함께 보여질 기본 정보예요</p>
        <label class="label">모임 이름</label>
        <input class="field" id="name-input" placeholder="예: 7월 팀 회식" maxlength="50" value="${escapeHtml(createState.name)}" />
        <label class="label" style="margin-top:22px;">예상 인원</label>
        <input class="field-sm" id="expected-count-input" type="number" inputmode="numeric" min="1" max="999" placeholder="예: 6" value="${escapeHtml(createState.expectedCount)}" />
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
    for (let i = 0; i < firstDow; i += 1) cells += `<div class="day disabled"></div>`;
    for (let d = 1; d <= totalDays; d += 1) {
      const dateObj = new Date(year, mIndex, d);
      const key = `${year}-${pad2(mIndex + 1)}-${pad2(d)}`;
      const isPast = dateObj < today;
      const selected = createState.dates.has(key);
      cells += `<div class="day ${isPast ? "disabled" : ""} ${selected ? "selected" : ""}" data-date="${key}">${d}</div>`;
    }

    return `
      <div class="calendar">
        <div class="calendar-head">
          <button id="cal-prev">‹</button>
          <span>${year}년 ${mIndex + 1}월</span>
          <button id="cal-next">›</button>
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
          <button class="${isDates ? "active" : ""}" data-mode="dates">특정 날짜</button>
          <button class="${!isDates ? "active" : ""}" data-mode="days">요일로 정하기</button>
        </div>
        ${isDates ? renderCalendar() : `<div class="chip-row" id="day-chips">${DAY_KEYS.map((k) => `<div class="chip ${createState.days.has(k) ? "active" : ""}" data-day="${k}">${DAY_LABELS[k]}</div>`).join("")}</div>`}
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
          <select id="time-start">${TIME_OPTIONS.slice(0, 24)
            .map((t) => `<option value="${t}" ${t === createState.timeStart ? "selected" : ""}>${t}</option>`)
            .join("")}</select>
          <span style="color:var(--navy-soft)">부터</span>
        </div>
        <div class="time-row">
          <select id="time-end">${TIME_OPTIONS.slice(1)
            .map((t) => `<option value="${t}" ${t === createState.timeEnd ? "selected" : ""}>${t}</option>`)
            .join("")}</select>
          <span style="color:var(--navy-soft)">까지</span>
        </div>
        <label class="label" style="margin-top:12px;">선택 단위</label>
        <div class="chip-row">
          ${[15, 30, 60]
            .map((m) => `<div class="chip ${createState.slotMinutes === m ? "active" : ""}" data-slot="${m}">${m}분</div>`)
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
        document.querySelectorAll("[data-slot]").forEach((c) => c.classList.toggle("active", c === chip));
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
    APP.innerHTML = `
      ${topbar(64)}
      <div class="screen">
        <h1 class="headline">마감일을<br/>정해둘까요?</h1>
        <p class="sub">마감되면 결과를 이메일로 보내드려요</p>
        <div class="toggle-row">
          <div>
            <div class="title">조율 마감 설정</div>
            <div class="desc">선택 사항이에요</div>
          </div>
          <div class="switch ${createState.deadlineEnabled ? "on" : ""}" id="deadline-switch"><div class="knob"></div></div>
        </div>
        <div id="deadline-fields" style="display:${createState.deadlineEnabled ? "block" : "none"}">
          <label class="label">마감 일시</label>
          <input class="field-sm" type="datetime-local" id="deadline-at" value="${createState.deadlineAt}" style="margin-bottom:16px;" />
          <label class="label">결과 받을 이메일</label>
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
      fields.style.display = createState.deadlineEnabled ? "block" : "none";
    });
    document.getElementById("deadline-at").addEventListener("input", (e) => (createState.deadlineAt = e.target.value));
    document.getElementById("notify-email").addEventListener("input", (e) => (createState.notifyEmail = e.target.value));

    document.getElementById("next-btn").addEventListener("click", () => {
      if (createState.deadlineEnabled && (!createState.deadlineAt || !createState.notifyEmail)) {
        showToast("마감 일시와 이메일을 모두 입력해주세요");
        return;
      }
      createState.step = 5;
      renderCreateStep();
    });
  }

  function renderCreateStep5() {
    APP.innerHTML = `
      ${topbar(82)}
      <div class="screen" style="text-align:center;">
        <h1 class="headline">초대장을<br/>직접 그려볼까요?</h1>
        <p class="sub">건너뛰어도 괜찮아요</p>
        ${
          createState.invitationImage
            ? `<div class="invitation-preview"><img src="${createState.invitationImage}" /></div>`
            : `<div class="invitation-preview" style="background:var(--surface); display:flex; align-items:center; justify-content:center; font-size:40px;">🎨</div>`
        }
      </div>
      <div class="cta-bar">
        <button class="cta" id="draw-btn">${createState.invitationImage ? "다시 그리기" : "그리기 시작"}</button>
        <div class="skip-link" id="skip-link">${createState.invitationImage ? "완료" : "나중에 할게요"}</div>
      </div>
    `;
    bindBack(() => {
      createState.step = 4;
      renderCreateStep();
    });

    document.getElementById("draw-btn").addEventListener("click", () => openInvitationCanvas());
    document.getElementById("skip-link").addEventListener("click", () => submitEvent());
  }

  async function submitEvent() {
    const btn = document.getElementById("draw-btn") || document.getElementById("next-btn");
    if (btn) btn.disabled = true;

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
        deadlineAt: createState.deadlineEnabled ? new Date(createState.deadlineAt).toISOString() : "",
        notifyEmail: createState.deadlineEnabled ? createState.notifyEmail : "",
        invitationImage: createState.invitationImage || undefined,
      };
      const { eventId } = await api("POST", "/events", payload);
      navigate(`/e/${eventId}?created=1`);
    } catch (err) {
      showToast(err.message);
      if (btn) btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Invitation canvas (S13, feature 2)
  // ---------------------------------------------------------------------

  function openInvitationCanvas() {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed; inset:0; background:#fff; z-index:200; overflow-y:auto;";
    overlay.innerHTML = `
      <div class="topbar">
        <button class="back" id="canvas-close">✕</button>
        <div class="brand">초대장 그리기</div>
      </div>
      <div class="screen">
        <div class="canvas-wrap"><canvas id="invite-canvas"></canvas></div>
        <div class="pen-tools">
          <div class="pen-color black active" data-color="#191F28"></div>
          <div class="pen-color orange" data-color="#FF9500"></div>
          <div class="pen-color green" data-color="#00C471"></div>
          <div class="spacer"></div>
          <button class="icon-btn" id="undo-btn" title="실행취소">↩︎</button>
          <button class="icon-btn" id="clear-btn" title="전체 지우기">🗑</button>
        </div>
      </div>
      <div class="cta-bar"><button class="cta" id="canvas-done">완료</button></div>
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

    function redraw() {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, SIZE, SIZE);
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
        overlay.querySelectorAll(".pen-color").forEach((s) => s.classList.toggle("active", s === swatch));
      });
    });

    overlay.querySelector("#undo-btn").addEventListener("click", () => {
      strokes.pop();
      redraw();
    });

    overlay.querySelector("#clear-btn").addEventListener("click", () => {
      if (strokes.length && !confirm("전체 지울까요?")) return;
      strokes = [];
      redraw();
    });

    overlay.querySelector("#canvas-close").addEventListener("click", () => overlay.remove());

    overlay.querySelector("#canvas-done").addEventListener("click", () => {
      createState.invitationImage = canvas.toDataURL("image/png");
      overlay.remove();
      renderCreateStep5();
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
  };

  function participantStorageKey(eventId) {
    return `moiza:participant:${eventId}`;
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
        <button class="cta" id="join-cta">시간 선택하기</button>
        <div class="skip-link" id="share-link" style="margin-top:14px;">공유하기</div>
      </div>
    `;
    bindBack(() => navigate("/"));
    document.getElementById("join-cta").addEventListener("click", renderJoinForm);
    document.getElementById("share-link").addEventListener("click", () => shareEvent(event));
  }

  function shareEvent(event) {
    const url = `${location.origin}/e/${eventPageState.eventId}`;
    const text = eventShareText(event);
    openShareSheet({
      title: `모이자 · ${event.name}`,
      text,
      url,
      imageUrl: `${location.origin}/${BRAND_ICON}`,
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
    ctx.fillText("MOIZA", 72, 104);

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
        <p class="sub">이름을 입력하고 시간을 선택해주세요</p>
        <input class="field" id="join-name" placeholder="이름" maxlength="20" style="margin-bottom:20px;" />
        <label class="label">비밀번호 (선택)</label>
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
      if (!name) return;
      btn.disabled = true;

      try {
        const { participantId } = await api("POST", `/events/${eventPageState.eventId}/join`, { name, password });
        localStorage.setItem(participantStorageKey(eventPageState.eventId), JSON.stringify({ participantId, name }));
        eventPageState.myParticipantId = participantId;
        eventPageState.myName = name;
        const total = eventPageState.data.grid.total;
        const existing = eventPageState.data.participants.find((p) => p.participantId === participantId);
        eventPageState.mySlots = existing ? [...existing.slots] : new Array(total).fill(0);
        renderGridScreen();
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
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
          <p class="sub">모이자는 생성 30일 후 자동으로 데이터를 삭제해요</p>
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
          <button class="${eventPageState.activeTab === "mine" ? "active" : ""}" data-tab="mine">내 시간</button>
          <button class="${eventPageState.activeTab === "group" ? "active" : ""}" data-tab="group">모두의 시간</button>
        </div>
        ${
          eventPageState.activeTab === "mine"
            ? `<div class="grid-tabs" id="date-tabs">
                ${grid.columns.map((c, i) => `<button class="${i >= eventPageState.activeDateIndex && i < eventPageState.activeDateIndex + visibleColumnCount() ? "active" : ""}" data-col="${i}">${c.label}</button>`).join("")}
              </div>`
            : `<div class="grid-summary">${grid.columns.length}일 전체 집계 · ${event.timeStart}–${event.timeEnd}</div>`
        }
        <div id="grid-container"></div>
      </div>
      <div class="cta-bar">
        <button class="cta ghost" id="share-btn">공유하기</button>
      </div>
    `;
    bindBack(() => {
      stopPolling();
      renderLanding();
    });

    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
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
        });
      });
    });

    document.getElementById("share-btn").addEventListener("click", () => shareEvent(event));

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
        <div class="slot-time"></div>
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
                .map((colIndex) => `<div class="slot-cell ${eventPageState.mySlots[slotIndex(grid, colIndex, row.index)] ? "active" : ""}" data-col="${colIndex}" data-row="${row.index}"></div>`)
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
                  return `<div class="slot-cell heat-${heatLevel(count, total)}" data-col="${colIndex}" data-row="${row.index}" data-count="${count}">${count || ""}</div>`;
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
        touched = true;
      },
      onCommit: () => {
        if (touched) persistAvailability();
        touched = false;
      },
    });
  }

  let saveInFlight = null;
  async function persistAvailability() {
    const eventId = eventPageState.eventId;
    const slots = [...eventPageState.mySlots];
    saveInFlight = api("PUT", `/events/${eventId}/availability`, {
      participantId: eventPageState.myParticipantId,
      slots,
    })
      .then(() => showToast("저장됐어요"))
      .catch(() => showToast("저장에 실패했어요. 다시 시도해주세요"));
    await saveInFlight;
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
    const resultUrl = `${location.origin}/e/${eventId}/result`;

    APP.innerHTML = `
      ${topbar(null)}
      <div class="screen">
        <h1 class="headline">${escapeHtml(event.name)}<br/>결과가 나왔어요</h1>
        <p class="sub">참여자 ${participants.length}명이 응답했어요</p>
        ${
          bestTimes.length
            ? `<div class="best-card">
                <div class="title">✨ 베스트 타임</div>
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
      </div>
      <div class="cta-bar">
        <button class="cta" id="share-text-btn">결과 공유하기</button>
      </div>
    `;
    bindBack(() => navigate(`/e/${eventId}`));

    document.getElementById("share-text-btn").addEventListener("click", () => {
      const top = bestTimes[0];
      const summary = top ? `${top.date} ${top.startLabel}–${top.endLabel} (${top.count}/${top.total}명)` : "아직 겹치는 시간이 없어요";
      openShareSheet({
        title: `모이자 · ${event.name} 결과`,
        text: `"${event.name}" 결과가 나왔어요! 가장 많이 겹치는 시간은 ${summary} 이에요 ✅`,
        url: resultUrl,
        filePromise: () => renderResultImage(event, bestTimes),
      });
    });
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
    ctx.fillText("모이자 (MOIZA)", 60, SIZE - 60);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new File([blob], `${sanitizeFilename(event.name)}_결과.png`, { type: "image/png" });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  render();
})();
