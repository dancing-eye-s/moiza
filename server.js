const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("./store");
const schedule = require("./schedule");
const google = require("./google");
const mailer = require("./mailer");
const geocoder = require("./geocoder");

const PORT = Number(process.env.PORT || 4175);
const ROOT = __dirname;
const rateBuckets = new Map();

loadEnvFile();

function loadEnvFile() {
  try {
    const raw = fsSync.readFileSync(path.join(ROOT, ".env"), "utf8");
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .forEach((line) => {
        const index = line.indexOf("=");
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (key && process.env[key] == null) process.env[key] = value;
      });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: { message } });
}

function applySecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function rateLimit(request, response, scope = "api", max = 120, windowMs = 60_000) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || request.socket?.remoteAddress || "unknown";
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  if (bucket.count <= max) return true;
  response.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
  sendError(response, 429, "요청이 너무 많아요. 잠시 후 다시 시도해주세요.");
  return false;
}

function isCronAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !process.env.VERCEL;
  const authorization = String(request.headers.authorization || "");
  const expected = `Bearer ${secret}`;
  if (authorization.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
}

function contentType(filePath) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml; charset=utf-8",
    }[path.extname(filePath).toLowerCase()] || "application/octet-stream"
  );
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("request-too-large"));
      }
    });
    request.on("end", () => resolve(body ? JSON.parse(body) : {}));
    request.on("error", reject);
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  // Client-side router: any non-file, non-API path serves the SPA shell.
  if (pathname === "/" || (!pathname.includes(".") && !pathname.startsWith("/api/"))) {
    pathname = "/index.html";
  }

  if (pathname.startsWith("/data/")) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function validEventInput(body) {
  if (!body.name || typeof body.name !== "string") return "일정 이름을 입력해주세요.";
  if (/[\r\n\u0000-\u001f]/.test(body.name)) return "일정 이름에 사용할 수 없는 문자가 있어요.";
  if (!["dates", "days"].includes(body.mode)) return "날짜 방식이 올바르지 않아요.";
  if (!Array.isArray(body.dates) || body.dates.length === 0) return "날짜를 하나 이상 선택해주세요.";
  if (body.dates.length > (body.mode === "days" ? 7 : 31)) return "후보 날짜가 너무 많아요.";
  if (body.mode === "dates" && body.dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(String(date)))) return "후보 날짜 형식이 올바르지 않아요.";
  if (body.mode === "days" && body.dates.some((day) => !["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].includes(day))) return "후보 요일 형식이 올바르지 않아요.";
  if (!/^\d{2}:\d{2}$/.test(body.timeStart) || !/^\d{2}:\d{2}$/.test(body.timeEnd)) return "시간 형식이 올바르지 않아요.";
  const [startHour, startMinute] = body.timeStart.split(":").map(Number);
  const [endHour, endMinute] = body.timeEnd.split(":").map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return "시간 형식이 올바르지 않아요.";
  if (body.timeStart >= body.timeEnd) return "종료 시간은 시작 시간보다 늦어야 해요.";
  if (body.expectedCount != null && body.expectedCount !== "" && (!Number.isInteger(Number(body.expectedCount)) || Number(body.expectedCount) < 1 || Number(body.expectedCount) > 999)) {
    return "예상 인원은 1명 이상으로 입력해주세요.";
  }
  if (body.notifyEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.notifyEmail)) || String(body.notifyEmail).length > 254)) return "알림 이메일 형식이 올바르지 않아요.";
  return null;
}

async function handleCreateEvent(request, response) {
  const body = await readBody(request);
  const invalidReason = validEventInput(body);
  if (invalidReason) return sendError(response, 400, invalidReason);

  const created = await store.createEvent({
    name: body.name.trim().slice(0, 50),
    mode: body.mode,
    expectedCount: body.expectedCount ? Number(body.expectedCount) : null,
    dates: body.dates,
    timeStart: body.timeStart,
    timeEnd: body.timeEnd,
    slotMinutes: [15, 30, 60].includes(body.slotMinutes) ? body.slotMinutes : 30,
    timezone: body.timezone || "Asia/Seoul",
    deadlineAt: body.deadlineAt || "",
    notifyEmail: String(body.notifyEmail || "").trim(),
  });

  sendJson(response, 200, created);
}

