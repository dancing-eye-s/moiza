const crypto = require("node:crypto");

const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

// A single hung Google call must not wedge the whole request queue in
// server.js, so every call is capped and degrades into a caught error.
const FETCH_TIMEOUT_MS = 20_000;

function fetch(url, options = {}) {
  return globalThis.fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

let cachedCredentials = null;
let cachedToken = null;
let ensuredSheets = new Set();

const SHEETS = {
  events: [
    "event_id",
    "name",
    "mode",
    "dates",
    "time_start",
    "time_end",
    "slot_minutes",
    "timezone",
    "deadline_at",
    "notify_email",
    "email_sent",
    "email_attempts",
    "created_at",
    "status",
    "expected_count",
  ],
  participants: ["event_id", "participant_id", "name", "password_hash", "created_at", "updated_at", "address", "preferred_area"],
  availability: ["event_id", "participant_id", "slots_bitmap", "updated_at", "created_at"],
  invitations: ["event_id", "image_dataurl", "created_at"],
  places: ["event_id", "place_id", "participant_id", "participant_name", "name", "area", "note", "created_at"],
};

function loadCredentials() {
  if (cachedCredentials !== null) return cachedCredentials;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    cachedCredentials = false;
    return false;
  }

  try {
    cachedCredentials = JSON.parse(raw);
  } catch {
    cachedCredentials = false;
  }

  return cachedCredentials;
}

function isConfigured() {
  return Boolean(loadCredentials() && process.env.GOOGLE_SHEETS_ID);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Service accounts sign a short-lived JWT with their private key and trade it
// for an OAuth access token; tokens last ~1h so we cache and refresh early.
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const credentials = loadCredentials();

  if (!credentials) {
    throw new Error("Google service account is not configured.");
  }

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: SCOPES,
      aud: credentials.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(credentials.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const response = await fetch(credentials.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Google auth failed: ${payload.error_description || payload.error || response.status}`);
  }

  cachedToken = { accessToken: payload.access_token, expiresAt: now + payload.expires_in };
  return cachedToken.accessToken;
}

async function checkAuth() {
  await getAccessToken();
  return true;
}

function columnName(count) {
  let name = "";
  let n = count;

  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }

  return name || "A";
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

async function getSpreadsheetSheets(token) {
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to read spreadsheet: ${payload.error?.message || response.status}`);
  }

  return (payload.sheets || []).map((sheet) => sheet.properties).filter((properties) => properties?.title);
}

async function ensureSheet(name) {
  const headers = SHEETS[name];
  const cacheKey = name;

  if (ensuredSheets.has(cacheKey)) return name;

  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const sheets = await getSpreadsheetSheets(token);
  const exists = sheets.some((sheet) => sheet.title === name);

  if (!exists) {
    const addResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: name, gridProperties: { frozenRowCount: 1 } } } }],
      }),
    });
    const addPayload = await addResponse.json().catch(() => ({}));

    if (!addResponse.ok) {
      throw new Error(`Sheet create failed: ${addPayload.error?.message || addResponse.status}`);
    }

    const headerRange = encodeURIComponent(`${quoteSheetTitle(name)}!A1:${columnName(headers.length)}1`);
    const writeResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${headerRange}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [headers] }),
      },
    );
    const writePayload = await writeResponse.json().catch(() => ({}));

    if (!writeResponse.ok) {
      throw new Error(`Sheet header write failed: ${writePayload.error?.message || writeResponse.status}`);
    }
  }

  ensuredSheets.add(cacheKey);
  return name;
}

async function readSheetRows(name) {
  await ensureSheet(name);
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const headers = SHEETS[name];
  const range = encodeURIComponent(`${quoteSheetTitle(name)}!A2:${columnName(headers.length)}`);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Sheet read failed: ${payload.error?.message || response.status}`);
  }

  return (payload.values || []).map((row, index) => {
    const record = {};
    headers.forEach((header, i) => {
      record[header] = row[i] ?? "";
    });
    record.__row = index + 2; // 1-indexed, +1 for header row
    return record;
  });
}

async function appendRow(name, record) {
  await ensureSheet(name);
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const headers = SHEETS[name];
  const values = headers.map((header) => (record[header] ?? "").toString());
  const range = encodeURIComponent(`${quoteSheetTitle(name)}!A1`);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${range}:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] }),
    },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Sheets append failed: ${payload.error?.message || response.status}`);
  }

  return payload;
}

async function updateRow(name, rowNumber, record) {
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const headers = SHEETS[name];
  const values = headers.map((header) => (record[header] ?? "").toString());
  const range = encodeURIComponent(`${quoteSheetTitle(name)}!A${rowNumber}:${columnName(headers.length)}${rowNumber}`);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${range}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] }),
    },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Sheets update failed: ${payload.error?.message || response.status}`);
  }

  return payload;
}

// Upsert by matching every key column; last-write-wins on the matched row.
async function upsertRow(name, keyColumns, record) {
  const rows = await readSheetRows(name);
  const match = rows.find((row) => keyColumns.every((column) => row[column] === record[column]));

  if (match) {
    await updateRow(name, match.__row, { ...match, ...record });
    return { updated: true };
  }

  await appendRow(name, record);
  return { updated: false };
}

async function deleteRows(name, rowNumbers) {
  if (!rowNumbers.length) return;

  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const sheets = await getSpreadsheetSheets(token);
  const sheetId = sheets.find((sheet) => sheet.title === name)?.sheetId;

  if (sheetId == null) return;

  // Delete from bottom to top so earlier deletions don't shift later row indexes.
  const requests = [...rowNumbers]
    .sort((a, b) => b - a)
    .map((rowNumber) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: rowNumber - 1,
          endIndex: rowNumber,
        },
      },
    }));

  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Sheets delete failed: ${payload.error?.message || response.status}`);
  }
}

module.exports = {
  isConfigured,
  checkAuth,
  readSheetRows,
  appendRow,
  updateRow,
  upsertRow,
  deleteRows,
};
