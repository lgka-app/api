import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessStationHealth, parseStationCsv } from "../src/parsers/station";
import { composeWeather, type StationBlock } from "../src/jobs/weather";
import { mapOpenMeteo } from "../src/parsers/weather";
import { STATION_UNITS } from "../src/parsers/station";

const fx = (...p: string[]) => join(__dirname, "fixtures", ...p);

describe("school weather station", () => {
  const csv = readFileSync(fx("weather", "lg_wetter_heute_stale_2026-09-12.csv"), "utf8");

  it("parses one row per minute since midnight", () => {
    const r = parseStationCsv(csv, { sampleEveryMinutes: 10 });
    expect(r.rows).toBe(29);
    expect(r.latest).toEqual({ time: "00:28", windSpeed: 1.6, windDeg: 180, temp: 10.4, humidity: 66.6, precipitation: 0, pressure: 1001.5, radiation: 0 });
    expect(r.series.map((s) => s.time)).toEqual(["00:00", "00:10", "00:20", "00:28"]);
  });

  it("flags the real-world stale file (Last-Modified from June) as unhealthy", () => {
    const h = assessStationHealth({ lastModified: "Tue, 30 Jun 2026 15:29:17 GMT", rows: 29, minutesSinceMidnight: 900, now: Date.parse("2026-09-12T15:05:56Z") });
    expect(h.healthy).toBe(false);
    expect(h.reason).toMatch(/min old/);
  });

  it("accepts a fresh file whose row count matches the time of day", () => {
    const now = Date.parse("2026-09-12T13:00:00Z");
    expect(assessStationHealth({ lastModified: new Date(now - 60_000).toUTCString(), rows: 895, minutesSinceMidnight: 900, now })).toEqual({ healthy: true, reason: null });
    // right after midnight the file is tiny: row check skipped
    expect(assessStationHealth({ lastModified: new Date(now - 60_000).toUTCString(), rows: 3, minutesSinceMidnight: 4, now }).healthy).toBe(true);
    // fresh timestamp but the file was never reset at midnight
    expect(assessStationHealth({ lastModified: new Date(now - 60_000).toUTCString(), rows: 1400, minutesSinceMidnight: 300, now }).healthy).toBe(false);
  });

  it("composes current conditions from the station when healthy, Open-Meteo otherwise", () => {
    const forecast = mapOpenMeteo(JSON.parse(readFileSync(fx("weather", "openmeteo_2026-09-12.json"), "utf8")));
    const latest = parseStationCsv(csv).latest!;
    const healthy: StationBlock = { healthy: true, reason: null, updatedAt: "2026-09-12T13:00:00.000Z", rows: 29, latest, today: [latest], units: STATION_UNITS };
    const a = composeWeather(forecast, healthy);
    expect(a.source).toBe("school");
    expect(a.current.provider).toBe("school");
    expect(a.current.temp).toBe(10.4);
    expect(a.current.windSpeed).toBe(5.8); // 1.6 m/s → km/h
    expect(a.current.weatherCode).toBe(forecast.current.weatherCode); // forecast fills what the station lacks
    expect(a.hourly.length).toBe(72);

    const b = composeWeather(forecast, { ...healthy, healthy: false, reason: "file is 106000 min old", latest: null, today: [] });
    expect(b.source).toBe("open-meteo");
    expect(b.current).toEqual({ ...forecast.current, provider: "open-meteo" });
    expect(b.station.reason).toMatch(/old/);
  });
});
