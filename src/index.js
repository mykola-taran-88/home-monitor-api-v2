// @ts-nocheck
// GitHub transition: API version updated to 5.6.1 in the repository.
// Home Monitor API v5.6.1 Display Layer - backward-compatible facade for ESP32-2432S028
// Worker: smart-home-api-v2
// Required binding: DB
// Optional secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
const API_VERSION = "5.6.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key",
};
const json = (data, status = 200, cacheControl = "no-store") =>
  Response.json(data, {
    status,
    headers: { ...CORS, "Cache-Control": cacheControl },
  });
async function cachedJson(request, ttl, producer) {
  const cache = caches.default,
    key = new Request(request.url, { method: "GET" }),
    hit = await cache.match(key);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set("X-Home-Monitor-Cache", "HIT");
    return new Response(hit.body, { status: hit.status, headers: h });
  }
  const data = await producer(),
    response = json(data, 200, `public, max-age=${ttl}, s-maxage=${ttl}`),
    stored = new Response(response.body, {
      status: response.status,
      headers: new Headers(response.headers),
    });
  stored.headers.set("X-Home-Monitor-Cache", "MISS");
  await cache.put(key, stored.clone());
  return stored;
}
async function cachedResponse(request, ttl, producer) {
  const cache = caches.default,
    key = new Request(request.url, { method: "GET" }),
    hit = await cache.match(key);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set("X-Home-Monitor-Cache", "HIT");
    return new Response(hit.body, { status: hit.status, headers: h });
  }
  const response = await producer();
  if (response.status !== 200) return response;
  const h = new Headers(response.headers);
  h.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
  h.set("X-Home-Monitor-Cache", "MISS");
  const stored = new Response(response.body, {
    status: response.status,
    headers: h,
  });
  await cache.put(key, stored.clone());
  return stored;
}
const enc = new TextEncoder();
const hex = (b) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) =>
  hex(await crypto.subtle.digest("SHA-256", enc.encode(String(s))));
const token = () => {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, "");
};
async function ensureV3(env) {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS admin_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT UNIQUE NOT NULL,role TEXT DEFAULT 'owner',created_at DATETIME DEFAULT CURRENT_TIMESTAMP,expires_at DATETIME NOT NULL,last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS admin_audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,session_hash TEXT,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT,old_value_json TEXT,new_value_json TEXT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS admin_login_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,ip_hash TEXT,success INTEGER DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS dashboard_preferences(pref_key TEXT PRIMARY KEY,pref_value TEXT,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS home_score_history(id INTEGER PRIMARY KEY AUTOINCREMENT,comfort_score INTEGER,energy_score INTEGER,weather_score INTEGER,device_score INTEGER,overall_score INTEGER,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_timeline_created ON home_timeline(created_at)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_outages_start ON outages(outage_start)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_score_history_created ON home_score_history(created_at)",
    ),
  ]);
}
async function session(req, env) {
  const h = req.headers.get("Authorization") || "",
    raw = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!raw) return null;
  const th = await sha256(raw),
    row = await env.DB.prepare(
      "SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>CURRENT_TIMESTAMP",
    )
      .bind(th)
      .first();
  if (row)
    await env.DB.prepare(
      "UPDATE admin_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(row.id)
      .run();
  return row ? { ...row, hash: th } : null;
}
async function audit(env, s, action, type, id, oldValue, newValue) {
  await env.DB.prepare(
    "INSERT INTO admin_audit_log(session_hash,action,entity_type,entity_id,old_value_json,new_value_json) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      s?.hash || null,
      action,
      type,
      String(id ?? ""),
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
    )
    .run();
}
async function body(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
const safeSettingKeys = new Set([
  "timezone",
  "city",
  "latitude",
  "longitude",
  "day_tariff",
  "night_tariff",
  "day_start",
  "night_start",
  "device_timeout_minutes",
  "max_power_alert_watts",
  "voltage_low_alert",
  "voltage_high_alert",
  "default_temp_low",
  "default_temp_high",
  "default_humidity_high",
  "rain_alert_probability",
  "ventilation_humidity_threshold",
  "telegram_enabled",
]);
const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const sqlDate = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const parseDbDate = (v) => new Date(String(v || "").replace(" ", "T") + "Z");
const ageMin = (v) =>
  v
    ? Math.max(0, Math.floor((Date.now() - parseDbDate(v).getTime()) / 60000))
    : null;
const dewPoint = (t, h) =>
  t == null || h == null || h <= 0
    ? null
    : +(
        (243.12 * (Math.log(h / 100) + (17.62 * t) / (243.12 + t))) /
        (17.62 - Math.log(h / 100) - (17.62 * t) / (243.12 + t))
      ).toFixed(2);
const comfort = (t, h, id = "") =>
  clamp(
    100 -
      Math.abs(n(t) - (id === "bedroom" ? 20 : 22.5)) * 9 -
      Math.abs(n(h) - 50) * 1.2 -
      (h > 70 || h < 25 ? 10 : 0),
  );
const weatherIcon = (c) => {
  c = +c;
  if (c === 0) return "☀️";
  if (c <= 3) return "⛅";
  if (c === 45 || c === 48) return "🌫️";
  if (c <= 67) return "🌧️";
  if (c <= 77) return "❄️";
  if (c <= 82) return "🌦️";
  if (c <= 86) return "🌨️";
  return "⛈️";
};
const weatherText = (c) =>
  ({
    0: "Ясно",
    1: "Малохмарно",
    2: "Мінлива хмарність",
    3: "Хмарно",
    45: "Туман",
    48: "Туман із памороззю",
    51: "Легка мряка",
    53: "Мряка",
    55: "Сильна мряка",
    61: "Невеликий дощ",
    63: "Дощ",
    65: "Сильний дощ",
    71: "Слабкий сніг",
    73: "Сніг",
    75: "Сильний сніг",
    80: "Невеликі зливи",
    81: "Зливи",
    82: "Сильні зливи",
    85: "Снігопад",
    86: "Сильний снігопад",
    95: "Гроза",
    96: "Гроза з градом",
    99: "Сильна гроза з градом",
  })[+c] || "Невідомо";
const localDate = (d, tz = "Europe/Kyiv") =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
const localHour = (tz = "Europe/Kyiv") =>
  +new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
const dayLabel = (s, tz = "Europe/Kyiv") =>
  s === localDate(new Date(), tz)
    ? "Сьогодні"
    : s === localDate(new Date(Date.now() + 86400000), tz)
      ? "Завтра"
      : new Intl.DateTimeFormat("uk-UA", {
          timeZone: tz,
          weekday: "long",
        }).format(new Date(s + "T12:00:00Z"));

async function settings(env, keys) {
  if (!keys.length) return {};
  const q = keys.map(() => "?").join(","),
    r = await env.DB.prepare(
      `SELECT setting_key,setting_value FROM settings WHERE setting_key IN (${q})`,
    )
      .bind(...keys)
      .all();
  return Object.fromEntries(
    r.results.map((x) => [x.setting_key, x.setting_value]),
  );
}
async function authorized(req, env) {
  const row = await env.DB.prepare(
    "SELECT setting_value FROM settings WHERE setting_key='api_key'",
  ).first();
  return Boolean(row && req.headers.get("X-API-Key") === row.setting_value);
}
async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const enabled = await settings(env, ["telegram_enabled"]);
  if (enabled.telegram_enabled !== "1") return false;
  const r = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    },
  );
  if (!r.ok) throw Error(`Telegram ${r.status}`);
  return true;
}

async function latestZones(env) {
  return (
    await env.DB.prepare(
      "SELECT d.device_id,d.device_name,d.is_outdoor,c.temperature,c.humidity,c.wifi_rssi,c.created_at FROM devices d LEFT JOIN climate_logs c ON c.id=(SELECT MAX(id) FROM climate_logs x WHERE x.device_id=d.device_id) WHERE d.device_type='climate' AND d.enabled=1",
    ).all()
  ).results;
}
async function latestBundle(env) {
  const [zones, power, weather, alerts, recs] = await Promise.all([
    latestZones(env),
    env.DB.prepare("SELECT * FROM power_logs ORDER BY id DESC LIMIT 1").first(),
    env.DB.prepare(
      "SELECT wc.*,x.dew_point FROM weather_current wc LEFT JOIN weather_cache x ON x.id=(SELECT MAX(id) FROM weather_cache) ORDER BY wc.id DESC LIMIT 1",
    ).first(),
    env.DB.prepare(
      "SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC",
    ).all(),
    env.DB.prepare(
      "SELECT * FROM recommendations WHERE status='active' ORDER BY score DESC LIMIT 20",
    ).all(),
  ]);
  return { zones, power, weather, alerts: alerts.results, recs: recs.results };
}

async function tariff(env) {
  const s = await settings(env, [
      "timezone",
      "day_tariff",
      "night_tariff",
      "day_start",
      "night_start",
    ]),
    tz = s.timezone || "Europe/Kyiv",
    time = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date()),
    ns = s.night_start || "23:00",
    ds = s.day_start || "07:00",
    night = ns < ds ? time >= ns && time < ds : time >= ns || time < ds;
  return {
    zone: night ? "night" : "day",
    cost: n(night ? s.night_tariff : s.day_tariff),
    time,
  };
}
async function periodStats(env, start) {
  const r = await env.DB.prepare(
    "SELECT energy_total,tariff_zone,cost_per_kwh,created_at FROM power_logs WHERE created_at>=? OR id=(SELECT id FROM power_logs WHERE created_at<? ORDER BY created_at DESC LIMIT 1) ORDER BY created_at",
  )
    .bind(start, start)
    .all();
  let day = 0,
    night = 0,
    costDay = 0,
    costNight = 0;
  for (let i = 1; i < r.results.length; i++) {
    if (String(r.results[i].created_at) < start) continue;
    const d = n(r.results[i].energy_total) - n(r.results[i - 1].energy_total);
    if (!Number.isFinite(d) || d < 0) continue;
    const cost = d * n(r.results[i].cost_per_kwh);
    if (r.results[i].tariff_zone === "night") {
      night += d;
      costNight += cost;
    } else {
      day += d;
      costDay += cost;
    }
  }
  return {
    energy_total: +(day + night).toFixed(3),
    energy_day: +day.toFixed(3),
    energy_night: +night.toFixed(3),
    cost_day: +costDay.toFixed(2),
    cost_night: +costNight.toFixed(2),
    cost_total: +(costDay + costNight).toFixed(2),
    samples: r.results.length,
  };
}
function kyivOffsetMinutes(d = new Date()) {
  const z =
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Kyiv",
        timeZoneName: "shortOffset",
      })
        .formatToParts(d)
        .find((x) => x.type === "timeZoneName")?.value || "GMT+2",
    m = z.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + (+m[3] || 0)) : 120;
}
function periodStarts() {
  const now = new Date(),
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Kyiv",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(now)
        .filter((x) => x.type !== "literal")
        .map((x) => [x.type, x.value]),
    ),
    off = kyivOffsetMinutes(now),
    toSql = (d) => new Date(d).toISOString().slice(0, 19).replace("T", " "),
    todayUtc =
      Date.UTC(+parts.year, +parts.month - 1, +parts.day) - off * 60000,
    monthUtc = Date.UTC(+parts.year, +parts.month - 1, 1) - off * 60000;
  return {
    today: toSql(todayUtc),
    month: toSql(monthUtc),
    timezone: "Europe/Kyiv",
    offset_minutes: off,
  };
}
async function powerStats(env) {
  const p = periodStarts(),
    [today, month] = await Promise.all([
      periodStats(env, p.today),
      periodStats(env, p.month),
    ]);
  return { today, month };
}

