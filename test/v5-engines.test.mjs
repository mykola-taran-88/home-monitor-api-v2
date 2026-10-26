import test from "node:test";
import assert from "node:assert/strict";
import { calculateBillForecast, calculateSleepScore, climateCandidates, explainHomeScore, fingerprint, shouldRefreshBill, shouldSuppressResolvedRecommendation, transitionAnomaly } from "../src/v5/engines.js";

test("Home Score exposes deductions and keeps its score in range", () => {
  const result = explainHomeScore({ comfort: 76, offline: 4, critical: 1, alerts: 5 });
  assert.equal(result.overall, 51);
  assert.equal(result.deductions.find((x) => x.code === "offline_sensors").points, 60);
});

test("Home Score handles missing climate evidence", () => {
  const result = explainHomeScore({ comfort: null, offline: 0 });
  assert.equal(result.comfort, null);
  assert.equal(result.overall, 100);
  assert.equal(result.confidence, 35);
});

test("bill forecast separates day and night tariff and compares prior month", () => {
  const r = calculateBillForecast({ dayKwh: 100, nightKwh: 50, dayRate: 4, nightRate: 2, elapsedDays: 15, daysInMonth: 30, actualCost: 300, previousMonthCost: 500, coverage: 0.9 });
  assert.equal(r.forecastDayCost, 800);
  assert.equal(r.forecastNightCost, 200);
  assert.equal(r.forecastCost, 1000);
  assert.equal(r.deltaCost, 500);
  assert.equal(r.confidence, "medium");
});

test("bill forecast reports missing tariffs rather than inventing a total", () => {
  assert.equal(calculateBillForecast({ dayKwh: 10 }).available, false);
});

test("bill recommendation stays quiet below thresholds and refreshes on material change", () => {
  const previous = { active: 1, metadata_json: JSON.stringify({ date: "2026-10-26", tariff_key: "4/2", forecast_cost: 500 }) },
    settings = { bill_change_uah: 50, bill_change_pct: 10 };
  assert.equal(shouldRefreshBill(previous, { forecastCost: 520 }, settings, "2026-10-26", "4/2"), false);
  assert.equal(shouldRefreshBill(previous, { forecastCost: 560 }, settings, "2026-10-26", "4/2"), true);
  assert.equal(shouldRefreshBill(previous, { forecastCost: 510 }, settings, "2026-10-27", "4/2"), false);
  assert.equal(shouldRefreshBill(previous, { forecastCost: 510 }, settings, "2026-10-27", "4.5/2"), true);
});

test("sleep score renormalizes weights when a component is unavailable", () => {
  const r = calculateSleepScore({ climate: 30, reliability: 20, energy: null, events: null });
  assert.equal(r.score, 77);
  assert.equal(r.confidence, 65);
  assert.equal(r.components.find((x) => x.key === "energy").available, false);
  assert.equal(calculateSleepScore({}).score, null);
});

test("climate engine ignores stale and impossible sensor samples", () => {
  const now = Date.parse("2026-10-26T12:00:00Z"),
    samples = [
      { device_id: "room", created_at: "2026-10-26 11:30:00", temperature: 22, humidity: 45 },
      { device_id: "room", created_at: "2026-10-26 11:45:00", temperature: 20, humidity: 45 },
      { device_id: "room", created_at: "2026-10-26 11:55:00", temperature: 18.5, humidity: 46 },
      { device_id: "bad", created_at: "2026-10-26 11:55:00", temperature: 999, humidity: 40 },
    ],
    result = climateCandidates(samples, {}, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "climate:temperature:room");
  assert.equal(result[0].value, -3.5);
});

test("climate anomaly state requires persistence and supports recovery", () => {
  const p = transitionAnomaly(null, true, "2026-10-26T12:00:00Z");
  assert.equal(p.status, "pending");
  const a = transitionAnomaly(p, true, "2026-10-26T12:05:00Z");
  assert.equal(a.status, "active");
  assert.equal(transitionAnomaly(a, false, "2026-10-26T12:10:00Z").status, "recovering");
});

test("recommendation fingerprint is stable for equivalent evidence", () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ value: 1 }), fingerprint({ value: 2 }));
});

test("completed recommendation stays suppressed until its condition clears", () => {
  const done={active:0,fingerprint:"abc12345"};
  assert.equal(shouldSuppressResolvedRecommendation(done,"abc12345"),true);
  assert.equal(shouldSuppressResolvedRecommendation({...done,fingerprint:"cleared:abc12345"},"abc12345"),false);
  assert.equal(shouldSuppressResolvedRecommendation({...done,fingerprint:"abc12345"},"changed"),false);
});
