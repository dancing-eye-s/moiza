const test = require("node:test");
const assert = require("node:assert/strict");
const schedule = require("../schedule");
const geocoder = require("../geocoder");

test("bestTimes keeps the candidate date key for confirmation", () => {
  const event = {
    mode: "dates",
    dates: ["2026-07-24"],
    timeStart: "09:00",
    timeEnd: "11:00",
    slotMinutes: 30,
  };
  const result = schedule.bestTimes(event, [{ name: "지윤", slots: [0, 1, 1, 0] }]);

  assert.equal(result[0].dateKey, "2026-07-24");
  assert.equal(result[0].startLabel, "09:30");
  assert.equal(result[0].endLabel, "10:30");
});

test("known Korean locations resolve without a network request", () => {
  const bupyeong = geocoder.knownLocation("인천 부평역");
  const jeongja = geocoder.knownLocation("분당 정자역");

  assert.equal(bupyeong.label, "부평");
  assert.equal(jeongja.label, "정자");
  assert.ok(Number.isFinite(bupyeong.lat));
});

test("nearestHub recommends a central hub from arbitrary coordinates", () => {
  const centerLat = (37.4895879 + 37.366234) / 2;
  const centerLng = (126.7233791 + 127.1081139) / 2;
  const hub = geocoder.nearestHub(centerLat, centerLng);

  assert.ok(hub);
  assert.ok(hub.distance < 20);
});

test("midpointCandidates returns three ranked hubs for multiple departures", async () => {
  const result = await geocoder.midpointCandidates(["부평역", "강남역", "잠실역"]);

  assert.equal(result.resolvedCount, 3);
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every((candidate) => candidate.area && candidate.description));
});
