[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.18787285.svg)](https://doi.org/10.5281/zenodo.18787285)
# KDS-UTI Protocol Engine (TypeScript)

A deterministic, offline-friendly TypeScript engine for:
- **Canonical JSON serialization** (byte-stable)
- **SHA-256 hashing** (cross-runtime)
- **Hash-chained tamper-evident event logs**
- **Strict CANON vs PROJECTION separation**
- Optional **astronomy-based projection utilities** (Meeus-style solar computations)
- A **KDS-specific calendar mapping** using a **13×28 + Year-Day** structure (a known calendrical scheme), defined here within the KDS canonical model

This release is intended as a **reference-grade artifact**: reproducible results, fail-closed validation, and long-term archival/citation.

---

## Why this exists (the core problem)

Most systems treat time records and event logs as “just data”. In practice, you often need:
- **Determinism**: same input → same hash/ID on every machine
- **Integrity**: detect tampering, reordering, omission, equivocation
- **Auditability**: explain how an ID was produced and verify it later
- **Offline independence**: no external services required
- **Separation of concerns**: immutable canonical records vs. display/projection layers

This engine implements those properties explicitly.

---

## Key advantages

### 1) Deterministic canonical hashing (reproducible IDs)
The engine canonicalizes JSON so that logically identical payloads produce **identical byte sequences** and therefore identical hashes, regardless of:
- key insertion order
- platform / runtime differences
- whitespace formatting
- accidental representation ambiguity

### 2) Fail-closed behavior (no silent corruption)
Instead of “best effort”, the engine **rejects** ambiguous or invalid inputs that would break determinism, such as:
- `NaN`, `Infinity`, `-Infinity`
- non-canonical numeric edge cases (e.g. `-0`)
- unsupported or unsafe JSON-like values (functions, symbols)
- invalid Unicode edge cases where relevant

Failing loudly is a feature: it prevents “quiet divergence” across runtimes.

### 3) Tamper-evident event logs (hash chains)
Events can be linked into a **hash chain** so any change in history becomes detectable:
- edit of past payload
- deletion or insertion
- reordering
- fork/equivocation patterns (depending on your verifier policy)

### 4) CANON vs PROJECTION separation (KDS philosophy)
The engine supports the KDS principle:
- **CANON**: immutable, hashable, replayable records and canonical time spine
- **PROJECTION**: optional derived views (e.g., solar apparent time, display corrections)

Projection logic must never contaminate canonical integrity.

### 5) Offline solar projections (optional)
For systems that model solar time, the engine includes offline computations based on Meeus-style algorithms and related components such as:
- Julian Day conversions
- Equation of Time (EoT)
- nutation/obliquity/aberration components (as implemented)
- sunrise/sunset anchors (where included)
- mean vs apparent solar time separation

These are utilities for projection layers, not a dependency for canonical log integrity.

### 6) KDS-specific calendar mapping (13×28 + Year-Day)
The engine includes a **KDS-specific** calendar mapping using a **13 months × 28 days + Year-Day** structure.
Important clarification:
- The 13×28 + Year-Day scheme is a **known calendrical pattern** historically.
- In this project, it is implemented as part of the **KDS canonical model** and its mapping rules.

---

## What “KDS-UTI” means (high-level)

**UTI** is a canonical time/index concept designed for:
- deterministic event identity
- ordering and replay
- verification via hash chaining
- stable serialization rules

You can treat it as a “protocol spine” that stays valid even as you change UI, local display, or projection choices.

---

## Time units (KDS-second vs SI-second)

### Deterministic civil time (timezone handling)

Some projection utilities may need a “civil local time of day”. To avoid dependence on the host runtime's local timezone,
the engine computes civil time deterministically from UTC using an explicit optional parameter:

- `tzOffsetMinutes?: number` — civil timezone offset in minutes (e.g., `60` for UTC+1). If omitted, **UTC is used**.


This engine is **protocol-first** and does not require any specific physical time unit.
Where KDS time is used, a **KDS-second** is defined by the KDS canonical model as a
uniform subdivision of a fixed canonical year of **365 × 86400** units (equinox-anchored),
i.e. the canonical year is mapped to exactly **31,536,000 KDS-seconds**.

Astronomy- and calendar-derived values should be treated as **projection-layer outputs**
unless your protocol explicitly includes them in canonical event payloads.

---

## Design overview

### Layers

1) **Canonical JSON & Hashing**
- Canonicalization → stable bytes
- SHA-256 → stable digest
- Used to produce event IDs and chain links

