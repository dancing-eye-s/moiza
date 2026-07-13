const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const google = require("./google");

const ROOT = __dirname;
const DATA_DIR = process.env.VERCEL ? path.join("/tmp", "moiza-go-data") : path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function randomId(length = 8) {
  const bytes = crypto.randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i += 1) {
    id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return id;
}

function hashPassword(password) {
  if (!password) return "";
  return crypto.createHash("sha256").update(`moiza-go:${password}`).digest("hex");
}

function hashLegacyPassword(password) {
  if (!password) return "";
  return crypto.createHash("sha256").update(`${["moi", "za"].join("")}:${password}`).digest("hex");
}

const AREA_COORDS = [
  { key: "홍대", names: ["홍대", "합정", "상수", "망원", "연남"], lat: 37.556, lng: 126.923 },
  { key: "신촌", names: ["신촌", "이대", "서강대"], lat: 37.556, lng: 126.936 },
  { key: "강남", names: ["강남", "역삼", "선릉", "삼성", "논현", "신논현"], lat: 37.498, lng: 127.028 },
  { key: "잠실", names: ["잠실", "송파", "석촌", "방이"], lat: 37.514, lng: 127.106 },
  { key: "종로", names: ["종로", "광화문", "을지로", "명동", "시청"], lat: 37.57, lng: 126.982 },
  { key: "성수", names: ["성수", "건대", "왕십리", "뚝섬"], lat: 37.544, lng: 127.055 },
  { key: "여의도", names: ["여의도", "영등포", "당산"], lat: 37.525, lng: 126.925 },
  { key: "용산", names: ["용산", "이태원", "한남", "숙대입구"], lat: 37.532, lng: 126.99 },
  { key: "사당", names: ["사당", "교대", "방배", "이수"], lat: 37.477, lng: 126.981 },
  { key: "서울역", names: ["서울역", "공덕", "충정로", "마포"], lat: 37.554, lng: 126.97 },
];

function textAreaMatches(text) {
  const source = String(text || "");
  return AREA_COORDS.filter((area) => area.names.some((name) => source.includes(name)));
}

function nearestArea(lat, lng) {
  return AREA_COORDS.reduce((best, area) => {
    const distance = Math.hypot(area.lat - lat, area.lng - lng);
    return !best || distance < best.distance ? { ...area, distance } : best;
  }, null);
}

function recommendMeetingPlace(participants, placeSuggestions = []) {
  const weighted = [];
  const preferredLabels = [];

  participants.forEach((participant) => {
    textAreaMatches(participant.address).forEach((area) => weighted.push({ ...area, weight: 1.4 }));
    textAreaMatches(participant.preferredArea).forEach((area) => {
      weighted.push({ ...area, weight: 1 });
      preferredLabels.push(area.key);
    });
  });

  placeSuggestions.forEach((place) => {
    textAreaMatches(`${place.area} ${place.name}`).forEach((area) => weighted.push({ ...area, weight: 0.8 }));
  });

  if (!weighted.length) {
    return {
      area: "장소 정보 입력 대기",
      reason: "참여자의 거주지나 희망 지역이 입력되면 중간 지점을 자동으로 계산해요.",
      suggestions: ["참여자별 거주지 입력", "희망 지역 추가", "직접 장소 추천"],
      confidence: "low",
    };
  }

  const totalWeight = weighted.reduce((sum, area) => sum + area.weight, 0);
  const lat = weighted.reduce((sum, area) => sum + area.lat * area.weight, 0) / totalWeight;
  const lng = weighted.reduce((sum, area) => sum + area.lng * area.weight, 0) / totalWeight;
  const center = nearestArea(lat, lng);
  const uniquePreferred = [...new Set(preferredLabels)].slice(0, 3);
  const stationLabel = center.key.endsWith("역") ? center.key : `${center.key}역`;

  return {
    area: center.key,
    reason: `${weighted.length}개의 거주지/희망지역 정보를 기준으로 이동 균형이 좋은 지역을 골랐어요.${
      uniquePreferred.length ? ` 선호 지역도 ${uniquePreferred.join(", ")} 중심으로 반영했어요.` : ""
    }`,
    suggestions: [`${stationLabel} 근처`, `${center.key} 카페/식당 밀집 거리`, `${center.key} 대중교통 접근 좋은 출구 주변`],
    confidence: weighted.length >= 2 ? "medium" : "low",
  };
}

