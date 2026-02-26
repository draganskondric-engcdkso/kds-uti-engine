/**
 * kds-uti-engine.ts
 *
 * KDS-UTI Protocol Engine — standalone, framework-agnostic TypeScript library.
 * Extracted from KDS-UTI.tsx (original monolith by the KDS project author).
 *
 * Includes:
 *   - KDS type system + branded time types (axis-safe arithmetic)
 *   - Meeus-based solar model (Julian Day, EoT, nutation, obliquity, aberration)
 *   - Solar anchor computation (sunrise/sunset, mean/apparent solar time)
 *   - KDS calendar computation (13×28 + Y-Day)
 *   - Season classification engine
 *   - KDS-UTI Protocol Engine:
 *       • stableStringify — canonical JSON (sorted keys, surrogate validation, no NaN/-0)
 *       • sha256Hex — WebCrypto SHA-256, fail-closed
 *       • proof chain hashing (v1 + v2 schemas)
 *       • event packet validation + hash-chain verification
 *       • conformance test suite
 *       • U64 handling (BigInt-safe decimal encoding)
 *
 * NO React. NO DOM (except WebCrypto for sha256Hex — works in Node.js 18+, browsers, Workers).
 *
 * Quickstart:
 *   import { sha256Hex, stableStringify, kdsUtiVerifyEventLogV1 } from './kds-uti-engine';
 *
 *   
export const KDS_UTI_ENGINE_VERSION = "1.0.0" as const;
const hash = await sha256Hex(stableStringify({ event: "hello", ts: 1234567890 }));
 */

type FidelityLevel = 0 | 1 | 2;

type RefractionMode = "STD" | "METEO";

// Optional offline correction parameters (never required; preserve independence).
// - dut1Sec: UT1-UTC in seconds (DUT1). Default 0 keeps pure UTC behavior.
// - tempC / pressureHPa: used only when refractionMode="METEO" to refine sunrise/sunset definition.
//
// IMPORTANT (KDS rigor): corrections may improve empirical accuracy but MUST NOT
// change the canonical KDS definitions unless explicitly enabled by the user.
type KdsCorrections = {
  // If dut1Table is provided and useDut1Table=true (UI), dut1Sec is ignored.
  dut1Sec: number;
  // Optional offline lookup table for DUT1 (UT1-UTC) by date (YYYY-MM-DD).
  // Format supported:
  //  - object map: {"2026-01-01": 0.123, ...}
  //  - array: [{date:"2026-01-01", dut1Sec:0.123}, ...]
  dut1Table?: unknown;
  // Internal metadata (for cache-key correctness). Not user-facing.
  _dut1Source?: "manual" | "table";
  _dut1TableHash?: number;
  refractionMode: RefractionMode;
  tempC: number;
  pressureHPa: number;
  // Observer geometry (offline, optional). Improves SR/SS realism without any web dependency.
  altitudeM: number;         // meters above sea level
  horizonOffsetDeg: number;  // + raises horizon (later SR, earlier SS); - lowers horizon
};

type CalendarProfile = {
  id?: string;
  label?: string;
  corr?: Partial<KdsCorrections>;
  applyCorrectionsToDomains?: boolean;
};


// ---- Offline-safe defaults for optional correction parameters.
// This does NOT change canonical correctness; it only provides a stable fallback
// when a call-site omits `corr`.
const DEFAULT_CORRECTIONS: KdsCorrections = {
  dut1Sec: 0,
  dut1Table: undefined,
  refractionMode: "STD",
  tempC: 10,
  pressureHPa: 1013,
  altitudeM: 0,
  horizonOffsetDeg: 0,
};


// ----------------- Golden Replay (offline deterministic) -----------------

type ReplayCase = {
  id: string;
  label: string;
  utcMs: number; // UTC timestamp (ms)
  lat: number;
  lon: number;
  level?: FidelityLevel;
  useEotDisplay?: boolean; // display axis only
  // Projection knobs (display + optional domain corrections when enabled)
  corr?: Partial<KdsCorrections>;
  applyCorrectionsToDomains?: boolean;
};


function serializeReplayCases(cases0: ReplayCase[]): string {
  // Keep stable ordering + strip undefined
  const norm = cases0.map((c) => ({
    ...c,
    level: c.level ?? 0,
    useEotDisplay: !!c.useEotDisplay,
    applyCorrectionsToDomains: !!c.applyCorrectionsToDomains,
    corr: c.corr ?? {},
  }));
  return JSON.stringify(norm, null, 2);
}

// Deterministic, rounded key for correction parameters that influence solar anchors / season modeling.

function stableHash32(s: string): number {
  // Simple deterministic 32-bit FNV-1a hash (good enough for cache keys; offline).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619 (with 32-bit overflow)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}



function normalizeDut1Table(raw: unknown): { ok: true; map: Record<string, number>; canonicalJson: string; hash: number } | { ok: false } {
  try {
    const out: Array<{ date: string; dut1Sec: number }> = [];

    // map form: { "YYYY-MM-DD": number }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "number" && Number.isFinite(v)) out.push({ date: k, dut1Sec: v });
      }
    } else if (Array.isArray(raw)) {
      // array form: [{date:"YYYY-MM-DD", dut1Sec:number}]
      for (const row of raw) {
        if (row && typeof row === "object") {
          const rec = row as Record<string, unknown>;
          const d = rec["date"];
          const v = rec["dut1Sec"];
          if (typeof d === "string" && typeof v === "number" && Number.isFinite(v)) out.push({ date: d, dut1Sec: v });
        }
      }
    } else {
      return { ok: false };
    }

    // canonicalize: stable sort by date, keep last value if duplicates
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const map: Record<string, number> = Object.create(null);
    const canon: Array<{ date: string; dut1Sec: number }> = [];
    for (const row of out) {
      // minimal sanity: require YYYY-MM-DD-ish
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
      map[row.date] = row.dut1Sec;
    }
    for (const date of Object.keys(map).sort()) {
      canon.push({ date, dut1Sec: map[date] });
    }
    const canonicalJson = JSON.stringify(canon);
    const hash = stableHash32(canonicalJson);
    return { ok: true, map, canonicalJson, hash };
  } catch {
    return { ok: false };
  }
}

function getCorrectionsCacheKey(c: KdsCorrections): string {
  const src = c._dut1Source ?? "manual";
  const th = Number.isFinite(c._dut1TableHash ?? NaN) ? (c._dut1TableHash as number) : 0;
  return [
    src,
    th,
    Math.round(c.dut1Sec * 1000),
    c.refractionMode,
    Math.round(c.tempC * 10),
    Math.round(c.pressureHPa),
    Math.round(c.altitudeM),
    Math.round(c.horizonOffsetDeg * 1000),
  ].join("|");
}

// Season key MUST NOT depend on DUT1 (UT1-UTC) because DUT1 shifts UTC↔UT1 by <1s
// and must remain a projection-only correction. Day-length physics is effectively DUT1-invariant here.
function getSeasonCorrectionsCacheKey(c: KdsCorrections): string {
  return [
    c.refractionMode,
    Math.round(c.tempC * 10),
    Math.round(c.pressureHPa),
    Math.round(c.altitudeM),
    Math.round(c.horizonOffsetDeg * 1000),
  ].join("|");
}


type EquinoxDebug = {
  startMs: number;
  endMs: number;
  yearLenRealSec: number;
  kdsScale: number; // KDS-sec per SI-sec
  realSinceStartSec: number;
  kdsYearSec: number;
};



type ProjectionTransform =
  | { kind: "DUT1"; enabled: boolean; dut1Sec: number; source: "manual" | "table" | "none" }
  | { kind: "LON_SHIFT"; lonDeg: number; secShift: number }
  | { kind: "EOT"; enabled: boolean; eotSec: number }
  | { kind: "TZ_LOCAL"; tzOffsetSec: number };

type ProjectionTrace = {
  // Canonical axis used for KDS domains (must remain MEAN solar; invariant-enforced).
  domainAxis: "SOLAR_MEAN";
  // Display axis can be MEAN or APPARENT (EoT).
  displayAxis: "SOLAR_MEAN" | "SOLAR_APPARENT";
  // Deterministic list of transformations applied to reach the display signals.
  transforms: ProjectionTransform[];
};

function buildProjectionTrace(args: {
  lonDeg: number;
  dut1Sec: number;
  dut1Source: "manual" | "table" | "none";
  useEot: boolean;
  eotSec: number;
  tzOffsetSec: number;
}): ProjectionTrace {
  const lonShift = args.lonDeg * 240;
  return {
    domainAxis: "SOLAR_MEAN",
    displayAxis: args.useEot ? "SOLAR_APPARENT" : "SOLAR_MEAN",
    transforms: [
      { kind: "DUT1", enabled: Math.abs(args.dut1Sec) > 1e-12, dut1Sec: args.dut1Sec, source: args.dut1Source },
      { kind: "LON_SHIFT", lonDeg: args.lonDeg, secShift: lonShift },
      { kind: "EOT", enabled: !!args.useEot, eotSec: args.useEot ? args.eotSec : 0 },
      { kind: "TZ_LOCAL", tzOffsetSec: args.tzOffsetSec },
    ],
  };
}


type KdsComputationResult = {
  projectionTrace?: ProjectionTrace;

  invariantError?: string; // populated if any KDS invariant is violated

  yearDays: number;

  // "inputs" (internal canonical)
  // KDS year fraction (equinox→equinox, exactly 365*86400 KDS-seconds)
  tau: number; // fraction of KDS year [0,1)
  // Debug: solar-local civil year fraction (Jan-1 based)
  tauSolar: number;
  // Debug-only day fractions (kept separate to avoid semantic drift)
  sigmaKds: number; // KDS-day fraction (kdsSec/86400)
  sigmaSiUtc: number; // SI UTC-day fraction (siSecOfDay/86400)

  doy: Doy; // 1..yearDays (solar-local)
  // Day-of-year used for WARM/COLD segmentation (KDS-aligned mapping into the civil solar year)
  seasonDoy: SeasonDoy;
  lat: number; // φ
  lon: number; // λ (East +)
  level: FidelityLevel;

  // mode / validity
  domainMode: DomainMode;
  astroValidity: AstroValidity;

  // configuration
  doyEq: number;
// derived time signals
  kdsSec: number; // 0..86400
  siSecOfDay: number; // 0..86399 SI seconds-of-day (for solar)
  // Solar seconds-of-day signals
  // NOTE (rigor): KDS domains (DAY/NIGHT, Θ) are defined in MEAN solar time.
  // Apparent solar time (mean + EoT) is provided strictly for display/comparison.
  solarSec: number; // MEAN solar seconds-of-day used for domains
  solarSecDisplay: number; // displayed solar seconds-of-day (mean or apparent, depending on useEot)
  solarSecMean: number; // mean solar seconds (UTC + lon)
  solarSecApp: number; // apparent solar seconds (mean + EoT)
  localSec: number; // civil local seconds (browser tz), purely for display
  eotSec: number; // equation of time correction used

  // solar geometry
  dayLenSec: SolarDurationSec;
  nightLenSec: SolarDurationSec;
  srSecSolar: SolarAnchorSec; // sunrise in solar seconds (around 06:xx)
  ssSecSolar: SolarAnchorSec; // sunset  in solar seconds (around 18:xx)

  // uncertainty diagnostics (seconds; deterministic estimates)
  srUncSec: number;
  ssUncSec: number;
  dayLenUncSec: number;
  h0DegUsed: number;

  // domains / phases
  domain: "DAY" | "NIGHT";
  theta: number; // 0..9999 within DAY or NIGHT

  season: "WARM" | "COLD";
  phi: number; // 0..9999 within current season segment

  // season progress (0..1) within current WARM/COLD segment (circular)
  seasonPct01: number;

  segStart: number;
  segEnd: number;
  segLen: number;
  k: number;

  stamp: string;

  // Dual-domain bundle (axis-safe representations of the key signals).
  dual: {
    canonDay: DualDomain<"KDS_CANON", "CANON", KdsSec, { tau: number; kdsDoy: number }>;
    solarMeanDay: DualDomain<"SOLAR_MEAN", "MEAN", MeanSolarSec, { lonDeg: number; dut1Sec: number }>;
    solarAppDay: DualDomain<"SOLAR_APPARENT", "APPARENT", ApparentSolarSec, { lonDeg: number; dut1Sec: number; eotSec: number }>;
    solarDisplayDay: DualDomain<
      "SOLAR_MEAN" | "SOLAR_APPARENT",
      "MEAN" | "APPARENT",
      MeanSolarSec | ApparentSolarSec,
      { useEot: boolean }
    >;
    civilLocalDay: DualDomain<"CIVIL_LOCAL", "CIVIL", CivilLocalSec, {}>;
    anchors: DualDomain<
      "SOLAR_MEAN",
      "NORMAL" | "ALWAYS_UP" | "ALWAYS_DOWN",
      number,
      { srSecSolar: SolarAnchorSec; ssSecSolar: SolarAnchorSec; h0DegUsed: number; srUncSec: number; ssUncSec: number; dayLenUncSec: number }
    >;
    dayNight: DualDomain<
      "SOLAR_MEAN",
      "DAY" | "NIGHT",
      number,
      { theta: number; srSecSolar: SolarAnchorSec; ssSecSolar: SolarAnchorSec; dayLenSec: SolarDurationSec; nightLenSec: SolarDurationSec }
    >;
    season: DualDomain<
      "KDS_CANON",
      "WARM" | "COLD",
      number,
      { phi: number; segStart: number; segEnd: number; segLen: number; k: number }
    >;

    // Flexible registry of additional dualized signals (keyed). Use this for debug/inspection,
    // but keep core signals above as the stable API.
    extra: Record<string, DualDomain<string, string, unknown, Record<string, unknown>>>;
  };
};

const PHASE_SCALE_10K = 10000;
// Canonical epsilons (keep meanings stable across the file)
const TAU_EPS_BELOW_ZERO = 1e-9;
const TAU_EPS_BELOW_ONE = 1e-12;
const EPS_SECONDS = 1e-3;
const EPS_KDS_YEAR_SCALE = 1e-6;
const EPS_NON_ZERO = 1e-9;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const clampInt = (x: number, a: number, b: number) => Math.min(b, Math.max(a, Math.trunc(x)));
const unbrand = <T extends number>(v: T): number => (v as unknown as number);
const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
// ---------- KDS semantic time brands (compile-time guard against axis mixing) ----------
// These are zero-cost at runtime; they prevent accidental mixing of canonical (KDS),
// mean-solar, apparent-solar, and civil-local axes in refactors.
type Brand<K extends string> = { readonly __brand: K };
type Branded<T, K extends string> = T & Brand<K>;

type KdsSec = Branded<number, "KdsSec">;

type Doy = Branded<number, "Doy">;
type SeasonDoy = Branded<number, "SeasonDoy">;
                 // canonical 0..86400 (KDS-second)
type MeanSolarSec = Branded<number, "MeanSolarSec">;     // mean solar seconds-of-day (longitude + DUT1)
type SolarAnchorSec = Branded<number, "SolarAnchorSec">; // MEAN solar seconds-of-day intended for SR/SS anchors and canonical solarSec
type SolarDurationSec = Branded<number, "SolarDurationSec">; // duration in seconds along MEAN solar axis (dayLen/nightLen)

type ApparentSolarSec = Branded<number, "ApparentSolarSec">; // mean + EoT (display only)
type CivilLocalSec = Branded<number, "CivilLocalSec">;   // browser local time-of-day (display only)

// ---- Domain mode (CANON vs PROFILED/PROJECTION) ----
type DomainMode = "CANON_STRICT" | "PROFILED_PROJECTION";

// ---- Astro validity (confidence diagnostics; does NOT affect canon) ----
type AstroConfidence = "OK" | "ESTIMATED" | "OUT_OF_RANGE";
type AstroValidity = {
  deltaTModel: "NASA_POLY";
  deltaTConfidence: AstroConfidence;
  equinoxPolyConfidence: AstroConfidence;
  notes: string[];
};

// ---- KDS Event Packet (vNext): event as object (Time + Space + Proof) ----
// This layer upgrades the app from "time as string" to "event as canonical object".
// It does NOT change KDS canon; it provides a stable transport/storage protocol.
//
// Design:
// - event_uid + mono_tick_ms are the minimal offline-stable identity.
// - uti_tick_ms is the coordination axis when available (in this web build, derived from Date.now()).
// - ati_tau is the astro anchor (CANON) with confidence metadata.
// - proof fields provide hash-chain integrity for event logs (offline-friendly).

type U64Like = number | string | bigint;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  return isFiniteNumber(v) ? v : null;
}

function asFiniteInt(v: unknown): number | null {
  if (!isFiniteNumber(v)) return null;
  const n = Math.trunc(v);
  return Number.isFinite(n) ? n : null;
}

// Local U64 checker (string form) usable before the main U64 helpers.
const U64_MAX_LOCAL = 18446744073709551615n;
function isU64DecStringLocal(s: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(s)) return false;
  try {
    const x = BigInt(s);
    return x >= 0n && x <= U64_MAX_LOCAL;
  } catch {
    return false;
  }
}

function isU64Like(v: unknown): v is U64Like {
  if (typeof v === "bigint") return v >= 0n;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 && Number.isSafeInteger(v);
  if (typeof v === "string") return isU64DecStringLocal(v.trim());
  return false;
}

function sanitizeU64Like(v: unknown): U64Like | undefined {
  if (!isU64Like(v)) return undefined;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Math.trunc(v);
  return v;
}

function sanitizeHex64(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : (isHex64(s) ? s : undefined);
}

function parseUtiCalibration(v: unknown): UtiCalibration | null {
  if (!isRecord(v)) return null;
  const baseUtcMs = asFiniteNumber(v.baseUtcMs);
  const baseMonoMs = asFiniteNumber(v.baseMonoMs);
  const scale = asFiniteNumber(v.scale);
  const createdUtcMs = asFiniteNumber(v.createdUtcMs);
  const conf = parseUtiConf(v.conf) ?? "OK";
  if (baseUtcMs == null || baseMonoMs == null || scale == null || createdUtcMs == null) return null;
  return { baseUtcMs, baseMonoMs, scale, createdUtcMs, conf };
}

