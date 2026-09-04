// Replay selection never silently substitutes another date or fills missing bars.
export function replayDate(series, session, today) {
  if (!["today", "previous"].includes(session)) {
    throw new Error("session 仅支持 today 或 previous");
  }
  const dates = [...new Set(series.bars.map((bar) => bar.time.slice(0, 10)))].sort();
  const date = session === "today" ? today : dates.filter((day) => day < today).at(-1);
  if (!date || !dates.includes(date)) {
    throw new Error(session === "today"
      ? `行情源未返回今日 ${today} 的分钟行情（可能尚未开盘、休市或源数据延迟），不会替换为其他日期`
      : "东方财富未返回前一交易日分钟行情");
  }
  return date;
}

export function assessReplaySession(bars, tradeDate, now = Date.now()) {
  const unique = new Map();
  // Ignore the currently forming minute; after 15:00 the closing bar is final.
  const cutoff = Math.floor(now / 60_000) * 60_000;
  for (const bar of bars) {
    const timestamp = Date.parse(bar.time);
    const minute = bar.time.slice(11, 16);
    if (bar.time.slice(0, 10) !== tradeDate || !Number.isFinite(timestamp)) {
      throw new Error("回放分钟行情日期不一致");
    }
    if (timestamp >= cutoff) continue;
    if (!((minute >= "09:30" && minute <= "11:30") || (minute >= "13:00" && minute <= "15:00"))) continue;
    if (![bar.open, bar.close, bar.high, bar.low].every((value) => Number.isFinite(value) && value > 0)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)
      || !Number.isFinite(bar.volume) || bar.volume < 0) {
      throw new Error("回放分钟行情价格或成交量无效");
    }
    if (unique.has(minute)) throw new Error(`回放分钟行情重复：${minute}`);
    unique.set(minute, bar);
  }
  const selected = [...unique.values()].sort((a, b) => a.time.localeCompare(b.time));
  if (selected.length < 2) throw new Error("已完成的真实分钟K线不足2根，请稍后重新载入");
  const expected = [];
  for (const [start, end] of [[571, 690], [781, 900]]) {
    for (let minute = start; minute <= end; minute++) {
      const label = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      if (Date.parse(`${tradeDate}T${label}:00+08:00`) < cutoff) expected.push(label);
    }
  }
  const missingMinutes = expected.filter((minute) => !unique.has(minute));
  const complete = expected.length === 240 && missingMinutes.length === 0;
  return {
    bars: selected,
    coverage: {
      complete,
      barCount: selected.length,
      firstTime: selected[0].time,
      lastTime: selected.at(-1).time,
      missingMinutes: missingMinutes.length,
      message: complete
        ? "全天分钟覆盖完整（240个连续交易分钟）"
        : `部分行情，仅回放已返回的真实K线；截至采集时缺少 ${missingMinutes.length} 个应有分钟，不补造数据`,
    },
  };
}