async function handleGetEvent(request, response, eventId) {
  const result = await store.getEvent(eventId);
  if (!result) return sendError(response, 404, "일정을 찾을 수 없어요. 삭제되었거나 잘못된 링크예요.");

  const grid = schedule.buildSlotGrid(result.event);
  const best = schedule.bestTimes(result.event, result.participants);
  const invitation = await store.getInvitation(eventId);

  const { notifyEmail, emailSent, ...publicEvent } = result.event;
  sendJson(response, 200, {
    event: publicEvent,
    grid,
    participants: result.participants.map((p) => ({
      name: p.name,
      hasLocation: Boolean(p.address || p.preferredArea),
      slots: p.slots,
      isCurrent: Boolean(request.headers["x-moiza-participant"] && p.participantId === request.headers["x-moiza-participant"]),
    })),
    bestTimes: best,
    placeRecommendation: result.placeRecommendation,
    placeSuggestions: result.placeSuggestions,
    invitationImage: invitation,
  });
}

async function handleJoin(request, response, eventId) {
  const body = await readBody(request);
  const name = String(body.name || "").trim().slice(0, 20);
  if (!name) return sendError(response, 400, "이름을 입력해주세요.");

  const event = await store.getEvent(eventId);
  if (!event) return sendError(response, 404, "일정을 찾을 수 없어요.");
  if (event.event.status === "confirmed") return sendError(response, 409, "이미 확정된 일정이에요.");

  const result = await store.joinEvent(eventId, {
    name,
    password: body.password || "",
    address: body.address || "",
    preferredArea: body.preferredArea || "",
  });
  if (result.error === "PASSWORD_MISMATCH") {
    return sendError(response, 409, "이미 사용 중인 이름이에요. 본인이라면 비밀번호를 입력해주세요.");
  }
  if (result.error === "EXISTING_PARTICIPANT_LOCKED") {
    return sendError(response, 409, "이미 사용 중인 이름이에요. 기존 기기에서 수정해주세요.");
  }

  sendJson(response, 200, { participantId: result.participantId });
}

async function handleAddPlace(request, response, eventId) {
  const body = await readBody(request);
  const event = await store.getEvent(eventId);
  if (!event) return sendError(response, 404, "일정을 찾을 수 없어요.");
  if (event.event.status === "confirmed") return sendError(response, 409, "확정된 일정에는 장소를 추가할 수 없어요.");

  const participantId = String(request.headers["x-moiza-participant"] || body.participantId || "");
  const participant = event.participants.find((item) => item.participantId === participantId);
  if (!participant) return sendError(response, 403, "참여자 확인이 필요해요.");

  const result = await store.addPlaceSuggestion(eventId, {
    participantId,
    participantName: participant.name,
    name: body.name || "",
    area: body.area || "",
    note: body.note || "",
  });

  if (result.error === "PLACE_REQUIRED") {
    return sendError(response, 400, "장소명이나 지역을 입력해주세요.");
  }

  sendJson(response, 200, { placeId: result.placeId });
}

async function handleCalculatePlaces(request, response, eventId) {
  const body = await readBody(request);
  const event = await store.getEvent(eventId);
  if (!event) return sendError(response, 404, "일정을 찾을 수 없어요.");
  if (event.event.status === "confirmed") return sendError(response, 409, "이미 확정된 일정이에요.");
  const participantId = String(request.headers["x-moiza-participant"] || "");
  if (!event.participants.some((item) => item.participantId === participantId)) return sendError(response, 403, "참여자 확인이 필요해요.");
  if (!Array.isArray(body.regions) || body.regions.length < 2 || body.regions.length > 8) return sendError(response, 400, "출발 지역을 2개 이상 8개 이하로 입력해주세요.");
  if (!rateLimit(request, response, "midpoint", 15, 60_000)) return;
  const result = await geocoder.midpointCandidates(body.regions);
  sendJson(response, 200, result);
}