// Transport-level sanitizer: accept only JSON-safe primitives + known optional fields.
// This prevents prototype pollution / weird types from localStorage/import.
function sanitizeKdsEventPacket(v: unknown): KdsEventPacket | null {
  if (!isRecord(v)) return null;
  const event_uid = asString(v.event_uid);
  const created_utc_ms = asFiniteNumber(v.created_utc_ms);
  const mono_tick_ms = asFiniteNumber(v.mono_tick_ms);
  if (!event_uid || created_utc_ms == null || mono_tick_ms == null) return null;

  const e: KdsEventPacket = {
    event_uid,
    created_utc_ms,
    mono_tick_ms,
  };

  const source_uid = asString(v.source_uid);
  if (source_uid) e.source_uid = source_uid;

  const event_seq = sanitizeU64Like(v.event_seq);
  if (event_seq !== undefined) e.event_seq = event_seq;

  const mono_seq = asFiniteInt(v.mono_seq);
  if (mono_seq != null) e.mono_seq = mono_seq;

  const uti_tick_ms = sanitizeU64Like(v.uti_tick_ms);
  if (uti_tick_ms !== undefined) e.uti_tick_ms = uti_tick_ms;

  const uti_conf = parseUtiConf(v.uti_conf);
  if (uti_conf) e.uti_conf = uti_conf;

  const uti_timescale = parseUtiTimescale(v.uti_timescale);
  if (uti_timescale) e.uti_timescale = uti_timescale;

  const tai_utc_offset_s = asFiniteNumber(v.tai_utc_offset_s);
  if (tai_utc_offset_s != null) e.tai_utc_offset_s = tai_utc_offset_s;

  const uti_uncertainty_ms = asFiniteNumber(v.uti_uncertainty_ms);
  if (uti_uncertainty_ms != null) e.uti_uncertainty_ms = uti_uncertainty_ms;

  const ati_tau = asFiniteNumber(v.ati_tau);
  if (ati_tau != null) e.ati_tau = ati_tau;

  const ati_conf = parseAstroConfidence(v.ati_conf);
  if (ati_conf) e.ati_conf = ati_conf;

  const kds_sec_of_year = asFiniteInt(v.kds_sec_of_year);
  if (kds_sec_of_year != null) e.kds_sec_of_year = kds_sec_of_year;

  const equinox_start_ms = asFiniteNumber(v.equinox_start_ms);
  if (equinox_start_ms != null) e.equinox_start_ms = equinox_start_ms;

  const equinox_end_ms = asFiniteNumber(v.equinox_end_ms);
  if (equinox_end_ms != null) e.equinox_end_ms = equinox_end_ms;

  const loc_id = asString(v.loc_id);
  if (loc_id) e.loc_id = loc_id;

  const lat = asFiniteNumber(v.lat);
  if (lat != null) e.lat = lat;

  const lon = asFiniteNumber(v.lon);
  if (lon != null) e.lon = lon;

  const alt_m = asFiniteNumber(v.alt_m);
  if (alt_m != null) e.alt_m = alt_m;

  const domain_mode = parseDomainMode(v.domain_mode);
  if (domain_mode) e.domain_mode = domain_mode;

  const projection_profile_id = asString(v.projection_profile_id);
  if (projection_profile_id) e.projection_profile_id = projection_profile_id;

  const proof_v = v.proof_v === 1 || v.proof_v === 2 ? v.proof_v : undefined;
  if (proof_v) e.proof_v = proof_v;

  const prev_hash = asString(v.prev_hash);
  if (prev_hash) e.prev_hash = prev_hash;

  const event_hash = sanitizeHex64(v.event_hash);
  if (event_hash) e.event_hash = event_hash;

  const hash = sanitizeHex64(v.hash);
  if (hash) e.hash = hash;

  const checkpoint = asString(v.checkpoint);
  if (checkpoint) e.checkpoint = checkpoint;

  const unix_ms = asFiniteNumber(v.unix_ms);
  if (unix_ms != null) e.unix_ms = unix_ms;

  const uti64 = asString(v.uti64);
  if (uti64) e.uti64 = uti64;

  // kds legacy blob: keep only if it's a plain record (UI-only, not proof).
  if (isRecord(v.kds)) e.kds = v.kds as unknown as KdsEventPacket["kds"];

  // meta is UI-only; keep only plain records to avoid poisoning state.
  if (isRecord(v.meta)) e.meta = v.meta as Record<string, unknown>;

  return e;
}


// ---- Strict enum parsers (fail-closed for protocol) -----------------------

const UTI_CONF_VALUES = ["OK","ESTIMATED","UNVERIFIED"] as const;
type UtiConf = (typeof UTI_CONF_VALUES)[number];
function parseUtiConf(v: unknown): UtiConf | null {
  if (typeof v !== "string") return null;
  return (UTI_CONF_VALUES as readonly string[]).includes(v) ? (v as UtiConf) : null;
}

const UTI_TIMESCALE_VALUES = ["POSIX_UTC","TAI","TT"] as const;
type UtiTimescale = (typeof UTI_TIMESCALE_VALUES)[number];
function parseUtiTimescale(v: unknown): UtiTimescale | null {
  if (typeof v !== "string") return null;
  return (UTI_TIMESCALE_VALUES as readonly string[]).includes(v) ? (v as UtiTimescale) : null;
}

const DOMAIN_MODE_VALUES = ["CANON_STRICT","PROFILED_PROJECTION"] as const;
function parseDomainMode(v: unknown): DomainMode | null {
  if (typeof v !== "string") return null;
  return (DOMAIN_MODE_VALUES as readonly string[]).includes(v) ? (v as DomainMode) : null;
}

const ASTRO_CONF_VALUES = ["OK","ESTIMATED","OUT_OF_RANGE"] as const;
function parseAstroConfidence(v: unknown): AstroConfidence | null {
  if (typeof v !== "string") return null;
  return (ASTRO_CONF_VALUES as readonly string[]).includes(v) ? (v as AstroConfidence) : null;
}

function isHex64(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
}

function kdsUtiValidateConformantV1(e: KdsEventPacket): string | null {
  // NOTE: This is a transport + semantic conformance check for v1 packet shape.
  // Hash-chain rules (prev_hash linkage, computed hash equality) are validated in kdsUtiVerifyEventLogV1.

  if (typeof e.event_uid !== "string" || !e.event_uid) return "event_uid";

  if (!isFiniteNumber(e.created_utc_ms) || !Number.isInteger(e.created_utc_ms) || e.created_utc_ms < 0) return "created_utc_ms";
  if (!isFiniteNumber(e.mono_tick_ms) || !Number.isInteger(e.mono_tick_ms) || e.mono_tick_ms < 0) return "mono_tick_ms";
  if (e.mono_seq !== undefined) {
    if (!isFiniteNumber(e.mono_seq) || !Number.isInteger(e.mono_seq) || e.mono_seq < 0) return "mono_seq";
  }

  if (e.source_uid !== undefined) {
    if (typeof e.source_uid !== "string") return "source_uid";
  }

  const u64LikeOk = (v: unknown): boolean => {
    if (v === undefined) return true;
    if (typeof v === "bigint") return v >= 0n && v <= U64_MAX_LOCAL;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return false;
      const n = Math.trunc(v);
      if (!Number.isSafeInteger(n) || n < 0) return false;
      return BigInt(n) <= U64_MAX_LOCAL;
    }
    if (typeof v === "string") return isU64DecStringLocal(v);
    return false;
  };

  if (!u64LikeOk(e.event_seq)) return "event_seq";
  if (!u64LikeOk(e.uti_tick_ms)) return "uti_tick_ms";

  if (e.uti_conf !== undefined && !parseUtiConf(e.uti_conf)) return "uti_conf";
  if (e.uti_timescale !== undefined && !parseUtiTimescale(e.uti_timescale)) return "uti_timescale";
  if (e.domain_mode !== undefined && !parseDomainMode(e.domain_mode)) return "domain_mode";
  if (e.ati_conf !== undefined && !parseAstroConfidence(e.ati_conf)) return "ati_conf";

  if (e.tai_utc_offset_s !== undefined) {
    if (!isFiniteNumber(e.tai_utc_offset_s) || !Number.isInteger(e.tai_utc_offset_s) || Math.abs(e.tai_utc_offset_s) > 100) return "tai_utc_offset_s";
  }
  if (e.uti_uncertainty_ms !== undefined) {
    if (!isFiniteNumber(e.uti_uncertainty_ms) || !Number.isInteger(e.uti_uncertainty_ms) || e.uti_uncertainty_ms < 0) return "uti_uncertainty_ms";
  }

  if (e.ati_tau !== undefined) {
    if (!isFiniteNumber(e.ati_tau) || !(e.ati_tau >= 0 && e.ati_tau < 1)) return "ati_tau";
  }

  if (e.kds_sec_of_year !== undefined) {
    const max = 365 * 86400;
    if (!isFiniteNumber(e.kds_sec_of_year) || !Number.isInteger(e.kds_sec_of_year) || e.kds_sec_of_year < 0 || e.kds_sec_of_year >= max) return "kds_sec_of_year";
  }
  if (e.equinox_start_ms !== undefined) {
    if (!isFiniteNumber(e.equinox_start_ms) || !Number.isInteger(e.equinox_start_ms)) return "equinox_start_ms";
  }
  if (e.equinox_end_ms !== undefined) {
    if (!isFiniteNumber(e.equinox_end_ms) || !Number.isInteger(e.equinox_end_ms)) return "equinox_end_ms";
  }
  if (e.equinox_start_ms !== undefined && e.equinox_end_ms !== undefined) {
    if (e.equinox_end_ms <= e.equinox_start_ms) return "equinox_end_ms";
  }

  if (e.loc_id !== undefined && typeof e.loc_id !== "string") return "loc_id";
  if (e.lat !== undefined) {
    if (!isFiniteNumber(e.lat) || e.lat < -90 || e.lat > 90) return "lat";
  }
  if (e.lon !== undefined) {
    if (!isFiniteNumber(e.lon) || e.lon < -180 || e.lon > 180) return "lon";
  }
  if (e.alt_m !== undefined) {
    if (!isFiniteNumber(e.alt_m)) return "alt_m";
  }

  if (e.proof_v !== undefined && e.proof_v !== 1 && e.proof_v !== 2) return "proof_v";

  // NOTE: prev_hash is *semantically* validated by the chain rule (must equal the previous computed hash).
  // The conformance suite includes a CHAIN_BREAK case that intentionally injects a malformed prev_hash.
  // We therefore do NOT treat "prev_hash not hex" as a NONCONFORMANT_FIELD here; we let CHAIN_BREAK fire.
  if (e.prev_hash !== undefined && typeof e.prev_hash !== "string") return "prev_hash";

  if (e.event_hash !== undefined && e.event_hash !== "" && !isHex64(e.event_hash)) return "event_hash";
  if (e.hash !== undefined && e.hash !== "" && !isHex64(e.hash)) return "hash";
  return null;
}



type KdsEventPacket = {
  // Stable source identity for a given installation/session.
  // NOTE: This is NOT the same as event_uid. It enables robust ordering + uniqueness across imports.
  source_uid?: string;

  // Strictly increasing sequence within the source (recommended for protocol-grade uniqueness).
  // (event_seq, source_uid) is a stable total order independent of clocks.
  event_seq?: U64Like;

  event_uid: string;
  created_utc_ms: number; // creation time in UTC ms (coordination-friendly)
  mono_tick_ms: number;   // monotonic tick within this client session/log

  // Tie-break when multiple events share the same mono_tick_ms (possible at ms resolution).
  mono_seq?: number;

  uti_tick_ms?: U64Like;   // optional global tick (UTC-ms in this build; can be remapped to KDS-UTI)
  uti_conf?: "OK" | "ESTIMATED" | "UNVERIFIED";

  // Time scale semantics for uti_tick_ms (drop-in default: POSIX-equivalent UTC seconds stream).
  // IMPORTANT: UTI tick stream is NOT TAI and NOT TT unless explicitly stated by profile/metadata.
  uti_timescale?: "POSIX_UTC" | "TAI" | "TT";
  // If uti_timescale indicates a non-POSIX scale or if forensics require explicit offsets,
  // provide the TAI-UTC offset (seconds) at event creation/import time.
  tai_utc_offset_s?: number;
  // Optional uncertainty bound for wall-clock correlation (ms). Does not affect ordering.
  uti_uncertainty_ms?: number;

  // Astro anchor (CANON-derived)
  ati_tau?: number; // τ in [0,1)
  ati_conf?: AstroConfidence;

  // Canonical KDS-UTI scaffold (offline, deterministic):
  // seconds-of-year in the strict 365×86400 KDS canon, plus the equinox window used.
  // This is the intended long-term replacement for Unix ticks (uti_tick_ms).
  kds_sec_of_year?: number; // integer in [0, 365*86400)
  equinox_start_ms?: number;
  equinox_end_ms?: number;

  // Space (optional but recommended for solar views)
  loc_id?: string;
  lat?: number;
  lon?: number;
  alt_m?: number;

  // Mode/profile (CANON vs PROFILED)
  domain_mode?: DomainMode;
  projection_profile_id?: string;

  // Proof layer (optional; computed when event is persisted into the log)
  proof_v?: 1 | 2;
  prev_hash?: string; // hex SHA-256
  event_hash?: string; // hex SHA-256 (spec name)
  hash?: string;      // hex SHA-256 (legacy alias)
  checkpoint?: string;

  // ----- Legacy / UI-derived mirrors (backward compatible) -----
  // These exist in older exports + the in-app simulator. They are not required
  // for protocol verification, but the UI expects them.
  unix_ms?: number;
  uti64?: string;
  kds?: {
    year_id: number;
    us_of_year: string;
    tau: number;
    doy_kds: number;
    kds_date: string;
    eq_start_ms: number;
    eq_end_ms: number;
    // Display-only mirrors (MUST NOT affect CANON / proof hashing unless explicitly whitelisted).
    // Kept for UI compatibility with legacy exports.
    proj_eot_display?: boolean;
    proj_dut1_sec?: number;
  };

  // Free metadata (non-canonical)
  meta?: Record<string, unknown>;
};

type KdsEventMeta = {
  event_uid?: string;
  mono_tick_ms?: number;
  uti_tick_ms?: U64Like;
  event_hash?: string;
  hash?: string;
  prev_hash?: string;
};


const GENESIS_HASH = "0".repeat(64);

function getEventHash(e: KdsEventPacket): string {
  return String(e.event_hash ?? e.hash ?? "");
}
function setEventHash(e: KdsEventPacket, h: string): void {
  e.event_hash = h;
  e.hash = h; // keep legacy alias for backward compatibility
}
function getPrevHash(e: KdsEventPacket): string {
  return String(e.prev_hash ?? "");
}

type UtiCalibration = {
  // Map MONO(ms) -> UTI(ms): uti = baseUtcMs + (monoNowMs - baseMonoMs) * scale
  baseUtcMs: number;
  baseMonoMs: number;
  scale: number; // default 1.0
  createdUtcMs: number;
  conf: "OK" | "ESTIMATED" | "UNVERIFIED";
};



// ---- Canonical JSON string safety (protocol-grade) ----
// IMPORTANT: Many languages treat lone UTF-16 surrogates differently.
// To keep cross-language canonicalization unambiguous, we REJECT strings (and object keys)
// that contain unpaired surrogate code units.
function assertNoUnpairedSurrogates(s: string, ctx = "string"): void {
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    const isHigh = cu >= 0xd800 && cu <= 0xdbff;
    const isLow = cu >= 0xdc00 && cu <= 0xdfff;
    if (isHigh) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      const nextIsLow = next >= 0xdc00 && next <= 0xdfff;
      if (!nextIsLow) throw new Error(`HASH_INPUT_NOT_CANONICAL: unpaired high surrogate in ${ctx}`);
      i++;
      continue;
    }
    if (isLow) throw new Error(`HASH_INPUT_NOT_CANONICAL: unpaired low surrogate in ${ctx}`);
  }
}
// Stable canonical stringify (sorted keys) for proof hashing.
// NOTE: this is intentionally conservative and supports JSON-safe values only.
function stableStringify(obj: unknown): string {
  const seen = new WeakSet<object>();

  const norm = (v: unknown): unknown => {
    if (v === null) return null;

    const t = typeof v;
    if (t === "string") { assertNoUnpairedSurrogates(v as string, "string"); return v; }
    if (t === "boolean") return v;

    if (t === "number") {
      if (!Number.isFinite(v)) throw new Error("HASH_INPUT_NOT_CANONICAL: non-finite number");
      if (Object.is(v, -0)) throw new Error("HASH_INPUT_NOT_CANONICAL: negative zero");
      return v;
    }

    if (t === "bigint") return (v as bigint).toString();

    if (t === "undefined") return null;

    if (t === "function" || t === "symbol") {
      throw new Error(`HASH_INPUT_NOT_CANONICAL: unsupported type ${t}`);
    }

    if (Array.isArray(v)) {
      const a = v as unknown[];
      const out = new Array(a.length);
      for (let i = 0; i < a.length; i++) {
        // Canonicalize sparse arrays explicitly (JSON.stringify turns holes into null).
        out[i] = Object.prototype.hasOwnProperty.call(a, i) ? norm(a[i]) : null;
      }
      return out;
    }

    if (t === "object") {
      const o = v as Record<string, unknown>;
      if (seen.has(o)) throw new Error("HASH_INPUT_NOT_CANONICAL: circular reference");
      seen.add(o);

      const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        assertNoUnpairedSurrogates(k, "object key");
        out[k] = norm(o[k]);
      }
      return out;
    }

    throw new Error(`HASH_INPUT_NOT_CANONICAL: unsupported type ${t}`);
  };

  return JSON.stringify(norm(obj));
}

async function sha256Hex(text: string): Promise<string> {
  const getCryptoSubtle = async (): Promise<SubtleCrypto> => {
    const c0 = (globalThis as unknown as { crypto?: Crypto }).crypto;
    if (c0?.subtle) return c0.subtle;

    // Node.js fallback (when globalThis.crypto is not exposed).
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const mod = await (new Function("return import('node:crypto')")() as Promise<any>);
      const wc = (mod as unknown as { webcrypto?: Crypto }).webcrypto;
      if (wc?.subtle) return wc.subtle;
    } catch {
      // ignore
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const mod = await (new Function("return import('crypto')")() as Promise<any>);
      const wc = (mod as unknown as { webcrypto?: Crypto }).webcrypto;
      if (wc?.subtle) return wc.subtle;
    } catch {
      // ignore
    }

    throw new Error("CRYPTO_UNAVAILABLE: crypto.subtle.digest(SHA-256) not available");
  };

  const subtle = await getCryptoSubtle();
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const digest = await subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}


