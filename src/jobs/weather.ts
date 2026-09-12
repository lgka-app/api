// Weather: the school's rooftop station is the primary source for current
// conditions; Open-Meteo provides the forecast and is the fallback for current
// conditions whenever the station is unhealthy (stale file, missing rows,
// unreachable). Every refresh re-evaluates the station, so it takes over again
// automatically once it is back.
import type { AppEnv } from "../env";
import { berlinTime, nowIso } from "../lib/time";
import { assessStationHealth, parseStationCsv, STATION_UNITS, type StationSample } from "../parsers/station";
import { mapOpenMeteo, OPEN_METEO_URL, type CurrentWeather, type DailyForecast, type HourlyForecast } from "../parsers/weather";
import { fetchResource, schoolUrl, utf8, type Validators } from "../sources/http";
import { getResource, getState, putResource, putState } from "../store";
import type { JobResult } from "./types";

export const STATION_CSV = "/wetter/lg_wetter_heute.csv";
export type WeatherSource = "school" | "open-meteo";

export interface StationBlock {
  healthy: boolean;
  /** Why the station is not used right now (null when healthy). */
  reason: string | null;
  /** Upstream Last-Modified as ISO-8601, when known. */
  updatedAt: string | null;
  rows: number;
  latest: StationSample | null;
  /** Today's readings, 10-minute samples (empty when unhealthy). */
  today: StationSample[];
  units: typeof STATION_UNITS;
}

export interface WeatherData {
  /** Who provides `current`: the school station or Open-Meteo. */
  source: WeatherSource;
  sources: { current: WeatherSource; forecast: "open-meteo" };
  timezone: string;
  current: CurrentWeather & { provider: WeatherSource };
  hourly: HourlyForecast[];
  daily: DailyForecast[];
  station: StationBlock;
  attribution: string[];
}

interface State {
  station?: Validators & { lastCheckedAt?: string; lastError?: string | null };
  openMeteo?: { lastCheckedAt?: string; lastError?: string | null };
}

export async function refreshWeather(env: AppEnv): Promise<JobResult> {
  const state = (await getState<State>(env, "weather")) ?? {};
  const previous = (await getResource<WeatherData>(env, "weather"))?.data ?? null;
  const notes: string[] = [];

  // ---- Open-Meteo (forecast + fallback) ----
  let forecast: ReturnType<typeof mapOpenMeteo> | null = null;
  try {
    const res = await fetchResource(env, OPEN_METEO_URL, { timeoutMs: 15_000 });
    if (res.status !== 200 || !res.bytes) throw new Error(`HTTP ${res.status}`);
    forecast = mapOpenMeteo(JSON.parse(utf8(res.bytes)));
    state.openMeteo = { lastCheckedAt: nowIso(), lastError: null };
  } catch (e) {
    state.openMeteo = { lastCheckedAt: nowIso(), lastError: e instanceof Error ? e.message : String(e) };
    notes.push(`open-meteo: ${state.openMeteo.lastError}`);
  }

  // ---- school station ----
  let station: StationBlock = {
    healthy: false,
    reason: "not fetched",
    updatedAt: null,
    rows: 0,
    latest: null,
    today: [],
    units: STATION_UNITS,
  };
  try {
    // No validators on purpose: a 304 would hide a stale Last-Modified.
    const res = await fetchResource(env, schoolUrl(env, STATION_CSV), { timeoutMs: 15_000 });
    if (res.status !== 200 || !res.bytes) throw new Error(`HTTP ${res.status}`);
    const reading = parseStationCsv(utf8(res.bytes), { sampleEveryMinutes: 10 });
    const health = assessStationHealth({ lastModified: res.lastModified, rows: reading.rows, minutesSinceMidnight: berlinTime().minutesSinceMidnight });
    const updatedAt = res.lastModified && !Number.isNaN(Date.parse(res.lastModified)) ? new Date(res.lastModified).toISOString() : null;
    station = {
      healthy: health.healthy,
      reason: health.reason,
      updatedAt,
      rows: reading.rows,
      latest: health.healthy ? reading.latest : null,
      today: health.healthy ? reading.series : [],
      units: STATION_UNITS,
    };
    state.station = { etag: res.etag, lastModified: res.lastModified, lastCheckedAt: nowIso(), lastError: null };
    notes.push(`station: ${health.healthy ? "healthy" : `unhealthy (${health.reason})`}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    station = { ...station, reason: msg };
    state.station = { ...(state.station ?? {}), lastCheckedAt: nowIso(), lastError: msg };
    notes.push(`station: ${msg}`);
  }
  await putState(env, "weather", state);

  if (!forecast) {
    if (!previous) return { job: "weather", changed: false, error: "open-meteo unavailable and no previous data", notes };
    // keep last known forecast, but still reflect the station's state
    forecast = { timezone: previous.timezone, current: stripProvider(previous.current), hourly: previous.hourly, daily: previous.daily };
    notes.push("kept previous forecast");
  }

  const data = composeWeather(forecast, station);
  const put = await putResource(env, "weather", data, { sourceUpdatedAt: station.healthy ? station.updatedAt : forecast.current.dt });
  notes.unshift(`source=${data.source}`);
  return { job: "weather", changed: put.changed, hash: put.hash, notes };
}

function stripProvider(c: CurrentWeather & { provider?: WeatherSource }): CurrentWeather {
  const { provider: _p, ...rest } = c;
  return rest;
}

export function composeWeather(forecast: ReturnType<typeof mapOpenMeteo>, station: StationBlock): WeatherData {
  const useStation = station.healthy && station.latest !== null;
  const s = station.latest;
  const current: WeatherData["current"] = useStation && s
    ? {
        ...forecast.current,
        temp: s.temp,
        humidity: Math.round(s.humidity),
        windSpeed: Math.round(s.windSpeed * 3.6 * 10) / 10, // station m/s → km/h like Open-Meteo
        windDeg: s.windDeg,
        pressure: Math.round(s.pressure),
        dt: station.updatedAt ? berlinTime(new Date(station.updatedAt)).local : forecast.current.dt,
        provider: "school",
      }
    : { ...forecast.current, provider: "open-meteo" };
  return {
    source: current.provider,
    sources: { current: current.provider, forecast: "open-meteo" },
    timezone: forecast.timezone,
    current,
    hourly: forecast.hourly,
    daily: forecast.daily,
    station,
    attribution: useStation
      ? ["Aktuelle Werte: Wetterstation des Lessing-Gymnasiums", "Vorhersage: Open-Meteo.com (CC BY 4.0)"]
      : ["Wetterdaten: Open-Meteo.com (CC BY 4.0)"],
  };
}
