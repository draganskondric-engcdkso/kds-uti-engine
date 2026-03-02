# KDS-UTI Protocol Engine (TypeScript)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/draganskondric-engcdkso/kds-uti-engine/releases/tag/v1.0.0)

A deterministic, offline-friendly TypeScript engine for **canonical JSON**, **tamper-evident hash-chained event logs**, strict **CANON vs PROJECTION** separation, and optional Meeus-style solar/astronomical projections + KDS-specific 13×28 + Year-Day calendar mapping.

Designed as a **reference-grade artifact** — reproducible, fail-closed, cross-runtime stable, and built for long-term archival and citation.

---

## Table of Contents

* [Why This Exists](#why-this-exists)
* [Key Advantages](#key-advantages)
* [Core Concepts](#core-concepts)
* [Quick Start](#quick-start)
* [Canonical JSON Rules](#canonical-json-rules)
* [Hash Chaining & Verification](#hash-chaining--verification)
* [Projection Utilities (Optional)](#projection-utilities-optional)
* [License](#license)
* [Citation](#citation)
* [Support the Project](#support-the-project)

---

## Why This Exists

Most event logs and time-based records are treated as "just data" — but real systems need:

* **Determinism** — same input → same hash/ID everywhere, always
* **Integrity** — detect any tampering, reordering, omission or equivocation
* **Auditability** — verifiable provenance and replayability
* **Offline independence** — no external APIs or services
* **Separation of concerns** — immutable canonical records vs. derived display/projection views

This engine enforces those properties explicitly.

---

## Key Advantages

1. **Deterministic Canonical Hashing**
   Logically identical JSON → identical bytes → identical SHA-256 digest, ignoring key order, whitespace, platform quirks.

2. **Fail-Closed Validation**
   Rejects `NaN`, `Infinity`, `-0`, functions, symbols, invalid Unicode — no silent corruption.

3. **Tamper-Evident Hash Chains**
   Detects edits, deletions, insertions, reordering or forks.

4. **Strict CANON vs PROJECTION Separation**

   * CANON = immutable, hashable core records
   * PROJECTION = optional derived views (solar time, calendar mapping, UI corrections) — never pollutes canonical integrity.

5. **Offline Astronomy Utilities**
   Meeus-based Julian Day, Equation of Time, nutation, sunrise/sunset — all in pure TypeScript, no dependencies.

6. **KDS Calendar**
   13 months × 28 days + Year-Day, equinox-anchored canonical year (365 × 86400 KDS-seconds).

---

## Core Concepts

* **UTI** — canonical time/index spine for deterministic event identity and ordering
* **KDS-Second** — uniform subdivision of fixed canonical year (equinox-anchored)
* **tzOffsetMinutes** — optional deterministic civil time offset (defaults to UTC)

**Layers:**

1. Canonical JSON & SHA-256 hashing
2. Event log with chain verification
3. Projection utilities (solar/calendar, display-only)

---

## Quick Start

1. **Add the Engine**
   Copy `kds-uti-engine.v1.0.0.ts` (single file, zero deps except Web Crypto).

2. **Import & Use**

```ts
import { stableStringify, sha256Hex } from './kds-uti-engine';

// Canonicalize & hash
const payload = { b: 2, a: 1 };

const canon = stableStringify(payload);  // → '{"a":1,"b":2}'
const hash  = await sha256Hex(canon);    // stable hex digest

console.log(canon); // '{"a":1,"b":2}'
console.log(hash);  // e.g. 'a3f5c...'
```

---

## Canonical JSON Rules

* Keys sorted alphabetically
* Arrays by index
* Non-representable values rejected (fail-closed)
* No `NaN`, `Infinity`, `-0`, functions, symbols
* Exact spec in source — treat implementation as protocol authority

---

## Hash Chaining & Verification

**Basic pattern:**

```text
prev_hash     ← hash of previous event
payload_hash  ← hash(canonical payload)
event_hash    ← hash(entire envelope including prev_hash)
```

Verifier checks:

* monotonic event_seq
* chain continuity
* rejects gaps, duplicates, forks

**Replay:** re-process raw events → must match original hashes.

---

## Projection Utilities (Optional)

Keep in **PROJECTION layer**:

* Julian Day, Equation of Time, nutation, sunrise/sunset anchors
* 13×28 + Year-Day calendar mapping
* Civil time with explicit tzOffsetMinutes

> Do **not** feed back into CANON unless protocol explicitly allows.

---

## License

MIT License — see [LICENSE.txt](LICENSE.txt)

---

## Citation

If using in research/academia, cite via Zenodo (preferred) or include:

```bibtex
@software{skondric_kds-uti-engine_2026,
  author       = {Dragan Škondrić},
  title        = {KDS-UTI Protocol Engine: Canonical JSON Hashing and Hash-Chain Verification (TypeScript)},
  year         = {2026},
  version      = {1.0.0},
  publisher    = {Zenodo},
  doi          = {10.5281/zenodo.18787285},
  url          = {https://github.com/draganskondric-engcdkso/kds-uti-engine}
}
```

---

## Support the Project

If this engine saves you time, helps in production, or aligns with your needs for determinism and auditability — consider a small donation. Every bit helps continue the work! 🙏

[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal\&logoColor=white\&style=for-the-badge)](https://paypal.me/cdkso)

Suggested amounts:

* [5 EUR](https://paypal.me/cdkso/5)
* [10 EUR](https://paypal.me/cdkso/10EUR)
* Direct donation: [https://paypal.me/cdkso](https://paypal.me/cdkso)

Thank you! ❤️