function makeEventUID(): string {
  // Engine default: cryptographically strong UID.
  // If WebCrypto is unavailable, we FAIL CLOSED.
  const c = globalThis.crypto as (Crypto & { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array }) | undefined;
  const ru = c?.randomUUID;
  if (typeof ru === "function") return ru.call(c);

  const grv = c?.getRandomValues;
  if (typeof grv !== "function") {
    throw new Error("CRYPTO_UNAVAILABLE: crypto.getRandomValues not available");
  }

  // RFC 4122 version-4 UUID from random bytes.
  const b = new Uint8Array(16);
  grv.call(c, b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeEventUIDWeak(): string {
  // NON-CRYPTO fallback UID generator (best-effort uniqueness only).
  // Useful for tests or constrained runtimes.
  return "u_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}



// ---- Branded constructors (SAFE) ----
// Avoid using `asX` casts directly at call-sites. Casts are kept private here.
const _asKdsSec = (x: number): KdsSec => x as KdsSec;
const _asMeanSolarSec = (x: number): MeanSolarSec => x as MeanSolarSec;
const _asSolarAnchorSec = (x: number): SolarAnchorSec => x as SolarAnchorSec;
const _asSolarDurationSec = (x: number): SolarDurationSec => x as SolarDurationSec;
const _asApparentSolarSec = (x: number): ApparentSolarSec => x as ApparentSolarSec;
const _asCivilLocalSec = (x: number): CivilLocalSec => x as CivilLocalSec;

const normSec86400 = (x: number): number => {
  const m = x % 86400;
  return m < 0 ? m + 86400 : m;
};

function makeKdsSec(x: number, name = "kdsSec"): KdsSec {
  if (!Number.isFinite(x)) throw new Error(`${name} not finite: ${x}`);
  // KDS seconds-of-day are canonical 0..86399, but we accept 0..86400 and normalize.
  const s = normSec86400(x);
  // Prefer integer KDS-sec (engine stores as integer).
  const si = Math.floor(s + 1e-9);
  if (si < 0 || si >= 86400) throw new Error(`${name} out of range after norm: ${x} -> ${si}`);
  return _asKdsSec(si);
}

function makeMeanSolarSec(x: number, name = "solarSecMean"): MeanSolarSec {
  if (!Number.isFinite(x)) throw new Error(`${name} not finite: ${x}`);
  return _asMeanSolarSec(normSec86400(x));
}

function makeSolarAnchorSec(x: number, name = "solarAnchorSec"): SolarAnchorSec {
  if (!Number.isFinite(x)) throw new Error(`${name} not finite: ${x}`);
  // IMPORTANT: Solar anchors allow the closed interval [0, 86400].
  // We use ss=86400 as a sentinel for polar day (24h daylight). Do NOT modulo-wrap it to 0.
  const EPS = 1e-9;
  if (x >= 86400 - EPS && x <= 86400 + EPS) return _asSolarAnchorSec(86400);
  return _asSolarAnchorSec(normSec86400(x));
}

function makeSolarDurationSec(x: number, name = "solarDurationSec"): SolarDurationSec {
  if (!Number.isFinite(x)) throw new Error(`${name} not finite: ${x}`);
  if (x < 0 || x > 86400 + 1e-6) throw new Error(`${name} out of range: ${x}`);
  return _asSolarDurationSec(Math.max(0, Math.min(86400, x)));
}

function makeApparentSolarSec(x: number, name = "solarSecApp"): ApparentSolarSec {
  if (!Number.isFinite(x)) throw new Error(`${name} not finite: ${x}`);
  return _asApparentSolarSec(normSec86400(x));
}

function makeCivilLocalSec(x: number, name = "civilLocalSec"): CivilLocalSec {
  if (!Number.isFinite(x)) throw new Error(`${name} not finite: ${x}`);
  return _asCivilLocalSec(normSec86400(x));
}


// ---------- Dual registry: type-safe core keys ----------
const DUAL_CORE_KEYS = [
  "canonDay",
  "solarMeanDay",
  "solarAppDay",
  "solarDisplayDay",
  "civilLocalDay",
  "anchors",
  "dayNight",
  "season",
] as const;

type DualCoreKey = (typeof DUAL_CORE_KEYS)[number];

const isDualCoreKey = (k: string): k is DualCoreKey =>
  (DUAL_CORE_KEYS as readonly string[]).includes(k);

// ---------- Dual-domain core (KDS generalization) ----------
// Any "important signal" can be represented as a dual-domain state:
// - axis: which time/physics axis this signal belongs to (prevents mixing)
// - domain: which discrete regime the signal is in (e.g., DAY/NIGHT, WARM/COLD, MEAN/APPARENT)
// - phase: 0..9999 normalized position within the active domain
// - start/end: domain boundaries in the same axis units
// - value: the raw value carried by the signal (often seconds-of-day or DOY)
// - meta: optional additional diagnostics
// NOTE: this file evolves quickly and we tag many diagnostic meanings.
// Keep it open-ended while preserving the core canonical meaning tags.
type PhaseMeaning = "POSITION" | "QUALITY" | "DIST_TO_BOUNDARY" | "TREND" | "MODEL" | string;

// Same rationale: allow extra diagnostic classes (e.g. H1/H2, DAY/NIGHT, etc.).
type DualDomainClass = "BOUNDARY" | "QUALITY" | "MODEL" | string;

// Any "important signal" can be represented as a dual-domain state.
// KDS discipline:
// - axis: which axis this signal belongs to (prevents mixing)
// - domain: which discrete regime the signal is in (e.g., DAY/NIGHT, WARM/COLD)
// - class: how to interpret the dualization (BOUNDARY vs QUALITY vs MODEL)
// - phaseMeaning: semantics of phase (POSITION vs QUALITY vs ...)
// - phase: 0..9999 normalized measure consistent with phaseMeaning
// - start/end: domain boundaries or reference range (same axis units)
// - value: raw carried value
// - valid/reason: safety
// - meta: diagnostics
type DualDomain<
  Axis extends string,
  Domain extends string,
  Value = number,
  Meta = Record<string, unknown>
> = {
  axis: Axis;
  domain: Domain;
  class: DualDomainClass;
  phaseMeaning: PhaseMeaning;
  phase: number; // 0..9999
  start: number;
  end: number;
  value: Value;
  valid: boolean;
  reason?: string;
  meta?: Meta;
};

function phaseFrom01(p01: number): number {
  return clamp(Math.floor((PHASE_SCALE_10K - 1) * clamp(p01, 0, 1)), 0, 9999);
}

function phaseFromRange(value: number, start: number, end: number): number {
  const len = end - start;
  if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end) || len <= 0) return 0;
  return phaseFrom01((value - start) / len);
}

function makeDual<
  Axis extends string,
  Domain extends string,
  Value = number,
  Meta = Record<string, unknown>
>(
  axis: Axis,
  domain: Domain,
  cls: DualDomainClass,
  phaseMeaning: PhaseMeaning,
  value: Value,
  start: number,
  end: number,
  phase: number,
  meta?: Meta,
  valid: boolean = true,
  reason?: string,
): DualDomain<Axis, Domain, Value, Meta> {
  return {
    axis,
    domain,
    class: cls,
    phaseMeaning,
    value,
    start,
    end,
    phase: clamp(Math.floor(phase), 0, 9999),
    meta,
    valid,
    reason,
  };
}


type AnyDual = DualDomain<string, string, unknown, Record<string, unknown>>;

// ------------------------------------------------------------------------------------

// Safe monotonic timer for chunk budgeting (works even in limited envs)
const safeNowMs = () => {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
    // ignore
  }
  return Date.now();
};


// ---------- Deterministic memoization (offline, no external deps) ----------
// Goals:
// - reduce repeated Meeus computations during frequent UI ticks
// - keep accuracy: cache granularity is 1 SI-second for EoT
//
// RIGOR: caches are bounded (CAP) + time-limited (TTL) to prevent unbounded growth.
// This preserves independence (no external storage) and does not affect correctness.

type CacheEntry<T> = { v: T; t: number };

// Cache clock control:
// In normal interactive mode we use wall-clock (Date.now) for TTL pruning.
// In deterministic replay/self-test mode we derive the "now" value from the input timestamp
// so caching stays fully reproducible (no hidden dependency on wall time).
let __deterministicCacheClock = false;
function setDeterministicCacheClock(v: boolean) {
  __deterministicCacheClock = !!v;
}
function cacheClockNowMs(seedMs: number) {
  return __deterministicCacheClock ? seedMs : Date.now();
}


function cacheGet<K, V>(
  m: Map<K, CacheEntry<V>>,
  k: K,
  now: number,
  ttlMs: number,
): V | undefined {
  const e = m.get(k);
  if (!e) return undefined;
  if (now - e.t > ttlMs) {
    m.delete(k);
    return undefined;
  }
  return e.v;
}

function cacheSet<K, V>(
  m: Map<K, CacheEntry<V>>,
  k: K,
  v: V,
  now: number,
  ttlMs: number,
  cap: number,
) {
  m.set(k, { v, t: now });

  // Opportunistic TTL prune (cheap; bounded by cap guard below for worst cases).
  for (const [key, e] of m) {
    if (now - e.t > ttlMs) m.delete(key);
  }

  // Hard cap: if exceeded, drop oldest ~10% (Map preserves insertion order).
  if (m.size > cap) {
    const target = Math.floor(cap * 0.9);
    // Oldest are the earliest inserted; iterate keys.
    for (const key of m.keys()) {
      m.delete(key);
      if (m.size <= target) break;
    }
  }
}

const EOT_TTL_MS = 14 * 86400000; // keep up to ~2 weeks (fine for UI)
const EOT_CAP = 20000;

const __eotCacheSec = new Map<number, CacheEntry<number>>();
function equationOfTimeSecondsUtcMsCached(utcMs: number, level: FidelityLevel): number {
  const k = Math.floor(utcMs / 1000); // SI-second bucket
  const now = cacheClockNowMs(k * 1000);
  const hit = cacheGet(__eotCacheSec, k, now, EOT_TTL_MS);
  if (hit !== undefined) return hit;
  const v = equationOfTimeSecondsUtcMs(k * 1000, level);
  cacheSet(__eotCacheSec, k, v, now, EOT_TTL_MS, EOT_CAP);
  return v;
}

const ANCH_TTL_MS = 2 * 365 * 86400000; // keep ~2 years of anchor-days
const ANCH_CAP = 6000;

// UI-only aliases (some panels refer to these names)
const MAX_EOT_CACHE = EOT_CAP;
const MAX_ANCHORS_CACHE = ANCH_CAP;

