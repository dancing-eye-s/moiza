// Sends the deadline-result email through the Gmail API using a pre-authorized
// OAuth refresh token (a service account cannot send Gmail on its own without
// domain-wide delegation, so this mirrors the "user already granted consent
// once" pattern instead). No-ops when the credentials aren't set so the cron
// route still runs cleanly in environments that haven't wired Gmail yet.

const FETCH_TIMEOUT_MS = 20_000;

function fetch(url, options = {}) {
  return globalThis.fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

let cachedToken = null;

function isConfigured() {
  return Boolean(
    process.env.GMAIL_OAUTH_CLIENT_ID &&
      process.env.GMAIL_OAUTH_CLIENT_SECRET &&
      process.env.GMAIL_OAUTH_REFRESH_TOKEN &&
      process.env.GMAIL_SENDER_EMAIL,
  );
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.accessToken;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Gmail OAuth refresh failed: ${payload.error_description || payload.error || response.status}`);
  }

  cachedToken = { accessToken: payload.access_token, expiresAt: now + payload.expires_in };
  return cachedToken.accessToken;
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function resultUrl(eventId) {
  const base = process.env.PUBLIC_BASE_URL || "https://moiza-go.vercel.app";
  return `${base}/e/${eventId}/result`;
}

function renderHtml({ eventName, eventId, participantCount, bestTimes }) {
  const rows = bestTimes
    .map(
      (t) =>
        `<li style="margin-bottom:8px;"><strong>${t.date} ${t.startLabel}–${t.endLabel}</strong> · ${t.count}/${t.total}명 가능</li>`,
    )
    .join("");

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#1E2A3B;">'${eventName}' 일정 조율 결과가 나왔어요</h2>
      <p style="color:#8B95A1;">참여자 ${participantCount}명이 응답했어요.</p>
      <ul style="padding-left:20px;color:#1E2A3B;">${rows || "<li>겹치는 시간이 없어요.</li>"}</ul>
      <a href="${resultUrl(eventId)}" style="display:inline-block;margin-top:16px;padding:12px 20px;background:#F2664A;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">결과 한눈에 보기</a>
    </div>
  `;
}

async function sendResultEmail({ to, eventName, eventId, participantCount, bestTimes }) {
  if (!isConfigured()) {
    console.log(`[mailer] Gmail not configured, skipping send for ${eventId}`);
    return false;
  }

  const token = await getAccessToken();
  const subject = `[모이자고] '${eventName}' 일정 조율 결과가 나왔어요`;
  const html = renderHtml({ eventName, eventId, participantCount, bestTimes });
  const sender = process.env.GMAIL_SENDER_EMAIL;

  const message = [
    `From: 모이자고 <${sender}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\r\n");

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64url(message) }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Gmail send failed: ${payload.error?.message || response.status}`);
  }

  return true;
}

module.exports = { isConfigured, sendResultEmail };
