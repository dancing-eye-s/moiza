const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const google = require("./google");
const geocoder = require("./geocoder");

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

function hashOwnerToken(token) {
  return crypto.createHash("sha256").update(`moiza-go-owner:${token}`).digest("hex");
}

function resolvedLocation(text, lat, lng, source, label) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng) && (parsedLat !== 0 || parsedLng !== 0)) {
    return { lat: parsedLat, lng: parsedLng, source: source || "stored", label: label || text };
  }
  return geocoder.knownLocation(text);
}

function recommendMeetingPlace(participants, placeSuggestions = []) {
  const weighted = [];
  const preferredLabels = [];
  const peopleWithLocation = new Set();
  const unresolved = [];

  participants.forEach((participant) => {
    const address = resolvedLocation(
      participant.address,
      participant.addressLat,
      participant.addressLng,
      participant.addressSource,
      participant.addressLabel,
    );
    const preferred = resolvedLocation(
      participant.preferredArea,
      participant.preferredLat,
      participant.preferredLng,
      participant.preferredSource,
      participant.preferredLabel,
    );
    if (address) {
      weighted.push({ ...address, weight: 1.4 });
      peopleWithLocation.add(participant.participantId || participant.name);
    } else if (participant.address) {
      unresolved.push(participant.address);
    }
    if (preferred) {
      weighted.push({ ...preferred, weight: 1 });
      preferredLabels.push(preferred.label || participant.preferredArea);
      peopleWithLocation.add(participant.participantId || participant.name);
    } else if (participant.preferredArea) {
      unresolved.push(participant.preferredArea);
    }
  });

  placeSuggestions.forEach((place) => {
    const location = resolvedLocation(`${place.area} ${place.name}`, place.lat, place.lng, place.locationSource, place.locationLabel);
    if (location) weighted.push({ ...location, weight: 0.8 });
    else if (place.area || place.name) unresolved.push(place.area || place.name);
  });

  if (!weighted.length) {
    return {
      area: "장소 정보 입력 대기",
      reason: "참여자의 거주지나 희망 지역이 입력되면 중간 지점을 자동으로 계산해요.",
      suggestions: ["참여자별 거주지 입력", "희망 지역 추가", "직접 장소 추천"],
      confidence: "low",
      peopleCount: 0,
      unresolvedCount: unresolved.length,
      usesOpenStreetMap: false,
    };
  }

  const totalWeight = weighted.reduce((sum, area) => sum + area.weight, 0);
  const lat = weighted.reduce((sum, area) => sum + area.lat * area.weight, 0) / totalWeight;
  const lng = weighted.reduce((sum, area) => sum + area.lng * area.weight, 0) / totalWeight;
  const center = geocoder.nearestHub(lat, lng);
  const uniquePreferred = [...new Set(preferredLabels)].slice(0, 2);
  const peopleCount = peopleWithLocation.size;
  const stationLabel = center.key.endsWith("역") ? center.key : `${center.key}역`;

  return {
    area: center.key,
    reason: `${peopleCount || weighted.length}명의 ${peopleCount >= 2 ? "위치 중심점을" : "위치를"} 기준으로 이동 균형이 좋은 지역을 골랐어요.${
      uniquePreferred.length ? ` 희망 지역 ${uniquePreferred.join(", ")}도 함께 반영했어요.` : ""
    }${unresolved.length ? ` 해석하지 못한 입력 ${unresolved.length}개는 계산에서 제외했어요.` : ""}`,
    suggestions: [`${stationLabel} 근처`, `${center.key} 카페/식당 밀집 거리`, `${center.key} 대중교통 접근 좋은 출구 주변`],
    confidence: peopleCount >= 3 ? "high" : peopleCount >= 2 ? "medium" : "low",
    peopleCount,
    unresolvedCount: unresolved.length,
    usesOpenStreetMap: weighted.some((item) => item.source === "openstreetmap"),
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
  const ownerToken = crypto.randomBytes(18).toString("base64url");
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
    owner_token_hash: hashOwnerToken(ownerToken),
    confirmed_date: "",
    confirmed_start: "",
    confirmed_end: "",
    confirmed_place_name: "",
    confirmed_place_area: "",
    confirmed_at: "",
  };

  if (google.isConfigured()) {
    await google.appendRow("events", event);
  } else {
    await withLocalState((state) => {
      state.events.push({ ...event, participants: [] });
    });
  }

  return { eventId, ownerToken };
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
        addressLat: participant.address_lat || "",
        addressLng: participant.address_lng || "",
        addressLabel: participant.address_label || "",
        addressSource: participant.address_source || "",
        preferredLat: participant.preferred_lat || "",
        preferredLng: participant.preferred_lng || "",
        preferredLabel: participant.preferred_label || "",
        preferredSource: participant.preferred_source || "",
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
    addressLat: p.address_lat || "",
    addressLng: p.address_lng || "",
    addressLabel: p.address_label || "",
    addressSource: p.address_source || "",
    preferredLat: p.preferred_lat || "",
    preferredLng: p.preferred_lng || "",
    preferredLabel: p.preferred_label || "",
    preferredSource: p.preferred_source || "",
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
    confirmation:
      row.status === "confirmed"
        ? {
            date: row.confirmed_date,
            startLabel: row.confirmed_start,
            endLabel: row.confirmed_end,
            placeName: row.confirmed_place_name || "",
            placeArea: row.confirmed_place_area || "",
            confirmedAt: row.confirmed_at || "",
          }
        : null,
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
  const [addressLocation, preferredLocation] = await Promise.all([
    geocoder.geocodeLocation(cleanAddress),
    geocoder.geocodeLocation(cleanPreferredArea),
  ]);
  const locationFields = {
    address_lat: addressLocation?.lat || "",
    address_lng: addressLocation?.lng || "",
    address_label: addressLocation?.label || "",
    address_source: addressLocation?.source || "",
    preferred_lat: preferredLocation?.lat || "",
    preferred_lng: preferredLocation?.lng || "",
    preferred_label: preferredLocation?.label || "",
    preferred_source: preferredLocation?.source || "",
  };

  if (existing) {
    if (existing.passwordHash && existing.passwordHash !== passwordHash && existing.passwordHash !== hashLegacyPassword(password)) {
      return { error: "PASSWORD_MISMATCH" };
    }
    await updateParticipantProfile(eventId, existing.participantId, {
      address: cleanAddress,
      preferredArea: cleanPreferredArea,
      locationFields,
    });
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
    ...locationFields,
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

async function updateParticipantProfile(eventId, participantId, { address, preferredArea, locationFields }) {
  if (!address && !preferredArea) return;

  if (google.isConfigured()) {
    const rows = await google.readSheetRows("participants");
    const row = rows.find((r) => r.event_id === eventId && r.participant_id === participantId);
    if (!row) return;
    await google.updateRow("participants", row.__row, {
      ...row,
      address: address || row.address,
      preferred_area: preferredArea || row.preferred_area,
      ...locationFields,
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
    Object.assign(participant, locationFields);
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
    lat: row.lat || "",
    lng: row.lng || "",
    locationLabel: row.location_label || "",
    locationSource: row.location_source || "",
    createdAt: row.created_at,
  };
}

async function addPlaceSuggestion(eventId, { participantId, participantName, name, area, note }) {
  const cleanName = String(name || "").trim().slice(0, 60);
  const cleanArea = String(area || "").trim().slice(0, 60);
  const location = await geocoder.geocodeLocation(`${cleanArea} ${cleanName}`.trim());
  const record = {
    event_id: eventId,
    place_id: randomId(8),
    participant_id: participantId || "",
    participant_name: String(participantName || "").trim().slice(0, 20),
    name: cleanName,
    area: cleanArea,
    note: String(note || "").trim().slice(0, 120),
    lat: location?.lat || "",
    lng: location?.lng || "",
    location_label: location?.label || "",
    location_source: location?.source || "",
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

async function confirmEvent(eventId, { ownerToken, date, startLabel, endLabel, placeName, placeArea }) {
  const tokenHash = hashOwnerToken(String(ownerToken || ""));
  const confirmation = {
    status: "confirmed",
    confirmed_date: String(date || "").slice(0, 20),
    confirmed_start: String(startLabel || "").slice(0, 10),
    confirmed_end: String(endLabel || "").slice(0, 10),
    confirmed_place_name: String(placeName || "").trim().slice(0, 60),
    confirmed_place_area: String(placeArea || "").trim().slice(0, 60),
    confirmed_at: nowIso(),
  };

  if (google.isConfigured()) {
    const rows = await google.readSheetRows("events");
    const row = rows.find((item) => item.event_id === eventId);
    if (!row) return { error: "EVENT_NOT_FOUND" };
    if (!row.owner_token_hash || row.owner_token_hash !== tokenHash) return { error: "OWNER_TOKEN_MISMATCH" };
    await google.updateRow("events", row.__row, { ...row, ...confirmation });
    return { ok: true };
  }

  return withLocalState((state) => {
    const event = state.events.find((item) => item.event_id === eventId);
    if (!event) return { error: "EVENT_NOT_FOUND" };
    if (!event.owner_token_hash || event.owner_token_hash !== tokenHash) return { error: "OWNER_TOKEN_MISMATCH" };
    Object.assign(event, confirmation);
    return { ok: true };
  });
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
  const record = { event_id: eventId, image_dataurl: imageDataUrl, created_at: nowIso() };

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

async function saveInvitationForOwner(eventId, ownerToken, imageDataUrl) {
  const tokenHash = hashOwnerToken(String(ownerToken || ""));

  if (google.isConfigured()) {
    const rows = await google.readSheetRows("events");
    const event = rows.find((item) => item.event_id === eventId);
    if (!event) return { error: "EVENT_NOT_FOUND" };
    if (!event.owner_token_hash || event.owner_token_hash !== tokenHash) return { error: "OWNER_TOKEN_MISMATCH" };
    if (event.status !== "confirmed") return { error: "EVENT_NOT_CONFIRMED" };
  } else {
    const state = readLocalState();
    const event = state.events.find((item) => item.event_id === eventId);
    if (!event) return { error: "EVENT_NOT_FOUND" };
    if (!event.owner_token_hash || event.owner_token_hash !== tokenHash) return { error: "OWNER_TOKEN_MISMATCH" };
    if (event.status !== "confirmed") return { error: "EVENT_NOT_CONFIRMED" };
  }

  await saveInvitation(eventId, imageDataUrl);
  return { ok: true };
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
  confirmEvent,
  saveInvitation,
  saveInvitationForOwner,
  getInvitation,
  listAllEvents,
  purgeEvent,
  markEmailSent,
};