const __anchorsCache = new Map<string, CacheEntry<SolarAnchors>>();
function solarAnchorsForUtcDayMemo(
  latDeg: number,
  lonDeg: number,
  utcMs: number,
  level: FidelityLevel,
  corr?: KdsCorrections,
): SolarAnchors {
  const cIn = corr ?? DEFAULT_CORRECTIONS;

  // KDS CANON RIGOR:
  // Solar anchors (SR/SS/dayLen) are *domain physics* and MUST be invariant to DUT1 (UT1-UTC).
  // DUT1 is a sub-second civil/projection correction and is not allowed to affect:
  // - which rotation-day is chosen,
  // - the computed sunrise/sunset in solar-seconds,
  // - or season/day-night domains.
  //
  // Therefore we hard-strip DUT1 here (even if a caller mistakenly passes it).
  const c: KdsCorrections = {
    ...cIn,
    dut1Sec: 0,
    dut1Table: undefined,
    _dut1Source: undefined,
    _dut1TableHash: undefined,
  };

  const mid = utcMidnightMsForRotationDay(utcMs, 0);

  // key rounding keeps determinism and prevents huge key strings
  const key = `${mid}|${level}|${Math.round(latDeg * 1e6)}|${Math.round(lonDeg * 1e6)}|${c.refractionMode}|${Math.round(c.tempC * 10)}|${Math.round(c.pressureHPa)}|${Math.round(c.altitudeM)}|${Math.round(c.horizonOffsetDeg * 1000)}`;
  const now = cacheClockNowMs(mid);
  const hit = cacheGet(__anchorsCache, key, now, ANCH_TTL_MS);
  if (hit) return hit;
  const v = solarAnchorsForUtcDay(latDeg, lonDeg, mid, level, c);
  cacheSet(__anchorsCache, key, v, now, ANCH_TTL_MS, ANCH_CAP);
  return v;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function pad4(n: number) {
  return String(n).padStart(4, "0");
}


// ---------- KDS Invariant Guards (runtime assertions) ----------
function assertFinite(name: string, v: number) {
  if (!Number.isFinite(v)) throw new Error(`${name} is not finite: ${v}`);
}
function assertIntRange(name: string, v: number, min: number, max: number) {
  if (!Number.isInteger(v)) throw new Error(`${name} is not integer: ${v}`);
  if (v < min || v > max)
    throw new Error(`${name} out of range [${min},${max}]: ${v}`);
}

function asDoy(v: number, yearDays: number, name = "doy"): Doy {
  const x = Math.floor(v);
  if (!Number.isFinite(x) || x < 1 || x > yearDays) {
    throw new Error(`${name} out of range: ${v} (expected 1..${yearDays})`);
  }
  return x as Doy;
}
function asSeasonDoy(v: number, name = "seasonDoy"): SeasonDoy {
  const x = Math.floor(v);
  if (!Number.isFinite(x) || x < 1 || x > 365) {
    throw new Error(`${name} out of range: ${v} (expected 1..365)`);
  }
  return x as SeasonDoy;
}



function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function kdsInvariantCheck(s: {
  KDS_SECONDS_PER_YEAR: number;
  tau: number;
  theta: number;
  phi: number;
  seasonDoy: SeasonDoy;
  dayLenSec: SolarDurationSec;
  nightLenSec: SolarDurationSec;
  srSecSolar: SolarAnchorSec;
  ssSecSolar: SolarAnchorSec;
}) {
  // 1) Hard-locked KDS year
  if (s.KDS_SECONDS_PER_YEAR !== 365 * 86400) {
    throw new Error(`KDS_SECONDS_PER_YEAR mismatch: ${s.KDS_SECONDS_PER_YEAR}`);
  }
  assertFinite("tau(KDS)", s.tau);
  // τ must be in [0,1) for a hard-locked equinox→equinox KDS year.
  // We allow a tiny negative epsilon for float noise, but NEVER allow τ ≥ 1.
  if (!(s.tau >= -TAU_EPS_BELOW_ZERO && s.tau < 1 - TAU_EPS_BELOW_ONE)) {
    throw new Error(`tau(KDS) out of range [0,1): ${s.tau}`);
  }

  // 2) Θ / Φ ranges
  assertIntRange("theta(Θ)", s.theta, 0, 9999);
  assertIntRange("phi(Φ)", s.phi, 0, 9999);
  assertIntRange("seasonDoy(365-track)", s.seasonDoy, 1, 365);

  // 3) SR/SS sanity (handle polar cases explicitly)
  assertFinite("srSecSolar", s.srSecSolar);
  assertFinite("ssSecSolar", s.ssSecSolar);
  assertFinite("dayLenSec", s.dayLenSec);
  assertFinite("nightLenSec", s.nightLenSec);

  // Polar numerical tolerance: near 0 or 86400 day length, small numeric noise can appear.
  // We canonicalize/validate with a looser epsilon to avoid false invariant failures at polar boundaries.
  const EPS_POLAR_SEC = 1e-2; // 10 ms

  // Polar: explicit degenerate expectations
  if (s.dayLenSec <= EPS_POLAR_SEC) {
    // polar night (no day)
    if (Math.abs(s.srSecSolar - s.ssSecSolar) > EPS_POLAR_SEC) {
      throw new Error(
        `Polar night expected sr==ss, got sr=${s.srSecSolar}, ss=${s.ssSecSolar}`,
      );
    }
    if (s.nightLenSec < 86400 - EPS_POLAR_SEC) {
      throw new Error(
        `Polar night expected nightLen≈86400, got ${s.nightLenSec}`,
      );
    }
  } else if (s.dayLenSec >= 86400 - EPS_POLAR_SEC) {
    // polar day (no night)
    if (
      !(
        Math.abs(s.srSecSolar - 0) < EPS_POLAR_SEC &&
        Math.abs(s.ssSecSolar - 86400) < EPS_POLAR_SEC
      )
    ) {
      throw new Error(
        `Polar day expected sr=0, ss=86400, got sr=${s.srSecSolar}, ss=${s.ssSecSolar}`,
      );
    }
    if (s.nightLenSec > EPS_POLAR_SEC) {
      throw new Error(`Polar day expected nightLen≈0, got ${s.nightLenSec}`);
    }
  }

    // 4) Day+Night must sum to 86400s (within float epsilon)
  const sumLen = s.dayLenSec + s.nightLenSec;
  if (Math.abs(sumLen - 86400) > EPS_SECONDS) {
    throw new Error(
      `Expected dayLen+nightLen≈86400, got ${sumLen} (day=${s.dayLenSec}, night=${s.nightLenSec})`,
    );
  }

  // Anchors must live in [0,86400] with a special allowance for ss=86400 in polar day.
  if (s.srSecSolar < -EPS_KDS_YEAR_SCALE || s.srSecSolar > 86400 + EPS_KDS_YEAR_SCALE) {
    throw new Error(`srSecSolar out of [0,86400]: ${s.srSecSolar}`);
  }
  if (s.ssSecSolar < -EPS_KDS_YEAR_SCALE || s.ssSecSolar > 86400 + EPS_KDS_YEAR_SCALE) {
    throw new Error(`ssSecSolar out of [0,86400]: ${s.ssSecSolar}`);
  }

// Non-polar: both day & night exist
  if (
    s.dayLenSec > 0 &&
    s.dayLenSec < 86400 &&
    s.nightLenSec > 0 &&
    s.nightLenSec < 86400
  ) {
    if (!(s.srSecSolar < s.ssSecSolar)) {
      throw new Error(
        `Expected srSecSolar < ssSecSolar, got ${s.srSecSolar} >= ${s.ssSecSolar}`,
      );
    }
    const impliedDayLen = s.ssSecSolar - s.srSecSolar;
    if (Math.abs(impliedDayLen - s.dayLenSec) > EPS_SECONDS) {
      throw new Error(
        `dayLenSec inconsistent with anchors: ss-sr=${impliedDayLen}, dayLenSec=${s.dayLenSec}`,
      );
    }
  }
}

function modSec(x: number) {
  const m = ((x % 86400) + 86400) % 86400;
  // avoid 86400 due to floating drift
  return m >= 86400 ? 0 : m;
}


type SolarLocalSignals = {
  rawMean: number;
  deltaDaysMean: number;
  solarSecMean: MeanSolarSec;
  solarDateMs: number;
  eotSec: number;
  solarSecApp: ApparentSolarSec;
  // solarSec is used for display only (either mean or apparent depending on useEot)
  solarSec: MeanSolarSec | ApparentSolarSec;

  // Dual-domain representations (axis-safe, phase-normalized).
  dualMean: DualDomain<"SOLAR_MEAN", "MEAN", MeanSolarSec, { lonDeg: number; dut1Sec: number }>;
  dualApp: DualDomain<"SOLAR_APPARENT", "APPARENT", ApparentSolarSec, { lonDeg: number; dut1Sec: number; eotSec: number }>;
  dualDisplay: DualDomain<
    "SOLAR_MEAN" | "SOLAR_APPARENT",
    "MEAN" | "APPARENT",
    MeanSolarSec | ApparentSolarSec,
    { useEot: boolean }
  >;
};

/**
 * Canonical solar-local time signals.
 * - DATE shift is defined strictly by longitude (mean solar), never by EoT.
 * - CLOCK can optionally follow apparent solar time via EoT.
 * Fully offline + deterministic given inputs.
 */
function solarLocalSignals(
  utcMs: number,
  siSecOfDay: number,
  lonDeg: number,
  useEot: boolean,
  dut1Sec: number,
  level: FidelityLevel,
): SolarLocalSignals {
  const siSecRot = modSec(siSecOfDay + dut1Sec);
  const rawMean = siSecRot + lonDeg * 240; // seconds (rotation-based mean solar)
  const deltaDaysMean = Math.floor(rawMean / 86400); // works for negative too
  const solarSecMean = makeMeanSolarSec(modSec(rawMean));

  // Solar-local civil date (UTC) for this instant (longitude-only day shift).
  const solarDateMs = utcMs + deltaDaysMean * 86400000;

  // Apparent solar time (optional).
  const eotSec = useEot ? equationOfTimeSecondsUtcMsCached(utcMs, level) : 0;
  const solarSecApp = makeApparentSolarSec(modSec(rawMean + eotSec));
const solarSec: MeanSolarSec | ApparentSolarSec = useEot ? solarSecApp : solarSecMean;

const dualMean = makeDual(
  "SOLAR_MEAN",
  "MEAN",
  "BOUNDARY",
  "POSITION",
  solarSecMean,
  0,
  86400,
  phaseFromRange(unbrand(solarSecMean), 0, 86400),
  { lonDeg, dut1Sec },
  true,
);
const dualApp = makeDual(
  "SOLAR_APPARENT",
  "APPARENT",
  "BOUNDARY",
  "POSITION",
  solarSecApp,
  0,
  86400,
  phaseFromRange(unbrand(solarSecApp), 0, 86400),
  { lonDeg, dut1Sec, eotSec },
  true,
);
const dualDisplay = useEot
  ? makeDual(
      "SOLAR_APPARENT",
      "APPARENT",
      "BOUNDARY",
      "POSITION",
      solarSecApp,
      0,
      86400,
      phaseFromRange(unbrand(solarSecApp), 0, 86400),
      { useEot: true },
      true,
    )
  : makeDual(
      "SOLAR_MEAN",
      "MEAN",
      "BOUNDARY",
      "POSITION",
      solarSecMean,
      0,
      86400,
      phaseFromRange(unbrand(solarSecMean), 0, 86400),
      { useEot: false },
      true,
    );

  return { rawMean, deltaDaysMean, solarSecMean, solarDateMs, eotSec, solarSecApp, solarSec, dualMean, dualApp, dualDisplay };
}

function secToHMS(sec: number): string {
  // Display should be stable (no rounding jump near boundaries).
  const s = Math.floor(sec);
  const t = modSec(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const secondsPart = Math.floor(t % 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(secondsPart)}`;
}

// Clock-format for anchors that can be exactly 86400 in polar-day handling.
// We want 86400 -> 24:00:00 (not 00:00:00).
function secToHMS24(sec: number): string {
  const s = Math.round(sec);
  if (s === 86400) return "24:00:00";
  return secToHMS(s);
}

// Duration-format (no wrap). Clamped to [0, 86400] so polar-day length shows 24:00:00.
function secToDurHMS(sec: number): string {
  const s = Math.round(clamp(sec, 0, 86400));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secondsPart = Math.floor(s % 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(secondsPart)}`;
}

function fmtPct01(x: number) {
  return `${Math.round(clamp(x, 0, 1) * 100)}%`;
}

// Compress a civil day-of-year (365/366) onto the strict KDS 365-track.
// Rule: in leap years, Feb 29 (civil DOY=60) is merged into Feb 28 (track DOY=59),
// and all subsequent days are shifted back by 1.
function civilDoyTo365(doyCivil: number, yearDaysCivil: number): number {
  const d = Math.floor(doyCivil);
  if (yearDaysCivil !== 366) return clamp(d, 1, 365);
  if (d <= 59) return d; // Jan 1 .. Feb 28
  if (d === 60) return 59; // Feb 29 -> Feb 28
  return clamp(d - 1, 1, 365); // Mar 1 .. Dec 31
}

// Gregorian leap-year test (UTC civil calendar).
function isLeapYearUtc(year: number): boolean {
  const y = Math.trunc(year);
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// UTC day-of-year for a given timestamp (ms since epoch).
// Uses the UTC date (not local time). Returns 1..365/366.
function dayOfYearUtcFromMs(ms: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const today = Date.UTC(y, d.getUTCMonth(), d.getUTCDate());
  return Math.floor((today - start) / 86400000) + 1;
}

// ---------- Solar core ----------
// KDS wants DAY/NIGHT and Θ anchored to SR/SS (solar geometry), not to heuristics.
// This implementation is fully offline and uses a Meeus-style solar model:
// - Apparent Sun longitude (with aberration + nutation term)
// - True obliquity (mean obliquity + nutation in obliquity)
// - Apparent RA/Dec
// - Equation of Time (Meeus Ch. 28)
// Sunrise/sunset are computed in *solar seconds-of-day* (solar noon = 12:00),
// therefore independent of longitude/timezone and robust for KDS DAY/NIGHT anchoring.

type PolarStatus = "NORMAL" | "ALWAYS_UP" | "ALWAYS_DOWN";

type SolarAnchors = {
  dayLenSec: SolarDurationSec;
  srSecSolar: SolarAnchorSec; // sunrise in solar seconds-of-day
  ssSecSolar: SolarAnchorSec; // sunset in solar seconds-of-day

  // Explicit polar regime (avoids ambiguous boolean combos).
  polarStatus: PolarStatus;

  // Back-compat booleans (derived from polarStatus; keep to minimize refactor blast radius).
  polarDay: boolean;
  polarNight: boolean;

  // Diagnostics / rigor (do not feed back into domain logic).
  h0DegUsed: number;
  srUncSec: number; // 1-sigma-ish uncertainty estimate (seconds)
  ssUncSec: number;
  dayLenUncSec: number;
};

// ---------- Canonical DAY/NIGHT predicate on MEAN-solar axis ----------
// Handles:
// - NORMAL: sr<ss (typical mid-latitudes)
// - wrap-around: sr>ss (rare but mathematically valid on a circular day axis)
// - polar regimes: ALWAYS_UP / ALWAYS_DOWN
function isInDayMeanSolar(solarSecMean: MeanSolarSec, a: SolarAnchors): boolean {
  const s = (unbrand(solarSecMean));
  if (a.polarStatus === "ALWAYS_UP") return true;
  if (a.polarStatus === "ALWAYS_DOWN") return false;
  const sr = unbrand(a.srSecSolar);
  const ss = unbrand(a.ssSecSolar);
  if (sr === ss) return false;
  if (sr < ss) return s >= sr && s < ss;
  // wrap-around interval: [sr,86400) ∪ [0,ss)
  return s >= sr || s < ss;
}

function mod86400(x: number): number {
  const y = x % 86400;
  return y < 0 ? y + 86400 : y;
}




function safeAcos(x: number) {
  return Math.acos(clamp(x, -1, 1));
}

// --- Julian day helpers (UTC) ---
function jdFromYmdHmsUTC(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
): number {
  // Meeus, Astronomical Algorithms, Ch. 7
  let Y = y;
  let M = m;
  if (M <= 2) {
    Y -= 1;
    M += 12;
  }
  const A = Math.floor(Y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const dayFrac = (hh + (mm + ss / 60) / 60) / 24;
  const JD =
    Math.floor(365.25 * (Y + 4716)) +
    Math.floor(30.6001 * (M + 1)) +
    d +
    B -
    1524.5 +
    dayFrac;
  return JD;
}

function jdFromUtcMs(utcMs: number): number {
  const dt = new Date(utcMs);
  return jdFromYmdHmsUTC(
    dt.getUTCFullYear(),
    dt.getUTCMonth() + 1,
    dt.getUTCDate(),
    dt.getUTCHours(),
    dt.getUTCMinutes(),
    dt.getUTCSeconds() + dt.getUTCMilliseconds() / 1000,
  );
}

function normDeg360(x: number) {
  const r = ((x % 360) + 360) % 360;
  return r >= 360 ? 0 : r;
}
function normDeg180(x: number) {
  let r = ((x % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
}

// --- Meeus solar position (sufficient for <~1 arcmin and accurate EoT) ---
type SunApparent = {
  declRad: number;
  raDeg: number;
  eotSec: number; // Equation of Time (apparent - mean), seconds
};

function meanObliquityArcsec(T: number): number {
  // Meeus Ch. 22 (IAU 1976/80), arcseconds
  const U = T / 100;
  const eps0 =
    84381.448 -
    4680.93 * U -
    1.55 * U * U +
    1999.25 * U * U * U -
    51.38 * U ** 4 -
    249.67 * U ** 5 -
    39.05 * U ** 6 +
    7.12 * U ** 7 +
    27.87 * U ** 8 +
    5.79 * U ** 9 +
    2.45 * U ** 10;
  return eps0;
}

function nutationSimpleDeg(T: number): {
  dPsiDeg: number;
  dEpsDeg: number;
  omegaDeg: number;
} {
  // Meeus Ch. 22, largest terms only (arcseconds -> degrees)
  const L = normDeg360(280.4665 + 36000.7698 * T);
  const Lp = normDeg360(218.3165 + 481267.8813 * T);
  const omega = normDeg360(125.04452 - 1934.136261 * T);
  const dPsiArcsec =
    -17.2 * Math.sin(deg2rad(omega)) -
    1.32 * Math.sin(deg2rad(2 * L)) -
    0.23 * Math.sin(deg2rad(2 * Lp)) +
    0.21 * Math.sin(deg2rad(2 * omega));
  const dEpsArcsec =
    9.2 * Math.cos(deg2rad(omega)) +
    0.57 * Math.cos(deg2rad(2 * L)) +
    0.1 * Math.cos(deg2rad(2 * Lp)) -
    0.09 * Math.cos(deg2rad(2 * omega));
  return {
    dPsiDeg: dPsiArcsec / 3600,
    dEpsDeg: dEpsArcsec / 3600,
    omegaDeg: omega,
  };
}



// Slightly expanded nutation (Meeus Table 22.A, several largest terms).
// This is still lightweight/offline but materially reduces systematic error vs the 4-term "simple" version.
function nutationExtendedDeg(T: number): { dPsiDeg: number; dEpsDeg: number; omegaDeg: number } {
  // Fundamental arguments (degrees)
  const L = normDeg360(280.4665 + 36000.7698 * T);      // mean longitude Sun
  const Lp = normDeg360(218.3165 + 481267.8813 * T);   // mean longitude Moon
  const omega = normDeg360(125.04452 - 1934.136261 * T);

  // Use a small set of dominant terms (arcseconds).
  // Each term: [sinCoeffPsi, sinArg, cosCoeffEps, cosArg] where arg is a function of L,Lp,omega.
  // We encode args as linear combinations: a*L + b*Lp + c*omega.
  const terms: Array<{ a: number; b: number; c: number; dPsi: number; dEps: number }> = [
    { a: 0, b: 0, c: 1, dPsi: -17.20, dEps: 9.20 },
    { a: 2, b: 0, c: 0, dPsi: -1.32, dEps: 0.57 },
    { a: 0, b: 2, c: 0, dPsi: -0.23, dEps: 0.10 },
    { a: 0, b: 0, c: 2, dPsi: 0.21, dEps: -0.09 },
    // additional large terms
    { a: 1, b: 0, c: 1, dPsi: -0.20, dEps: 0.00 },
    { a: 0, b: 1, c: 1, dPsi: -0.10, dEps: 0.00 },
    { a: -2, b: 0, c: 1, dPsi: 0.13, dEps: 0.00 },
    { a: 0, b: 0, c: -1, dPsi: 0.07, dEps: 0.00 },
    { a: 2, b: 0, c: 1, dPsi: 0.12, dEps: -0.01 },
    { a: 0, b: 2, c: 1, dPsi: 0.04, dEps: 0.00 },
  ];

  let dPsi = 0;
  let dEps = 0;
  for (const t of terms) {
    const arg = deg2rad(t.a * L + t.b * Lp + t.c * omega);
    dPsi += t.dPsi * Math.sin(arg);
    dEps += t.dEps * Math.cos(arg);
  }

  return { dPsiDeg: dPsi / 3600, dEpsDeg: dEps / 3600, omegaDeg: omega };
}
function sunApparentMeeusFromJdTT(jdTT: number, level: number): SunApparent {
  const T = (jdTT - 2451545.0) / 36525;

  // Mean longitude (deg) and anomaly (deg)
  const L0 = normDeg360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = normDeg360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);

  // Equation of center (deg)
  const Mr = deg2rad(M);
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) +
    0.000289 * Math.sin(3 * Mr);

  // True longitude (deg)
  const trueLong = L0 + C;

  // Nutation and obliquity
  const { dPsiDeg, dEpsDeg, omegaDeg } = level >= 2 ? nutationExtendedDeg(T) : (level >= 1 ? nutationSimpleDeg(T) : { dPsiDeg: 0, dEpsDeg: 0, omegaDeg: 0 });
  const eps0 = meanObliquityArcsec(T) / 3600;
  const eps = eps0 + dEpsDeg; // true obliquity (deg)

  // Apparent longitude (deg): aberration + nutation correction
  const lambdaApp =
    trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(omegaDeg)) + dPsiDeg;

  // RA/Dec from apparent ecliptic longitude (β≈0 for Sun)
  const lam = deg2rad(lambdaApp);
  const epsr = deg2rad(eps);

  const alpha = Math.atan2(Math.cos(epsr) * Math.sin(lam), Math.cos(lam)); // rad
  const delta = Math.asin(Math.sin(epsr) * Math.sin(lam)); // rad
  const alphaDeg = normDeg360(rad2deg(alpha));

  // Equation of Time (Meeus Ch. 28):
  // E (minutes) = 4 * (L0 - 0.0057183 - alpha + dPsi*cos(eps))
  const Edeg = normDeg180(L0 - 0.0057183 - alphaDeg + dPsiDeg * Math.cos(epsr));
  const eotMin = 4 * Edeg;
  const eotSec = eotMin * 60;

  return { declRad: delta, raDeg: alphaDeg, eotSec };
}


function decimalYearFromUtcMs(utcMs: number): number {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1, 0, 0, 0, 0);
  const end = Date.UTC(y + 1, 0, 1, 0, 0, 0, 0);
  const frac = (utcMs - start) / (end - start);
  return y + clamp(frac, 0, 1);
}

// ΔT = TT − UT (seconds). Offline polynomial model (Espenak/Meeus-style piecewise).
// This is a pragmatic deterministic approximation; PROJECTION layer may refine if desired.
function deltaTSecondsFromDecimalYear(y: number): number {
  // Clamp to a reasonable window for numeric stability.
  const yy = clamp(y, 1600, 2200);

  // 2005–2050 (NASA polynomial, seconds)
  if (yy >= 2005 && yy < 2050) {
    const t = yy - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }

  // 2050–2150 (Meeus approximation)
  if (yy >= 2050 && yy <= 2150) {
    const u = (yy - 1820) / 100;
    return -20 + 32 * u * u - 0.5628 * (2150 - yy);
  }

  // 1986–2005
  if (yy >= 1986 && yy < 2005) {
    const t = yy - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5;
  }

  // 1961–1986
  if (yy >= 1961 && yy < 1986) {
    const t = yy - 1975;
    return 45.45 + 1.067 * t - (t * t) / 260 - (t ** 3) / 718;
  }

  // 1941–1961
  if (yy >= 1941 && yy < 1961) {
    const t = yy - 1950;
    return 29.07 + 0.407 * t - (t * t) / 233 + (t ** 3) / 2547;
  }

  // 1920–1941
  if (yy >= 1920 && yy < 1941) {
    const t = yy - 1930;
    return 21.20 + 0.84493 * t - 0.0761 * t * t + 0.0020936 * t ** 3;
  }

  // 1900–1920
  if (yy >= 1900 && yy < 1920) {
    const t = yy - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t ** 3 - 0.000197 * t ** 4;
  }

  // 1860–1900
  if (yy >= 1860 && yy < 1900) {
    const t = yy - 1860;
    return 7.62 + 0.5737 * t - 0.251754 * t * t + 0.01680668 * t ** 3 - 0.0004473624 * t ** 4 + (t ** 5) / 233174;
  }

  // 1800–1860
  if (yy >= 1800 && yy < 1860) {
    const t = yy - 1800;
    return 13.72 - 0.332447 * t + 0.0068612 * t * t + 0.0041116 * t ** 3 - 0.00037436 * t ** 4 + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 + 0.000000000875 * t ** 7;
  }

  // 1700–1800
  if (yy >= 1700 && yy < 1800) {
    const t = yy - 1700;
    return 8.83 + 0.1603 * t - 0.0059285 * t * t + 0.00013336 * t ** 3 - (t ** 4) / 1174000;
  }

  // 1600–1700
  if (yy >= 1600 && yy < 1700) {
    const t = yy - 1600;
    return 120 - 0.9808 * t - 0.01532 * t * t + (t ** 3) / 7129;
  }

  // Fallback (outside polynomials): quadratic in centuries from 1820
  const u = (yy - 1820) / 100;
  return -20 + 32 * u * u;
}

function jdTTFromUtcMs(utcMs: number): number {
  const jdUT = jdFromUtcMs(utcMs);
  const yDec = decimalYearFromUtcMs(utcMs);
  const dT = deltaTSecondsFromDecimalYear(yDec); // TT − UT
  return jdUT + dT / 86400;
}

// ----------------- Equinox (March) — CANON anchor helpers -----------------
// KDS CANON rule: the canonical year is equinox-to-equinox and is hard-locked to
// exactly 365×86400 KDS-seconds. The *real* SI duration between equinoxes is used
// only to compute the scale factor for mapping UTC↔KDS within that window.
//
// This engine intentionally uses an offline Meeus-style approximation for the March
// equinox JDE (TT). It is deterministic and does not require any external tables.
// For most applications this is sufficient; higher-precision iterative solvers can
// be added later without changing the public API.

const JD_UNIX_EPOCH = 2440587.5; // 1970-01-01T00:00:00Z

function utcMsFromJdUT(jdUT: number): number {
  // JD(UT) → UTC epoch ms (UT≈UTC at this layer; DUT1 is a projection option)
  return (jdUT - JD_UNIX_EPOCH) * 86400 * 1000;
}

// Meeus (Astronomical Algorithms, Ch. 27) coefficients for equinox/solstice corrections.
type MeeusTerm = { A: number; B: number; C: number };
const MEEUS_EQ_TERMS: MeeusTerm[] = [
  { A: 485, B: 324.96, C: 1934.136 },
  { A: 203, B: 337.23, C: 32964.467 },
  { A: 199, B: 342.08, C: 20.186 },
  { A: 182, B: 27.85, C: 445267.112 },
  { A: 156, B: 73.14, C: 45036.886 },
  { A: 136, B: 171.52, C: 22518.443 },
  { A: 77, B: 222.54, C: 65928.934 },
  { A: 74, B: 296.72, C: 3034.906 },
  { A: 70, B: 243.58, C: 9037.513 },
  { A: 58, B: 119.81, C: 33718.147 },
  { A: 52, B: 297.17, C: 150.678 },
  { A: 50, B: 21.02, C: 2281.226 },
  { A: 45, B: 247.54, C: 29929.562 },
  { A: 44, B: 325.15, C: 31555.956 },
  { A: 29, B: 60.93, C: 4443.417 },
  { A: 18, B: 155.12, C: 67555.328 },
  { A: 17, B: 288.79, C: 4562.452 },
  { A: 16, B: 198.04, C: 62894.029 },
  { A: 14, B: 199.76, C: 31436.921 },
  { A: 12, B: 95.39, C: 14577.848 },
  { A: 12, B: 287.11, C: 31931.756 },
  { A: 12, B: 320.81, C: 34777.259 },
  { A: 9, B: 227.73, C: 1222.114 },
  { A: 8, B: 15.45, C: 16859.074 },
];

function marchEquinoxJdTTApprox(year: number): { jdTT: number; confidence: AstroConfidence } {
  // Valid nominally for years ~1000..3000 (Meeus gives different polynomials outside).
  const conf: AstroConfidence = year >= 1000 && year <= 3000 ? "OK" : "OUT_OF_RANGE";
  const T = (year - 2000) / 1000; // millennia from J2000
  // March equinox polynomial (Meeus) for 1000..3000:
  // JDE0 = 2451623.80984 + 365242.37404*T + 0.05169*T^2 - 0.00411*T^3 - 0.00057*T^4
  const JDE0 =
    2451623.80984 +
    365242.37404 * T +
    0.05169 * T * T -
    0.00411 * T * T * T -
    0.00057 * T * T * T * T;

  const W = (35999.373 * T - 2.47) * DEG2RAD;
  const lambda = 1 + 0.0334 * Math.cos(W) + 0.0007 * Math.cos(2 * W);

  let S = 0;
  for (const term of MEEUS_EQ_TERMS) {
    S += term.A * Math.cos((term.B + term.C * T) * DEG2RAD);
  }
  const jdTT = JDE0 + (0.00001 * S) / lambda; // days

  return { jdTT, confidence: conf };
}

function marchEquinoxUtcMsApprox(year: number): { utcMs: number; confidence: AstroConfidence } {
  const { jdTT, confidence } = marchEquinoxJdTTApprox(year);
  // Convert TT → UT(≈UTC) using ΔT (TT−UT). Use a representative decimal year near March.
  const yDec = year + 0.22;
  const dT = deltaTSecondsFromDecimalYear(yDec);
  const jdUT = jdTT - dT / 86400;
  return { utcMs: utcMsFromJdUT(jdUT), confidence };
}

function equinoxWindowForUtcMs(utcMs: number): { startMs: number; endMs: number; equinoxYear: number; confidence: AstroConfidence } {
  const y = new Date(utcMs).getUTCFullYear();
  const eThis = marchEquinoxUtcMsApprox(y);
  const eNext = marchEquinoxUtcMsApprox(y + 1);

  if (utcMs >= eThis.utcMs) {
    return { startMs: eThis.utcMs, endMs: eNext.utcMs, equinoxYear: y, confidence: eThis.confidence === "OK" && eNext.confidence === "OK" ? "OK" : "ESTIMATED" };
  }
  const ePrev = marchEquinoxUtcMsApprox(y - 1);
  return { startMs: ePrev.utcMs, endMs: eThis.utcMs, equinoxYear: y - 1, confidence: ePrev.confidence === "OK" && eThis.confidence === "OK" ? "OK" : "ESTIMATED" };
}


function sunApparentMeeusFromUtcMs(utcMs: number, level: number): SunApparent {
  return sunApparentMeeusFromJdTT(jdTTFromUtcMs(utcMs), level);
}

// Equation of Time (seconds) at an instant, from UTC ms (offline, Meeus).
function equationOfTimeSecondsUtcMs(utcMs: number, level: number): number {
  return sunApparentMeeusFromUtcMs(utcMs, level).eotSec;
}

// --- Optional UT1 proxy (offline): UT1 ≈ UTC + DUT1 (seconds).
// We use DUT1 ONLY to define the *rotation day* boundaries for mean-solar signals;
// solar ephemeris itself remains based on UTC->TT via ΔT model.
function utcMidnightMsForRotationDay(utcMs: number, dut1Sec: number): number {
  const rotMs = utcMs + dut1Sec * 1000;
  const d = new Date(rotMs);
  const midRot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  return midRot - dut1Sec * 1000;
}

function meanSolarNoonUtcMsForRotationDay(utcMs: number, lonDeg: number, dut1Sec: number): number {
  const mid = utcMidnightMsForRotationDay(utcMs, dut1Sec);
  const lonSec = lonDeg * 240;
  return mid + (43200 - lonSec) * 1000;
}

// --- KDS day sampling helper (offline, deterministic) ---
// We map a KDS DOY (1..yearDays) to a representative UTC instant inside the current equinox→equinox window.
// Then we snap that instant to the **mean solar noon** of its rotation day (UT1-proxy via DUT1),
// which stabilizes SR/SS/day-length sampling near window boundaries.
//
// Canon rule: this is sampling for *projections/physics*, not a redefinition of KDS time.
// It must never change the hard 365×86400 structure.
function sampleUtcMsForKdsDoyNoon(
  doy: number,
  yearDays: number,
  equinoxStartMs: number,
  equinoxEndMs: number,
  lonDeg: number,
  corr?: KdsCorrections,
): number {
  const c = corr ?? DEFAULT_CORRECTIONS;
  const winLen = Math.max(1, equinoxEndMs - equinoxStartMs);
  const tauMid = (clamp(doy, 1, yearDays) - 0.5) / yearDays;
  const approxUtcMs = equinoxStartMs + tauMid * winLen;
  return meanSolarNoonUtcMsForRotationDay(approxUtcMs, lonDeg, c.dut1Sec);
}

type AnchorSamplingMode = "MEAN_NOON" | "APPARENT_NOON";

function apparentSolarNoonUtcMsForRotationDay(
  utcMs: number,
  lonDeg: number,
  dut1Sec: number,
  level: FidelityLevel,
): number {
  // Apparent solar time = mean + EoT. At apparent noon, apparent solar time is 12:00,
  // so mean solar time is 12:00 - EoT. We solve t ≈ meanNoon - EoT(t) with 2 fixed-point steps.
  let t = meanSolarNoonUtcMsForRotationDay(utcMs, lonDeg, dut1Sec);
  for (let i = 0; i < 2; i++) {
    const eot = equationOfTimeSecondsUtcMs(t, level);
    t = meanSolarNoonUtcMsForRotationDay(utcMs, lonDeg, dut1Sec) - eot * 1000;
  }
  return t;
}

// Representative UTC sampling for a KDS DOY (for SR/SS/daylen projection).
// Default is MEAN_NOON (canon-safe). APPARENT_NOON is a projection-only choice.
function sampleUtcMsForKdsDoyRepresentative(
  doy: number,
  yearDays: number,
  equinoxStartMs: number,
  equinoxEndMs: number,
  lonDeg: number,
  mode: AnchorSamplingMode,
  level: FidelityLevel,
  corr?: KdsCorrections,
): number {
  const c = corr ?? DEFAULT_CORRECTIONS;
  const winLen = Math.max(1, equinoxEndMs - equinoxStartMs);
  const tauMid = (clamp(doy, 1, yearDays) - 0.5) / yearDays;
  const approxUtcMs = equinoxStartMs + tauMid * winLen;
  if (mode === "APPARENT_NOON") {
    return apparentSolarNoonUtcMsForRotationDay(approxUtcMs, lonDeg, c.dut1Sec, level);
  }
  return meanSolarNoonUtcMsForRotationDay(approxUtcMs, lonDeg, c.dut1Sec);
}


// --- Canonical KDS ↔ UTC mapping helpers (pure equinox scaling; no SR/SS needed) ---


// Bennett refraction approximation (arcminutes) with standard scaling for pressure/temperature.
// For sunrise/sunset we evaluate at geometric altitude ~0° (h=0).
function refractionArcminBennettAtH0(tempC: number, pressureHPa: number): number {
  const T = tempC;
  const P = pressureHPa;
  // Bennett (1982): R = 1.02 / tan( h + 10.3/(h+5.11) ) arcmin; use h=0.
  const h = 0;
  const denomDeg = h + 10.3 / (h + 5.11);
  const R0 = 1.02 / Math.tan(deg2rad(denomDeg)); // arcmin at standard conditions
  const scale = (P / 1010) * (283 / (273 + T));
  return R0 * scale;
}

function sunriseH0DegFromCorrections(c: KdsCorrections): number {
  // Solar semidiameter ~16 arcmin (0.266666.. deg).
  const SD_DEG = 16 / 60;

  // Base geometric altitude threshold relative to the *astronomical horizon*.
  // Standard convention uses refraction ~34' + SD ~16' = 50' = 0.8333°.
  let baseH0Deg: number;
  if (c.refractionMode === "METEO") {
    const R_arcmin = refractionArcminBennettAtH0(c.tempC, c.pressureHPa);
    baseH0Deg = -(R_arcmin / 60 + SD_DEG);
  } else {
    baseH0Deg = -0.833;
  }

  // Horizon dip from observer altitude (meters): dip ≈ sqrt(2h/R) in radians.
  // This is a *major* offline realism win for SR/SS without any external data.
  const h = Number.isFinite(c.altitudeM) ? Math.max(0, c.altitudeM) : 0;
  const R_EARTH_M = 6371000;
  const dipRad = h > 0 ? Math.sqrt((2 * h) / R_EARTH_M) : 0;
  const dipDeg = rad2deg(dipRad);

  // Local horizon offset (degrees): + raises horizon => later sunrise / earlier sunset.
  const hoff = Number.isFinite(c.horizonOffsetDeg) ? c.horizonOffsetDeg : 0;

  // Effective threshold: base - dip + horizonOffset
  return baseH0Deg - dipDeg + hoff;
}



// Compute SR/SS anchors in SOLAR seconds-of-day for a given UTC day (any time within that day).
//
// Rigor note (KDS Rule #3): the largest practical offline accuracy win is iterating SR/SS using
// declination evaluated at the event times (not only at noon). We keep the model independent
// of EoT toggles by anchoring everything to **mean** solar time.
// - Solar seconds-of-day are defined such that mean solar noon = 12:00 (43200s).
// - We map a solar second-of-day guess to UTC via meanSolarNoonUtcMsForDay() + (solarSec-43200)s.
// - Two iterations are enough to reduce SR/SS error from ~minutes to typically <~10s (lat-dependent).
function solarAnchorsForUtcDay(
  latDeg: number,
  lonDeg: number,
  utcMs: number,
  level: FidelityLevel,
  corr?: KdsCorrections,
): SolarAnchors {
  const c = corr ?? DEFAULT_CORRECTIONS;
  const latClamped = clamp(latDeg, -89.999, 89.999);
  const phi = deg2rad(latClamped);

  // Refraction + solar radius: sunrise/set defined by altitude crossing h0.
  // Canonical default is -0.833°, but KDS allows an explicit, offline, user-provided
  // refraction refinement (temp/pressure) without any web dependency.
  //
  // IMPORTANT (KDS rigor): fidelity must NEVER change the physical definition of SR/SS,
  // only iteration depth. Definition is controlled ONLY by corrections.refractionMode.
  const h0Deg = sunriseH0DegFromCorrections(c);
  const h0 = deg2rad(h0Deg);

  const EPS_POLAR_SEC = 1e-2; // 10 ms canonicalization tolerance near polar limits

  // Helper: compute x = cos(H0) argument and handle polar cases.
  const computeFromDecl = (declRad: number, h0Rad: number) => {
    const num = Math.sin(h0Rad) - Math.sin(phi) * Math.sin(declRad);
    const den = Math.cos(phi) * Math.cos(declRad);

    if (Math.abs(den) < 1e-12) {
      // Extreme latitude / numerical degeneracy: decide polar day/night by sign of num.
      // If num <= 0, the Sun is effectively always above the threshold (polar day); else polar night.
      const polarDay = num <= 0;
      const polarNight = !polarDay;

      return {
        ok: false as const,
        dayLenSec: makeSolarDurationSec(polarDay ? 86400 : 0),
        srSecSolar: makeSolarAnchorSec(0),
        ssSecSolar: makeSolarAnchorSec(polarDay ? 86400 : 0),
        polarStatus: polarDay ? "ALWAYS_UP" : "ALWAYS_DOWN",
        polarDay,
        polarNight,
      };
    }

    const x = num / den;
    // Near the polar limit, tiny numerical noise around |x|≈1 can cause day/night "flicker".
    // Use a small hysteresis-like clamp band to stabilize classification.
    const EPS_POLAR_X = 1e-12;
    if (x <= -1 + EPS_POLAR_X) {
      return {
        ok: false as const,
        dayLenSec: makeSolarDurationSec(86400),
        srSecSolar: makeSolarAnchorSec(0),
        ssSecSolar: makeSolarAnchorSec(86400),
        polarStatus: "ALWAYS_UP",
        polarDay: true,
        polarNight: false,
      };
    }
    if (x >= 1 - EPS_POLAR_X) {
      return {
        ok: false as const,
        dayLenSec: makeSolarDurationSec(0),
        srSecSolar: makeSolarAnchorSec(0),
        ssSecSolar: makeSolarAnchorSec(0),
        polarStatus: "ALWAYS_DOWN",
        polarDay: false,
        polarNight: true,
      };
    }

    const H0 = safeAcos(x); // rad
    const H0deg = rad2deg(H0);
    const dayLenRawSec = ((2 * H0deg) / 15) * 3600;
    const dayLenSec = clamp(dayLenRawSec, 0, 86400);
    // Canonicalize near-polar numerical noise: treat extremely small/large day length as polar.
    if (dayLenSec <= EPS_POLAR_SEC) {
      return {
        ok: false as const,
        dayLenSec: makeSolarDurationSec(0),
        srSecSolar: makeSolarAnchorSec(0),
        ssSecSolar: makeSolarAnchorSec(0),
        polarStatus: "ALWAYS_DOWN",
        polarDay: false,
        polarNight: true,
      };
    }
    if (86400 - dayLenSec <= EPS_POLAR_SEC) {
      return {
        ok: false as const,
        dayLenSec: makeSolarDurationSec(86400),
        srSecSolar: makeSolarAnchorSec(0),
        ssSecSolar: makeSolarAnchorSec(86400),
        polarStatus: "ALWAYS_UP",
        polarDay: true,
        polarNight: false,
      };
    }
    const srSecSolar = clamp(12 * 3600 - dayLenSec / 2, 0, 86400);
    const ssSecSolar = clamp(12 * 3600 + dayLenSec / 2, 0, 86400);

    return {
      ok: true as const,
      dayLenSec: makeSolarDurationSec(dayLenSec),
      srSecSolar: makeSolarAnchorSec(srSecSolar),
      ssSecSolar: makeSolarAnchorSec(ssSecSolar),
      polarStatus: "NORMAL",
      polarDay: false,
      polarNight: false,
    };
  };

  // Mean local solar noon for this UTC day (mean-time anchor; independent of EoT).
  const noonMs = meanSolarNoonUtcMsForRotationDay(utcMs, lonDeg, c.dut1Sec);

  // Initial declination at mean solar noon.
  let decl0 = sunApparentMeeusFromUtcMs(noonMs, level).declRad;

  // Start with noon-based anchors.
  let base = computeFromDecl(decl0, h0);
  if (!base.ok) {
    return {
      dayLenSec: base.dayLenSec,
      srSecSolar: base.srSecSolar,
      ssSecSolar: base.ssSecSolar,
      polarStatus: base.polarDay ? "ALWAYS_UP" : base.polarNight ? "ALWAYS_DOWN" : "NORMAL",
      polarDay: base.polarDay,
      polarNight: base.polarNight,
      h0DegUsed: h0Deg,
      srUncSec: 0,
      ssUncSec: 0,
      dayLenUncSec: 0,
    };
  }

  // Iterate: evaluate declination at SR/SS guess times, average, recompute H0.
  // Fidelity determines ONLY iteration depth (cost), not SR/SS definition.
  // - level 0: 0 iterations (noon decl only) — fast, still physically-defined anchors.
  // - level 1: 2 iterations — high accuracy (typically ~seconds level at mid-lats).
  let sr = base.srSecSolar;
  let ss = base.ssSecSolar;

  const iterCount = level === 0 ? 0 : 2;
  for (let iter = 0; iter < iterCount; iter++) {
    const srUtc = noonMs + (sr - 43200) * 1000;
    const ssUtc = noonMs + (ss - 43200) * 1000;

    const declSr = sunApparentMeeusFromUtcMs(srUtc, level).declRad;
    const declSs = sunApparentMeeusFromUtcMs(ssUtc, level).declRad;

    const declAvg = 0.5 * (declSr + declSs);

    const next = computeFromDecl(declAvg, h0);
    if (!next.ok) {
      // If iteration wandered into a polar edge (shouldn't for stable cases), fall back to last base.
      return {
        dayLenSec: next.dayLenSec,
        srSecSolar: next.srSecSolar,
        ssSecSolar: next.ssSecSolar,
        polarStatus: next.polarDay ? "ALWAYS_UP" : next.polarNight ? "ALWAYS_DOWN" : "NORMAL",
        polarDay: next.polarDay,
        polarNight: next.polarNight,
        h0DegUsed: h0Deg,
        srUncSec: 0,
        ssUncSec: 0,
        dayLenUncSec: 0,
      };
    }

    sr = next.srSecSolar;
    ss = next.ssSecSolar;
    base = next;
  }

  // --- Uncertainty estimate (offline, heuristic but deterministic) ---
  // We estimate sensitivity to the effective horizon altitude h0 by a small perturbation.
  // This captures the dominant real-world uncertainty source (refraction variability).
  const dhDeg = c.refractionMode === "METEO" ? 2 / 60 : 5 / 60; // 2' vs 5'
  const h0p = deg2rad(h0Deg + dhDeg);
  const h0m = deg2rad(h0Deg - dhDeg);

  // Use the last declination average as best representative for sensitivity (decl changes slowly).
  const srUtcBest = noonMs + (sr - 43200) * 1000;
  const ssUtcBest = noonMs + (ss - 43200) * 1000;
  const declSrBest = sunApparentMeeusFromUtcMs(srUtcBest, level).declRad;
  const declSsBest = sunApparentMeeusFromUtcMs(ssUtcBest, level).declRad;
  const declAvgBest = 0.5 * (declSrBest + declSsBest);

  const p = computeFromDecl(declAvgBest, h0p);
  const m = computeFromDecl(declAvgBest, h0m);
  const srUncSec = p.ok && m.ok ? 0.5 * Math.abs(p.srSecSolar - m.srSecSolar) : 0;
  const ssUncSec = p.ok && m.ok ? 0.5 * Math.abs(p.ssSecSolar - m.ssSecSolar) : 0;
  const dayLenUncSec = p.ok && m.ok ? 0.5 * Math.abs(p.dayLenSec - m.dayLenSec) : 0;

  return {
    dayLenSec: base.dayLenSec,
    srSecSolar: makeSolarAnchorSec(sr),
    ssSecSolar: makeSolarAnchorSec(ss),
    polarStatus: "NORMAL",
      polarDay: false,
      polarNight: false,
    h0DegUsed: h0Deg,
    srUncSec,
    ssUncSec,
    dayLenUncSec,
  };
}

type SeasonState = {
  // Build key binds this state to (lat,lon,yearDays,equinox window, fidelity)
  key: string;
  lat: number;
  lon: number;
  level: FidelityLevel;
  startMs: number;
  endMs: number;

  cls: number[];
  L: number[];
  days: number;
  Lmin: number;
  Lmax: number;
  Lmid: number;
};

function makeSeasonKey(
  lat: number,
  yearDays: number,
  equinoxStartMs: number,
  equinoxEndMs: number,
  level: FidelityLevel,
  corr: KdsCorrections,
) {
  // Deterministic key: season physics depends on latitude and the anchor model parameters.
  // Longitude excluded to maximize reuse (day-length is longitude-invariant in the solar-second frame).
  return `${yearDays}|${level}|${equinoxStartMs}|${equinoxEndMs}|${Math.round(lat * 1e6)}|${getSeasonCorrectionsCacheKey(corr)}`;
}



function buildSeasonStateTwoDomains(
  latDeg: number,
  lonDeg: number,
  yearDays: number,
  equinoxStartMs: number,
  equinoxEndMs: number,
  level: FidelityLevel,
  corr?: KdsCorrections,
): SeasonState {
  const c = corr ?? DEFAULT_CORRECTIONS;
  const key = makeSeasonKey(latDeg, yearDays, equinoxStartMs, equinoxEndMs, level, c);
  // KDS-aligned season state: evaluated over the *current equinox→equinox window*.
  // For each KDS day index, we sample the corresponding UTC date inside the equinox window
  // and compute the daylight duration from Meeus solar declination (via SR/SS anchors).
  const L = new Array(yearDays + 1).fill(0);
  let Lmin = Number.POSITIVE_INFINITY;
  let Lmax = Number.NEGATIVE_INFINITY;

  for (let d = 1; d <= yearDays; d++) {
    const sampleNoonUtcMs = sampleUtcMsForKdsDoyNoon(d, yearDays, equinoxStartMs, equinoxEndMs, lonDeg, c);
    const ld = solarAnchorsForUtcDayMemo(
      latDeg,
      lonDeg,
      sampleNoonUtcMs,
      level,
      c
    ).dayLenSec;
    L[d] = ld;
    Lmin = Math.min(Lmin, ld);
    Lmax = Math.max(Lmax, ld);
  }

  const Lmid = (Lmin + Lmax) / 2;

  // Classify into two seasons using a small hysteresis band around Lmid to avoid
  // numerical "flapping" at low latitudes or small day-length amplitude.
  const span = Math.max(0, Lmax - Lmin);
  const eps = Math.max(60, span * 0.02); // at least 60s, or 2% of annual span

  const cls = new Array(yearDays + 1).fill(0);
  cls[1] = L[1] >= Lmid ? +1 : -1;
  for (let d = 2; d <= yearDays; d++) {
    const v = L[d];
    if (v > Lmid + eps) cls[d] = +1;
    else if (v < Lmid - eps) cls[d] = -1;
    else cls[d] = cls[d - 1];
  }
  // Ensure circular consistency for day 1 if it's inside the band.
  if (Math.abs(L[1] - Lmid) <= eps) cls[1] = cls[yearDays];

  // Strict sanity (kept local; season model must be self-consistent)
  if (L.length !== yearDays + 1 || cls.length !== yearDays + 1) {
    throw new Error(`SeasonState array length mismatch (days=${yearDays})`);
  }
  if (!Number.isFinite(Lmin) || !Number.isFinite(Lmax) || Lmin < 0 || Lmax > 86400 + EPS_SECONDS) {
    throw new Error(`SeasonState invalid day-length bounds (Lmin=${Lmin}, Lmax=${Lmax})`);
  }

  return {
    key,
    lat: latDeg,
    lon: lonDeg,
    level,
    startMs: equinoxStartMs,
    endMs: equinoxEndMs,
    cls,
    L,
    days: yearDays,
    Lmin,
    Lmax,
    Lmid,
  };
}


/**
 * Non-blocking season-state build.
 * Exact same math as buildSeasonStateTwoDomains(), but computed in small chunks
 * to keep the UI responsive when the user edits lat/lon/settings.
 *
 * Independence: no workers, no external libs, deterministic results.
 */
function buildSeasonStateTwoDomainsChunked(
  latDeg: number,
  lonDeg: number,
  yearDays: number,
  equinoxStartMs: number,
  equinoxEndMs: number,
  level: FidelityLevel,
  onProgress: (p01: number) => void,
  isCancelled: () => boolean,
  corr?: KdsCorrections,
): Promise<SeasonState> {
  return new Promise((resolve, reject) => {
    try {
      const c = corr ?? DEFAULT_CORRECTIONS;
      const key = makeSeasonKey(latDeg, yearDays, equinoxStartMs, equinoxEndMs, level, c);

      const L = new Array(yearDays + 1).fill(0);
      let Lmin = Number.POSITIVE_INFINITY;
      let Lmax = Number.NEGATIVE_INFINITY;

      const winLen = Math.max(1, equinoxEndMs - equinoxStartMs);

      let d = 1;

      const runChunk = () => {
        if (isCancelled()) return;

        // Budget: ~6ms per chunk (keeps 60fps-ish). Deterministic results.
        const t0 = safeNowMs();
        while (d <= yearDays && safeNowMs() - t0 < 6) {
          const tauMid = (d - 0.5) / yearDays;
          const sampleUtcMs = equinoxStartMs + tauMid * winLen;
          const ld = solarAnchorsForUtcDayMemo(
            latDeg,
            lonDeg,
            sampleUtcMs,
    level,
            c,
          ).dayLenSec;
          L[d] = ld;
          if (ld < Lmin) Lmin = ld;
          if (ld > Lmax) Lmax = ld;

          d++;
        }

        onProgress(clamp((d - 1) / yearDays, 0, 1));

        if (d <= yearDays) {
          // Use idle callback when available; fallback to setTimeout(0).
          const w =
            typeof window !== "undefined"
              ? (window as Window & {
                  requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
                  cancelIdleCallback?: (id: number) => void;
                })
              : undefined;
          const ric = w?.requestIdleCallback as
            | ((cb: () => void, opts?: { timeout?: number }) => unknown)
            | undefined;
          if (ric) ric(runChunk, { timeout: 50 });
          else if (w && typeof w.setTimeout === "function") w.setTimeout(runChunk, 0);
          else setTimeout(runChunk, 0);
          return;
        }

        // Finalize classification
        const Lmid = (Lmin + Lmax) / 2;
        const span = Math.max(0, Lmax - Lmin);
        const eps = Math.max(60, span * 0.02);

        const cls = new Array(yearDays + 1).fill(0);
        cls[1] = L[1] >= Lmid ? +1 : -1;
        for (let dd = 2; dd <= yearDays; dd++) {
          const v = L[dd];
          if (v > Lmid + eps) cls[dd] = +1;
          else if (v < Lmid - eps) cls[dd] = -1;
          else cls[dd] = cls[dd - 1];
        }
        if (Math.abs(L[1] - Lmid) <= eps) cls[1] = cls[yearDays];

        if (L.length !== yearDays + 1 || cls.length !== yearDays + 1) {
          throw new Error(`SeasonState array length mismatch (days=${yearDays})`);
        }
        if (!Number.isFinite(Lmin) || !Number.isFinite(Lmax) || Lmin < 0 || Lmax > 86400 + EPS_SECONDS) {
          throw new Error(`SeasonState invalid day-length bounds (Lmin=${Lmin}, Lmax=${Lmax})`);
        }

        resolve({
          key,
          lat: latDeg,
          lon: lonDeg,
          level,
          startMs: equinoxStartMs,
          endMs: equinoxEndMs,
          cls,
          L,
          days: yearDays,
          Lmin,
          Lmax,
          Lmid,
        });
      };

      runChunk();
    } catch (e: unknown) {
      reject(e);
    }
  });
}


function circularSegment(state: SeasonState, doy: number) {
  const { cls, days, L, Lmin, Lmax, Lmid } = state;

  const span = Math.max(0, Lmax - Lmin);
  const epsBand = Math.max(60, span * 0.02); // must match season hysteresis (>=60s)

  const confidenceFor = (d: number) => {
    if (span <= 1) return 1;
    const diff = Math.abs((L[d] ?? Lmid) - Lmid);
    const maxDiff = Math.max(1, span / 2);
    if (maxDiff <= epsBand) return 1;
    return clamp((diff - epsBand) / (maxDiff - epsBand), 0, 1);
  };

  // constant season (e.g., equator-like)
  let allSame = true;
  for (let d = 2; d <= days; d++) {
    if (cls[d] !== cls[1]) {
      allSame = false;
      break;
    }
  }
  if (allSame) {
    const season: "WARM" | "COLD" = cls[1] === +1 ? "WARM" : "COLD";
    const segStart = 1;
    const segEnd = days;
    const segLen = days;
    const k = (doy - 1 + days) % days;
    const denom = Math.max(1, segLen - 1);
    const prog01 = clamp(k / denom, 0, 1);
    const phi = phaseFrom01(prog01);
    const seasonConfidence = confidenceFor(clamp(doy, 1, days));
    const distToBoundaryDays = days; // no boundary exists
    return { season, phi, segStart, segEnd, segLen, k, seasonConfidence, distToBoundaryDays };
  }

  const c0 = cls[doy];
  const prev = (d: number) => (d === 1 ? days : d - 1);
  const next = (d: number) => (d === days ? 1 : d + 1);

  let segStart = doy;
  while (cls[prev(segStart)] === c0) segStart = prev(segStart);

  let segEnd = doy;
  while (cls[next(segEnd)] === c0) segEnd = next(segEnd);

  let segLen = 1;
  let cur = segStart;
  while (cur !== segEnd) {
    cur = next(cur);
    segLen++;
    if (segLen > days + 1) break;
  }

  let k = 0;
  cur = segStart;
  while (cur !== doy) {
    cur = next(cur);
    k++;
    if (k > days + 1) break;
  }

  const season: "WARM" | "COLD" = c0 === +1 ? "WARM" : "COLD";
  const denom = Math.max(1, segLen - 1);
  const prog01 = clamp(k / denom, 0, 1);
  const phi = phaseFrom01(prog01);

  const seasonConfidence = confidenceFor(clamp(doy, 1, days));
  const distToBoundaryDays = Math.min(k, Math.max(0, segLen - 1 - k));

  return { season, phi, segStart, segEnd, segLen, k, seasonConfidence, distToBoundaryDays };
}

// ---------- Ring helpers ----------
function polarPoint(cx: number, cy: number, r: number, angleRad: number) {
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function cwDelta(a0: number, a1: number) {
  const TAU = Math.PI * 2;
  let d = a1 - a0;
  while (d < 0) d += TAU;
  while (d >= TAU) d -= TAU;
  return d;
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const d = cwDelta(a0, a1);
  const largeArc = d > Math.PI ? 1 : 0;
  const p0 = polarPoint(cx, cy, r, a0);
  const p1 = polarPoint(cx, cy, r, a1);
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} 1 ${p1.x} ${p1.y}`;
}
function angleForDoy(doy: number, days: number) {
  const TAU = Math.PI * 2;
  return -Math.PI / 2 + ((doy - 1) / days) * TAU;
}
function angleForSec(sec: number) {
  const TAU = Math.PI * 2;
  const t01 = clamp(modSec(sec) / 86400, 0, 1);
  return -Math.PI / 2 + t01 * TAU;
}

function quadrantTagDomain(theta: number, domain: "DAY" | "NIGHT"): string {
  const q = Math.floor(theta / 2500);
  if (domain === "DAY") return ["Morning", "Noon", "Afternoon", "Dusk"][q] || "";
  return ["Evening", "Midnight", "Late", "Dawn"][q] || "";
}


function thetaFromMeanSolar(
  solarSecMean: MeanSolarSec,
  anchors: SolarAnchors,
  prev?: { domain: "DAY" | "NIGHT"; solarSecMean: MeanSolarSec } | null,
  hystSec = 30, // small latch window around SR/SS to avoid boundary flicker
): { domain: "DAY" | "NIGHT"; theta: number } {
  const inDay = isInDayMeanSolar(solarSecMean, anchors);
  let domain: "DAY" | "NIGHT" = inDay ? "DAY" : "NIGHT";

  const sr = unbrand(anchors.srSecSolar);
  const ss = unbrand(anchors.ssSecSolar);
  const dl = unbrand(anchors.dayLenSec);
  const nl = 86400 - dl;

  // --- DAY/NIGHT hysteresis (polar knife-edge + SR/SS boundary jitter) ---
  // The canonical domain is determined by anchors + mean-solar sec, but near boundaries
  // tiny numerical changes can flip the boolean. We latch to the previous domain within
  // a small window to ensure perceptual stability WITHOUT changing the underlying anchors.
  if (prev && prev.domain !== domain) {
    const s = unbrand(solarSecMean);
    const dToSr = Math.min(mod86400(s - sr), mod86400(sr - s));
    const dToSs = Math.min(mod86400(s - ss), mod86400(ss - s));
    const dMin = Math.min(dToSr, dToSs);

    const minSeg = 120; // seconds; below this a segment is effectively degenerate
    const dlDegenerate = dl < minSeg;
    const nlDegenerate = nl < minSeg;

    if (dMin <= hystSec || dlDegenerate || nlDegenerate) {
      domain = prev.domain;
    }
  }


  let theta: number;
  if (domain === "DAY") {
    const elapsed = mod86400(unbrand(solarSecMean) - sr);
    const psi = dl > EPS_SECONDS ? clamp(elapsed / dl, 0, 1) : 0;
    theta = clamp(Math.floor((PHASE_SCALE_10K - 1) * psi), 0, 9999);
  } else {
    const elapsed = mod86400(unbrand(solarSecMean) - ss);
    const psi = nl > EPS_SECONDS ? clamp(elapsed / nl, 0, 1) : 0;
    theta = clamp(Math.floor((PHASE_SCALE_10K - 1) * psi), 0, 9999);
  }
  return { domain, theta };
}

function clamp01(x: number) {
  return ((x % 1) + 1) % 1;
}

// ---------- Core compute ----------
function computeKds(params: {
  lat: number;
  lon: number;
  yearDays: number;
  doyEq: number;
  utcNowMs: number; // current UTC epoch ms (for EoT + solar-local DOY)

  // current equinox window in SI UTC ms (for KDS→civil mapping)
  equinoxStartMs: number;
  equinoxEndMs: number;

  // canonical KDS clock (derived from KDS-second) (seeded once from browser, then purely monotonic)
  kdsDoy: number; // 1..yearDays (KDS day-of-year)
  kdsSec: number; // 0..86399 (KDS seconds-of-day)

  // real SI seconds-of-day (0..86399) derived from the one-time-synced monotonic UTC clock
  // used ONLY for solar-local clock (longitude/EoT are defined in SI seconds)
  siSecOfDay: number;

  // civil local seconds-of-day (browser timezone), for display only
  civilLocalSecOfDay: number;

  level: FidelityLevel;
  seasonState: SeasonState;
  useEot: boolean;
  anchors: SolarAnchors;
  // previous DAY/NIGHT state for hysteresis (UI-stability only; does not affect anchors)
  prevDayNight?: { domain: "DAY" | "NIGHT"; solarSecMean: MeanSolarSec } | null;
  domainMode?: DomainMode;
  corr?: KdsCorrections;
  profile?: CalendarProfile;
  eventMeta?: KdsEventMeta;
}): KdsComputationResult {
  const {
    lat,
    lon,
    yearDays,
    doyEq,
    utcNowMs,
    equinoxStartMs,
    equinoxEndMs,
    kdsDoy,
    kdsSec,
    siSecOfDay,
    civilLocalSecOfDay,
    level,
    seasonState,
    useEot,
    anchors,
    prevDayNight,
    corr: corrIn,
    domainMode: domainModeIn,

  } = params;
  const eventMeta = params.eventMeta;

  // ---- CANON vs PROJECTION correction split (hard rule) ----
  // - DUT1 (UT1-UTC) is ALWAYS projection-only.
  // - Geometric/atmospheric terms may be allowed to affect domains only if explicitly enabled upstream.
  // This function therefore accepts `corrIn` as a *projection* bundle, but internally strips DUT1
  // from the domain computations.
  const corrDisplay = corrIn ?? DEFAULT_CORRECTIONS;
  const dut1DisplaySec = Number.isFinite(corrDisplay.dut1Sec) ? corrDisplay.dut1Sec : 0;
  const dut1SourceDisplay: "manual" | "table" | "none" =
    corrDisplay._dut1Source ?? (Math.abs(dut1DisplaySec) > 1e-12 ? "manual" : "none");


  const domainMode: DomainMode = domainModeIn ?? "CANON_STRICT";

  // ---- Astro validity (diagnostics only; never changes canon) ----
  const yDec = decimalYearFromUtcMs(utcNowMs);
  const notes: string[] = [];
  const deltaTConfidence: AstroConfidence =
    yDec >= 1600 && yDec <= 2050 ? "OK" : (yDec >= -500 && yDec <= 2150 ? "ESTIMATED" : "OUT_OF_RANGE");
  if (deltaTConfidence !== "OK") notes.push(`ΔT model extrapolation: year=${yDec.toFixed(3)} conf=${deltaTConfidence}`);
  const yUtc = new Date(utcNowMs).getUTCFullYear();
  const equinoxPolyConfidence: AstroConfidence = (yUtc >= 1000 && yUtc <= 3000) ? "OK" : "OUT_OF_RANGE";
  if (equinoxPolyConfidence !== "OK") notes.push(`Equinox solver outside preferred range: UTCyear=${yUtc}`);
  const astroValidity: AstroValidity = {
    deltaTModel: "NASA_POLY",
    deltaTConfidence,
    equinoxPolyConfidence,
    notes,
  };


  // Domain corrections (DUT1 stripped)
  const corr: KdsCorrections = {
    ...corrDisplay,
    dut1Sec: 0,
    dut1Table: undefined,
    _dut1Source: undefined,
    _dut1TableHash: undefined,
  };
// ---- Dual registry (extra) ----
// Core signals are exposed as stable fields in KdsComputationResult.dual.*
// Extra registry holds additional dualized debug signals (safe to extend without breaking API).
const dualExtra: Record<string, DualDomain<string, string, unknown, Record<string, unknown>>> = {};

const putDualExtra = <A extends string, D extends string, V, M extends Record<string, unknown>>(
  key: string,
  dd: DualDomain<A, D, V, M>,
): DualDomain<A, D, V, M> => {
  if (!isDualCoreKey(key)) {
    dualExtra[key] = dd as unknown as DualDomain<string, string, unknown, Record<string, unknown>>;
  }
  return dd;
};

  // ---- Dual meta signals (inspector-visible, axis-isolated) ----
  putDualExtra(
    "meta.domainMode",
    makeDual("META", domainMode, "SCALAR", "MODE", 0, 0, 1, 0, { domainMode }, true),
  );
  putDualExtra(
    "meta.astroValidity",
    makeDual("META", "ASTRO", "SCALAR", "VALIDITY", 0, 0, 1, 0, astroValidity as unknown as Record<string, unknown>, true),
  );
  putDualExtra(
    "meta.cacheSizes",
    makeDual(
      "META",
      "CACHE",
      "SCALAR",
      "SIZES",
      0,
      0,
      1,
      0,
      {
        anchors: __anchorsCache.size,
        eot: __eotCacheSec.size,
      },
      true,
    ),
  );

putDualExtra(
  "meta.event",
  makeDual(
    "META",
    "EVENT",
    "SCALAR",
    "PACKET",
    0,
    0,
    1,
    0,
    {
      event_uid: eventMeta?.event_uid ?? "",
      mono_tick_ms: eventMeta?.mono_tick_ms ?? null,
      uti_tick_ms: eventMeta?.uti_tick_ms ?? null,
    } as unknown as Record<string, unknown>,
    true,
  ),
);
putDualExtra(
  "meta.proof",
  makeDual(
    "META",
    "PROOF",
    "SCALAR",
    "HASH",
    0,
    0,
    1,
    0,
    {
      prev_hash: eventMeta?.prev_hash ?? "",
      hash: eventMeta?.event_hash ?? eventMeta?.hash ?? "",
    } as unknown as Record<string, unknown>,
    true,
  ),
);


 

  

  const dualScalar = (
    key: string,
    axis: string,
    domain: string,
    value: number,
    start: number,
    end: number,
    meta?: Record<string, unknown>,
  ) => {
    const valid = Number.isFinite(value) && Number.isFinite(start) && Number.isFinite(end) && end > start;
    const phase = valid ? phaseFromRange(value, start, end) : 0;
    return putDualExtra(
      key,
      makeDual(axis, domain, "BOUNDARY", "POSITION", value, start, end, phase, meta ?? {}, valid, valid ? undefined : "invalid scalar"),
    );
  };
// --- SeasonState coherence (hard invariant) ---
  // seasonState MUST match current geo + equinox window + fidelity; otherwise Φ becomes physically meaningless.
  const expectedSeasonKey = makeSeasonKey(lat, yearDays, equinoxStartMs, equinoxEndMs, level, corr);
  const seasonKeyMismatch = seasonState.key !== expectedSeasonKey;
  if (seasonKeyMismatch) {
    // Do not crash render; surface via invariantError below.
    // eslint-disable-next-line no-console
  }

  // IMPORTANT:
  // We treat the engine as "solar-local" everywhere that affects the domains:
  // - day/night uses SOLAR seconds
  // - season segmentation uses SOLAR day-of-year
  // The internal kdsDoy/kdsSec exist only to advance a stable monotonic clock after one-time seeding.

  // ---- Solar-local time signals (strict separation of DATE vs CLOCK) ----
  // Canonical helper ensures ALL call-sites use identical rules (no 1-day slips).
  const solarSig = solarLocalSignals(utcNowMs, siSecOfDay, lon, useEot, corr.dut1Sec, level);
  const solarSecMean = solarSig.solarSecMean;

  // Apparent solar time: mean + Equation of Time (EoT).
  const eotSec = solarSig.eotSec;
  const solarSecApp = solarSig.solarSecApp;

  // Dualize key solar signals (MEAN/APPARENT) and EoT itself (NEG/POS).
  dualScalar("solarSecMean", "SOLAR_MEAN", "MEAN", solarSecMean, 0, 86400, { lonDeg: lon, dut1Sec: corr.dut1Sec });
  dualScalar("solarSecApp", "SOLAR_APPARENT", "APPARENT", solarSecApp, 0, 86400, { lonDeg: lon, dut1Sec: corr.dut1Sec, eotSec });
  dualScalar("eotSec", "SOLAR_APPARENT", eotSec < 0 ? "NEG" : "POS", eotSec, -1200, 1200, { kind: "equationOfTime" });

  // RIGOR (KDS): Domains must be evaluated in a single, non-mixed time axis.
  // - Sunrise/Sunset anchors are computed in MEAN solar seconds-of-day.
  // - Therefore DAY/NIGHT and Θ are defined in MEAN solar time (domain axis).
  // Apparent solar time (mean + EoT) is for display only (can be toggled without changing domains).
  const solarSecDomain: MeanSolarSec = solarSecMean;
  const solarSecDisplayAxis: MeanSolarSec | ApparentSolarSec = useEot ? solarSecApp : solarSecMean;
  const solarDateMs = solarSig.solarDateMs;

        // Compile-time guard: KDS domains MUST use MEAN solar axis only (never EoT display axis).
        const _kdsDomainAxis: MeanSolarSec = solarSig.solarSecMean as MeanSolarSec;
        void _kdsDomainAxis;


  // Solar-local civil year/DOY (UTC)
  const solarYear = new Date(solarDateMs).getUTCFullYear();
  const solarYearDays = isLeapYearUtc(solarYear) ? 366 : 365;
  const solarDoyCivil = dayOfYearUtcFromMs(solarDateMs);

  // KDS "solar DOY" is expressed on a strict 365-track (leap years compressed)
  const doy = asDoy(civilDoyTo365(solarDoyCivil, solarYearDays), yearDays);
  dualScalar("doy", "SOLAR_MEAN", unbrand(doy) <= yearDays / 2 ? "H1" : "H2", unbrand(doy), 1, yearDays + 1, { solarDoyCivil, solarYearDays });



  // --- KDS year fraction (τ) ---
  // Defined strictly in KDS-units: equinox→equinox is exactly 365*86400 KDS-seconds.
  const KDS_SECONDS_PER_YEAR = 365 * 86400;
  const kdsYearSec = clamp(
    (kdsDoy - 1) * 86400 + kdsSec,
    0,
    KDS_SECONDS_PER_YEAR - EPS_KDS_YEAR_SCALE,
  );
  const tau = kdsYearSec / KDS_SECONDS_PER_YEAR; // already in [0,1)

// Dualize τ on canonical axis (split into two half-year domains for a true dual regime).
  dualScalar("tau", "KDS_CANON", tau < 0.5 ? "H1" : "H2", tau, 0, 1, { kind: "yearFraction" });


  // Debug: solar-local civil year fraction (Jan-1 based, true 365/366 civil year)
  const tauSolar =
    ((solarDoyCivil - 1 + solarSecMean / 86400) / solarYearDays) % 1;

// Dualize solar-local civil τ (debug axis; still useful as a dual regime).
  dualScalar("tauSolar", "CIVIL_UTC", tauSolar < 0.5 ? "H1" : "H2", tauSolar, 0, 1, { kind: "civilYearFraction", solarYearDays });


  // --- WARM/COLD mapping (KDS-aligned) ---
  // Seasons in KDS are defined over the hard-locked equinox→equinox year.
  // Therefore the seasonal day-index is the KDS day-of-year itself.
  const seasonDoy = asSeasonDoy(clamp(Math.floor(tau * 365) + 1, 1, 365));
  // NOTE: end=366 is intentional (half-open range) to map 1..365 onto [0,1) without phase overflow.
  dualScalar("seasonDoy", "KDS_CANON", seasonDoy <= 183 ? "H1" : "H2", seasonDoy, 1, 366, { kind: "kdsSeasonDoy" });



  const dayLenSec = anchors.dayLenSec;
  const nightLenSec = makeSolarDurationSec(86400 - (unbrand(dayLenSec)));
  const dayShare01 = clamp(dayLenSec / 86400, 0, 1);
  const nightShare01 = 1 - dayShare01;
  const { srSecSolar, ssSecSolar } = anchors;

  
// --- DAY/NIGHT domain + Θ in MEAN solar time (CANON) ---
  // Optional hysteresis uses previous result to prevent boundary flicker (especially near polar thresholds).
  const dayNightRes = thetaFromMeanSolar(solarSecDomain, anchors, prevDayNight ?? null, 30);
  const domain = dayNightRes.domain;
  const theta = dayNightRes.theta;


  const seg = circularSegment(seasonState, seasonDoy);
  const season: "WARM" | "COLD" = seg.season;
  const phi = seg.phi;

  // Warm/Cold % in KDS is typically interpreted as *progress through the current season segment*
  // (e.g., COLD runs from autumn-equinox boundary to spring-equinox boundary).
  // This matches expectations like "February ~80% cold" at mid/high latitudes.
  const seasonPct01 = clamp(seg.k / Math.max(1, seg.segLen - 1), 0, 1);

  const stamp =
    `${season === "WARM" ? "W" : "C"}Φ${pad4(phi)} ` +
    `${domain === "DAY" ? "D" : "N"}Θ${pad4(theta)} ` +
    `DOY(KDS/equinox)=${seasonDoy}/365 KDSsec=${kdsSec} | ` +
    `τKDS=${tau.toFixed(6)} | DOY(civil365)=${doy}/${yearDays} SolarSec=${unbrand(solarSecDisplayAxis).toFixed(0)} τSolar=${tauSolar.toFixed(6)} | ` +
        `φ=${lat.toFixed(4)}° λ=${lon.toFixed(4)}° | ` +
    `Solar=${secToHMS(unbrand(solarSecDisplayAxis))}${useEot ? ` (mean ${secToHMS(unbrand(solarSecMean))}, app ${secToHMS(unbrand(solarSecApp))})` : ""} | ` +
    `SR/SS(solar)=${secToHMS24(srSecSolar)} / ${secToHMS24(ssSecSolar)} | ` +
    `Day/Night share=${(dayShare01 * 100).toFixed(1)}%/${(nightShare01 * 100).toFixed(1)}%` +
    `${anchors.polarStatus !== "NORMAL" ? ` | POLAR=${anchors.polarStatus}` : ""} | ` +
    `L${level} | MODE=${domainMode} | DOYeq=${doyEq}${useEot ? " | EoT=ON" : ""}`;

  // KDS invariant validation (throws if anything breaks strict rules)
  let invariantError: string | undefined = undefined;
  try {
    kdsInvariantCheck({
      KDS_SECONDS_PER_YEAR,
      tau,
      theta,
      phi,
      seasonDoy,
      dayLenSec,
      nightLenSec,
      srSecSolar,
      ssSecSolar,
    });
  } catch (e: unknown) {
    invariantError = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
  }

  if (!invariantError && seasonKeyMismatch) {
    invariantError = `SeasonState mismatch (expected ${expectedSeasonKey}, got ${seasonState.key})`;
  }

  
  // ---- Dual-domain bundle (axis-safe, phase-normalized) ----
  const dualCanonDay = putDualExtra("canonDay", makeDual(
    "KDS_CANON",
    "CANON",
	  "BOUNDARY",
	  "POSITION",
    makeKdsSec(kdsSec),
    0,
    86400,
    phaseFromRange(kdsSec, 0, 86400),
    { tau, kdsDoy },
    true,
  ));

  const dualSolarMeanDay = solarSig.dualMean;
  const dualSolarAppDay = solarSig.dualApp;
  const dualSolarDisplayDay = solarSig.dualDisplay;

  putDualExtra("solarMeanDay", dualSolarMeanDay);
  putDualExtra("solarAppDay", dualSolarAppDay);
  putDualExtra("solarDisplayDay", dualSolarDisplayDay);


  const dualCivilLocalDay = putDualExtra("civilLocalDay", makeDual(
    "CIVIL_LOCAL",
    "CIVIL",
    "BOUNDARY",
    "POSITION",
    makeCivilLocalSec(modSec(civilLocalSecOfDay)),
    0,
    86400,
    phaseFromRange(modSec(civilLocalSecOfDay), 0, 86400),
    {},
    true,
  ));

  const anchorDomain: "NORMAL" | "ALWAYS_UP" | "ALWAYS_DOWN" =
    anchors.polarStatus;
  // Canonical solar anchors/durations already computed above (MEAN solar axis)

  const dualAnchors = putDualExtra("anchors", makeDual(
    "SOLAR_MEAN",
    anchorDomain,
    "QUALITY",
    "QUALITY",
    dayLenSec,
    0,
    86400,
    phaseFromRange(dayLenSec, 0, 86400),
    {
      srSecSolar,
      ssSecSolar,
      h0DegUsed: anchors.h0DegUsed,
      srUncSec: anchors.srUncSec,
      ssUncSec: anchors.ssUncSec,
      dayLenUncSec: anchors.dayLenUncSec,
    },
    true,
  ));

  // Domain boundaries in MEAN solar axis
  const dnStart = domain === "DAY" ? srSecSolar : ssSecSolar;
  const dnEnd = domain === "DAY" ? ssSecSolar : (unbrand(srSecSolar)) + 86400; // conceptual wrap for NIGHT
  // For NIGHT, unwrap solarSec into the same [dnStart,dnEnd] interval (post-midnight portion becomes >86400).
  const solarSecUnwrapped = domain === "NIGHT" && (unbrand(solarSecDomain)) < (unbrand(srSecSolar))
    ? makeSolarAnchorSec((unbrand(solarSecDomain)) + 86400)
    : makeSolarAnchorSec(unbrand(solarSecDomain));
  const dnPhase = theta; // Θ is already 0..9999 within active DAY/NIGHT domain
  const dualDayNight = putDualExtra("dayNight", makeDual(
    "SOLAR_MEAN",
    domain,
    "BOUNDARY",
    "POSITION",
    solarSecUnwrapped,
    dnStart,
    dnEnd,
    dnPhase,
    { theta, srSecSolar, ssSecSolar, dayLenSec, nightLenSec },
    true,
  ));

  // Season domain in canonical KDS axis (KDS DOY)
  const dualSeason = putDualExtra("season", makeDual(
    "KDS_CANON",
    season,
    "BOUNDARY",
    "POSITION",
    seasonDoy,
    seg.segStart,
    seg.segEnd,
    phi, // Φ is already 0..9999 within active WARM/COLD segment
    { phi, segStart: seg.segStart, segEnd: seg.segEnd, segLen: seg.segLen, k: seg.k },
    true,
  ));

  const dual = {
    canonDay: dualCanonDay,
    solarMeanDay: dualSolarMeanDay,
    solarAppDay: dualSolarAppDay,
    solarDisplayDay: dualSolarDisplayDay,
    civilLocalDay: dualCivilLocalDay,
    anchors: dualAnchors,
    dayNight: dualDayNight,
    season: dualSeason,
    extra: dualExtra,
  };


    // ---- Canon/Projection invariants (hard guard) ----
  // Domains MUST be computed in MEAN solar axis only (no EoT leakage).
  if (Math.abs(unbrand(solarSecDomain) - unbrand(solarSecMean)) > 1e-9) {
    throw new Error(
      `Invariant violation: solarSecDomain != solarSecMean (domain=${unbrand(solarSecDomain)}, mean=${unbrand(solarSecMean)})`
    );
  }
  const expectedDisplay = useEot ? solarSecApp : solarSecMean;
  if (Math.abs(unbrand(solarSecDisplayAxis) - unbrand(expectedDisplay)) > 1e-6) {
    throw new Error(
      `Invariant violation: solarSecDisplay mismatch (useEot=${useEot}, display=${unbrand(solarSecDisplayAxis)}, expected=${unbrand(expectedDisplay)})`
    );
  }

const tzOffsetSec = (() => {
  try {
    // JS Date offset is minutes behind UTC; convert to seconds east-positive.
    return -new Date(utcNowMs).getTimezoneOffset() * 60;
  } catch {
    return 0;
  }
})();

  const projectionTrace = buildProjectionTrace({
    lonDeg: lon,
    dut1Sec: dut1DisplaySec,
    dut1Source: dut1SourceDisplay,
    useEot,
    eotSec,
    tzOffsetSec,
  });

return {
    yearDays,
    invariantError,
    tau,
    tauSolar,
    sigmaKds: clamp01(kdsSec / 86400),
    sigmaSiUtc: clamp(siSecOfDay / 86400, 0, 1),
    doy,
    seasonDoy,
    lat,
    lon,
    level,
    domainMode,
    astroValidity,
    doyEq,
    kdsSec,
    siSecOfDay,
    solarSec: unbrand(solarSecDomain),
    solarSecDisplay: unbrand(solarSecDisplayAxis),
    solarSecMean: unbrand(solarSecMean),
    solarSecApp: unbrand(solarSecApp),
    localSec: civilLocalSecOfDay,
    eotSec,
    dayLenSec,
    nightLenSec,
    srSecSolar,
    ssSecSolar,
    srUncSec: anchors.srUncSec,
    ssUncSec: anchors.ssUncSec,
    dayLenUncSec: anchors.dayLenUncSec,
    h0DegUsed: anchors.h0DegUsed,
    domain,
    theta,
    season,
    phi,
    seasonPct01,
    segStart: seg.segStart,
    segEnd: seg.segEnd,
    segLen: seg.segLen,
    k: seg.k,
    projectionTrace,
    dual,
    stamp,
  };
}


// ================= KDS-UTI PROTOCOL ENGINE (pure, UI-agnostic) =================
// Goal: strict, spec-versioned hashing + verification without React/UI side effects.

type U64DecString = string & { readonly __u64_dec: "U64_DEC_STRING" };

const U64_MAX = 18446744073709551615n;

const isU64DecString = (s: string): boolean => {
  if (!/^(0|[1-9]\d*)$/.test(s)) return false;
  try {
    const x = BigInt(s);
    return x >= 0n && x <= U64_MAX;
  } catch {
    return false;
  }
};

const u64ToDecString = (v: unknown, fallback: bigint = 0n): U64DecString => {
  try {
    if (typeof v === "string") {
      const s = v.trim();
      if (isU64DecString(s)) return s as U64DecString;
    }
    if (typeof v === "bigint") {
      const x = v;
      if (x >= 0n && x <= U64_MAX) return x.toString(10) as U64DecString;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v < 0) return fallback.toString(10) as U64DecString;
      const n = Math.trunc(v);
      if (!Number.isSafeInteger(n)) return fallback.toString(10) as U64DecString;
      return BigInt(n).toString(10) as U64DecString;
    }
  } catch {}
  return fallback.toString(10) as U64DecString;
};

const u64ToBigInt = (v: unknown): bigint | null => {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return null;
      const n = Math.trunc(v);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      return BigInt(n);
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (!isU64DecString(s)) return null;
      return BigInt(s);
    }
  } catch {
    return null;
  }
  return null;
};

// ---- Strict schema per spec_version ----
const HASH_PAYLOAD_V1_KEYS = ["proof_v", "source_uid", "event_seq", "uti", "payload", "prev_hash"] as const;
type HashPayloadV1Key = (typeof HASH_PAYLOAD_V1_KEYS)[number];

const HASH_PAYLOAD_V1_PAYLOAD_KEYS = [
  "event_uid","created_utc_ms","mono_tick_ms","mono_seq",
  "uti_tick_ms","uti_conf","uti_timescale","tai_utc_offset_s","uti_uncertainty_ms",
  "ati_tau","ati_conf",
  "kds_sec_of_year","equinox_start_ms","equinox_end_ms",
  "loc_id","lat","lon","alt_m",
  "domain_mode","projection_profile_id",
  "meta",
] as const;

// ---- Hash payload v2 (CANON-first): excludes projection/meta fields ----
// KDS Model rule: only CANON fields are hash-bound. Any PROJECTION fields
// (timezone, EoT display, UI meta, profile IDs, etc.) must never affect the hash.
const HASH_PAYLOAD_V2_PAYLOAD_KEYS = [
  "event_uid","created_utc_ms","mono_tick_ms","mono_seq",
  "uti_tick_ms","uti_conf","uti_timescale","tai_utc_offset_s","uti_uncertainty_ms",
  "ati_tau","ati_conf",
  "kds_sec_of_year","equinox_start_ms","equinox_end_ms",
  "loc_id","lat","lon","alt_m",
  "domain_mode",
] as const;

type HashPayloadV2Key = typeof HASH_PAYLOAD_V2_PAYLOAD_KEYS[number];

function kdsUtiBuildHashPayloadV2(e: KdsEventPacket): Record<string, unknown> {
  const proof_v = 2 as const;
  const source_uid = e.source_uid ?? "";
  const event_seq = u64ToDecString(e.event_seq, 0n);
  const uti = u64ToDecString(e.uti_tick_ms, 0n);

  const payloadBase: Record<string, unknown> = {
    event_uid: e.event_uid,
    created_utc_ms: e.created_utc_ms,
    mono_tick_ms: e.mono_tick_ms,
    mono_seq: typeof e.mono_seq === "number" ? e.mono_seq : null,

    uti_tick_ms: typeof e.uti_tick_ms === "number" ? e.uti_tick_ms : null,
    uti_conf: parseUtiConf(e.uti_conf) ?? "UNVERIFIED",
    uti_timescale: parseUtiTimescale(e.uti_timescale) ?? "POSIX_UTC",
    tai_utc_offset_s: typeof e.tai_utc_offset_s === "number" ? e.tai_utc_offset_s : null,
    uti_uncertainty_ms: typeof e.uti_uncertainty_ms === "number" ? e.uti_uncertainty_ms : null,

    ati_tau: typeof e.ati_tau === "number" ? e.ati_tau : null,
    ati_conf: parseAstroConfidence(e.ati_conf) ?? null,

    kds_sec_of_year: typeof e.kds_sec_of_year === "number" ? e.kds_sec_of_year : null,
    equinox_start_ms: typeof e.equinox_start_ms === "number" ? e.equinox_start_ms : null,
    equinox_end_ms: typeof e.equinox_end_ms === "number" ? e.equinox_end_ms : null,

    loc_id: e.loc_id ?? "",
    lat: typeof e.lat === "number" ? e.lat : null,
    lon: typeof e.lon === "number" ? e.lon : null,
    alt_m: typeof e.alt_m === "number" ? e.alt_m : null,

    domain_mode: parseDomainMode(e.domain_mode) ?? "CANON_STRICT",
  };

  const payload: Record<string, unknown> = {};
  for (const k of HASH_PAYLOAD_V2_PAYLOAD_KEYS) payload[k] = payloadBase[k];

  return { proof_v, source_uid, event_seq, uti, payload, prev_hash: getPrevHash(e) };
}

async function kdsUtiVerifyEventLogV2(eventLog: KdsEventPacket[]): Promise<VerifyResult> {
  if (!eventLog.length) return { ok: true, message: "OK: empty log" };

  const seenIdHash = new Map<string, string>(); // id → hash
  const seenHash = new Set<string>();

  // Group by source_uid; within each source sort by event_seq.
  const bySource = new Map<string, KdsEventPacket[]>();
  for (const e of eventLog) {
    const s = e.source_uid ?? "";
    const arr = bySource.get(s) ?? [];
    arr.push(e);
    bySource.set(s, arr);
  }

  for (const [source_uid, arr] of bySource.entries()) {
    arr.sort((a, b) => {
      const aa = u64ToBigInt(a.event_seq) ?? 0n;
      const bb = u64ToBigInt(b.event_seq) ?? 0n;
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    });

    let prev: string | null = null;
    for (const e of arr) {
      const id = `${source_uid}#${u64ToDecString(e.event_seq, 0n)}`;

      const built = kdsUtiBuildHashPayloadV2(e);
      const h = await sha256Hex(stableStringify(built));

      // Basic uniqueness
      if (seenHash.has(h)) return { ok: false, message: `FAIL: duplicate hash detected (source=${source_uid})` };
      seenHash.add(h);
      if (seenIdHash.has(id) && seenIdHash.get(id) !== h) return { ok: false, message: `FAIL: equivocation detected at ${id}` };
      seenIdHash.set(id, h);

      // Chain continuity
      const p = getPrevHash(e);
      if (prev === null) {
        if (p && p !== "") return { ok: false, message: `FAIL: first event has prev_hash (source=${source_uid})` };
      } else {
        if (!p || p !== prev) return { ok: false, message: `FAIL: prev_hash mismatch at ${id}` };
      }

      prev = h;
    }
  }

  return { ok: true, message: "OK: verified v2" };
}


