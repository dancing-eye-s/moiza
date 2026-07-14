const HUBS = [
  { key: "홍대", names: ["홍대", "합정", "상수", "망원", "연남"], lat: 37.556, lng: 126.923 },
  { key: "신촌", names: ["신촌", "이대", "서강대"], lat: 37.556, lng: 126.936 },
  { key: "강남", names: ["강남", "역삼", "선릉", "삼성", "논현", "신논현"], lat: 37.498, lng: 127.028 },
  { key: "잠실", names: ["잠실", "송파", "석촌", "방이"], lat: 37.514, lng: 127.106 },
  { key: "종로", names: ["종로", "광화문", "을지로", "명동", "시청"], lat: 37.57, lng: 126.982 },
  { key: "성수", names: ["성수", "건대", "뚝섬"], lat: 37.544, lng: 127.055 },
  { key: "왕십리", names: ["왕십리", "한양대"], lat: 37.561, lng: 127.037 },
  { key: "여의도", names: ["여의도", "영등포", "당산"], lat: 37.525, lng: 126.925 },
  { key: "용산", names: ["용산", "이태원", "한남", "숙대입구"], lat: 37.532, lng: 126.99 },
  { key: "사당", names: ["사당", "교대", "방배", "이수"], lat: 37.477, lng: 126.981 },
  { key: "서울역", names: ["서울역", "공덕", "충정로", "마포"], lat: 37.554, lng: 126.97 },
  { key: "고속터미널", names: ["고속터미널", "반포"], lat: 37.505, lng: 127.005 },
  { key: "신도림", names: ["신도림", "구로"], lat: 37.509, lng: 126.891 },
  { key: "김포공항", names: ["김포공항", "마곡", "발산"], lat: 37.562, lng: 126.802 },
  { key: "부평", names: ["부평", "부평역"], lat: 37.49, lng: 126.724 },
  { key: "수유", names: ["수유", "미아", "쌍문"], lat: 37.638, lng: 127.026 },
  { key: "노원", names: ["노원", "상계", "창동"], lat: 37.655, lng: 127.061 },
  { key: "청량리", names: ["청량리", "회기"], lat: 37.58, lng: 127.047 },
  { key: "판교", names: ["판교"], lat: 37.394, lng: 127.111 },
  { key: "정자", names: ["정자", "분당"], lat: 37.366, lng: 127.108 },
  { key: "인덕원", names: ["인덕원", "평촌", "범계"], lat: 37.401, lng: 126.976 },
  { key: "수원", names: ["수원", "수원역"], lat: 37.266, lng: 126.999 },
  { key: "북한산우이", names: ["북한산 우이", "우이역"], lat: 37.664, lng: 127.012 },
];

const cache = new Map();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function knownLocation(text) {
  const source = String(text || "").replace(/\s+/g, "");
  const hub = HUBS.find((item) => item.names.some((name) => source.includes(name.replace(/\s+/g, ""))));
  return hub ? { label: hub.key, lat: hub.lat, lng: hub.lng, source: "builtin" } : null;
}

async function requestNominatim(query) {
  const waitMs = Math.max(0, 1100 - (Date.now() - lastRequestAt));
  if (waitMs) await sleep(waitMs);
  lastRequestAt = Date.now();

  const url = new URL(process.env.GEOCODER_BASE_URL || "https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "kr");
  url.searchParams.set("accept-language", "ko");
  url.searchParams.set("limit", "1");

  const baseUrl = process.env.PUBLIC_BASE_URL || "https://moiza-go.vercel.app";
  const response = await globalThis.fetch(url, {
    headers: {
      "User-Agent": process.env.GEOCODER_USER_AGENT || `moiza-go/0.1 (${baseUrl})`,
      Referer: baseUrl,
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`GEOCODING_${response.status}`);
  const payload = await response.json();
  const result = payload[0];
  if (!result) return null;

  return {
    label: String(result.name || result.display_name || query).slice(0, 60),
    lat: Number(result.lat),
    lng: Number(result.lon),
    source: "openstreetmap",
  };
}

async function geocodeLocation(text) {
  const query = String(text || "").trim().slice(0, 80);
  if (!query) return null;
  if (cache.has(query)) return cache.get(query);

  const builtIn = knownLocation(query);
  if (builtIn) {
    cache.set(query, builtIn);
    return builtIn;
  }

  const task = requestQueue.then(() => requestNominatim(query)).catch(() => null);
  requestQueue = task.then(() => undefined);
  const result = await task;
  cache.set(query, result);
  return result;
}

function nearestHub(lat, lng) {
  return nearestHubs(lat, lng, 1)[0] || null;
}

function nearestHubs(lat, lng, limit = 3) {
  return HUBS.map((hub) => {
    const latKm = (hub.lat - lat) * 111;
    const lngKm = (hub.lng - lng) * 88;
    const distance = Math.hypot(latKm, lngKm);
    return { ...hub, distance };
  })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, Math.min(Number(limit) || 3, 5)));
}

async function midpointCandidates(regions) {
  const cleanRegions = [...new Set((regions || []).map((region) => String(region).trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
  const locations = (await Promise.all(cleanRegions.map((region) => geocodeLocation(region)))).filter(Boolean);
  if (locations.length < 2) return { candidates: [], resolvedCount: locations.length, unresolvedCount: cleanRegions.length - locations.length };

  const lat = locations.reduce((sum, location) => sum + location.lat, 0) / locations.length;
  const lng = locations.reduce((sum, location) => sum + location.lng, 0) / locations.length;
  const candidates = nearestHubs(lat, lng, 3).map((hub, index) => ({
    area: hub.key,
    description: index === 0 ? `${locations.length}개 출발지의 중심에 가장 가까워요` : `중심에서 약 ${hub.distance.toFixed(1)}km 떨어진 대안이에요`,
  }));

  return { candidates, resolvedCount: locations.length, unresolvedCount: cleanRegions.length - locations.length };
}

module.exports = { HUBS, geocodeLocation, knownLocation, nearestHub, nearestHubs, midpointCandidates };