2) **Event Log & Verification**
- events include minimal required fields (e.g., `source_uid`, `event_seq`, payload)
- verifier checks continuity and detects violations

3) **Projection utilities (optional)**
- solar computations (Meeus-style components)
- calendar mapping and seasonal classification
- display-only transforms, never canonical integrity inputs (unless you explicitly design it that way)

### Determinism guarantees

The engine aims for:
- same canonical JSON → same bytes
- same bytes → same SHA-256
- same event chain rules → same verification result

If determinism cannot be guaranteed, the engine prefers to throw.

---

## Quick start

### 1) Add the engine
This release may be distributed as a single `.ts` file.

Example structure:

```
/src
  kds-uti-engine.ts
```

### 2) Import (example)
Adjust import path to your project.

```ts
import {
  stableStringify,
  sha256Hex,
  // ... other exports
} from "./kds-uti-engine";
```

### 3) Canonicalize and hash a payload

```ts
const payload = { b: 2, a: 1 };

const canon = stableStringify(payload); // keys sorted deterministically
const hash = await sha256Hex(canon);    // stable digest across runtimes

console.log(canon); // {"a":1,"b":2}
console.log(hash);  // e.g. "a3f5..."
```

---

## Canonical JSON rules (practical summary)

The engine’s canonicalization is designed so that two logically identical JSON structures produce identical strings/bytes.

Typical rules include:
- Object keys are **sorted deterministically**
- Arrays are serialized by index
- Sparse arrays are normalized (e.g., missing indexes become explicit `null` if supported by the implementation)
- Values not representable in strict JSON are rejected (fail-closed)
- Non-finite numbers are rejected
- Numeric edge cases that break canonical form (e.g. `-0`) are rejected

> Exact behavior is defined by the implementation in this release. Treat it as the canonical authority for the protocol version.

---

## Hash chaining (concept)

A basic chain pattern:

- Event `i` includes:
  - `prev_hash` = hash of event `i-1` (or genesis value)
  - `payload_hash` = hash of canonical payload
  - `event_hash` = hash of canonical event envelope (including `prev_hash`)

If any prior event changes, every subsequent `prev_hash` relationship breaks.

---

## Verification & replay

A verifier typically checks:
- monotonic `event_seq` per `source_uid`
- chain continuity (`prev_hash` matches)
- canonicalization and hash matches expected rules
- reject duplicates, gaps, forks (depending on policy)

Replay means you can:
- re-run canonicalization and hashing from raw events
- confirm you obtain identical results years later

---

## Solar and calendar projection utilities (optional)

If you use the astronomy/calendar features:
- Keep them in **PROJECTION** territory by default.
- Do not feed projection outputs back into canonical event identity unless you explicitly define that as part of your protocol.

Recommended pattern:
- Canonical event stores a minimal stable time spine
- Projection layer computes solar times, calendar views, seasonal state for UI/analysis

---

## Suggested “Zenodo record” metadata

- **Resource type**: Software
- **Title**: KDS-UTI Protocol Engine: Canonical JSON Hashing and Hash-Chain Verification (TypeScript)
- **Version**: 1.0.0
- **Keywords**:
  - KDS, UTI, canonical JSON, SHA-256, hash chain, tamper-evident log,
    deterministic hashing, TypeScript, offline, event ledger
- **License**: MIT

---

## License

This release is published under the **MIT License**. See `LICENSE.txt`.

---

## Citation

If you publish on Zenodo, use the DOI citation Zenodo generates.
You can also include a `CITATION.cff` later if you publish on GitHub.

---

## Notes / scope

- This engine is built to prioritize **determinism, auditability, and invariants**.
- It is suitable as a reference implementation for protocol-level hashing and verification.
- Projection utilities are provided to support KDS-style solar and calendar views, but remain optional.

---

## Contact / project context

KDS-UTI Engine is part of the broader KDS Model work:
a canon-first architecture separating immutable records (CANON) from derived views (PROJECTION).
