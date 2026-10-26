export const V5_DEFAULTS = Object.freeze({
  climate_temp_delta_30m_c: 3,
  climate_humidity_delta_30m_pct: 20,
  climate_high_humidity_pct: 75,
  climate_low_humidity_pct: 25,
  condensation_margin_c: 2,
  bill_change_pct: 10,
  bill_change_uah: 50,
  sleep_start: "22:00",
  sleep_end: "07:00",
  event_group_window_min: 5,
  smart_digest_max_items: 3,
  climate_expected_interval_min: 5,
});

const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, v));
const round = (v, digits = 2) => +Number(v || 0).toFixed(digits);

export function explainHomeScore({ comfort, offline = 0, critical = 0, alerts = 0, energyRatio = null, voltageNormal = null }) {
  const comfortAvailable = comfort != null && comfort !== "" && Number.isFinite(Number(comfort)),
    comfortPoints = comfortAvailable ? clamp(Number(comfort)) * 0.65 : null,
    healthDeductions = Math.min(100, offline * 15 + critical * 20 + alerts * 3),
    health = clamp(100 - healthDeductions),
    components = [];
  if (comfortAvailable) components.push({ code: "climate", label: "Клімат", score: clamp(Number(comfort)), weight: 0.65, points: round(comfortPoints) });
  components.push({ code: "system", label: "Стан системи", score: health, weight: 0.35, points: round(health * 0.35) });
  const overall = clamp(Math.round(components.reduce((sum, c) => sum + c.points, 0) / components.reduce((sum, c) => sum + c.weight, 0)));
  const deductions = [];
  if (critical) deductions.push({ code: "critical_alerts", label: `${critical} критичних алертів`, points: Math.min(100, critical * 20), evidence: { count: critical } });
  if (offline) deductions.push({ code: "offline_sensors", label: `${offline} несвіжих/offline датчиків`, points: Math.min(100, offline * 15), evidence: { count: offline } });
  if (alerts) deductions.push({ code: "active_alerts", label: `${alerts} активних алертів`, points: Math.min(100, alerts * 3), evidence: { count: alerts } });
  if (comfortAvailable && Number(comfort) < 80) deductions.push({ code: "comfort", label: `Комфорт ${Math.round(Number(comfort))}/100`, points: round((100 - clamp(Number(comfort))) * 0.65), evidence: { comfort: Number(comfort) } });
  if (energyRatio != null && Number(energyRatio) > 1.2) deductions.push({ code: "energy_baseline", label: "Споживання вище базового", points: 6, evidence: { ratio: Number(energyRatio) } });
  const positives = voltageNormal ? [{ code: "voltage_normal", label: "Напруга в нормальному діапазоні", points: 5, evidence: { voltageNormal: true } }] : [];
  return { overall, comfort: comfortAvailable ? Math.round(Number(comfort)) : null, health, components, deductions, positives, confidence: comfortAvailable ? 100 : 35 };
}

export function calculateBillForecast({ dayKwh = 0, nightKwh = 0, dayRate = null, nightRate = null, sampleDayRate = null, sampleNightRate = null, elapsedDays = 1, daysInMonth = 30, actualCost = 0, previousMonthCost = null, coverage = 0 }) {
  const dayRateValue = dayRate ?? sampleDayRate, nightRateValue = nightRate ?? sampleNightRate,
    dr = dayRateValue == null || dayRateValue === "" ? NaN : Number(dayRateValue),
    nr = nightRateValue == null || nightRateValue === "" ? NaN : Number(nightRateValue);
  if (![dr, nr].every(Number.isFinite) || dr < 0 || nr < 0) return { available: false, reason: "Тарифи недоступні" };
  const elapsed = Math.max(1, Number(elapsedDays)), days = Math.max(elapsed, Number(daysInMonth));
  const forecastDayKwh = Number(dayKwh) / elapsed * days,
    forecastNightKwh = Number(nightKwh) / elapsed * days,
    forecastDayCost = forecastDayKwh * dr,
    forecastNightCost = forecastNightKwh * nr,
    forecastCost = forecastDayCost + forecastNightCost,
    confidence = elapsed >= 20 && coverage >= 0.8 ? "high" : elapsed >= 7 && coverage >= 0.5 ? "medium" : "low";
  return { available: true, actualCost: round(actualCost), forecastDayKwh: round(forecastDayKwh, 3), forecastNightKwh: round(forecastNightKwh, 3), forecastDayCost: round(forecastDayCost), forecastNightCost: round(forecastNightCost), forecastCost: round(forecastCost), previousMonthCost: previousMonthCost == null ? null : round(previousMonthCost), deltaCost: previousMonthCost == null ? null : round(forecastCost - Number(previousMonthCost)), confidence, coverage: clamp(Math.round(Number(coverage) * 100)) };
}