// --- Local JSON fallback (zero-setup local dev when Sheets isn't configured) ---

let writeQueue = Promise.resolve();

function readLocalState() {
  try {
    const raw = fsSync.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { events: [] };
  }
}

async function writeLocalState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function withLocalState(mutator) {
  writeQueue = writeQueue.then(async () => {
    const state = readLocalState();
    const result = await mutator(state);
    await writeLocalState(state);
    return result;
  });
  return writeQueue;
}

function slotsToBitmap(slots) {
  return slots.map((value) => (value ? "1" : "0")).join("");
}

function bitmapToSlots(bitmap, length) {
  const slots = new Array(length).fill(0);
  for (let i = 0; i < Math.min(bitmap.length, length); i += 1) {
    slots[i] = bitmap[i] === "1" ? 1 : 0;
  }
  return slots;
}

function nowIso() {
  return new Date().toISOString();
}

function slotCount(event) {
  const dateCount = event.mode === "days" ? event.dates.length : event.dates.length;
  const [startH, startM] = event.timeStart.split(":").map(Number);
  const [endH, endM] = event.timeEnd.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  const perDay = Math.max(0, Math.round((endMin - startMin) / event.slotMinutes));
  return dateCount * perDay;
}

// --- Public API (backend-agnostic) ---

async function createEvent(input) {
  const eventId = randomId(8);
  const event = {
    event_id: eventId,
    name: input.name,
    mode: input.mode,
    expected_count: input.expectedCount ? String(input.expectedCount) : "",
    dates: (input.dates || []).join(","),
    time_start: input.timeStart,
    time_end: input.timeEnd,
    slot_minutes: String(input.slotMinutes || 30),
    timezone: input.timezone || "Asia/Seoul",
    deadline_at: input.deadlineAt || "",
    notify_email: input.notifyEmail || "",
    email_sent: "FALSE",
    email_attempts: "0",
    created_at: nowIso(),
    status: "active",
  };

  if (google.isConfigured()) {
    await google.appendRow("events", event);
  } else {
    await withLocalState((state) => {
      state.events.push({ ...event, participants: [] });
    });
  }

  return eventId;
}

async function getEvent(eventId) {
  if (google.isConfigured()) {
    const events = await google.readSheetRows("events");
    const eventRow = events.find((row) => row.event_id === eventId);
    if (!eventRow) return null;

    const [participantRows, availabilityRows, placeRows] = await Promise.all([
      google.readSheetRows("participants"),
      google.readSheetRows("availability"),
      google.readSheetRows("places"),
    ]);
    const myParticipants = participantRows.filter((row) => row.event_id === eventId);
    const myAvailability = availabilityRows.filter((row) => row.event_id === eventId);
    const myPlaces = placeRows.filter((row) => row.event_id === eventId);
    const parsedEvent = parseEventRow(eventRow);
    const total = slotCount(parsedEvent);

    const participants = myParticipants.map((participant) => {
      const availability = myAvailability.find((row) => row.participant_id === participant.participant_id);
      return {
        participantId: participant.participant_id,
        name: participant.name,
        hasPassword: Boolean(participant.password_hash),
        address: participant.address || "",
        preferredArea: participant.preferred_area || "",
        slots: availability ? bitmapToSlots(availability.slots_bitmap, total) : new Array(total).fill(0),
      };
    });

    const placeSuggestions = myPlaces.map(parsePlaceRow);
    return { event: parsedEvent, participants, placeSuggestions, placeRecommendation: recommendMeetingPlace(participants, placeSuggestions) };
  }

  const state = readLocalState();
  const event = state.events.find((e) => e.event_id === eventId);
  if (!event) return null;

  const parsedEvent = parseEventRow(event);
  const total = slotCount(parsedEvent);
  const participants = (event.participants || []).map((p) => ({
    participantId: p.participant_id,
    name: p.name,
    hasPassword: Boolean(p.password_hash),
    address: p.address || "",
    preferredArea: p.preferred_area || "",
    slots: p.slots && p.slots.length === total ? p.slots : new Array(total).fill(0),
  }));

  const placeSuggestions = (event.places || []).map(parsePlaceRow);
  return { event: parsedEvent, participants, placeSuggestions, placeRecommendation: recommendMeetingPlace(participants, placeSuggestions) };
}