async function setAlert(env, a) {
  const old = await env.DB.prepare(
    "SELECT * FROM alerts WHERE alert_key=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
  )
    .bind(a.key)
    .first();
  if (a.active && !old) {
    const r = await env.DB.prepare(
      "INSERT INTO alerts(device_id,alert_key,alert_type,alert_message,severity,alert_value,alert_threshold,is_read) VALUES(?,?,?,?,?,?,?,0)",
    )
      .bind(
        a.device || null,
        a.key,
        a.type,
        a.message,
        a.severity || "warning",
        a.value ?? null,
        a.threshold ?? null,
      )
      .run();
    try {
      if (await telegram(env, a.message))
        await env.DB.prepare(
          "UPDATE alerts SET notified_at=CURRENT_TIMESTAMP WHERE id=?",
        )
          .bind(r.meta.last_row_id)
          .run();
    } catch (e) {
      console.error("TELEGRAM_ALERT", e.message);
    }
  } else if (!a.active && old)
    await env.DB.prepare(
      "UPDATE alerts SET resolved_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(old.id)
      .run();
}
async function evaluateAlerts(env) {
  const s = await settings(env, [
      "device_timeout_minutes",
      "max_power_alert_watts",
      "voltage_low_alert",
      "voltage_high_alert",
      "default_temp_low",
      "default_temp_high",
      "default_humidity_high",
    ]),
    timeout = n(s.device_timeout_minutes, 15),
    zones = await latestZones(env);
  for (const z of zones) {
    const offline =
      ageMin(z.created_at) == null || ageMin(z.created_at) > timeout;
    await setAlert(env, {
      key: `offline:${z.device_id}`,
      device: z.device_id,
      type: "device_offline",
      active: offline,
      message: `⚠️ ${z.device_name}: немає даних понад ${timeout} хв.`,
    });
    if (offline || z.is_outdoor) continue;
    await setAlert(env, {
      key: `temp-low:${z.device_id}`,
      device: z.device_id,
      type: "temperature_low",
      active: z.temperature < n(s.default_temp_low, 18),
      value: z.temperature,
      threshold: n(s.default_temp_low, 18),
      message: `🥶 ${z.device_name}: ${z.temperature}°C`,
    });
    await setAlert(env, {
      key: `temp-high:${z.device_id}`,
      device: z.device_id,
      type: "temperature_high",
      active: z.temperature > n(s.default_temp_high, 28),
      value: z.temperature,
      threshold: n(s.default_temp_high, 28),
      message: `🥵 ${z.device_name}: ${z.temperature}°C`,
    });
    await setAlert(env, {
      key: `hum-high:${z.device_id}`,
      device: z.device_id,
      type: "humidity_high",
      active: z.humidity > n(s.default_humidity_high, 70),
      value: z.humidity,
      threshold: n(s.default_humidity_high, 70),
      message: `💧 ${z.device_name}: ${z.humidity}%`,
    });
  }
  const p = await env.DB.prepare(
    "SELECT * FROM power_logs ORDER BY id DESC LIMIT 1",
  ).first();
  if (p) {
    await setAlert(env, {
      key: "power-offline",
      device: p.device_id,
      type: "device_offline",
      active: ageMin(p.created_at) > timeout,
      severity: "critical",
      message: `⚠️ Power Meter: немає даних понад ${timeout} хв.`,
    });
    await setAlert(env, {
      key: "overload",
      device: p.device_id,
      type: "power_overload",
      active: p.power > n(s.max_power_alert_watts, 5000),
      severity: "critical",
      value: p.power,
      threshold: n(s.max_power_alert_watts, 5000),
      message: `🔥 Потужність ${p.power} Вт`,
    });
    await setAlert(env, {
      key: "voltage-low",
      device: p.device_id,
      type: "voltage_low",
      active: p.voltage < n(s.voltage_low_alert, 200),
      severity: "critical",
      value: p.voltage,
      threshold: n(s.voltage_low_alert, 200),
      message: `⚡ Низька напруга ${p.voltage} В`,
    });
    await setAlert(env, {
      key: "voltage-high",
      device: p.device_id,
      type: "voltage_high",
      active: p.voltage > n(s.voltage_high_alert, 250),
      severity: "critical",
      value: p.voltage,
      threshold: n(s.voltage_high_alert, 250),
      message: `⚡ Висока напруга ${p.voltage} В`,
    });
  }
}

async function recommendations(env) {
  const s = await settings(env, [
      "device_timeout_minutes",
      "max_power_alert_watts",
      "rain_alert_probability",
      "ventilation_humidity_threshold",
    ]),
    timeout = n(s.device_timeout_minutes, 15),
    data = await latestBundle(env),
    stats = await powerStats(env),
    rows = [],
    add = (x) =>
      rows.push({
        ...x,
        confidence: x.confidence ?? 0.8,
        score:
          ({ critical: 100, high: 75, medium: 50, low: 25, info: 0 }[
            x.priority
          ] || 0) + 20,
      });
  const indoor = data.zones.filter(
      (x) => !x.is_outdoor && x.temperature != null,
    ),
    outside =
      data.zones.find((x) => x.is_outdoor && x.temperature != null) ||
      data.weather;
  for (const z of indoor) {
    if (ageMin(z.created_at) == null || ageMin(z.created_at) > timeout) {
      add({
        key: `offline:${z.device_id}`,
        category: "device_health",
        priority: "high",
        title: "Датчик offline",
        message: `${z.device_name}: немає оновлень понад ${timeout} хв.`,
        action: "Перевірити живлення та Wi-Fi",
        room_id: z.device_id,
      });
      continue;
    }
    const score = comfort(z.temperature, z.humidity, z.device_id),
      insideDew = dewPoint(z.temperature, z.humidity),
      outsideDew = outside
        ? dewPoint(outside.temperature, outside.humidity)
        : null;
    if (score < 65)
      add({
        key: `comfort:${z.device_id}`,
        category: "comfort",
        priority: score < 45 ? "high" : "medium",
        title: "Низький комфорт",
        message: `${z.device_name}: ${score}/100, ${z.temperature}°C, ${z.humidity}%.`,
        action: "Скоригувати клімат",
        room_id: z.device_id,
      });
    if (
      z.humidity >= n(s.ventilation_humidity_threshold, 65) &&
      outsideDew != null &&
      insideDew - outsideDew >= 2 &&
      outside.temperature > 3
    )
      add({
        key: `ventilate:${z.device_id}`,
        category: "ventilation",
        priority: "high",
        title: "Провітріть кімнату",
        message: `${z.device_name}: зовнішнє повітря сухіше.`,
        action: "Відкрити вікно на 5–10 хв",
        room_id: z.device_id,
      });
    if (z.humidity > 75 && z.temperature - insideDew < 4)
      add({
        key: `mold:${z.device_id}`,
        category: "condensation",
        priority: "critical",
        title: "Ризик конденсату",
        message: `${z.device_name}: підвищений ризик плісняви.`,
        action: "Провітрити й перевірити холодні поверхні",
        room_id: z.device_id,
      });
  }
  if (data.power && data.power.power > n(s.max_power_alert_watts, 5000) * 0.85)
    add({
      key: "load",
      category: "energy",
      priority:
        data.power.power > n(s.max_power_alert_watts, 5000)
          ? "critical"
          : "high",
      title: "Високе навантаження",
      message: `${data.power.power} Вт`,
      action: "Вимкнути некритичні прилади",
    });
  const day = Math.max(1, +localDate(new Date()).slice(8, 10)),
    days = new Date(
      new Date().getFullYear(),
      new Date().getMonth() + 1,
      0,
    ).getDate(),
    estimate = +((stats.month.cost_total / day) * days).toFixed(2);
  add({
    key: "bill",
    category: "cost",
    priority: "info",
    title: "Прогноз рахунку",
    message: `Близько ${estimate} грн за місяць.`,
    action: "Переглянути пікові години",
  });
  rows.sort((a, b) => b.score - a.score);
  await env.DB.prepare(
    "UPDATE recommendations SET status='expired',resolved_at=CURRENT_TIMESTAMP WHERE status='active'",
  ).run();
  if (rows.length)
    await env.DB.batch(
      rows.map((x) =>
        env.DB.prepare(
          "INSERT INTO recommendations(recommendation_key,category,priority,title,message,action,source,room_id,score,confidence,status,expires_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,'active',datetime('now','+2 hours'),'{}')",
        ).bind(
          x.key,
          x.category,
          x.priority,
          x.title,
          x.message,
          x.action || null,
          "engine",
          x.room_id || null,
          x.score,
          x.confidence,
        ),
      ),
    );
  const alerts = data.alerts,
    offline = data.zones.filter(
      (z) => ageMin(z.created_at) == null || ageMin(z.created_at) > timeout,
    ).length,
    cs = indoor.length
      ? Math.round(
          indoor.reduce(
            (sum, z) => sum + comfort(z.temperature, z.humidity, z.device_id),
            0,
          ) / indoor.length,
        )
      : 0,
    health = clamp(
      100 -
        offline * 15 -
        alerts.filter((a) => a.severity === "critical").length * 20 -
        alerts.length * 3,
    );
  return {
    scores: {
      comfort: cs,
      home_health: health,
      overall: clamp(cs * 0.65 + health * 0.35),
    },
    room_ranking: indoor
      .map((z) => ({
        device_id: z.device_id,
        name: z.device_name,
        temperature: z.temperature,
        humidity: z.humidity,
        comfort_score: comfort(z.temperature, z.humidity, z.device_id),
      }))
      .sort((a, b) => b.comfort_score - a.comfort_score),
    energy_forecast: { month_cost: estimate },
    recommendations: rows,
  };
}

async function homeScoreSnapshot(env) {
  const s = await settings(env, ["device_timeout_minutes"]),
    timeout = n(s.device_timeout_minutes, 15),
    data = await latestBundle(env),
    stats = await powerStats(env),
    indoor = data.zones.filter((x) => !x.is_outdoor && x.temperature != null),
    offline = data.zones.filter(
      (z) => ageMin(z.created_at) == null || ageMin(z.created_at) > timeout,
    ).length,
    cs = indoor.length
      ? Math.round(
          indoor.reduce(
            (sum, z) => sum + comfort(z.temperature, z.humidity, z.device_id),
            0,
          ) / indoor.length,
        )
      : 0,
    health = clamp(
      100 -
        offline * 15 -
        data.alerts.filter((a) => a.severity === "critical").length * 20 -
        data.alerts.length * 3,
    ),
    day = Math.max(1, +localDate(new Date()).slice(8, 10)),
    days = new Date(
      new Date().getFullYear(),
      new Date().getMonth() + 1,
      0,
    ).getDate(),
    estimate = +((stats.month.cost_total / day) * days).toFixed(2);
  return {
    scores: {
      comfort: cs,
      home_health: health,
      overall: clamp(cs * 0.65 + health * 0.35),
    },
    room_ranking: indoor
      .map((z) => ({
        device_id: z.device_id,
        name: z.device_name,
        temperature: z.temperature,
        humidity: z.humidity,
        comfort_score: comfort(z.temperature, z.humidity, z.device_id),
      }))
      .sort((a, b) => b.comfort_score - a.comfort_score),
    energy_forecast: { month_cost: estimate },
    recommendations: data.recs,
  };
}
async function updateWeather(env) {
  const s = await settings(env, ["latitude", "longitude", "city", "timezone"]),
    tz = s.timezone || "Europe/Kyiv";
  if (!s.latitude || !s.longitude)
    throw Error("Missing latitude/longitude settings");
  const p = new URLSearchParams({
      latitude: s.latitude,
      longitude: s.longitude,
      current:
        "temperature_2m,relative_humidity_2m,weather_code,pressure_msl,wind_speed_10m",
      hourly:
        "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m",
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
      timezone: tz,
      forecast_days: "7",
    }),
    r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
  if (!r.ok) throw Error(`Open-Meteo ${r.status}`);
  const w = await r.json(),
    dp = dewPoint(w.current.temperature_2m, w.current.relative_humidity_2m),
    today = localDate(new Date(), tz),
    tomorrow = localDate(new Date(Date.now() + 86400000), tz),
    dayAfterTomorrow = localDate(new Date(Date.now() + 2 * 86400000), tz),
    hourly = w.hourly.time
      .map((time, i) => ({
        time,
        temp: w.hourly.temperature_2m[i],
        hum: w.hourly.relative_humidity_2m[i],
        prob: w.hourly.precipitation_probability[i],
        rain: w.hourly.precipitation[i],
        code: w.hourly.weather_code[i],
        wind: w.hourly.wind_speed_10m[i],
      }))
      .filter(
        (x) =>
          [today, tomorrow, dayAfterTomorrow].some((date) =>
            x.time.startsWith(date),
          ) &&
          +x.time.slice(11, 13) % 3 === 0,
      ),
    daily = w.daily.time.map((date, i) => ({
      date,
      min: w.daily.temperature_2m_min[i],
      max: w.daily.temperature_2m_max[i],
      prob: w.daily.precipitation_probability_max[i],
      sum: w.daily.precipitation_sum[i],
      code: w.daily.weather_code[i],
    }));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM weather_current"),
    env.DB.prepare(
      "INSERT INTO weather_current(temperature,humidity,wind_speed,pressure,weather_code) VALUES(?,?,?,?,?)",
    ).bind(
      w.current.temperature_2m,
      w.current.relative_humidity_2m,
      w.current.wind_speed_10m,
      w.current.pressure_msl,
      String(w.current.weather_code),
    ),
    env.DB.prepare(
      "INSERT INTO weather_cache(outdoor_temperature,outdoor_humidity,dew_point) VALUES(?,?,?)",
    ).bind(w.current.temperature_2m, w.current.relative_humidity_2m, dp),
    env.DB.prepare("DELETE FROM weather_forecast"),
    ...daily.map((x) =>
      env.DB.prepare(
        "INSERT INTO weather_forecast(forecast_date,temp_min,temp_max,humidity,precipitation_probability,precipitation_sum,weather_code) VALUES(?,?,?,?,?,?,?)",
      ).bind(x.date, x.min, x.max, null, x.prob, x.sum, String(x.code)),
    ),
    env.DB.prepare("DELETE FROM weather_hourly"),
    ...hourly.map((x) =>
      env.DB.prepare(
        "INSERT INTO weather_hourly(forecast_time,temperature,humidity,precipitation_probability,precipitation,weather_code,wind_speed) VALUES(?,?,?,?,?,?,?)",
      ).bind(x.time, x.temp, x.hum, x.prob, x.rain, String(x.code), x.wind),
    ),
  ]);
  return { city: s.city || "Unknown", updated_at: new Date().toISOString() };
}