async function handleSaveAvailability(request, response, eventId) {
  const body = await readBody(request);
  if (!body.participantId || !Array.isArray(body.slots)) return sendError(response, 400, "잘못된 요청이에요.");

  const full = await store.getEvent(eventId);
  if (!full) return sendError(response, 404, "일정을 찾을 수 없어요.");
  if (full.event.status === "confirmed") return sendError(response, 409, "이미 확정된 일정이에요.");
  const participantId = String(request.headers["x-moiza-participant"] || body.participantId || "");
  if (!full.participants.some((participant) => participant.participantId === participantId)) return sendError(response, 403, "참여자 확인이 필요해요.");
  const expectedSlots = schedule.buildSlotGrid(full.event).total;
  if (body.slots.length !== expectedSlots || body.slots.length > 3000) return sendError(response, 400, "시간 선택 데이터 길이가 올바르지 않아요.");

  await store.saveAvailability(eventId, participantId, body.slots.map((v) => (v ? 1 : 0)));
  sendJson(response, 200, { ok: true });
}

async function handleConfirmEvent(request, response, eventId) {
  const body = await readBody(request);
  const full = await store.getEvent(eventId);
  if (!full) return sendError(response, 404, "일정을 찾을 수 없어요.");

  const grid = schedule.buildSlotGrid(full.event);
  const date = String(body.date || "");
  const startLabel = String(body.startLabel || "");
  const endLabel = String(body.endLabel || "");
  const dateExists = grid.columns.some((column) => column.key === date);
  const startIndex = grid.rows.findIndex((row) => row.label === startLabel);
  const endMinutes = endLabel.split(":").map(Number);
  const endTotal = endMinutes.length === 2 ? endMinutes[0] * 60 + endMinutes[1] : -1;
  const eventEnd = full.event.timeEnd.split(":").map(Number);
  const eventEndTotal = eventEnd[0] * 60 + eventEnd[1];
  const startMinutes = startLabel.split(":").map(Number);
  const startTotal = startMinutes.length === 2 ? startMinutes[0] * 60 + startMinutes[1] : -1;

  if (!dateExists || startIndex < 0 || endTotal <= startTotal || endTotal > eventEndTotal) {
    return sendError(response, 400, "확정할 후보 시간이 올바르지 않아요.");
  }

  const result = await store.confirmEvent(eventId, {
    ownerToken: body.ownerToken,
    date,
    startLabel,
    endLabel,
    placeName: body.placeName || "",
    placeArea: body.placeArea || "",
  });
  if (result.error === "OWNER_TOKEN_MISMATCH") return sendError(response, 403, "일정을 만든 사람만 확정할 수 있어요.");
  if (result.error === "EVENT_NOT_FOUND") return sendError(response, 404, "일정을 찾을 수 없어요.");
  sendJson(response, 200, { ok: true });
}

async function handleSaveInvitation(request, response, eventId) {
  const body = await readBody(request);
  const imageDataUrl = String(body.imageDataUrl || "");
  if (!/^data:image\/(webp|png|jpeg);base64,/.test(imageDataUrl)) {
    return sendError(response, 400, "공유 이미지 형식이 올바르지 않아요.");
  }
  if (imageDataUrl.length > 48000) {
    return sendError(response, 413, "공유 이미지가 너무 커요. 그림을 조금 단순하게 다시 저장해주세요.");
  }

  const result = await store.saveInvitationForOwner(eventId, body.ownerToken, imageDataUrl);
  if (result.error === "OWNER_TOKEN_MISMATCH") return sendError(response, 403, "일정을 만든 사람만 공유 이미지를 저장할 수 있어요.");
  if (result.error === "EVENT_NOT_CONFIRMED") return sendError(response, 409, "일정을 확정한 뒤 공유 이미지를 만들 수 있어요.");
  if (result.error === "EVENT_NOT_FOUND") return sendError(response, 404, "일정을 찾을 수 없어요.");
  sendJson(response, 200, { ok: true });
}

