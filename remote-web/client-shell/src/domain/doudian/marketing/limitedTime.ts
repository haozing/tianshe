export interface MarketingTimeSegment {
  startTime: string;
  endTime: string;
}

export function splitMarketingTimeSegments(startTime: string, endTime: string, segmentMinutes = 60): MarketingTimeSegment[] {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const step = Math.max(5, Math.floor(Number(segmentMinutes) || 60)) * 60_000;
  const result: MarketingTimeSegment[] = [];
  for (let cursor = start; cursor < end; cursor += step) {
    result.push({ startTime: new Date(cursor).toISOString(), endTime: new Date(Math.min(end, cursor + step)).toISOString() });
  }
  return result;
}
