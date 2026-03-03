# KDS-UTI Protocol Engine (TypeScript)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/draganskondric-engcdkso/kds-uti-engine/releases/tag/v1.0.0)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.18787285-blue.svg)](https://doi.org/10.5281/zenodo.18787285)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![Zero deps](https://img.shields.io/badge/dependencies-zero-brightgreen.svg)](#)

A deterministic, offline-friendly TypeScript engine for **canonical JSON hashing**, **tamper-evident hash-chained event logs**, strict **CANON vs PROJECTION** separation, and optional Meeus-style solar/astronomical projections + KDS-specific 13×28 + Year-Day calendar mapping.

Designed as a **reference-grade artifact** — reproducible, fail-closed, cross-runtime stable, and built for long-term archival and citation.

---

## Table of Contents

* [Why This Exists](#why-this-exists)
* [Key Advantages](#key-advantages)
* [Core Concepts](#core-concepts)
* [Quick Start](#quick-start)
* [Canonical JSON Rules](#canonical-json-rules)
* [Hash Chaining & Verification](#hash-chaining--verification)
* [KDS Event Packet Schema](#kds-event-packet-schema)
* [Projection Utilities (Optional)](#projection-utilities-optional)
* [Fidelity Levels](#fidelity-levels)
* [Runtime Compatibility](#runtime-compatibility)
* [License](#license)
* [Citation](#citation)
* [Support the Project](#support-the-project)

---

## Why This Exists

Unix time counts seconds from an arbitrary epoch — January 1, 1970 UTC — a date chosen by convention, not physics. It is opaque, culturally specific, and tells you nothing about the natural rhythms that govern human life: when the sun rises, whether it is summer or winter, how far through the year we actually are.

For most software, this is fine. For systems that demand **long-term verifiability**, **cross-jurisdiction neutrality**, or **physical grounding** — forensic records, archival systems, scientific logs, or any data that must remain interpretable without reference to a specific standards body — Unix time is a fragile foundation.

The KDS-UTI Engine uses a different anchor: the **March equinox**. Each year begins when the Sun crosses the celestial equator northward. The year is divided into exactly **365 × 86400 KDS-seconds**, scaled to fit between consecutive equinoxes. Every event can be expressed as a fraction τ ∈ [0,1) of that astronomically-defined year — a coordinate reproducible from first principles, anywhere, without any external authority.

Beyond the time anchor, real systems also need:

* **Determinism** — same input → same hash/ID everywhere, always
* **Integrity** — detect any tampering, reordering, omission or equivocation
* **Auditability** — verifiable provenance and replayability
* **Offline independence** — no external APIs or services
* **Separation of concerns** — immutable canonical records vs. derived display/projection views

This engine enforces all of those properties explicitly.

---

## Key Advantages

1. **Deterministic Canonical Hashing**
   Logically identical JSON → identical bytes → identical SHA-256 digest, regardless of key insertion order, whitespace, or platform quirks.

2. **Fail-Closed Validation**
   Rejects `NaN`, `Infinity`, `-0`, functions, symbols, lone Unicode surrogates, and circular references — no silent corruption.

3. **Tamper-Evident Hash Chains**
   Detects edits, deletions, insertions, reordering, or forks in event logs. Two protocol versions (v1, v2) with a built-in conformance suite.

4. **Strict CANON vs PROJECTION Separation**
   * CANON = immutable, hashable core records
   * PROJECTION = derived views (solar time, EoT, DUT1, timezone, UI corrections) — enforced at the TypeScript type level via branded types; never pollutes canonical integrity.

5. **Offline Solar Engine**
   Meeus-based Julian Day, ΔT polynomial, apparent solar longitude, nutation, aberration, Equation of Time, and geometric sunrise/sunset with atmospheric refraction — all in pure TypeScript, zero dependencies.

6. **KDS Calendar**
   13 months × 28 days + Year-Day, equinox-anchored canonical year (365 × 86400 KDS-seconds), with deterministic DAY/NIGHT (Θ) and WARM/COLD (Φ) domain phases.

---

## Core Concepts

* **UTI** — canonical time/index spine for deterministic event identity and ordering, anchored to the March equinox
* **KDS-Second** — uniform subdivision of the fixed canonical year (365 × 86400 per equinox-to-equinox span)
* **τ (tau)** — year fraction in [0,1); the astronomy-grounded event coordinate
* **Θ (theta)** — position 0–9999 within the current DAY or NIGHT domain
* **Φ (phi)** — position 0–9999 within the current WARM or COLD season segment
* **tzOffsetMinutes** — optional deterministic civil time offset (defaults to UTC for reproducibility)

**Layers:**

1. Canonical JSON & SHA-256 hashing
2. Hash-chained event log with verification
3. Solar model + KDS calendar (projection utilities, display-only by default)

---

## Quick Start

Copy `kds-uti-engine.v1.0.0.ts` into your project. The only runtime dependency is [WebCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) (`crypto.subtle`), available natively in all modern browsers, Node.js 18+, and Cloudflare Workers.

```ts
import {
  stableStringify,
  sha256Hex,
  computeKdsCanonFromUtcNow,
  kdsUtiVerifyEventLogV1,
  runUtiConformanceSuite,
} from './kds-uti-engine.v1.0.0';
```

**Canonical hashing:**

```ts
const payload = { b: 2, a: 1 };
const canon = stableStringify(payload);  // → '{"a":1,"b":2}'
const hash  = await sha256Hex(canon);    // stable SHA-256 hex digest
```

**KDS time computation:**

```ts
const result = computeKdsCanonFromUtcNow({
  utcNowMs: Date.now(),
  lat: 44.7722,
  lon: 17.191,
  tzOffsetMinutes: 60,   // CET (optional; defaults to UTC)
});

console.log(result.tau);     // year fraction τ ∈ [0,1)
console.log(result.domain);  // "DAY" or "NIGHT"
console.log(result.theta);   // 0..9999 within current domain
console.log(result.season);  // "WARM" or "COLD"
console.log(result.stamp);   // human-readable KDS timestamp
```

**Run the conformance suite:**

```ts
const { report, allOk } = await runUtiConformanceSuite();
console.log(report);
// KDS-UTI v1.0 Conformance Suite: PASS
// ✅ CANON_KEY_ORDER: ...
// ✅ CHAIN_INTACT: ...
// ✅ CHAIN_BREAK: ...
```

---

## Canonical JSON Rules

* Keys sorted alphabetically (recursive, all nesting levels)
* Array elements preserved by index; sparse holes canonicalized to `null`
* Non-representable values rejected with explicit errors (fail-closed):
  `NaN`, `Infinity`, `-0`, functions, symbols, lone UTF-16 surrogates, circular references
* `bigint` values serialized as decimal strings
* `undefined` values serialized as `null`
* Implementation is the protocol authority — treat source as spec

---

## Hash Chaining & Verification

**Basic pattern:**

```
prev_hash   ← SHA-256 of previous event envelope (genesis = "000...0" × 64)
event_hash  ← SHA-256(canonical envelope including prev_hash)
```

Verifier checks:

* Monotonic `event_seq`
* Chain continuity (each `prev_hash` matches the previous `event_hash`)
* Rejects gaps, duplicates, and forks

Two protocol versions are supported:

* **v1** — `kdsUtiBuildHashPayloadV1` / `kdsUtiVerifyEventLogV1` — core fields
* **v2** — `kdsUtiBuildHashPayloadV2` / `kdsUtiVerifyEventLogV2` — extended fields including spatial and KDS-UTI scaffold

**Replay:** re-process raw events from their inputs → computed hashes must exactly match the stored ones.

---

## KDS Event Packet Schema

Each event in the log is a typed `KdsEventPacket`. Fields marked as required are the minimum for a valid packet.

```ts
type KdsEventPacket = {
  event_uid: string;          // (required) cryptographically unique event ID
  created_utc_ms: number;     // (required) UTC milliseconds at event creation
  mono_tick_ms: number;       // (required) monotonic session tick

  source_uid?: string;        // stable source/device identity
  event_seq?: U64Like;        // strictly increasing sequence within source

  ati_tau?: number;           // KDS year fraction τ ∈ [0,1) — astronomy anchor
  kds_sec_of_year?: number;   // integer in [0, 365×86400)
  equinox_start_ms?: number;  // equinox window used for canonical year
  equinox_end_ms?: number;

  lat?: number;               // observer latitude  (WGS84, -90..90)
  lon?: number;               // observer longitude (WGS84, -180..180)
  alt_m?: number;             // altitude in metres

  proof_v?: 1 | 2;            // hash-chain protocol version
  prev_hash?: string;         // SHA-256 of previous event (64 hex chars)
  event_hash?: string;        // SHA-256 of this event envelope (64 hex chars)

  meta?: Record<string, unknown>; // free non-canonical metadata
};
```

**CANON fields** (enter the hash): `event_uid`, `created_utc_ms`, `source_uid`, `event_seq`, `ati_tau`, `kds_sec_of_year`, `equinox_*`, spatial fields, `prev_hash`.

**PROJECTION fields** (display only, never hashed): `proj_eot_display`, `proj_dut1_sec`, civil timezone derivations.

---

## Projection Utilities (Optional)

All solar and calendar computations live in the **PROJECTION layer** by default. They affect what a user sees; they do not affect canonical hashes.

Available utilities:

* Julian Day conversion
* ΔT (TT−UT) piecewise polynomial (Espenak/Meeus, 1600–2150)
* Apparent solar longitude with nutation and aberration
* Equation of Time (`equationOfTimeSecondsUtcMs`)
* Geometric sunrise/sunset with atmospheric refraction (`solarAnchorsForUtcDay`)
* 13×28 + Year-Day calendar mapping
* Civil time with explicit `tzOffsetMinutes`
* WARM/COLD season segmentation (`buildSeasonStateTwoDomains`)

> Do **not** feed projection outputs back into CANON fields unless the protocol explicitly permits it via `applyCorrectionsToDomains: true`.

---

## Fidelity Levels

The solar model accepts a `FidelityLevel` (0–2) that trades accuracy for speed:

| Level | Nutation | Accuracy | Use case |
|-------|----------|----------|----------|
| `0` | None | ~1–2 arcmin | Fast UI, default |
| `1` | Simple (4 terms) | ~0.5 arcmin | Balanced |
| `2` | Extended (10 terms) | ~0.1 arcmin | Reference grade |

All levels are fully deterministic and offline.

---

## Runtime Compatibility

| Environment | Status |
|-------------|--------|
| Browser (modern) | ✅ Native WebCrypto |
| Node.js 18+ | ✅ `node:crypto` webcrypto |
| Cloudflare Workers | ✅ Native WebCrypto |
| Deno | ✅ Native WebCrypto |
| Node.js < 18 | ⚠️ Requires crypto polyfill |

---

## License

MIT License — see [LICENSE.txt](LICENSE.txt)

---

## Citation

If using in research or academia, cite via Zenodo (preferred):

```bibtex
@software{skondric_kds-uti-engine_2026,
  author    = {Dragan Škondrić},
  title     = {KDS-UTI Protocol Engine: Canonical JSON Hashing and Hash-Chain Verification (TypeScript)},
  year      = {2026},
  version   = {1.0.0},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.18787285},
  url       = {https://github.com/draganskondric-engcdkso/kds-uti-engine}
}
```

---

## Support the Project

If this engine saves you time, helps in production, or aligns with your needs for determinism and auditability — consider a small donation. Every bit helps continue the work! 🙏

[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white&style=for-the-badge)](https://paypal.me/cdkso)

Suggested amounts:

* [5 EUR](https://paypal.me/cdkso/5)
* [10 EUR](https://paypal.me/cdkso/10EUR)
* Direct donation: [https://paypal.me/cdkso](https://paypal.me/cdkso)

Thank you! ❤️