function parseEventRow(row) {
  return {
    eventId: row.event_id,
    name: row.name,
    mode: row.mode,
    expectedCount: Number(row.expected_count) || null,
    dates: row.dates ? row.dates.split(",").filter(Boolean) : [],
    timeStart: row.time_start,
    timeEnd: row.time_end,
    slotMinutes: Number(row.slot_minutes) || 30,
    timezone: row.timezone,
    deadlineAt: row.deadline_at || null,
    notifyEmail: row.notify_email || null,
    emailSent: row.email_sent === "TRUE" || row.email_sent === true,
    createdAt: row.created_at,
    status: row.status || "active",
  };
}

async function findParticipantByName(eventId, name) {
  if (google.isConfigured()) {
    const rows = await google.readSheetRows("participants");
    const match = rows.find((row) => row.event_id === eventId && row.name === name);
    return match ? { participantId: match.participant_id, passwordHash: match.password_hash } : null;
  }

  const state = readLocalState();
  const event = state.events.find((e) => e.event_id === eventId);
  const match = (event?.participants || []).find((p) => p.name === name);
  return match ? { participantId: match.participant_id, passwordHash: match.password_hash } : null;
}

async function joinEvent(eventId, { name, password, address, preferredArea }) {
  const existing = await findParticipantByName(eventId, name);
  const passwordHash = hashPassword(password);
  const cleanAddress = String(address || "").trim().slice(0, 80);
  const cleanPreferredArea = String(preferredArea || "").trim().slice(0, 80);

  if (existing) {
    if (existing.passwordHash && existing.passwordHash !== passwordHash && existing.passwordHash !== hashLegacyPassword(password)) {
      return { error: "PASSWORD_MISMATCH" };
    }
    await updateParticipantProfile(eventId, existing.participantId, { address: cleanAddress, preferredArea: cleanPreferredArea });
    return { participantId: existing.participantId };
  }

  const participantId = randomId(8);
  const record = {
    event_id: eventId,
    participant_id: participantId,
    name,
    password_hash: passwordHash,
    created_at: nowIso(),
    updated_at: nowIso(),
    address: cleanAddress,
    preferred_area: cleanPreferredArea,
  };

  if (google.isConfigured()) {
    await google.appendRow("participants", record);
  } else {
    await withLocalState((state) => {
      const event = state.events.find((e) => e.event_id === eventId);
      if (!event) throw new Error("EVENT_NOT_FOUND");
      event.participants = event.participants || [];
      event.participants.push({ ...record, slots: [] });
    });
  }

  return { participantId };
}

async function updateParticipantProfile(eventId, participantId, { address, preferredArea }) {
  if (!address && !preferredArea) return;

  if (google.isConfigured()) {
    const rows = await google.readSheetRows("participants");
    const row = rows.find((r) => r.event_id === eventId && r.participant_id === participantId);
    if (!row) return;
    await google.updateRow("participants", row.__row, {
      ...row,
      address: address || row.address,
      preferred_area: preferredArea || row.preferred_area,
      updated_at: nowIso(),
    });
    return;
  }

  await withLocalState((state) => {
    const event = state.events.find((e) => e.event_id === eventId);
    const participant = (event?.participants || []).find((p) => p.participant_id === participantId);
    if (!participant) return;
    participant.address = address || participant.address || "";
    participant.preferred_area = preferredArea || participant.preferred_area || "";
    participant.updated_at = nowIso();
  });
}

function parsePlaceRow(row) {
  return {
    placeId: row.place_id,
    participantId: row.participant_id,
    participantName: row.participant_name,
    name: row.name,
    area: row.area,
    note: row.note,
    createdAt: row.created_at,
  };
}

async function addPlaceSuggestion(eventId, { participantId, participantName, name, area, note }) {
  const record = {
    event_id: eventId,
    place_id: randomId(8),
    participant_id: participantId || "",
    participant_name: String(participantName || "").trim().slice(0, 20),
    name: String(name || "").trim().slice(0, 60),
    area: String(area || "").trim().slice(0, 60),
    note: String(note || "").trim().slice(0, 120),
    created_at: nowIso(),
  };

  if (!record.name && !record.area) {
    return { error: "PLACE_REQUIRED" };
  }

  if (google.isConfigured()) {
    await google.appendRow("places", record);
  } else {
    await withLocalState((state) => {
      const event = state.events.find((e) => e.event_id === eventId);
      if (!event) throw new Error("EVENT_NOT_FOUND");
      event.places = event.places || [];
      event.places.push(record);
    });
  }

  return { placeId: record.place_id };
}