function kdsUtiBuildHashPayloadV1(e: KdsEventPacket): Record<HashPayloadV1Key, unknown> {
  const proof_v = 1 as const;
  const source_uid = e.source_uid ?? "";
  const event_seq = u64ToDecString(e.event_seq, 0n);
  const uti = u64ToDecString(e.uti_tick_ms, 0n);

  const payloadBase: Record<string, unknown> = {
    event_uid: e.event_uid,
    created_utc_ms: e.created_utc_ms,
    mono_tick_ms: e.mono_tick_ms,
    mono_seq: typeof e.mono_seq === "number" ? e.mono_seq : null,

    uti_tick_ms: typeof e.uti_tick_ms === "number" ? e.uti_tick_ms : null,
    uti_conf: parseUtiConf(e.uti_conf) ?? "UNVERIFIED",
    uti_timescale: parseUtiTimescale(e.uti_timescale) ?? "POSIX_UTC",
    tai_utc_offset_s: typeof e.tai_utc_offset_s === "number" ? e.tai_utc_offset_s : null,
    uti_uncertainty_ms: typeof e.uti_uncertainty_ms === "number" ? e.uti_uncertainty_ms : null,

    ati_tau: typeof e.ati_tau === "number" ? e.ati_tau : null,
    ati_conf: parseAstroConfidence(e.ati_conf) ?? null,

    kds_sec_of_year: typeof e.kds_sec_of_year === "number" ? e.kds_sec_of_year : null,
    equinox_start_ms: typeof e.equinox_start_ms === "number" ? e.equinox_start_ms : null,
    equinox_end_ms: typeof e.equinox_end_ms === "number" ? e.equinox_end_ms : null,

    loc_id: e.loc_id ?? "",
    lat: typeof e.lat === "number" ? e.lat : null,
    lon: typeof e.lon === "number" ? e.lon : null,
    alt_m: typeof e.alt_m === "number" ? e.alt_m : null,

    domain_mode: parseDomainMode(e.domain_mode) ?? "CANON_STRICT",
    projection_profile_id: e.projection_profile_id ?? "",
    meta: e.meta ?? null,
  };

  const payload: Record<string, unknown> = {};
  for (const k of HASH_PAYLOAD_V1_PAYLOAD_KEYS) payload[k] = payloadBase[k];

  return { proof_v, source_uid, event_seq, uti, payload, prev_hash: getPrevHash(e) };
}

