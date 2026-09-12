// The school's rooftop weather station publishes /wetter/lg_wetter_heute.csv:
// a header row followed by one row per minute since local midnight (there is
// no timestamp column — row N is minute N of today). Freshness therefore
// comes from the HTTP Last-Modified header plus a row-count plausibility check.
//
//   Windgeschwindigkeit;Windrichtung;Temperatur;relative Feuchte;Niederschlag;Luftdruck;Strahlung
//   1.2;180;11.0;71.0;0.0;1000.9;0.0

export interface StationSample {
  /** HH:MM local (minute of day). */
  time: string;
  windSpeed: number; // m/s (as published)
  windDeg: number;
  temp: number; // °C
  humidity: number; // %
  precipitation: number; // mm
  pressure: number; // hPa
  radiation: number; // W/m²
}

export interface StationReading {
  rows: number;
  latest: StationSample | null;
  /** Down-sampled series for charts. */
  series: StationSample[];
}

export const STATION_UNITS = {
  windSpeed: "m/s",
  windDeg: "°",
  temp: "°C",
  humidity: "%",
  precipitation: "mm",
  pressure: "hPa",
  radiation: "W/m²",
} as const;

export function parseStationCsv(csv: string, opts: { sampleEveryMinutes?: number } = {}): StationReading {
  const step = Math.max(1, opts.sampleEveryMinutes ?? 10);
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const samples: StationSample[] = [];
  let minute = 0;
  for (let i = 1; i < lines.length; i++, minute++) {
    const cells = lines[i]!.split(";").map((c) => Number(c.trim().replace(",", ".")));
    if (cells.length < 7 || cells.some((n) => Number.isNaN(n))) continue;
    samples.push({
      time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
      windSpeed: cells[0]!,
      windDeg: Math.round(cells[1]!),
      temp: cells[2]!,
      humidity: cells[3]!,
      precipitation: cells[4]!,
      pressure: cells[5]!,
      radiation: cells[6]!,
    });
  }
  const latest = samples.at(-1) ?? null;
  const series = samples.filter((_, i) => i % step === 0);
  if (latest && series.at(-1) !== latest) series.push(latest);
  return { rows: samples.length, latest, series };
}

export interface StationHealth {
  healthy: boolean;
  reason: string | null;
}

/**
 * Healthy when the file was modified within `maxAgeMinutes` and its row count
 * roughly matches the current minute of the day (the station appends a row a
 * minute). Right after midnight the row check is skipped.
 */
export function assessStationHealth(
  args: { lastModified: string | null; rows: number; minutesSinceMidnight: number; now?: number },
  maxAgeMinutes = 20,
  rowTolerance = 30,
): StationHealth {
  if (!args.lastModified) return { healthy: false, reason: "no Last-Modified header" };
  const modified = Date.parse(args.lastModified);
  if (Number.isNaN(modified)) return { healthy: false, reason: "unparseable Last-Modified" };
  const ageMin = ((args.now ?? Date.now()) - modified) / 60_000;
  if (ageMin > maxAgeMinutes) return { healthy: false, reason: `file is ${Math.round(ageMin)} min old` };
  if (args.rows === 0) return { healthy: false, reason: "no data rows" };
  if (args.minutesSinceMidnight > rowTolerance && Math.abs(args.rows - args.minutesSinceMidnight) > rowTolerance) {
    return { healthy: false, reason: `${args.rows} rows but minute ${args.minutesSinceMidnight} of day` };
  }
  return { healthy: true, reason: null };
}