async function saveAvailability(eventId, participantId, slots) {
  const record = {
    event_id: eventId,
    participant_id: participantId,
    slots_bitmap: slotsToBitmap(slots),
    updated_at: nowIso(),
    created_at: nowIso(),
  };

  if (google.isConfigured()) {
    await google.upsertRow("availability", ["event_id", "participant_id"], record);
  } else {
    await withLocalState((state) => {
      const event = state.events.find((e) => e.event_id === eventId);
      if (!event) throw new Error("EVENT_NOT_FOUND");
      const participant = (event.participants || []).find((p) => p.participant_id === participantId);
      if (!participant) throw new Error("PARTICIPANT_NOT_FOUND");
      participant.slots = slots;
      participant.updated_at = record.updated_at;
    });
  }

  return true;
}

async function saveInvitation(eventId, imageDataUrl) {
  const record = { event_id: eventId, image_dataurl: imageDataUrl.slice(0, 280000), created_at: nowIso() };

  if (google.isConfigured()) {
    await google.upsertRow("invitations", ["event_id"], record);
  } else {
    await withLocalState((state) => {
      const event = state.events.find((e) => e.event_id === eventId);
      if (!event) throw new Error("EVENT_NOT_FOUND");
      event.invitation = record;
    });
  }

  return true;
}

async function getInvitation(eventId) {
  if (google.isConfigured()) {
    const rows = await google.readSheetRows("invitations");
    const match = rows.find((row) => row.event_id === eventId);
    return match ? match.image_dataurl : null;
  }

  const state = readLocalState();
  const event = state.events.find((e) => e.event_id === eventId);
  return event?.invitation?.image_dataurl || null;
}

async function listAllEvents() {
  if (google.isConfigured()) {
    return (await google.readSheetRows("events")).map(parseEventRow);
  }

  const state = readLocalState();
  return state.events.map(parseEventRow);
}

async function purgeEvent(eventId) {
  if (google.isConfigured()) {
    const [events, participants, availability, invitations, places] = await Promise.all([
      google.readSheetRows("events"),
      google.readSheetRows("participants"),
      google.readSheetRows("availability"),
      google.readSheetRows("invitations"),
      google.readSheetRows("places"),
    ]);
    await google.deleteRows(
      "events",
      events.filter((r) => r.event_id === eventId).map((r) => r.__row),
    );
    await google.deleteRows(
      "participants",
      participants.filter((r) => r.event_id === eventId).map((r) => r.__row),
    );
    await google.deleteRows(
      "availability",
      availability.filter((r) => r.event_id === eventId).map((r) => r.__row),
    );
    await google.deleteRows(
      "invitations",
      invitations.filter((r) => r.event_id === eventId).map((r) => r.__row),
    );
    await google.deleteRows(
      "places",
      places.filter((r) => r.event_id === eventId).map((r) => r.__row),
    );
    return;
  }

  await withLocalState((state) => {
    state.events = state.events.filter((e) => e.event_id !== eventId);
  });
}

async function markEmailSent(eventId, success) {
  if (google.isConfigured()) {
    const rows = await google.readSheetRows("events");
    const row = rows.find((r) => r.event_id === eventId);
    if (!row) return;
    const attempts = Number(row.email_attempts || 0) + 1;
    await google.updateRow("events", row.__row, {
      ...row,
      email_sent: success ? "TRUE" : row.email_sent,
      email_attempts: String(attempts),
    });
    return;
  }

  await withLocalState((state) => {
    const event = state.events.find((e) => e.event_id === eventId);
    if (!event) return;
    event.email_attempts = String(Number(event.email_attempts || 0) + 1);
    if (success) event.email_sent = "TRUE";
  });
}

module.exports = {
  slotCount,
  createEvent,
  getEvent,
  joinEvent,
  saveAvailability,
  addPlaceSuggestion,
  saveInvitation,
  getInvitation,
  listAllEvents,
  purgeEvent,
  markEmailSent,
};