type VerifyResult = { ok: true; message: string } | { ok: false; message: string };

async function kdsUtiVerifyEventLogV1(eventLog: KdsEventPacket[]): Promise<VerifyResult> {
  if (!eventLog.length) return { ok: true, message: "OK: empty log" };

  const seenIdHash = new Map<string, string>();
  const bySource = new Map<string, KdsEventPacket[]>();

  for (const e of eventLog) {
    const sid = (e.source_uid ?? "").trim();
    const key = sid || "_NO_SOURCE_";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(e);
  }

  for (const [sid, arr] of bySource.entries()) {
    const hasSeq = arr.some((e) => typeof e.event_seq === "number" || typeof e.event_seq === "string" || typeof e.event_seq === "bigint");
    const list = hasSeq
      ? [...arr].sort((a, b) => {
          const aa = u64ToBigInt(a.event_seq) ?? 0n;
          const bb = u64ToBigInt(b.event_seq) ?? 0n;
          return aa < bb ? -1 : aa > bb ? 1 : 0;
        })
      : [...arr];

    let lastSeq: bigint | null = null;
    let lastUti: bigint | null = null;
    let lastHash: string = GENESIS_HASH;

    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;

      const badField = kdsUtiValidateConformantV1(e);
      if (badField) {
        return { ok: false, message: `FAIL[NONCONFORMANT_FIELD]: source=${sid} field=${badField}` };
      }

      const seq = u64ToBigInt(e.event_seq);
      if (sid !== "_NO_SOURCE_" && seq !== null) {
        const idKey = `${sid}#${seq.toString(10)}`;
        const h0 = getEventHash(e);

        if (seenIdHash.has(idKey)) {
          const prevH = seenIdHash.get(idKey)!;
          if (!(prevH && h0 && prevH === h0)) {
            return { ok: false, message: `FAIL[EQUIVOCATION]: duplicate identity (${sid},${seq.toString(10)}) with different hash` };
          }
        } else {
          seenIdHash.set(idKey, h0);
        }

        if (lastSeq !== null && seq !== lastSeq + 1n) {
          return { ok: false, message: `FAIL[SEQ_GAP]: source=${sid} expected=${(lastSeq + 1n).toString(10)} got=${seq.toString(10)}` };
        }
        lastSeq = seq;
      }

      const curUti = u64ToBigInt(e.uti_tick_ms);
      if (curUti !== null) {
        if (lastUti !== null && curUti < lastUti) {
          return { ok: false, message: `FAIL[UTI_DECREASE]: source=${sid} prev=${lastUti.toString(10)} cur=${curUti.toString(10)}` };
        }
        lastUti = curUti;
      }

      const prev = String(e.prev_hash ?? "");
      const prevNorm = prev || (i === 0 ? GENESIS_HASH : prev);
      if (prevNorm !== lastHash) {
        return { ok: false, message: `FAIL[CHAIN_BREAK]: source=${sid} expectedPrev=${lastHash.slice(0, 12)} got=${prevNorm.slice(0, 12)}` };
      }

      const canon = stableStringify(kdsUtiBuildHashPayloadV1(e));
      let h: string;
      try {
        h = await sha256Hex(canon);
      } catch (err) {
        return { ok: false, message: `FAIL[CRYPTO_UNAVAILABLE]: ${String(err instanceof Error ? err.message : err)}` };
      }

      if (getEventHash(e) !== h) {
        return { ok: false, message: `FAIL[HASH_MISMATCH]: source=${sid} expected=${h.slice(0, 12)} got=${getEventHash(e).slice(0, 12)}` };
      }

      lastHash = h;
    }
  }

  return { ok: true, message: `OK: proof valid (sources=${bySource.size}, events=${eventLog.length})` };
}




