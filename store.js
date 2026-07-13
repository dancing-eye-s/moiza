const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const google = require("./google");

const ROOT = __dirname;
const DATA_DIR = process.env.VERCEL ? path.join("/tmp", "moiza-data") : path.join(ROOT, "data");
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
  return crypto.createHash("sha256").update(`moiza:${password}`).digest("hex");
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

    const [participantRows, availabilityRows] = await Promise.all([
      google.readSheetRows("participants"),
      google.readSheetRows("availability"),
    ]);
    const myParticipants = participantRows.filter((row) => row.event_id === eventId);
    const myAvailability = availabilityRows.filter((row) => row.event_id === eventId);
    const parsedEvent = parseEventRow(eventRow);
    const total = slotCount(parsedEvent);

    const participants = myParticipants.map((participant) => {
      const availability = myAvailability.find((row) => row.participant_id === participant.participant_id);
      return {
        participantId: participant.participant_id,
        name: participant.name,
        hasPassword: Boolean(participant.password_hash),
        slots: availability ? bitmapToSlots(availability.slots_bitmap, total) : new Array(total).fill(0),
      };
    });

    return { event: parsedEvent, participants };
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
    slots: p.slots && p.slots.length === total ? p.slots : new Array(total).fill(0),
  }));

  return { event: parsedEvent, participants };
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

async function joinEvent(eventId, { name, password }) {
  const existing = await findParticipantByName(eventId, name);
  const passwordHash = hashPassword(password);

  if (existing) {
    if (existing.passwordHash && existing.passwordHash !== passwordHash) {
      return { error: "PASSWORD_MISMATCH" };
    }
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
    const [events, participants, availability, invitations] = await Promise.all([
      google.readSheetRows("events"),
      google.readSheetRows("participants"),
      google.readSheetRows("availability"),
      google.readSheetRows("invitations"),
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
  saveInvitation,
  getInvitation,
  listAllEvents,
  purgeEvent,
  markEmailSent,
};
