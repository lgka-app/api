// Open-Meteo → the app's weather model. Timestamps stay in Open-Meteo's local
// (Europe/Berlin) "YYYY-MM-DDTHH:MM" form; the apps already parse that.

export interface CurrentWeather {
  temp: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  windDeg: number;
  windGust: number;
  pressure: number;
  clouds: number;
  visibility: number;
  uvi: number;
  weatherCode: number;
  isDay: boolean;
  dt: string;
}
export interface HourlyForecast {
  dt: string;
  temp: number;
  humidity: number;
  windSpeed: number;
  windDeg: number;
  /** 0..1 */
  pop: number;
  weatherCode: number;
  isDay: boolean;
}
export interface DailyForecast {
  dt: string;
  sunrise: string;
  sunset: string;
  tempMax: number;
  tempMin: number;
  pop: number;
  uvi: number;
  windSpeed: number;
  weatherCode: number;
}
export interface WeatherData {
  timezone: string;
  current: CurrentWeather;
  /** All forecast hours (3 days). Apps window this to [now, +24h). */
  hourly: HourlyForecast[];
  daily: DailyForecast[];
}

// LGKA school, Karlsruhe (49.00775°N, 8.375°E), elevation 122 m.
export const OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=49.00775&longitude=8.375&elevation=122" +
  "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m" +
  ",pressure_msl,cloud_cover,visibility,uv_index,is_day" +
  "&hourly=temperature_2m,relative_humidity_2m,weather_code,precipitation_probability,wind_speed_10m,wind_direction_10m,is_day" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max,sunrise,sunset" +
  "&timezone=Europe%2FBerlin&forecast_days=3";

type Json = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function mapOpenMeteo(json: Json): WeatherData {
  const c = json.current as Json;
  const current: CurrentWeather = {
    temp: num(c.temperature_2m),
    feelsLike: num(c.apparent_temperature),
    humidity: num(c.relative_humidity_2m),
    windSpeed: num(c.wind_speed_10m),
    windDeg: num(c.wind_direction_10m),
    windGust: num(c.wind_gusts_10m),
    pressure: Math.round(num(c.pressure_msl)),
    clouds: num(c.cloud_cover),
    visibility: num(c.visibility),
    uvi: num(c.uv_index),
    weatherCode: num(c.weather_code),
    isDay: c.is_day === 1,
    dt: String(c.time),
  };

  const h = json.hourly as Json;
  const times = list(h.time);
  const hourly: HourlyForecast[] = times.map((t, i) => ({
    dt: String(t),
    temp: num(list(h.temperature_2m)[i]),
    humidity: num(list(h.relative_humidity_2m)[i]),
    windSpeed: num(list(h.wind_speed_10m)[i]),
    windDeg: num(list(h.wind_direction_10m)[i]),
    pop: num(list(h.precipitation_probability)[i]) / 100,
    weatherCode: num(list(h.weather_code)[i]),
    isDay: list(h.is_day)[i] === 1,
  }));

  const d = json.daily as Json;
  const daily: DailyForecast[] = list(d.time).map((t, i) => ({
    dt: String(t),
    sunrise: String(list(d.sunrise)[i]),
    sunset: String(list(d.sunset)[i]),
    tempMax: num(list(d.temperature_2m_max)[i]),
    tempMin: num(list(d.temperature_2m_min)[i]),
    pop: num(list(d.precipitation_probability_max)[i]) / 100,
    uvi: num(list(d.uv_index_max)[i]),
    windSpeed: num(list(d.wind_speed_10m_max)[i]),
    weatherCode: num(list(d.weather_code)[i]),
  }));

  return { timezone: String(json.timezone ?? "Europe/Berlin"), current, hourly, daily };
}

/** The app's hourly window: [start of referenceNow's hour, +24h). referenceNow is local "YYYY-MM-DDTHH:MM[:SS]". */
export function windowHourly(hourly: HourlyForecast[], referenceNow: string, hours = 24): HourlyForecast[] {
  const start = referenceNow.slice(0, 13) + ":00";
  const startDate = new Date(start + ":00Z");
  const end = new Date(startDate.getTime() + hours * 3_600_000).toISOString().slice(0, 16);
  return hourly.filter((h) => h.dt >= start && h.dt < end);
}