// ===================== KDS-UTI v1.0 Normative Summary (MUST/SHALL) =====================
// This is a *short* in-file spec excerpt to keep the reference implementation self-describing.
// For the full spec, mirror these rules verbatim in the v1.0 document.
//
// Canonical JSON for hashing (MUST):
//  - Output is UTF-8 bytes without BOM.
//  - No trailing newline in the canonical JSON string.
//  - Object keys sorted lexicographically (Unicode code point order).
//  - No pretty whitespace.
//  - Disallow circular references.
//  - Map `undefined` => `null`.
//  - Disallow non-finite numbers (NaN, +Infinity, -Infinity).
//  - Disallow negative zero (-0).
//  - Disallow unpaired UTF-16 surrogates in strings and object keys.
//  - bigint values MUST be encoded as decimal strings.
//
// Hash envelope schema (MUST for spec_version "1.0"):
//  - The hashed object MUST have exactly these top-level keys:
//      { proof_v, source_uid, event_seq, uti, payload, prev_hash }
//  - proof_v is integer 1.
//  - source_uid is string.
//  - event_seq is uint64 encoded as decimal string.
//  - uti is uint64 encoded as decimal string.
//  - prev_hash is hex string; first event uses GENESIS_HASH.
//  - payload is an object with keys restricted to HASH_PAYLOAD_V1_PAYLOAD_KEYS (stable schema).
//
// Verification (MUST):
//  - For each source_uid, events are ordered by event_seq (uint64).
//  - event_seq MUST be contiguous (+1) if present (SEQ_GAP is invalid).
//  - uti MUST be non-decreasing if present (UTI_DECREASE is invalid).
//  - prev_hash MUST match previous event's computed hash (CHAIN_BREAK is invalid).
//  - event_hash MUST equal SHA-256( stableStringify( hash_envelope_v1(event) ) ).
//  - (Equivocation) Same (source_uid,event_seq) MUST NOT appear with different event_hash.
//
// ========================================================================================