async function handleCronDeadline(request, response) {
  if (!isCronAuthorized(request)) return sendError(response, 401, "인증이 필요해요.");
  const events = await store.listAllEvents();
  const now = new Date();
  let processed = 0;

  for (const event of events) {
    if (!event.deadlineAt || event.emailSent || !event.notifyEmail) continue;
    if (new Date(event.deadlineAt) > now) continue;

    const full = await store.getEvent(event.eventId);
    const best = schedule.bestTimes(full.event, full.participants);

    try {
      await mailer.sendResultEmail({
        to: event.notifyEmail,
        eventName: event.name,
        eventId: event.eventId,
        participantCount: full.participants.length,
        bestTimes: best,
      });
      await store.markEmailSent(event.eventId, true);
    } catch (err) {
      await store.markEmailSent(event.eventId, false);
      console.error(`[cron/deadline] ${event.eventId} 이메일 발송 실패:`, err.message);
    }
    processed += 1;
  }

  sendJson(response, 200, { processed });
}

async function handleCronPurge(request, response) {
  if (!isCronAuthorized(request)) return sendError(response, 401, "인증이 필요해요.");
  const events = await store.listAllEvents();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let purged = 0;

  for (const event of events) {
    if (new Date(event.createdAt).getTime() < cutoff) {
      await store.purgeEvent(event.eventId);
      purged += 1;
    }
  }

  sendJson(response, 200, { purged });
}

async function routeApi(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "events", ":id", ...]

  if (request.method !== "GET" && !rateLimit(request, response)) return;

  if (request.method === "POST" && parts[1] === "events" && parts.length === 2) {
    return handleCreateEvent(request, response);
  }
  if (request.method === "GET" && parts[1] === "events" && parts.length === 3) {
    return handleGetEvent(request, response, parts[2]);
  }
  if (request.method === "POST" && parts[1] === "events" && parts[3] === "join") {
    return handleJoin(request, response, parts[2]);
  }
  if (request.method === "PUT" && parts[1] === "events" && parts[3] === "availability") {
    return handleSaveAvailability(request, response, parts[2]);
  }
  if (request.method === "POST" && parts[1] === "events" && parts[3] === "places" && parts[4] === "calculate") {
    return handleCalculatePlaces(request, response, parts[2]);
  }
  if (request.method === "POST" && parts[1] === "events" && parts[3] === "places" && parts.length === 4) {
    return handleAddPlace(request, response, parts[2]);
  }
  if (request.method === "POST" && parts[1] === "events" && parts[3] === "confirm") {
    return handleConfirmEvent(request, response, parts[2]);
  }
  if (request.method === "PUT" && parts[1] === "events" && parts[3] === "invitation") {
    return handleSaveInvitation(request, response, parts[2]);
  }
  if (request.method === "GET" && parts[1] === "cron" && parts[2] === "deadline") {
    return handleCronDeadline(request, response);
  }
  if (request.method === "GET" && parts[1] === "cron" && parts[2] === "purge") {
    return handleCronPurge(request, response);
  }
  if (request.method === "GET" && parts[1] === "status") {
    return sendJson(response, 200, { sheetsConfigured: google.isConfigured(), mailerConfigured: mailer.isConfigured() });
  }

  sendError(response, 404, "API 경로를 찾지 못했어요.");
}

async function appHandler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  applySecurityHeaders(response);

  if (!url.pathname.startsWith("/api/")) {
    await serveStatic(request, response);
    return;
  }

  try {
    await routeApi(request, response, url);
  } catch (error) {
    if (error.message !== "request-too-large") console.error("[api]", error);
    const message = error.message === "request-too-large" ? "요청 데이터가 너무 커요." : "서버 오류가 발생했어요.";
    sendError(response, error.message === "request-too-large" ? 413 : 500, message);
  }
}

if (require.main === module) {
  const server = http.createServer(appHandler);
  server.listen(PORT, () => {
    console.log(`moiza-go: http://localhost:${PORT}`);
  });
}

module.exports = appHandler;