function keyFor(value, bucket) {
  const d = parseDbDate(value);
  if (bucket === "month") return d.toISOString().slice(0, 7);
  if (bucket === "week") {
    const x = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      ),
      day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() + 4 - day);
    const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)),
      week = Math.ceil(((x - y) / 86400000 + 1) / 7);
    return `${x.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return d.toISOString().slice(0, 10);
}
async function rangeAnalytics(env, from, to) {
  const start = `${from} 00:00:00`,
    end = `${to} 23:59:59`,
    days = Math.max(
      1,
      Math.ceil(
        (new Date(to + "T23:59:59Z") - new Date(from + "T00:00:00Z")) /
          86400000,
      ),
    ),
    bucket = days <= 62 ? "day" : days <= 400 ? "week" : "month",
    [p, c] = await Promise.all([
      env.DB.prepare(
        "SELECT created_at,power,voltage,energy_total,tariff_zone,cost_per_kwh FROM power_logs WHERE created_at BETWEEN ? AND ? ORDER BY created_at",
      )
        .bind(start, end)
        .all(),
      env.DB.prepare(
        "SELECT device_id,created_at,temperature,humidity FROM climate_logs WHERE created_at BETWEEN ? AND ? ORDER BY device_id,created_at",
      )
        .bind(start, end)
        .all(),
    ]),
    pg = {},
    cg = {};
  for (const x of p.results) (pg[keyFor(x.created_at, bucket)] ??= []).push(x);
  const power = Object.entries(pg).map(([period, rows]) => {
    let day = 0,
      night = 0,
      cost = 0;
    for (let i = 1; i < rows.length; i++) {
      const d = n(rows[i].energy_total) - n(rows[i - 1].energy_total);
      if (!Number.isFinite(d) || d < 0) continue;
      if (rows[i].tariff_zone === "night") night += d;
      else day += d;
      cost += d * n(rows[i].cost_per_kwh);
    }
    const watts = rows.map((x) => n(x.power)),
      volts = rows.map((x) => n(x.voltage));
    return {
      period,
      energy_kwh: +(day + night).toFixed(3),
      energy_day: +day.toFixed(3),
      energy_night: +night.toFixed(3),
      cost: +cost.toFixed(2),
      avg_power: +(watts.reduce((a, b) => a + b, 0) / watts.length).toFixed(1),
      max_power: Math.max(...watts),
      avg_voltage: +(volts.reduce((a, b) => a + b, 0) / volts.length).toFixed(
        1,
      ),
      min_voltage: Math.min(...volts),
      max_voltage: Math.max(...volts),
      samples: rows.length,
    };
  });
  for (const x of c.results)
    (cg[`${x.device_id}|${keyFor(x.created_at, bucket)}`] ??= []).push(x);
  const climate = {};
  for (const [k, rows] of Object.entries(cg)) {
    const [id, period] = k.split("|"),
      temps = rows.map((x) => n(x.temperature)),
      hums = rows.map((x) => n(x.humidity));
    (climate[id] ??= []).push({
      period,
      avg_temperature: +(
        temps.reduce((a, b) => a + b, 0) / temps.length
      ).toFixed(1),
      min_temperature: Math.min(...temps),
      max_temperature: Math.max(...temps),
      avg_humidity: +(hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(1),
      min_humidity: Math.min(...hums),
      max_humidity: Math.max(...hums),
      samples: rows.length,
    });
  }
  const all = Object.values(climate).flat();
  return {
    from,
    to,
    span_days: days,
    aggregation: bucket,
    summary: {
      total_energy_kwh: +power.reduce((s, x) => s + x.energy_kwh, 0).toFixed(3),
      total_cost: +power.reduce((s, x) => s + x.cost, 0).toFixed(2),
      average_power_w: power.length
        ? +(power.reduce((s, x) => s + x.avg_power, 0) / power.length).toFixed(
            1,
          )
        : 0,
      peak_power_w: power.length
        ? Math.max(...power.map((x) => x.max_power))
        : 0,
      average_temperature: all.length
        ? +(
            all.reduce((s, x) => s + x.avg_temperature, 0) / all.length
          ).toFixed(1)
        : null,
      average_humidity: all.length
        ? +(all.reduce((s, x) => s + x.avg_humidity, 0) / all.length).toFixed(1)
        : null,
    },
    power,
    climate,
  };
}

// -----------------------------------------------------------------------------
// v5.6.1 DISPLAY LAYER
// Compact, read-only payloads for ESP32-2432S028 / LVGL.
// Existing v5.5 endpoints remain backward-compatible.
// -----------------------------------------------------------------------------
const DISPLAY_VERSION = "1.0";
const DISPLAY_FRESHNESS = {
  home: 60,
  climate: 120,
  weather: 3600,
  energy: 60,
  intelligence: 300,
  system: 60,
};
const finiteOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const roundOrNull = (v, d = 1) =>
  Number.isFinite(Number(v)) ? +Number(v).toFixed(d) : null;
const displayMeta = (screen, ttl, extra = {}) => ({
  screen,
  schema_version: DISPLAY_VERSION,
  api_version: API_VERSION,
  generated_at: new Date().toISOString(),
  freshness_seconds: ttl,
  ...extra,
});
function displayDevice(z, timeout) {
  const age = ageMin(z?.created_at),
    online = age != null && age <= timeout;
  return {
    device_id: z?.device_id ?? null,
    name: z?.device_name ?? z?.device_id ?? "Unknown",
    is_outdoor: Boolean(n(z?.is_outdoor)),
    online,
    status: online
      ? "online"
      : age != null && age <= timeout * 2
        ? "warning"
        : "offline",
    age_minutes: age,
    last_seen: z?.created_at ?? null,
    temperature: finiteOrNull(z?.temperature),
    humidity: finiteOrNull(z?.humidity),
    wifi_rssi: finiteOrNull(z?.wifi_rssi),
    comfort_score:
      z?.temperature != null && z?.humidity != null
        ? comfort(z.temperature, z.humidity, z.device_id)
        : null,
  };
}
const displaySeverity = (a) =>
  a?.severity === "critical"
    ? "critical"
    : a?.severity === "warning"
      ? "warning"
      : "info";
function displayAlert(a) {
  return {
    id: a.id,
    key: a.alert_key ?? null,
    type: a.alert_type ?? null,
    title: a.alert_type ?? "alert",
    message: a.alert_message ?? "",
    severity: displaySeverity(a),
    device_id: a.device_id ?? null,
    value: finiteOrNull(a.alert_value),
    threshold: finiteOrNull(a.alert_threshold),
    created_at: a.created_at ?? null,
    resolved_at: a.resolved_at ?? null,
    is_read: Boolean(n(a.is_read)),
  };
}
async function displayConfig(env) {
  const keys = [
      "timezone",
      "city",
      "day_tariff",
      "night_tariff",
      "day_start",
      "night_start",
      "device_timeout_minutes",
      "max_power_alert_watts",
      "voltage_low_alert",
      "voltage_high_alert",
      "default_temp_low",
      "default_temp_high",
      "default_humidity_high",
      "rain_alert_probability",
      "ventilation_humidity_threshold",
    ],
    s = await settings(env, keys);
  return {
    success: true,
    meta: displayMeta("config", 300),
    config: {
      timezone: s.timezone || "Europe/Kyiv",
      city: s.city || "Unknown",
      currency: "UAH",
      units: {
        temperature: "C",
        humidity: "%",
        power: "W",
        energy: "kWh",
        voltage: "V",
        wind: "km/h",
        pressure: "hPa",
      },
      tariff: {
        day: finiteOrNull(s.day_tariff),
        night: finiteOrNull(s.night_tariff),
        day_start: s.day_start || "07:00",
        night_start: s.night_start || "23:00",
      },
      thresholds: {
        device_timeout_minutes: n(s.device_timeout_minutes, 15),
        power_warning_w: Math.round(n(s.max_power_alert_watts, 5000) * 0.8),
        power_danger_w: n(s.max_power_alert_watts, 5000),
        voltage_low_v: n(s.voltage_low_alert, 200),
        voltage_high_v: n(s.voltage_high_alert, 250),
        temperature_low_c: n(s.default_temp_low, 18),
        temperature_high_c: n(s.default_temp_high, 28),
        humidity_high_pct: n(s.default_humidity_high, 70),
        rain_probability_pct: n(s.rain_alert_probability, 70),
        ventilation_humidity_pct: n(s.ventilation_humidity_threshold, 65),
      },
      capabilities: {
        alert_ack: false,
        air_quality: false,
        device_diagnostics: false,
        hourly_forecast_step_hours: 3,
        day_chart_bucket_minutes: 30,
      },
    },
  };
}
async function displayHome(env) {
  const [s, data, stats, score, daily, devices] = await Promise.all([
      settings(env, ["device_timeout_minutes", "city", "timezone"]),
      latestBundle(env),
      powerStats(env),
      homeScoreSnapshot(env),
      env.DB.prepare(
        "SELECT * FROM weather_forecast ORDER BY forecast_date LIMIT 4",
      ).all(),
      displayDevicesData(env),
    ]),
    timeout = n(s.device_timeout_minutes, 15),
    rooms = data.zones.filter((z) => !n(z.is_outdoor)),
    valid = rooms.filter((z) => z.temperature != null && z.humidity != null),
    avgT = valid.length
      ? valid.reduce((x, z) => x + n(z.temperature), 0) / valid.length
      : null,
    avgH = valid.length
      ? valid.reduce((x, z) => x + n(z.humidity), 0) / valid.length
      : null,
    outdoor = data.zones.find((z) => n(z.is_outdoor)),
    p = data.power;
  return {
    success: true,
    meta: displayMeta("home", DISPLAY_FRESHNESS.home, {
      timezone: s.timezone || "Europe/Kyiv",
    }),
    header: {
      home_score: score.scores.overall,
      home_score_label:
        score.scores.overall >= 90
          ? "excellent"
          : score.scores.overall >= 75
            ? "good"
            : score.scores.overall >= 55
              ? "attention"
              : "critical",
      active_alerts: data.alerts.length,
      devices_online: devices.online,
      devices_total: devices.total,
    },
    climate: {
      average_temperature: roundOrNull(avgT),
      average_humidity: roundOrNull(avgH),
      rooms: rooms.slice(0, 3).map((z) => displayDevice(z, timeout)),
    },
    weather: {
      city: s.city || "Unknown",
      current: data.weather
        ? {
            temperature: finiteOrNull(data.weather.temperature),
            humidity: finiteOrNull(data.weather.humidity),
            weather_code: data.weather.weather_code,
            icon: weatherIcon(data.weather.weather_code),
            description: weatherText(data.weather.weather_code),
            updated_at: data.weather.created_at ?? null,
          }
        : outdoor
          ? {
              temperature: finiteOrNull(outdoor.temperature),
              humidity: finiteOrNull(outdoor.humidity),
              weather_code: null,
              icon: null,
              description: "Local sensor",
              updated_at: outdoor.created_at,
            }
          : null,
      daily: daily.results.map((x) => ({
        date: x.forecast_date,
        label: dayLabel(x.forecast_date, s.timezone || "Europe/Kyiv"),
        min: finiteOrNull(x.temp_min),
        max: finiteOrNull(x.temp_max),
        rain_probability: finiteOrNull(x.precipitation_probability),
        code: x.weather_code,
        icon: weatherIcon(x.weather_code),
      })),
    },
    energy: {
      power_w: finiteOrNull(p?.power),
      voltage_v: finiteOrNull(p?.voltage),
      today_kwh: stats.today.energy_total,
      month_kwh: stats.month.energy_total,
      month_cost: stats.month.cost_total,
      currency: "UAH",
      updated_at: p?.created_at ?? null,
    },
    alerts: data.alerts.slice(0, 3).map(displayAlert),
  };
}
async function displayClimate(env, url) {
  const hours = Math.min(
      168,
      Math.max(1, n(url.searchParams.get("hours"), 24)),
    ),
    s = await settings(env, ["device_timeout_minutes"]),
    timeout = n(s.device_timeout_minutes, 15),
    zones = await latestZones(env),
    rooms = zones.filter((z) => !n(z.is_outdoor)),
    valid = rooms.filter((z) => z.temperature != null && z.humidity != null),
    r = await env.DB.prepare(
      "SELECT device_id,created_at,temperature,humidity,wifi_rssi FROM climate_logs WHERE created_at>=? ORDER BY device_id,created_at",
    )
      .bind(sqlDate(new Date(Date.now() - hours * 3600000)))
      .all(),
    series = {};
  for (const x of r.results) {
    const a = (series[x.device_id] ??= []);
    a.push({
      timestamp: x.created_at,
      temperature: finiteOrNull(x.temperature),
      humidity: finiteOrNull(x.humidity),
      wifi_rssi: finiteOrNull(x.wifi_rssi),
    });
    series[x.device_id] = a;
  }
  return {
    success: true,
    meta: displayMeta("climate", DISPLAY_FRESHNESS.climate),
    period_hours: hours,
    summary: {
      average_temperature: valid.length
        ? roundOrNull(
            valid.reduce((a, z) => a + n(z.temperature), 0) / valid.length,
          )
        : null,
      average_humidity: valid.length
        ? roundOrNull(
            valid.reduce((a, z) => a + n(z.humidity), 0) / valid.length,
          )
        : null,
      rooms_online: rooms.filter((z) => displayDevice(z, timeout).online)
        .length,
      rooms_total: rooms.length,
    },
    rooms: rooms.map((z) => ({
      ...displayDevice(z, timeout),
      series: series[z.device_id] || [],
    })),
  };
}
async function displayWeather(env) {
  const s = await settings(env, ["timezone", "city"]),
    tz = s.timezone || "Europe/Kyiv",
    [data, daily, hourly, zones] = await Promise.all([
      env.DB.prepare(
        "SELECT * FROM weather_current ORDER BY id DESC LIMIT 1",
      ).first(),
      env.DB.prepare(
        "SELECT * FROM weather_forecast ORDER BY forecast_date LIMIT 7",
      ).all(),
      env.DB.prepare(
        "SELECT * FROM weather_hourly ORDER BY forecast_time LIMIT 48",
      ).all(),
      latestZones(env),
    ]),
    outdoor = zones.find((z) => n(z.is_outdoor));
  return {
    success: true,
    meta: displayMeta("weather", DISPLAY_FRESHNESS.weather, { timezone: tz }),
    city: s.city || "Unknown",
    actual: {
      source: outdoor ? "outdoor_sensor" : "forecast_api",
      temperature: finiteOrNull(outdoor?.temperature ?? data?.temperature),
      humidity: finiteOrNull(outdoor?.humidity ?? data?.humidity),
      last_seen: outdoor?.created_at ?? data?.created_at ?? null,
    },
    current: data
      ? {
          temperature: finiteOrNull(data.temperature),
          humidity: finiteOrNull(data.humidity),
          wind_speed: finiteOrNull(data.wind_speed),
          pressure: finiteOrNull(data.pressure),
          weather_code: data.weather_code,
          icon: weatherIcon(data.weather_code),
          description: weatherText(data.weather_code),
          created_at: data.created_at ?? null,
        }
      : null,
    daily: daily.results.map((x) => ({
      date: x.forecast_date,
      label: dayLabel(x.forecast_date, tz),
      min: finiteOrNull(x.temp_min),
      max: finiteOrNull(x.temp_max),
      rain_probability: finiteOrNull(x.precipitation_probability),
      rain_sum: finiteOrNull(x.precipitation_sum),
      code: x.weather_code,
      icon: weatherIcon(x.weather_code),
      description: weatherText(x.weather_code),
    })),
    hourly: hourly.results.map((x) => ({
      timestamp: x.forecast_time,
      time: String(x.forecast_time).slice(11, 16),
      temperature: finiteOrNull(x.temperature),
      humidity: finiteOrNull(x.humidity),
      rain_probability: finiteOrNull(x.precipitation_probability),
      rain: finiteOrNull(x.precipitation),
      wind_speed: finiteOrNull(x.wind_speed),
      code: x.weather_code,
      icon: weatherIcon(x.weather_code),
    })),
    limitations: {
      hourly_step_hours: 3,
      feels_like_available: false,
      sunrise_sunset_available: false,
      wind_direction_available: false,
    },
  };
}
async function displayEnergy(env, url) {
  const stats = await powerStats(env),
    latest = await env.DB.prepare(
      "SELECT * FROM power_logs ORDER BY id DESC LIMIT 1",
    ).first(),
    s = await settings(env, [
      "max_power_alert_watts",
      "voltage_low_alert",
      "voltage_high_alert",
    ]),
    now = new Date(),
    start = new Date(now.getTime() - 86400000),
    r = await env.DB.prepare(
      "SELECT created_at,power,voltage,energy_total,tariff_zone,cost_per_kwh FROM power_logs WHERE created_at BETWEEN ? AND ? ORDER BY created_at",
    )
      .bind(sqlDate(start), sqlDate(now))
      .all(),
    bucketMs = 30 * 60000,
    buckets = new Map();
  for (const x of r.results) {
    const t = parseDbDate(x.created_at).getTime(),
      k =
        start.getTime() +
        Math.floor((t - start.getTime()) / bucketMs) * bucketMs,
      b = buckets.get(k) || {
        timestamp: sqlDate(new Date(k)),
        power_sum: 0,
        voltage_sum: 0,
        count: 0,
        energy_kwh: 0,
        day_kwh: 0,
        night_kwh: 0,
      };
    b.power_sum += n(x.power);
    b.voltage_sum += n(x.voltage);
    b.count++;
    buckets.set(k, b);
  }
  for (let i = 1; i < r.results.length; i++) {
    const x = r.results[i],
      delta = Math.max(0, n(x.energy_total) - n(r.results[i - 1].energy_total)),
      t = parseDbDate(x.created_at).getTime(),
      k =
        start.getTime() +
        Math.floor((t - start.getTime()) / bucketMs) * bucketMs,
      b = buckets.get(k);
    if (b) {
      b.energy_kwh += delta;
      if (x.tariff_zone === "night") b.night_kwh += delta;
      else b.day_kwh += delta;
    }
  }
  const points = [...buckets.values()].map((b) => ({
      timestamp: b.timestamp,
      avg_power_w: roundOrNull(b.power_sum / Math.max(1, b.count)),
      avg_voltage_v: roundOrNull(b.voltage_sum / Math.max(1, b.count), 2),
      energy_kwh: +b.energy_kwh.toFixed(5),
      day_kwh: +b.day_kwh.toFixed(5),
      night_kwh: +b.night_kwh.toFixed(5),
      samples: b.count,
    })),
    danger = n(s.max_power_alert_watts, 5000),
    power = n(latest?.power),
    classification =
      power >= danger
        ? "danger"
        : power >= danger * 0.5
          ? "high"
          : power >= danger * 0.16
            ? "moderate"
            : "normal";
  return {
    success: true,
    meta: displayMeta("energy", DISPLAY_FRESHNESS.energy),
    current: {
      power_w: finiteOrNull(latest?.power),
      voltage_v: finiteOrNull(latest?.voltage),
      current_a: finiteOrNull(latest?.current),
      frequency_hz: finiteOrNull(latest?.frequency),
      updated_at: latest?.created_at ?? null,
      classification,
    },
    thresholds: {
      power_normal_max_w: Math.round(danger * 0.16),
      power_moderate_max_w: Math.round(danger * 0.5),
      power_high_max_w: danger,
      voltage_low_v: n(s.voltage_low_alert, 200),
      voltage_high_v: n(s.voltage_high_alert, 250),
    },
    today: stats.today,
    month: stats.month,
    currency: "UAH",
    day_chart: { bucket_minutes: 30, points },
  };
}
async function displayDevicesData(env) {
  const s = await settings(env, ["device_timeout_minutes"]),
    timeout = n(s.device_timeout_minutes, 15),
    [devices, zones, power] = await Promise.all([
      env.DB.prepare(
        "SELECT * FROM devices WHERE enabled=1 ORDER BY display_order,id",
      ).all(),
      latestZones(env),
      env.DB.prepare(
        "SELECT * FROM power_logs ORDER BY id DESC LIMIT 1",
      ).first(),
    ]),
    zoneMap = Object.fromEntries(zones.map((x) => [x.device_id, x])),
    items = devices.results.map((d) => {
      const z = zoneMap[d.device_id],
        isPower = ["power", "energy", "pzem"].includes(d.device_type),
        raw = z || {
          device_id: d.device_id,
          device_name: d.device_name,
          is_outdoor: d.is_outdoor,
          created_at: isPower ? power?.created_at : d.last_seen,
          wifi_rssi: null,
        };
      return {
        ...displayDevice(raw, timeout),
        device_type: d.device_type,
        location: d.location ?? null,
        power_w: isPower ? finiteOrNull(power?.power) : null,
        voltage_v: isPower ? finiteOrNull(power?.voltage) : null,
      };
    });
  return {
    timeout_minutes: timeout,
    total: items.length,
    online: items.filter((x) => x.online).length,
    offline: items.filter((x) => !x.online).length,
    items,
  };
}
async function displayIntelligence(env) {
  const [score, overview, recs, alerts, devices, timeline] = await Promise.all([
      homeScoreSnapshot(env),
      latestBundle(env),
      env.DB.prepare(
        "SELECT * FROM recommendations WHERE status='active' ORDER BY score DESC LIMIT 5",
      ).all(),
      env.DB.prepare(
        "SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 20",
      ).all(),
      displayDevicesData(env),
      env.DB.prepare(
        "SELECT * FROM home_timeline ORDER BY id DESC LIMIT 10",
      ).all(),
    ]),
    zones = overview.zones.filter((z) => !n(z.is_outdoor)),
    energy =
      overview.power?.power > 5000
        ? 55
        : overview.power?.power > 3500
          ? 75
          : 95,
    weather = overview.weather ? 90 : 50,
    deviceScore = clamp(
      devices.total ? (devices.online / devices.total) * 100 : 100,
    );
  return {
    success: true,
    meta: displayMeta("intelligence", DISPLAY_FRESHNESS.intelligence),
    scores: {
      overall: score.scores.overall,
      climate: score.scores.comfort,
      energy,
      devices: deviceScore,
      weather,
    },
    data_confidence: {
      value: null,
      status: "unavailable",
      reason: `API v${API_VERSION} has no persisted confidence model`,
    },
    device_health: {
      online: devices.online,
      total: devices.total,
      score: deviceScore,
    },
    anomalies: {
      active: alerts.results.length,
      items: alerts.results.slice(0, 5).map(displayAlert),
    },
    recommendations: recs.results,
    today_story: timeline.results,
    rooms: zones.length,
  };
}
async function displaySystem(env) {
  const started = Date.now(),
    db = await env.DB.prepare("SELECT 1 ok").first(),
    devices = await displayDevicesData(env);
  return {
    success: true,
    meta: displayMeta("system", DISPLAY_FRESHNESS.system),
    services: {
      worker: { status: "online", version: API_VERSION },
      api: { status: "healthy" },
      d1: { status: db?.ok === 1 ? "online" : "unknown" },
      cache: {
        status: "available",
        note: "Cache API availability; per-key freshness is reported by response headers",
      },
    },
    devices: { online: devices.online, total: devices.total },
    request: { processing_ms: Date.now() - started },
    display_owned_fields: [
      "wifi_rssi",
      "free_heap",
      "flash_usage",
      "uptime_seconds",
      "brightness_percent",
    ],
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method;
    try {
      if (path === "/api/v1/status")
        return json({
          project: "Home Monitor",
          version: API_VERSION,
          status: "online",
          display_layer: DISPLAY_VERSION,
          timestamp: new Date().toISOString(),
        });
      if (path === "/api/v1/debug")
        return json({
          version: API_VERSION,
          path,
          host: url.host,
          display_layer: DISPLAY_VERSION,
        });

      if (path === "/api/v1/display/config" && method === "GET")
        return cachedJson(request, 300, async () => await displayConfig(env));
      if (path === "/api/v1/display/home" && method === "GET")
        return cachedJson(request, 60, async () => await displayHome(env));
      if (path === "/api/v1/display/climate" && method === "GET")
        return cachedJson(
          request,
          120,
          async () => await displayClimate(env, url),
        );
      if (path === "/api/v1/display/weather" && method === "GET")
        return cachedJson(request, 300, async () => await displayWeather(env));
      if (path === "/api/v1/display/energy" && method === "GET")
        return cachedJson(
          request,
          60,
          async () => await displayEnergy(env, url),
        );
      if (path === "/api/v1/display/intelligence" && method === "GET")
        return cachedJson(
          request,
          300,
          async () => await displayIntelligence(env),
        );
      if (path === "/api/v1/display/system" && method === "GET")
        return cachedJson(request, 60, async () => await displaySystem(env));

      if (path === "/api/v1/dashboard" && method === "GET")
        return cachedJson(request, 60, async () => {
          const [data, daily, hourly, stats] = await Promise.all([
              latestBundle(env),
              env.DB.prepare(
                "SELECT * FROM weather_forecast ORDER BY forecast_date LIMIT 7",
              ).all(),
              env.DB.prepare(
                "SELECT * FROM weather_hourly ORDER BY forecast_time",
              ).all(),
              powerStats(env),
            ]),
            indoor = data.zones.filter(
              (z) => !z.is_outdoor && z.temperature != null,
            ),
            sorted = [...indoor].sort((a, b) => a.temperature - b.temperature),
            wet = [...indoor].sort((a, b) => b.humidity - a.humidity);
          return {
            success: true,
            project: { name: "Home Monitor", version: API_VERSION },
            insights: {
              climate: {
                zones: data.zones,
                indoor_average: indoor.length
                  ? +(
                      indoor.reduce((s, z) => s + n(z.temperature), 0) /
                      indoor.length
                    ).toFixed(1)
                  : null,
                warmest_room: sorted.at(-1) || null,
                coldest_room: sorted[0] || null,
                highest_humidity_room: wet[0] || null,
              },
              power: {
                current: data.power,
                statistics: stats,
                currency: "UAH",
              },
              weather: {
                current: data.weather,
                rain_risk:
                  daily.results.find(
                    (x) => n(x.precipitation_probability) >= 70,
                  ) || null,
              },
              system: { active_alerts: data.alerts.length },
            },
            recommendations: data.recs,
            weather: {
              current: data.weather
                ? {
                    ...data.weather,
                    weather_icon: weatherIcon(data.weather.weather_code),
                    weather_description: weatherText(data.weather.weather_code),
                  }
                : null,
              daily: daily.results.map((x) => ({
                ...x,
                day_label: dayLabel(x.forecast_date),
                weather_icon: weatherIcon(x.weather_code),
                weather_description: weatherText(x.weather_code),
              })),
              hourly_3h: hourly.results.map((x) => ({
                ...x,
                time: x.forecast_time.slice(11, 16),
                weather_icon: weatherIcon(x.weather_code),
                weather_description: weatherText(x.weather_code),
              })),
            },
            alerts: data.alerts,
          };
        });
      if (path === "/api/v1/home-score" && method === "GET")
        return cachedJson(request, 300, async () => ({
          success: true,
          ...(await homeScoreSnapshot(env)),
        }));
      if (path === "/api/v1/recommendations" && method === "GET")
        return cachedJson(request, 300, async () => {
          const r = await env.DB.prepare(
            "SELECT * FROM recommendations WHERE status='active' ORDER BY score DESC LIMIT 50",
          ).all();
          return { success: true, recommendations: r.results };
        });
      if (path === "/api/v1/recommendations/generate" && method === "POST") {
        if (!(await authorized(request, env)))
          return json({ error: "Unauthorized" }, 401);
        return json({ success: true, ...(await recommendations(env)) });
      }
      if (path === "/api/v1/alerts" && method === "GET")
        return cachedJson(request, 60, async () => {
          const r = await env.DB.prepare(
            "SELECT * FROM alerts ORDER BY resolved_at IS NULL DESC,id DESC LIMIT 200",
          ).all();
          return { success: true, alerts: r.results };
        });
      if (path === "/api/v1/power/stats" && method === "GET")
        return cachedJson(request, 300, async () => ({
          success: true,
          currency: "UAH",
          ...(await powerStats(env)),
        }));
      if (path === "/api/v1/charts/power" && method === "GET")
        return cachedJson(request, 900, async () => {
          const hours = Math.min(
              168,
              Math.max(1, n(url.searchParams.get("hours"), 24)),
            ),
            r = await env.DB.prepare(
              "SELECT created_at,voltage,current,power,frequency,energy_total FROM power_logs WHERE created_at>=? ORDER BY created_at",
            )
              .bind(sqlDate(new Date(Date.now() - hours * 3600000)))
              .all();
          return {
            success: true,
            period_hours: hours,
            labels: r.results.map((x) => x.created_at),
            datasets: {
              power: r.results.map((x) => x.power),
              voltage: r.results.map((x) => x.voltage),
              current: r.results.map((x) => x.current),
              energy_total: r.results.map((x) => x.energy_total),
            },
          };
        });
      if (path === "/api/v1/charts/climate" && method === "GET")
        return cachedJson(request, 900, async () => {
          const hours = Math.min(
              168,
              Math.max(1, n(url.searchParams.get("hours"), 24)),
            ),
            r = await env.DB.prepare(
              "SELECT device_id,created_at,temperature,humidity,wifi_rssi FROM climate_logs WHERE created_at>=? ORDER BY device_id,created_at",
            )
              .bind(sqlDate(new Date(Date.now() - hours * 3600000)))
              .all(),
            sets = {};
          for (const x of r.results) {
            const s = (sets[x.device_id] ??= {
              labels: [],
              temperature: [],
              humidity: [],
              wifi_rssi: [],
            });
            s.labels.push(x.created_at);
            s.temperature.push(x.temperature);
            s.humidity.push(x.humidity);
            s.wifi_rssi.push(x.wifi_rssi);
          }
          return { success: true, period_hours: hours, datasets: sets };
        });
      if (path === "/api/v1/analytics/range" && method === "GET") {
        const from = url.searchParams.get("from"),
          to = url.searchParams.get("to");
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(from || "") ||
          !/^\d{4}-\d{2}-\d{2}$/.test(to || "") ||
          new Date(from) > new Date(to)
        )
          return json({ error: "Invalid from/to" }, 400);
        return cachedJson(request, 900, async () => ({
          success: true,
          analytics: await rangeAnalytics(env, from, to),
        }));
      }
      if (path === "/api/v1/analytics/compare" && method === "GET")
        return cachedResponse(request, 900, async () => {
          const f = url.searchParams.get("from"),
            t = url.searchParams.get("to"),
            cf = url.searchParams.get("compare_from"),
            ct = url.searchParams.get("compare_to"),
            [current, previous] = await Promise.all([
              rangeAnalytics(env, f, t),
              rangeAnalytics(env, cf, ct),
            ]),
            pct = (a, b) => (b ? +(((a - b) / b) * 100).toFixed(1) : null);
          return json({
            success: true,
            comparison: {
              current,
              previous,
              changes: {
                energy_percent: pct(
                  current.summary.total_energy_kwh,
                  previous.summary.total_energy_kwh,
                ),
                cost_percent: pct(
                  current.summary.total_cost,
                  previous.summary.total_cost,
                ),
                avg_power_percent: pct(
                  current.summary.average_power_w,
                  previous.summary.average_power_w,
                ),
                temperature_delta:
                  current.summary.average_temperature != null &&
                  previous.summary.average_temperature != null
                    ? +(
                        current.summary.average_temperature -
                        previous.summary.average_temperature
                      ).toFixed(1)
                    : null,
                humidity_delta:
                  current.summary.average_humidity != null &&
                  previous.summary.average_humidity != null
                    ? +(
                        current.summary.average_humidity -
                        previous.summary.average_humidity
                      ).toFixed(1)
                    : null,
              },
            },
          });
        });
      if (path === "/api/v1/analytics/hourly-profile" && method === "GET")
        return cachedResponse(request, 900, async () => {
          const f = url.searchParams.get("from"),
            t = url.searchParams.get("to"),
            r = await env.DB.prepare(
              "SELECT CAST(strftime('%H',created_at) AS INTEGER) hour,ROUND(AVG(power),1) avg_power,ROUND(MAX(power),1) max_power,COUNT(*) samples FROM power_logs WHERE created_at BETWEEN ? AND ? GROUP BY hour ORDER BY hour",
            )
              .bind(`${f} 00:00:00`, `${t} 23:59:59`)
              .all();
          return json({ success: true, profile: r.results });
        });
      if (path === "/api/v1/analytics/heatmap" && method === "GET")
        return cachedResponse(request, 900, async () => {
          const a = await rangeAnalytics(
            env,
            url.searchParams.get("from"),
            url.searchParams.get("to"),
          );
          return json({
            success: true,
            days: a.power.map((x) => ({
              date: x.period,
              energy_kwh: x.energy_kwh,
              cost: x.cost,
              max_power: x.max_power,
            })),
          });
        });
      if (path === "/api/v1/insights/trends" && method === "GET")
        return cachedResponse(request, 900, async () => {
          const f = url.searchParams.get("from"),
            t = url.searchParams.get("to"),
            cf = url.searchParams.get("compare_from"),
            ct = url.searchParams.get("compare_to"),
            [cur, old] = await Promise.all([
              rangeAnalytics(env, f, t),
              rangeAnalytics(env, cf, ct),
            ]),
            pct = old.summary.total_energy_kwh
              ? +(
                  ((cur.summary.total_energy_kwh -
                    old.summary.total_energy_kwh) /
                    old.summary.total_energy_kwh) *
                  100
                ).toFixed(1)
              : null,
            items = [];
          if (pct != null)
            items.push({
              category: "energy",
              icon: "⚡",
              title: "Зміна споживання",
              message: `Споживання ${pct >= 0 ? "зросло" : "зменшилось"} на ${Math.abs(pct)}% проти попереднього періоду.`,
              priority: Math.abs(pct) > 20 ? "high" : "info",
            });
          if (cur.summary.peak_power_w > 4000)
            items.push({
              category: "energy",
              icon: "🔥",
              title: "Високий пік",
              message: `Зафіксовано пік ${cur.summary.peak_power_w} Вт.`,
              priority: "high",
            });
          if (cur.summary.average_humidity > 65)
            items.push({
              category: "climate",
              icon: "💧",
              title: "Підвищена вологість",
              message: `Середня вологість ${cur.summary.average_humidity}%.`,
              priority: "medium",
            });
          return json({ success: true, items });
        });
      if (path === "/api/v1/devices/status" && method === "GET")
        return cachedJson(request, 60, async () => {
          const s = await settings(env, ["device_timeout_minutes"]),
            timeout = n(s.device_timeout_minutes, 15),
            [devices, zones, power] = await Promise.all([
              env.DB.prepare(
                "SELECT * FROM devices WHERE enabled=1 ORDER BY display_order,id",
              ).all(),
              latestZones(env),
              env.DB.prepare(
                "SELECT * FROM power_logs ORDER BY id DESC LIMIT 1",
              ).first(),
            ]),
            zoneMap = Object.fromEntries(zones.map((x) => [x.device_id, x])),
            items = devices.results.map((d) => {
              const climate = zoneMap[d.device_id],
                isPower =
                  d.device_type === "power" ||
                  d.device_type === "energy" ||
                  d.device_type === "pzem",
                last =
                  climate?.created_at ||
                  (isPower &&
                  (!power?.device_id || power.device_id === d.device_id)
                    ? power?.created_at
                    : d.last_seen),
                age = ageMin(last),
                online = age != null && age <= timeout;
              return {
                device_id: d.device_id,
                device_name: d.device_name || d.device_id,
                device_type: d.device_type,
                location: d.location,
                is_outdoor: n(d.is_outdoor) ? 1 : 0,
                online,
                status: online
                  ? "online"
                  : age != null && age <= timeout * 2
                    ? "warning"
                    : "offline",
                age_minutes: age,
                last_seen: last,
                temperature: climate?.temperature ?? null,
                humidity: climate?.humidity ?? null,
                wifi_rssi: climate?.wifi_rssi ?? null,
                power: isPower ? (power?.power ?? null) : null,
                voltage: isPower ? (power?.voltage ?? null) : null,
              };
            });
          if (
            power &&
            !items.some(
              (x) =>
                x.device_type === "power" ||
                x.device_type === "energy" ||
                x.device_type === "pzem",
            )
          ) {
            const age = ageMin(power.created_at),
              online = age != null && age <= timeout;
            items.push({
              device_id: power.device_id || "power-meter",
              device_name: "Електролічильник",
              device_type: "power",
              is_outdoor: 0,
              online,
              status: online
                ? "online"
                : age != null && age <= timeout * 2
                  ? "warning"
                  : "offline",
              age_minutes: age,
              last_seen: power.created_at,
              power: power.power,
              voltage: power.voltage,
            });
          }
          return {
            success: true,
            timeout_minutes: timeout,
            total: items.length,
            online: items.filter((x) => x.online).length,
            offline: items.filter((x) => !x.online).length,
            items,
          };
        });
      if (path === "/api/v1/analytics/tariff-range" && method === "GET")
        return cachedJson(request, 300, async () => {
          const period = url.searchParams.get("period") || "month",
            now = new Date(),
            toParam = url.searchParams.get("to"),
            fromParam = url.searchParams.get("from"),
            month = url.searchParams.get("month"),
            monthStart = month
              ? new Date(month + "-01T00:00:00Z")
              : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
            monthEnd = new Date(
              Date.UTC(
                monthStart.getUTCFullYear(),
                monthStart.getUTCMonth() + 1,
                1,
              ) - 1,
            ),
            start = fromParam ? new Date(fromParam + "T00:00:00Z") : monthStart,
            end = toParam ? new Date(toParam + "T23:59:59Z") : monthEnd,
            r = await env.DB.prepare(
              "SELECT created_at,energy_total,tariff_zone,cost_per_kwh FROM power_logs WHERE created_at BETWEEN ? AND ? ORDER BY created_at",
            )
              .bind(sqlDate(start), sqlDate(end))
              .all(),
            rows = r.results,
            totals = { day: { kwh: 0, cost: 0 }, night: { kwh: 0, cost: 0 } };
          for (let i = 1; i < rows.length; i++) {
            const delta = Math.max(
                0,
                n(rows[i].energy_total) - n(rows[i - 1].energy_total),
              ),
              zone = rows[i].tariff_zone === "night" ? "night" : "day",
              charge = delta * n(rows[i].cost_per_kwh);
            totals[zone].kwh += delta;
            totals[zone].cost += charge;
          }
          for (const z of ["day", "night"]) {
            totals[z].kwh = +totals[z].kwh.toFixed(3);
            totals[z].cost = +totals[z].cost.toFixed(2);
          }
          return {
            success: true,
            from: sqlDate(start),
            to: sqlDate(end),
            totals,
            total_kwh: +(totals.day.kwh + totals.night.kwh).toFixed(3),
            total_cost: +(totals.day.cost + totals.night.cost).toFixed(2),
          };
        });
      if (path === "/api/v1/charts/energy/range" && method === "GET")
        return cachedJson(request, 300, async () => {
          const period = url.searchParams.get("period") || "week",
            now = new Date(),
            toParam = url.searchParams.get("to"),
            fromParam = url.searchParams.get("from"),
            end = toParam ? new Date(toParam + "T23:59:59Z") : now,
            start = fromParam
              ? new Date(fromParam + "T00:00:00Z")
              : new Date(
                  end.getTime() -
                    (period === "day"
                      ? 86400000
                      : period === "month"
                        ? 30 * 86400000
                        : 7 * 86400000),
                ),
            duration = Math.max(1, end - start),
            bucketMs =
              period === "day"
                ? 15 * 60000
                : period === "week"
                  ? 2 * 3600000
                  : period === "month"
                    ? 86400000
                    : duration <= 2 * 86400000
                      ? 30 * 60000
                      : duration <= 14 * 86400000
                        ? 4 * 3600000
                        : duration <= 62 * 86400000
                          ? 86400000
                          : 7 * 86400000,
            r = await env.DB.prepare(
              "SELECT created_at,power,voltage,energy_total,tariff_zone,cost_per_kwh FROM power_logs WHERE created_at BETWEEN ? AND ? ORDER BY created_at",
            )
              .bind(sqlDate(start), sqlDate(end))
              .all(),
            rows = r.results,
            buckets = new Map();
          let totalE = 0,
            totalC = 0;
          for (let i = 0; i < rows.length; i++) {
            const x = rows[i],
              t = parseDbDate(x.created_at).getTime(),
              key =
                start.getTime() +
                Math.floor((t - start.getTime()) / bucketMs) * bucketMs,
              b = buckets.get(key) || {
                label: sqlDate(new Date(key)),
                powerSum: 0,
                voltageSum: 0,
                count: 0,
                energy: 0,
                cost: 0,
              };
            b.powerSum += n(x.power);
            b.voltageSum += n(x.voltage);
            b.count++;
            if (i) {
              const delta = Math.max(
                  0,
                  n(x.energy_total) - n(rows[i - 1].energy_total),
                ),
                charge = delta * n(x.cost_per_kwh);
              b.energy += delta;
              b.cost += charge;
              totalE += delta;
              totalC += charge;
            }
            buckets.set(key, b);
          }
          let cumulativeE = 0,
            cumulativeC = 0;
          const points = [...buckets.values()].map((b) => {
            cumulativeE += b.energy;
            cumulativeC += b.cost;
            return {
              label: b.label,
              avg_power: +(b.powerSum / Math.max(1, b.count)).toFixed(1),
              avg_voltage: +(b.voltageSum / Math.max(1, b.count)).toFixed(2),
              energy: +b.energy.toFixed(5),
              cost: +b.cost.toFixed(4),
              cumulative_energy: +cumulativeE.toFixed(4),
              cumulative_cost: +cumulativeC.toFixed(2),
              samples: b.count,
            };
          });
          return {
            success: true,
            period,
            from: sqlDate(start),
            to: sqlDate(end),
            bucket_minutes: Math.round(bucketMs / 60000),
            summary: {
              energy: +totalE.toFixed(4),
              cost: +totalC.toFixed(2),
              samples: rows.length,
            },
            points,
          };
        });
      if (path === "/api/v1/charts/energy" && method === "GET")
        return cachedJson(request, 300, async () => {
          const hours = Math.min(
              168,
              Math.max(1, n(url.searchParams.get("hours"), 24)),
            ),
            r = await env.DB.prepare(
              "SELECT created_at,power,voltage,energy_total,tariff_zone,cost_per_kwh FROM power_logs WHERE created_at>=? ORDER BY created_at",
            )
              .bind(sqlDate(new Date(Date.now() - hours * 3600000)))
              .all(),
            rows = r.results,
            labels = [],
            power = [],
            voltage = [],
            energy = [],
            cost = [],
            cumulativeEnergy = [],
            cumulativeCost = [];
          let eSum = 0,
            cSum = 0;
          for (let i = 0; i < rows.length; i++) {
            const x = rows[i],
              delta = i
                ? Math.max(0, n(x.energy_total) - n(rows[i - 1].energy_total))
                : 0,
              charge = delta * n(x.cost_per_kwh);
            eSum += delta;
            cSum += charge;
            labels.push(x.created_at);
            power.push(n(x.power));
            voltage.push(n(x.voltage));
            energy.push(+delta.toFixed(5));
            cost.push(+charge.toFixed(4));
            cumulativeEnergy.push(+eSum.toFixed(4));
            cumulativeCost.push(+cSum.toFixed(2));
          }
          return {
            success: true,
            period_hours: hours,
            labels,
            datasets: {
              power,
              voltage,
              energy,
              cost,
              cumulative_energy: cumulativeEnergy,
              cumulative_cost: cumulativeCost,
            },
          };
        });
      if (path === "/api/v1/control/overview" && method === "GET")
        return cachedJson(request, 60, async () => {
          const [dash, score, timeline, outages] = await Promise.all([
              latestBundle(env),
              homeScoreSnapshot(env),
              env.DB.prepare(
                "SELECT * FROM home_timeline ORDER BY id DESC LIMIT 30",
              ).all(),
              env.DB.prepare(
                "SELECT * FROM outages ORDER BY id DESC LIMIT 30",
              ).all(),
            ]),
            zones = dash.zones.filter((z) => !z.is_outdoor),
            online = zones.filter(
              (z) => ageMin(z.created_at) != null && ageMin(z.created_at) <= 15,
            ).length;
          return {
            success: true,
            status: dash.alerts.some((a) => a.severity === "critical")
              ? "critical"
              : dash.alerts.length
                ? "attention"
                : "good",
            scores: {
              overall: score.scores.overall,
              comfort: score.scores.comfort,
              devices: clamp(
                zones.length ? (online / zones.length) * 100 : 100,
              ),
              energy:
                dash.power?.power > 5000
                  ? 55
                  : dash.power?.power > 3500
                    ? 75
                    : 95,
              weather: dash.weather ? 90 : 50,
            },
            today: {
              power: dash.power,
              weather: dash.weather,
              alerts: dash.alerts.length,
              rooms: zones.length,
              online,
            },
            rooms: score.room_ranking,
            timeline: timeline.results,
            outages: outages.results,
            recommendations: dash.recs.slice(0, 5),
          };
        });
      if (path === "/api/v1/timeline" && method === "GET")
        return cachedJson(request, 60, async () => {
          const limit = Math.min(
              100,
              Math.max(1, n(url.searchParams.get("limit"), 50)),
            ),
            r = await env.DB.prepare(
              "SELECT * FROM home_timeline ORDER BY id DESC LIMIT ?",
            )
              .bind(limit)
              .all();
          return { success: true, items: r.results };
        });
      if (path === "/api/v1/auth/login" && method === "POST") {
        const b = await body(request),
          ip = await sha256(
            request.headers.get("CF-Connecting-IP") || "unknown",
          ),
          recent = await env.DB.prepare(
            "SELECT COUNT(*) n FROM admin_login_attempts WHERE ip_hash=? AND success=0 AND created_at>=datetime('now','-15 minutes')",
          )
            .bind(ip)
            .first();
        if (n(recent?.n) >= 8) return json({ error: "Too many attempts" }, 429);
        const expected =
            env.ADMIN_PASSWORD_HASH || (await sha256(env.ADMIN_PASSWORD || "")),
          actual = await sha256(b.password || ""),
          ok = Boolean(
            (env.ADMIN_PASSWORD || env.ADMIN_PASSWORD_HASH) &&
            actual === expected,
          );
        await env.DB.prepare(
          "INSERT INTO admin_login_attempts(ip_hash,success) VALUES(?,?)",
        )
          .bind(ip, ok ? 1 : 0)
          .run();
        if (!ok) return json({ error: "Невірний пароль" }, 401);
        const raw = token(),
          th = await sha256(raw);
        await env.DB.prepare(
          "INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,datetime('now','+1 hour'))",
        )
          .bind(th)
          .run();
        return json({
          success: true,
          token: raw,
          expires_in: 3600,
          role: "owner",
        });
      }
      if (path === "/api/v1/auth/session" && method === "GET") {
        const s = await session(request, env);
        return s
          ? json({
              authenticated: true,
              role: s.role,
              expires_at: s.expires_at,
            })
          : json({ authenticated: false }, 401);
      }
      if (path === "/api/v1/auth/logout" && method === "POST") {
        const s = await session(request, env);
        if (s)
          await env.DB.prepare("DELETE FROM admin_sessions WHERE id=?")
            .bind(s.id)
            .run();
        return json({ success: true });
      }
      if (path === "/api/v1/home-score/history" && method === "GET")
        return cachedJson(request, 300, async () => {
          const days = Math.min(
              365,
              Math.max(1, n(url.searchParams.get("days"), 30)),
            ),
            r = await env.DB.prepare(
              "SELECT * FROM home_score_history WHERE created_at>=datetime('now',?) ORDER BY created_at",
            )
              .bind(`-${days} days`)
              .all();
          return { success: true, items: r.results };
        });
      if (path.startsWith("/api/v1/admin/")) {
        const s = await session(request, env);
        if (!s) return json({ error: "Unauthorized" }, 401);
        if (path === "/api/v1/admin/settings" && method === "GET") {
          const r = await env.DB.prepare(
            "SELECT setting_key,setting_value FROM settings ORDER BY setting_key",
          ).all();
          return json({
            success: true,
            settings: Object.fromEntries(
              r.results
                .filter((x) => safeSettingKeys.has(x.setting_key))
                .map((x) => [x.setting_key, x.setting_value]),
            ),
          });
        }
        if (path === "/api/v1/admin/settings" && method === "PATCH") {
          const b = await body(request),
            entries = Object.entries(b.settings || {}).filter(([k]) =>
              safeSettingKeys.has(k),
            );
          for (const [k, v] of entries) {
            const old = await env.DB.prepare(
              "SELECT setting_value FROM settings WHERE setting_key=?",
            )
              .bind(k)
              .first();
            await env.DB.prepare(
              "INSERT INTO settings(setting_key,setting_value) VALUES(?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value",
            )
              .bind(k, String(v))
              .run();
            await env.DB.prepare(
              "INSERT INTO settings_history(setting_key,old_value,new_value) VALUES(?,?,?)",
            )
              .bind(k, old?.setting_value ?? null, String(v))
              .run();
            await audit(
              env,
              s,
              "update",
              "setting",
              k,
              old?.setting_value ?? null,
              String(v),
            );
          }
          return json({ success: true, updated: entries.length });
        }
        if (path === "/api/v1/admin/channels" && method === "GET") {
          const c = await env.DB.prepare(
              "SELECT * FROM notification_channels ORDER BY id",
            ).all(),
            x = await env.DB.prepare(
              "SELECT * FROM notification_channel_categories",
            ).all();
          return json({
            success: true,
            channels: c.results,
            overrides: x.results,
          });
        }
        if (path === "/api/v1/admin/channels" && method === "POST") {
          const b = await body(request);
          if (!b.chat_id) return json({ error: "chat_id required" }, 400);
          const r = await env.DB.prepare(
            "INSERT INTO notification_channels(chat_id,channel_name,enabled) VALUES(?,?,1) ON CONFLICT(chat_id) DO UPDATE SET channel_name=excluded.channel_name,enabled=1",
          )
            .bind(String(b.chat_id), String(b.channel_name || b.chat_id))
            .run();
          await audit(env, s, "create", "channel", b.chat_id, null, b);
          return json({ success: true, id: r.meta?.last_row_id });
        }
        const cm = path.match(/^\/api\/v1\/admin\/channels\/(\d+)$/);
        if (cm && method === "PATCH") {
          const id = n(cm[1]),
            old = await env.DB.prepare(
              "SELECT * FROM notification_channels WHERE id=?",
            )
              .bind(id)
              .first(),
            b = await body(request);
          if (!old) return json({ error: "Not found" }, 404);
          await env.DB.prepare(
            "UPDATE notification_channels SET channel_name=?,enabled=?,quiet_enabled=?,quiet_start=?,quiet_end=? WHERE id=?",
          )
            .bind(
              String(b.channel_name ?? old.channel_name),
              n(b.enabled, old.enabled) ? 1 : 0,
              n(b.quiet_enabled, old.quiet_enabled) ? 1 : 0,
              String(b.quiet_start ?? old.quiet_start),
              String(b.quiet_end ?? old.quiet_end),
              id,
            )
            .run();
          await audit(env, s, "update", "channel", id, old, b);
          return json({ success: true });
        }
        if (cm && method === "DELETE") {
          const id = n(cm[1]),
            old = await env.DB.prepare(
              "SELECT * FROM notification_channels WHERE id=?",
            )
              .bind(id)
              .first();
          if (old)
            await env.DB.batch([
              env.DB.prepare(
                "DELETE FROM notification_channel_categories WHERE chat_id=?",
              ).bind(old.chat_id),
              env.DB.prepare(
                "DELETE FROM notification_channels WHERE id=?",
              ).bind(id),
            ]);
          await audit(env, s, "delete", "channel", id, old, null);
          return json({ success: true });
        }
        if (path === "/api/v1/admin/categories" && method === "GET") {
          const r = await env.DB.prepare(
            "SELECT * FROM notification_settings ORDER BY category_key",
          ).all();
          return json({ success: true, categories: r.results });
        }
        const cat = path.match(/^\/api\/v1\/admin\/categories\/([^/]+)$/);
        if (cat && method === "PATCH") {
          const k = decodeURIComponent(cat[1]),
            old = await env.DB.prepare(
              "SELECT * FROM notification_settings WHERE category_key=?",
            )
              .bind(k)
              .first(),
            b = await body(request);
          if (!old) return json({ error: "Not found" }, 404);
          await env.DB.prepare(
            "UPDATE notification_settings SET enabled=?,mode=?,schedule_time=?,weekday=?,monthday=?,cooldown=? WHERE category_key=?",
          )
            .bind(
              n(b.enabled, old.enabled) ? 1 : 0,
              String(b.mode ?? old.mode),
              b.schedule_time ?? old.schedule_time,
              b.weekday ?? old.weekday,
              b.monthday ?? old.monthday,
              n(b.cooldown, old.cooldown),
              k,
            )
            .run();
          await audit(env, s, "update", "category", k, old, b);
          return json({ success: true });
        }
        if (path === "/api/v1/admin/channel-category" && method === "PATCH") {
          const b = await body(request);
          await env.DB.prepare(
            "INSERT INTO notification_channel_categories(chat_id,category_key,enabled) VALUES(?,?,?) ON CONFLICT(chat_id,category_key) DO UPDATE SET enabled=excluded.enabled",
          )
            .bind(
              String(b.chat_id),
              String(b.category_key),
              n(b.enabled) ? 1 : 0,
            )
            .run();
          await audit(
            env,
            s,
            "update",
            "channel_category",
            `${b.chat_id}:${b.category_key}`,
            null,
            b,
          );
          return json({ success: true });
        }
        if (path === "/api/v1/admin/test-notification" && method === "POST") {
          const b = await body(request),
            c = await env.DB.prepare(
              "SELECT * FROM notification_channels WHERE id=?",
            )
              .bind(n(b.channel_id))
              .first();
          if (!c) return json({ error: "Channel not found" }, 404);
          if (!env.TELEGRAM_BOT_TOKEN)
            return json({ error: "TELEGRAM_BOT_TOKEN missing" }, 400);
          const r = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: c.chat_id,
                text: "✅ Home Monitor 3.0: тест каналу успішний",
              }),
            },
          );
          const result = await r.json();
          await audit(env, s, "test", "channel", c.id, null, { ok: result.ok });
          return json({ success: Boolean(result.ok), telegram: result });
        }
        if (path === "/api/v1/admin/modes" && method === "GET") {
          const r = await env.DB.prepare(
            "SELECT * FROM home_modes ORDER BY mode_key",
          ).all();
          return json({ success: true, modes: r.results });
        }
        const mm = path.match(/^\/api\/v1\/admin\/modes\/([^/]+)$/);
        if (mm && method === "PATCH") {
          const k = decodeURIComponent(mm[1]),
            old = await env.DB.prepare(
              "SELECT * FROM home_modes WHERE mode_key=?",
            )
              .bind(k)
              .first(),
            b = await body(request);
          if (!old) return json({ error: "Not found" }, 404);
          if (n(b.enabled)) {
            await env.DB.prepare("UPDATE home_modes SET enabled=0").run();
          }
          await env.DB.prepare(
            "UPDATE home_modes SET enabled=? WHERE mode_key=?",
          )
            .bind(n(b.enabled) ? 1 : 0, k)
            .run();
          await audit(env, s, "update", "home_mode", k, old, b);
          return json({ success: true });
        }
        if (path === "/api/v1/admin/preferences" && method === "GET") {
          const r = await env.DB.prepare(
            "SELECT pref_key,pref_value FROM dashboard_preferences ORDER BY pref_key",
          ).all();
          return json({
            success: true,
            preferences: Object.fromEntries(
              r.results.map((x) => [x.pref_key, x.pref_value]),
            ),
          });
        }
        if (path === "/api/v1/admin/preferences" && method === "PATCH") {
          const b = await body(request),
            entries = Object.entries(b.preferences || {}).slice(0, 50);
          for (const [k, v] of entries)
            await env.DB.prepare(
              "INSERT INTO dashboard_preferences(pref_key,pref_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(pref_key) DO UPDATE SET pref_value=excluded.pref_value,updated_at=CURRENT_TIMESTAMP",
            )
              .bind(String(k).slice(0, 80), String(v).slice(0, 500))
              .run();
          await audit(
            env,
            s,
            "update",
            "dashboard_preferences",
            "global",
            null,
            b.preferences,
          );
          return json({ success: true, updated: entries.length });
        }
        if (path === "/api/v1/admin/audit" && method === "GET") {
          const r = await env.DB.prepare(
            "SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 100",
          ).all();
          return json({ success: true, items: r.results });
        }
        return json({ error: "Admin route not found" }, 404);
      }
      if (path === "/api/v1/climate" && method === "POST") {
        if (!(await authorized(request, env)))
          return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        await env.DB.prepare(
          "INSERT INTO climate_logs(device_id,temperature,humidity,wifi_rssi,supply_voltage) VALUES(?,?,?,?,?)",
        )
          .bind(
            b.device_id,
            b.temperature,
            b.humidity,
            b.wifi_rssi ?? null,
            b.supply_voltage ?? null,
          )
          .run();
        return json({ success: true });
      }
      if (path === "/api/v1/power" && method === "POST") {
        if (!(await authorized(request, env)))
          return json({ error: "Unauthorized" }, 401);
        const b = await request.json(),
          tr = await tariff(env);
        await env.DB.prepare(
          "INSERT INTO power_logs(device_id,voltage,current,power,frequency,energy_total,tariff_zone,cost_per_kwh) VALUES(?,?,?,?,?,?,?,?)",
        )
          .bind(
            b.device_id,
            b.voltage,
            b.current,
            b.power,
            b.frequency,
            b.energy_total,
            tr.zone,
            tr.cost,
          )
          .run();
        return json({ success: true, tariff: tr });
      }
      if (path === "/api/v1/weather/update" && method === "POST") {
        if (!(await authorized(request, env)))
          return json({ error: "Unauthorized" }, 401);
        const result = await updateWeather(env);
        await evaluateAlerts(env);
        await recommendations(env);
        return json({ success: true, ...result });
      }
      return json({ error: "Not Found", path }, 404);
    } catch (e) {
      console.error("API_ERROR", { path, error: e.message, stack: e.stack });
      return json({ error: e.message || String(e), path }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await updateWeather(env);
        await evaluateAlerts(env);
        await recommendations(env);
        const s = await homeScoreSnapshot(env),
          d = await latestBundle(env),
          zones = d.zones.filter((z) => !z.is_outdoor),
          online = zones.filter(
            (z) => ageMin(z.created_at) != null && ageMin(z.created_at) <= 15,
          ).length,
          device = clamp(zones.length ? (online / zones.length) * 100 : 100),
          energy = d.power?.power > 5000 ? 55 : d.power?.power > 3500 ? 75 : 95,
          weather = d.weather ? 90 : 50;
        await env.DB.prepare(
          "INSERT INTO home_score_history(comfort_score,energy_score,weather_score,device_score,overall_score) VALUES(?,?,?,?,?)",
        )
          .bind(s.scores.comfort, energy, weather, device, s.scores.overall)
          .run();
        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM admin_sessions WHERE expires_at<CURRENT_TIMESTAMP",
          ),
          env.DB.prepare(
            "DELETE FROM admin_login_attempts WHERE created_at<datetime('now','-1 day')",
          ),
          env.DB.prepare(
            "DELETE FROM home_score_history WHERE created_at<datetime('now','-400 days')",
          ),
        ]);
      })(),
    );
  },
};