type UtiConformanceCase = { name: string; ok: boolean; detail: string };

async function runUtiConformanceSuite(): Promise<{ report: string; allOk: boolean }> {
  const cases: UtiConformanceCase[] = [];
  const add = (name: string, ok: boolean, detail: string) => cases.push({ name, ok, detail });

  const mkEvent = (sid: string, seq: bigint, uti: bigint, prevHash: string, meta?: Record<string, unknown>): KdsEventPacket => {
    const e: KdsEventPacket = {
      source_uid: sid,
      event_seq: seq.toString(10),
      uti_tick_ms: uti.toString(10),
      prev_hash: prevHash,
      event_uid: `${sid}:${seq.toString(10)}`,
      created_utc_ms: 0,
      mono_tick_ms: 0,
      mono_seq: 0,
      uti_conf: "UNVERIFIED",
      uti_timescale: "POSIX_UTC",
      meta: { ...(meta ?? {}), _test_case: true },
    };
    return e;
  };

  const sealChain = async (events: KdsEventPacket[]): Promise<KdsEventPacket[]> => {
    let last = GENESIS_HASH;
    const out: KdsEventPacket[] = [];
    for (const e of events) {
      e.prev_hash = String(e.prev_hash ?? "") || last;
      const canon = stableStringify(kdsUtiBuildHashPayloadV1(e));
      let h: string;
      try {
	        h = await sha256Hex(canon);
      } catch (err) {
	        throw new Error(`FAIL[CRYPTO_UNAVAILABLE]: ${String(err instanceof Error ? err.message : err)}`);
	      }
      setEventHash(e, h);
      last = h;
      out.push(e);
    }
    return out;
  };

  const sid = "SRC_TEST";
  {
    const base = await sealChain([
      mkEvent(sid, 1n, 1000n, GENESIS_HASH, { t: "ok" }),
      mkEvent(sid, 2n, 1001n, "", { t: "ok" }),
      mkEvent(sid, 3n, 1001n, "", { t: "ok" }),
    ]);
    const r = await kdsUtiVerifyEventLogV1(base);
    add("OK_CHAIN", r.ok, r.message);
  }

  {
    const base = await sealChain([
      mkEvent(sid, 1n, 2000n, GENESIS_HASH, { t: "cb" }),
      mkEvent(sid, 2n, 2001n, "", { t: "cb" }),
    ]);
    base[1]!.prev_hash = "deadbeef";
    const r = await kdsUtiVerifyEventLogV1(base);
    add("CHAIN_BREAK", !r.ok && r.message.includes("CHAIN_BREAK"), r.message);
  }

  {
    const base = await sealChain([
      mkEvent(sid, 1n, 3000n, GENESIS_HASH, { t: "gap" }),
      mkEvent(sid, 3n, 3001n, "", { t: "gap" }),
    ]);
    const r = await kdsUtiVerifyEventLogV1(base);
    add("SEQ_GAP", !r.ok && r.message.includes("SEQ_GAP"), r.message);
  }

  {
    const base = await sealChain([
      mkEvent(sid, 1n, 4000n, GENESIS_HASH, { t: "dec" }),
      mkEvent(sid, 2n, 3999n, "", { t: "dec" }),
    ]);
    const r = await kdsUtiVerifyEventLogV1(base);
    add("UTI_DECREASE", !r.ok && r.message.includes("UTI_DECREASE"), r.message);
  }

  {
    const e1 = mkEvent(sid, 10n, 5000n, GENESIS_HASH, { t: "eq1" });
    const h1 = await sha256Hex(stableStringify(kdsUtiBuildHashPayloadV1(e1)));
    setEventHash(e1, h1);

    const e2 = mkEvent(sid, 10n, 5000n, GENESIS_HASH, { t: "eq2-different" });
    const h2 = await sha256Hex(stableStringify(kdsUtiBuildHashPayloadV1(e2)));
    setEventHash(e2, h2);

    const r = await kdsUtiVerifyEventLogV1([e1, e2]);
    add("EQUIVOCATION", !r.ok && r.message.includes("EQUIVOCATION"), r.message);
  }

  const mustThrow = (name: string, fn: () => void) => {
    try { fn(); add(name, false, "Expected throw, got OK"); }
    catch (e) { add(name, true, String(e instanceof Error ? e.message : e)); }
  };

  mustThrow("CANON_NEGATIVE_ZERO", () => stableStringify({ x: -0 }));
  mustThrow("CANON_NAN", () => stableStringify({ x: Number.NaN }));
  mustThrow("CANON_INFINITY", () => stableStringify({ x: Number.POSITIVE_INFINITY }));
  mustThrow("CANON_LONE_SURROGATE", () => stableStringify({ x: "\uD800" }));

  const allOk = cases.every((c) => c.ok);
  const lines = [
    `KDS-UTI v1.0 Conformance Suite: ${allOk ? "PASS" : "FAIL"}`,
    `Cases: ${cases.length}`,
    "",
    ...cases.map((c) => `${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`),
  ];
  return { report: lines.join("\n"), allOk };
}
// ==============================================================================

// ----------------- KDS Event Packet log (Time + Space + Proof) -----------------
type KdsEventLogHeader = {
  spec_version: "1.0";
  profile_id: "INTEROP_POSIX" | "FORENSIC_SIGNED" | "CUSTOM";
  encoding: "CANONICAL_JSON_UTF8";
  hash_alg: "SHA-256";
  created_utc_ms: number;
};

type KdsEventLogBundle = {
  header: KdsEventLogHeader;
  events: KdsEventPacket[];
  uti_calibration?: UtiCalibration;
};

const KDS_SPEC_VERSION: KdsEventLogHeader["spec_version"] = "1.0";
const KDS_DEFAULT_PROFILE: KdsEventLogHeader["profile_id"] = "INTEROP_POSIX";

const EVENT_LOG_KEY = "kds_event_log_v1";
const SOURCE_UID_KEY = "kds_source_uid_v1";
const SOURCE_SEQ_KEY = "kds_source_next_seq_v1";




// ============================================================================
// PUBLIC API EXPORTS
// ============================================================================


// ------------------------------
// Examples (not used by the engine)
// ------------------------------

const EXAMPLE_REPLAY_CASES: ReplayCase[] = [
  {
    id: "BL_NOW",
    label: "Banja Luka (now-ish)",
    utcMs: Date.UTC(2026, 1, 21, 14, 56, 44),
    lat: 44.7722,
    lon: 17.191,
    level: 0,
    useEotDisplay: false,
    corr: { dut1Sec: 0, refractionMode: "STD", altitudeM: 165, horizonOffsetDeg: 0 },
    applyCorrectionsToDomains: false,
  },
  {
    id: "EQ_JUN",
    label: "Equator 0°, June solstice (midday UTC)",
    utcMs: Date.UTC(2026, 5, 21, 12, 0, 0),
    lat: 0,
    lon: 0,
    level: 0,
    useEotDisplay: false,
    corr: { dut1Sec: 0, refractionMode: "STD" },
    applyCorrectionsToDomains: false,
  },
  {
    id: "70N_JUN",
    label: "70°N, June solstice (midday UTC)",
    utcMs: Date.UTC(2026, 5, 21, 12, 0, 0),
    lat: 70,
    lon: 0,
    level: 0,
    useEotDisplay: false,
    corr: { dut1Sec: 0, refractionMode: "STD" },
    applyCorrectionsToDomains: false,
  },
];


const DEFAULT_REPLAY_CASES = EXAMPLE_REPLAY_CASES;


// ----------------- CANON-first high-level API (KDS Model) -----------------

const KDS_DAYS_PER_YEAR_CANON = 365 as const;
const KDS_SECONDS_PER_DAY_CANON = 86400 as const;
const KDS_SECONDS_PER_YEAR_CANON = KDS_DAYS_PER_YEAR_CANON * KDS_SECONDS_PER_DAY_CANON;

// Build a full KDS computation strictly from UTC now + location, deriving the equinox window
// internally and enforcing the 365×86400 canonical year invariant.
function computeKdsCanonFromUtcNow(params: {
  utcNowMs: number;
  // Optional explicit civil time zone offset (minutes). If omitted, civil time uses UTC for determinism.
  tzOffsetMinutes?: number;
  lat: number;
  lon: number;
  level?: FidelityLevel;

  // Display axis only (EoT affects display, not canon)
  useEotDisplay?: boolean;

  // Optional offline corrections (projection by default)
  corr?: Partial<KdsCorrections>;

  // If true, allow corrections (DUT1/refraction/observer geometry) to influence domains/season.
  // Default false keeps strict CANON behavior.
  applyCorrectionsToDomains?: boolean;

  prevDayNight?: { domain: "DAY" | "NIGHT"; solarSecMean: MeanSolarSec } | null;
  domainMode?: DomainMode;
  profile?: CalendarProfile;
  eventMeta?: KdsEventMeta;
}): KdsComputationResult {
  const level = params.level ?? 0;
  const useEot = !!params.useEotDisplay;

  const corrMerged: KdsCorrections = { ...DEFAULT_CORRECTIONS, ...(params.corr ?? {}) };
  const corrForCanon: KdsCorrections = params.applyCorrectionsToDomains ? corrMerged : DEFAULT_CORRECTIONS;

  // Derive equinox window around utcNowMs
  const win = equinoxWindowForUtcMs(params.utcNowMs);
  const equinoxStartMs = win.startMs;
  const equinoxEndMs = win.endMs;

  // Map UTC into canonical KDS year seconds via scale factor
  const realYearLenSec = (equinoxEndMs - equinoxStartMs) / 1000;
  const realSinceStartSec = (params.utcNowMs - equinoxStartMs) / 1000;
  const kdsScale = KDS_SECONDS_PER_YEAR_CANON / realYearLenSec;
  const kdsYearSec = clamp(realSinceStartSec * kdsScale, 0, KDS_SECONDS_PER_YEAR_CANON - 1e-9);

  const kdsDoy = clampInt(Math.floor(kdsYearSec / KDS_SECONDS_PER_DAY_CANON) + 1, 1, KDS_DAYS_PER_YEAR_CANON);
  const kdsSec = clampInt(Math.floor(kdsYearSec % KDS_SECONDS_PER_DAY_CANON), 0, KDS_SECONDS_PER_DAY_CANON - 1);

  const dUtc = new Date(params.utcNowMs);
  const siSecOfDay = dUtc.getUTCHours() * 3600 + dUtc.getUTCMinutes() * 60 + dUtc.getUTCSeconds();

  // Civil local time is computed deterministically from UTC using an explicit offset.
  // If tzOffsetMinutes is omitted, UTC is used (avoid runtime-local timezone dependence).
  const tzOffMin = (params.tzOffsetMinutes ?? 0) | 0;
  const dLoc = new Date(params.utcNowMs + tzOffMin * 60_000);
  const civilLocalSecOfDay = dLoc.getUTCHours() * 3600 + dLoc.getUTCMinutes() * 60 + dLoc.getUTCSeconds();

  const anchors = solarAnchorsForUtcDayMemo(params.lat, params.lon, params.utcNowMs, level, corrForCanon);
  const seasonState = buildSeasonStateTwoDomains(params.lat, params.lon, KDS_DAYS_PER_YEAR_CANON, equinoxStartMs, equinoxEndMs, level, corrForCanon);

  // doyEq is informational in current engine logs; keep it stable.
  const doyEq = 1;

  return computeKds({
    lat: params.lat,
    lon: params.lon,
    yearDays: KDS_DAYS_PER_YEAR_CANON,
    doyEq,
    utcNowMs: params.utcNowMs,
    equinoxStartMs,
    equinoxEndMs,
    kdsDoy,
    kdsSec,
    siSecOfDay,
    civilLocalSecOfDay,
    level,
    seasonState,
    useEot,
    anchors,
    prevDayNight: params.prevDayNight ?? null,
    domainMode: params.domainMode,
    corr: corrMerged,
    profile: params.profile,
    eventMeta: params.eventMeta,
  });
}

export {
  // --- Proof + hashing ---
  stableStringify,
  sha256Hex,
  stableHash32,
  DEFAULT_CORRECTIONS,

  // --- Protocol engine ---
  kdsUtiVerifyEventLogV1,
  kdsUtiBuildHashPayloadV1,
  kdsUtiVerifyEventLogV2,
  kdsUtiBuildHashPayloadV2,
  runUtiConformanceSuite,
  kdsUtiValidateConformantV1,

  // --- Solar engine ---
  solarAnchorsForUtcDay,
  solarAnchorsForUtcDayMemo,
  equationOfTimeSecondsUtcMs,

  // --- KDS calendar ---
  computeKds,
  computeKdsCanonFromUtcNow,
  makeEventUID,
  makeEventUIDWeak,

  // --- Examples ---
  EXAMPLE_REPLAY_CASES,
  DEFAULT_REPLAY_CASES,

  // --- Season ---
  buildSeasonStateTwoDomains,
  buildSeasonStateTwoDomainsChunked,

  // --- Utilities ---
  u64ToDecString,
  u64ToBigInt,
  isU64DecString,
};

export type {
  KdsEventPacket,
  KdsComputationResult,
  KdsCorrections,
  SolarAnchors,
  UtiConf,
  UtiTimescale,
  VerifyResult,
  FidelityLevel,
  RefractionMode,
  KdsSec,
  MeanSolarSec,
  ApparentSolarSec,
  SolarAnchorSec,
  U64DecString,
  ReplayCase,
};