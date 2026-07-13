const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const store = require("./store");
const schedule = require("./schedule");
const google = require("./google");
const mailer = require("./mailer");

const PORT = Number(process.env.PORT || 4175);
const ROOT = __dirname;

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
  if (!["dates", "days"].includes(body.mode)) return "날짜 방식이 올바르지 않아요.";
  if (!Array.isArray(body.dates) || body.dates.length === 0) return "날짜를 하나 이상 선택해주세요.";
  if (!/^\d{2}:\d{2}$/.test(body.timeStart) || !/^\d{2}:\d{2}$/.test(body.timeEnd)) return "시간 형식이 올바르지 않아요.";
  if (body.timeStart >= body.timeEnd) return "종료 시간은 시작 시간보다 늦어야 해요.";
  if (body.expectedCount != null && body.expectedCount !== "" && (!Number.isInteger(Number(body.expectedCount)) || Number(body.expectedCount) < 1 || Number(body.expectedCount) > 999)) {
    return "예상 인원은 1명 이상으로 입력해주세요.";
  }
  return null;
}

async function handleCreateEvent(request, response) {
  const body = await readBody(request);
  const invalidReason = validEventInput(body);
  if (invalidReason) return sendError(response, 400, invalidReason);

  const eventId = await store.createEvent({
    name: body.name.trim().slice(0, 50),
    mode: body.mode,
    expectedCount: body.expectedCount ? Number(body.expectedCount) : null,
    dates: body.dates,
    timeStart: body.timeStart,
    timeEnd: body.timeEnd,
    slotMinutes: [15, 30, 60].includes(body.slotMinutes) ? body.slotMinutes : 30,
    timezone: body.timezone || "Asia/Seoul",
    deadlineAt: body.deadlineAt || "",
    notifyEmail: body.notifyEmail || "",
  });

  if (body.invitationImage) {
    await store.saveInvitation(eventId, body.invitationImage);
  }

  sendJson(response, 200, { eventId });
}

async function handleGetEvent(request, response, eventId) {
  const result = await store.getEvent(eventId);
  if (!result) return sendError(response, 404, "일정을 찾을 수 없어요. 삭제되었거나 잘못된 링크예요.");

  const grid = schedule.buildSlotGrid(result.event);
  const best = schedule.bestTimes(result.event, result.participants);
  const invitation = await store.getInvitation(eventId);

  sendJson(response, 200, {
    event: result.event,
    grid,
    participants: result.participants.map((p) => ({ participantId: p.participantId, name: p.name, slots: p.slots })),
    bestTimes: best,
    invitationImage: invitation,
  });
}

async function handleJoin(request, response, eventId) {
  const body = await readBody(request);
  const name = String(body.name || "").trim().slice(0, 20);
  if (!name) return sendError(response, 400, "이름을 입력해주세요.");

  const event = await store.getEvent(eventId);
  if (!event) return sendError(response, 404, "일정을 찾을 수 없어요.");

  const result = await store.joinEvent(eventId, { name, password: body.password || "" });
  if (result.error === "PASSWORD_MISMATCH") {
    return sendError(response, 409, "이미 사용 중인 이름이에요. 본인이라면 비밀번호를 입력해주세요.");
  }

  sendJson(response, 200, { participantId: result.participantId });
}

async function handleSaveAvailability(request, response, eventId) {
  const body = await readBody(request);
  if (!body.participantId || !Array.isArray(body.slots)) return sendError(response, 400, "잘못된 요청이에요.");

  await store.saveAvailability(eventId, body.participantId, body.slots.map((v) => (v ? 1 : 0)));
  sendJson(response, 200, { ok: true });
}

async function handleCronDeadline(request, response) {
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

  if (!url.pathname.startsWith("/api/")) {
    await serveStatic(request, response);
    return;
  }

  try {
    await routeApi(request, response, url);
  } catch (error) {
    const message = error.message === "request-too-large" ? "요청 데이터가 너무 커요." : error.message;
    sendError(response, 400, message || "서버 오류가 발생했어요.");
  }
}

if (require.main === module) {
  const server = http.createServer(appHandler);
  server.listen(PORT, () => {
    console.log(`moiza: http://localhost:${PORT}`);
  });
}

module.exports = appHandler;