export function climateCandidates(samples, settings = {}, nowMs = Date.now()) {
  const byDevice = new Map();
  for (const s of samples) {
    const at = new Date(String(s.created_at).replace(" ", "T") + (String(s.created_at).endsWith("Z") ? "" : "Z")).getTime();
    if (!s.device_id || !Number.isFinite(at) || nowMs - at > 130 * 60000 || nowMs < at - 60000) continue;
    if (!Number.isFinite(Number(s.temperature)) || Number(s.temperature) < -50 || Number(s.temperature) > 80 || !Number.isFinite(Number(s.humidity)) || Number(s.humidity) < 0 || Number(s.humidity) > 100) continue;
    const list = byDevice.get(String(s.device_id)) || [];
    list.push({ ...s, at }); byDevice.set(String(s.device_id), list);
  }
  const results = [];
  for (const [id, list] of byDevice) {
    list.sort((a, b) => a.at - b.at);
    const latest = list.at(-1), recent = list.filter((x) => nowMs - x.at <= 30 * 60000);
    if (!recent.length || nowMs - latest.at > 15 * 60000) continue;
    const first30 = list.find((x) => x.at >= nowMs - 35 * 60000 && x.at <= nowMs - 25 * 60000),
      tempThreshold = Number(settings.climate_temp_delta_30m_c ?? 3), humThreshold = Number(settings.climate_humidity_delta_30m_pct ?? 20);
    if (first30 && recent.length >= 3) {
      const dt = Number(latest.temperature) - Number(first30.temperature), dh = Number(latest.humidity) - Number(first30.humidity);
      if (Math.abs(dt) >= tempThreshold) results.push({ key: `climate:temperature:${id}`, device_id: id, type: "temperature_change", value: round(dt, 1), first: Number(first30.temperature), current: Number(latest.temperature), samples: recent.length, timestamp: latest.created_at, severity: "warning" });
      if (dh >= humThreshold) results.push({ key: `climate:humidity_jump:${id}`, device_id: id, type: "humidity_jump", value: round(dh, 1), first: Number(first30.humidity), current: Number(latest.humidity), samples: recent.length, timestamp: latest.created_at, severity: "warning" });
    }
    const expectedInterval = Math.max(1, Number(settings.climate_expected_interval_min ?? 5)),
      last60 = list.filter((x) => nowMs - x.at <= 60 * 60000), coverage60 = last60.length / Math.max(1, 60 / expectedInterval);
    if (Number(latest.humidity) >= Number(settings.climate_high_humidity_pct ?? 75) && coverage60 >= 0.8)
      results.push({ key: `climate:high_humidity:${id}`, device_id: id, type: "high_humidity", value: Number(latest.humidity), samples: last60.length, coverage: round(coverage60, 2), timestamp: latest.created_at, severity: "warning" });
    const last120 = list.filter((x) => nowMs - x.at <= 120 * 60000), coverage120 = last120.length / Math.max(1, 120 / expectedInterval);
    if (Number(latest.humidity) <= Number(settings.climate_low_humidity_pct ?? 25) && coverage120 >= 0.8)
      results.push({ key: `climate:low_humidity:${id}`, device_id: id, type: "low_humidity", value: Number(latest.humidity), samples: last120.length, coverage: round(coverage120, 2), timestamp: latest.created_at, severity: "info" });
  }
  return results;
}

export function transitionAnomaly(previous, candidate, nowIso) {
  const state = previous?.status || "normal";
  if (candidate) {
    if (state === "normal") return { status: "pending", pending_since: nowIso, active: false };
    if (state === "pending") return { status: "active", pending_since: previous.pending_since, opened_at: nowIso, active: true };
    if (state === "recovering") return { status: "active", opened_at: previous.opened_at, active: true };
    return { status: "active", opened_at: previous.opened_at, active: true };
  }
  if (state === "active") return { status: "recovering", recovered_since: nowIso, active: false };
  if (state === "recovering") return { status: "normal", resolved_at: nowIso, active: false };
  return { status: "normal", active: false };
}

export function calculateSleepScore({ climate = null, reliability = null, energy = null, events = null }) {
  const values = { climate, reliability, energy, events },
    has = (v) => v != null && v !== "" && Number.isFinite(Number(v)),
    defs = [["climate", 40], ["reliability", 25], ["energy", 20], ["events", 15]],
    available = defs.filter(([k]) => has(values[k])),
    weight = available.reduce((s, [, w]) => s + w, 0);
  if (!weight) return { score: null, confidence: 0, components: defs.map(([key, max]) => ({ key, max, score: null, available: false })) };
  const score = Math.round(available.reduce((s, [k, w]) => s + clamp(Number(values[k]), 0, w), 0) / weight * 100);
  return { score: clamp(score), confidence: Math.round(weight), components: defs.map(([key, max]) => ({ key, max, score: has(values[key]) ? clamp(Number(values[key]), 0, max) : null, available: has(values[key]) })) };
}

export function fingerprint(value) {
  const input = JSON.stringify(value), hash = [...input].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export function shouldRefreshBill(previous, forecast, settings, date, tariffKey) {
  if (!previous?.active) return true;
  let meta = {};
  try { meta = JSON.parse(previous.metadata_json || "{}"); } catch {}
  if (meta.tariff_key !== tariffKey) return true;
  const old = Number(meta.forecast_cost), next = Number(forecast.forecastCost);
  if (!Number.isFinite(old) || !Number.isFinite(next)) return true;
  const delta = Math.abs(next - old), pct = old > 0 ? delta / old * 100 : (next > 0 ? 100 : 0);
  return delta >= Number(settings.bill_change_uah ?? 50) || pct >= Number(settings.bill_change_pct ?? 10);
}

export function shouldSuppressResolvedRecommendation(previous, nextFingerprint) {
  return Boolean(previous && !Number(previous.active) && previous.fingerprint === nextFingerprint && !String(previous.fingerprint).startsWith("cleared:"));
}
