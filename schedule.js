// Shared slot <-> date/time math used by the API (grid definition, best-time
// ranking) and reused verbatim by the client for rendering the same grid.

function pad2(n) {
  return String(n).padStart(2, "0");
}

function timeLabelFromMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

const WEEKDAY_LABEL = { SUN: "일", MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토" };
const WEEKDAY_ORDER = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function buildSlotGrid(event) {
  const [startH, startM] = event.timeStart.split(":").map(Number);
  const [endH, endM] = event.timeEnd.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  const perDay = Math.max(0, Math.round((endMin - startMin) / event.slotMinutes));

  const columns = event.dates.map((dateKey) => {
    if (event.mode === "days") {
      return { key: dateKey, label: WEEKDAY_LABEL[dateKey] || dateKey };
    }
    const d = new Date(`${dateKey}T00:00:00`);
    const weekday = WEEKDAY_LABEL[WEEKDAY_ORDER[d.getDay()]];
    return { key: dateKey, label: `${d.getMonth() + 1}/${d.getDate()} (${weekday})` };
  });

  const rows = [];
  for (let i = 0; i < perDay; i += 1) {
    const minutes = startMin + i * event.slotMinutes;
    rows.push({ index: i, label: timeLabelFromMinutes(minutes) });
  }

  return { columns, rows, perDay, total: columns.length * perDay };
}

// Ranks slots by how many participants marked them available, merges
// adjacent winning slots on the same date into a single time range, and
// returns the top N ranges.
function bestTimes(event, participants, limit = 3) {
  const grid = buildSlotGrid(event);
  const total = grid.total;
  const counts = new Array(total).fill(0);

  participants.forEach((participant) => {
    participant.slots.forEach((value, index) => {
      if (value && index < total) counts[index] += 1;
    });
  });

  const maxCount = Math.max(0, ...counts);
  if (maxCount === 0) return [];

  const ranges = [];
  let current = null;

  for (let col = 0; col < grid.columns.length; col += 1) {
    for (let row = 0; row < grid.perDay; row += 1) {
      const index = col * grid.perDay + row;
      const count = counts[index];

      if (count === maxCount) {
        if (current && current.col === col && current.endRow === row - 1) {
          current.endRow = row;
        } else {
          if (current) ranges.push(current);
          current = { col, startRow: row, endRow: row, count };
        }
      } else if (current) {
        ranges.push(current);
        current = null;
      }
    }
    if (current) {
      ranges.push(current);
      current = null;
    }
  }

  return ranges.slice(0, limit).map((range) => {
    const column = grid.columns[range.col];
    const startLabel = grid.rows[range.startRow].label;
    const endMinutes = (range.endRow + 1) * event.slotMinutes;
    const [startH] = event.timeStart.split(":").map(Number);
    const endTotalMin = startH * 60 + Number(event.timeStart.split(":")[1]) + endMinutes;
    const endLabel = timeLabelFromMinutes(endTotalMin);

    return {
      dateKey: column.key,
      date: column.label,
      startLabel,
      endLabel,
      count: range.count,
      total: participants.length,
      names: participants.filter((p) => p.slots[range.col * grid.perDay + range.startRow]).map((p) => p.name),
    };
  });
}

module.exports = { buildSlotGrid, bestTimes };
