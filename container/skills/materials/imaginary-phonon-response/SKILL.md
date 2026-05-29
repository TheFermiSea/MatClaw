---
name: imaginary-phonon-response
description: Graduated response strategy when mcp__phonon_gw__detect_imaginary_modes returns a fail/warn verdict. Steps from cheapest to most expensive (tighter relax → larger FFT/EDIFF → MLIP-anharmonic correction → SSCHA). Use whenever phonon calc has imaginary modes; do NOT discard a structure on first failure.
---

# Imaginary Phonon Response

## What this skill does

When a phonon calculation comes back with imaginary modes (negative
frequencies), the harmonic dynamical matrix has at least one eigenvalue
< 0, meaning the structure is dynamically unstable at the level of theory
you ran. The default reaction — "discard this polymorph and try
something else" — is wrong roughly half the time. The underlying physics
is one of four things, each with a different fix: (1) the relax did not
converge tightly enough; (2) the FFT/charge-density grid was too coarse;
(3) the mode is genuinely anharmonic and stabilizes at finite T;
(4) the mode is a real ferroelectric/CDW soft mode that points at a
distorted polymorph you should follow. This skill prescribes the
**graduated response** that distinguishes these cases in order of cost,
and ties each tier's outcome to a `ConvergenceVerdict` so the caller can
choose whether to escalate or stop.

## When to use it

- `mcp__phonon_gw__detect_imaginary_modes` returns `verdict: "fail"` or
  `verdict: "warn"` on a phonon calc you care about.
- The user asks "is this structure dynamically stable" — answering "yes"
  is unsafe without running at least Tier 0 + Tier 1.
- Before claiming any newly proposed polymorph or MLIP-relaxed structure
  is real (e.g., before adding it to a Materials Project–style index, or
  before publishing it as a metastable phase).
- A downstream skill (thermal-conductivity, gruneisen-qha,
  electron-phonon) is about to consume the force constants — imaginary
  modes there silently corrupt every derived quantity.

Do NOT use this skill to declare a structure stable. It only resolves
the question "is the imaginary mode an artifact". Confirming dynamical
stability still requires positive frequencies on the full BZ mesh from
the appropriate tier.

## Decision tree (the graduated response)

```
Tier 0: Diagnose
  mcp__phonon_gw__detect_imaginary_modes(threshold_thz=-0.5)
  -> worst_thz, worst_qpoint
      worst_thz >  -0.5         numerical noise -> tighten + recheck (cheap)
      -2.0 < worst_thz < -0.5   real small instability -> Tier 1
      worst_thz <= -2.0         large instability:
                                  zone center  -> consider distorted polymorph
                                  zone boundary-> follow soft mode (real physics)
                                  bulk-wide    -> structure is wrong; redo input

Tier 1: Tighter relax (~minutes-hours)
  Re-relax with EDIFFG=-0.001 (10x tighter forces), ISIF=3 (full cell),
  EDIFF=1e-8, then rerun phonon.
  Resolves: residual-force-induced fake imaginaries (the most common
  cause once the structure is reasonable).

Tier 2: Larger FFT + ENCUT (~hours)
  Bump ENCUT by 25% (e.g. 520 -> 650 eV), NGX/NGY/NGZ by 50%, rerun
  phonon. Resolves: charge-density aliasing on soft modes near zone
  boundary. If Tier 1 already passed, skip this.

Tier 3: MLIP-anharmonic correction (~hours)
  Run NVT MD at T_target with mcp__mlip__md_step. Build the temperature-
  dependent effective dynamical matrix (TDEP-style) from the time-
  averaged force-displacement pairs. Compare harmonic vs anharmonic
  spectrum.
  -> If imaginary mode disappears at finite T:   anharmonic stabilization,
                                                  finding is publishable
                                                  (e.g. cubic SrTiO3
                                                  perovskites).
  -> If it persists:                              proceed to Tier 4.

Tier 4: SSCHA (~days)
  Full Stochastic Self-Consistent Harmonic Approximation (Monacelli
  arXiv:2103.03973). Heavy; ~10^3 single-point evaluations per iteration
  per supercell, 5-15 iterations to converge. Only run when:
    - Tiers 0-3 have not resolved, AND
    - The user explicitly needs the anharmonic-corrected phonon spectrum
      (not just "is it stable").
```

At each tier, emit a `ConvergenceVerdict` (code: `"phonopy"`, verdict
`"pass" | "warn" | "fail"`) with `reasons` carrying the per-tier action
log and `evidence` pointing at the resolved/unresolved q-points. The
caller decides whether to spend the next tier's budget.

## MCP tools

- `mcp__phonon_gw__detect_imaginary_modes` — Tier 0 diagnostic; returns
  `worst_thz`, `worst_qpoint`, `n_imaginary`, `verdict`. Default
  threshold `-0.5 THz`; tighten to `-0.1` only on intentionally
  picometer-precise relaxations.
- `mcp__phonon_gw__generate_phonon_displacements` — Tier 1/2; regenerates
  the displaced supercells after tightening relax/FFT. Pass the
  re-relaxed structure, **not** the original.
- `mcp__mlip__md_step` — Tier 3; short NVT MD (~10-50 ps after
  equilibration is usually enough at typical T). Returns trajectory +
  forces; pair with phonopy's TDEP path or `hiphive`.
- `mcp__atomate2__build_flow` (with `PhononMaker`) — Tier 1/2 in
  publication-quality DFT mode (VASP/QE backend); use when the original
  phonon was MLIP and we need a DFT cross-check before declaring
  imaginary modes "real".
- `mcp__jobflow_remote__submit_flow` — wire any atomate2 flow above to
  the cluster. SSCHA at Tier 4 also goes through this.

Cross-ref the live phonon driver in `→ skills/thermal-properties/phonon/SKILL.md`
for input-file scaffolding (EDIFF/EDIFFG/ENCUT/NGX template wording).
Cross-ref `→ skills/materials/dry-run-validate/SKILL.md` before
re-submitting at Tier 1/2 — the validator catches NELECT/ENMAX/EDIFFG
mismatches that would silently re-introduce a fake imaginary mode.

## Output template

Each invocation of this skill should produce a Markdown block of this
shape (the caller stores it; the agent-runner's post-verifier hook
reads `reached_tier` and `verdict.verdict` for TZ feedback):

```markdown
### imaginary-phonon-response — <material formula> @ <calc_id>

Tier 0 (diagnose):
  worst_thz = -1.4, worst_qpoint = [0.5, 0.5, 0.5]
  n_imaginary = 3 bands at X
  classification = "real small instability"

Tier 1 (tighter relax, ~30 min on coder tier):
  EDIFFG: -0.01 -> -0.001
  max force after re-relax: 4.2e-4 eV/A (pass)
  rerun phonopy -> worst_thz = -0.3 (warn, near threshold)
  -> escalate

Tier 2 (larger FFT, ~45 min):
  ENCUT: 520 -> 650 eV
  NGX,NGY,NGZ: 60,60,60 -> 90,90,90
  rerun phonopy -> worst_thz = +0.05 (pass)

Verdict (phonopy, pass): resolved at Tier 2.
Recommended next: feed force constants to thermoconductivity skill.
Estimated cost spent: ~75 GPU-min. Cost not spent: Tier 3/4 (~12+ GPU-h).
```

If Tier 3 fires and the imaginary mode disappears at T, label the
verdict `pass` and explicitly note in `reasons`: "anharmonically
stabilized at T = <K>; harmonic spectrum unphysical for this material".
Do NOT silently overwrite the harmonic force constants with the
anharmonic ones — downstream consumers (gruneisen-qha,
thermoconductivity) need to choose.

## Common pitfalls

- **Declaring "unstable" after Tier 0 alone.** Tier 0 is a diagnostic,
  not a verdict on the material. Always run at least Tier 1 before
  reporting dynamical instability to the user.
- **Jumping straight to SSCHA.** Tier 4 is days of cluster time. ~80%
  of fail verdicts resolve at Tier 1 or Tier 2; the remaining 20% mostly
  resolve at Tier 3. Tier 4 is a last resort.
- **Ignoring soft-mode physics.** An imaginary mode at the zone boundary
  is often a *real* ferroelectric or CDW soft mode pointing at a
  lower-symmetry polymorph. Following the eigenvector and re-relaxing
  in the distorted cell is the physically correct response — `→ skills/ferroelectric/`
  and `→ skills/phase-transition/` cover this. The graduated response
  is for *suspected artifacts*, not for known soft modes.
- **Re-running phonopy on the un-re-relaxed structure** after Tier 1.
  Cheap bug; the `generate_phonon_displacements` call must receive the
  freshly relaxed structure or you re-derive identical imaginary modes.
- **Mixing tier outputs in one CalcReport.** Each tier's
  `ConvergenceVerdict` should have a distinct `calc_id` (e.g.
  `<base>_tier1_relax`, `<base>_tier2_fft`). Otherwise TZ feedback can't
  attribute resolution to the right action.
- **Using MLIP at Tier 1/2.** Tightening EDIFFG / ENCUT only helps if
  the underlying potential resolves the difference. If the original
  phonon was MLIP, the right Tier 1/2 escalation is a DFT cross-check
  via `mcp__atomate2__build_flow`, not a tighter MLIP relax — MLIPs do
  not have an "EDIFF" to tighten.

## References

- **Digital Discovery 2025 D4DD00353E** — canonical paper for the
  graduated-response strategy + tier ordering used here. Read this
  before any material-class deviation from the default thresholds.
- phonopy documentation (`https://phonopy.github.io/phonopy/`) —
  Sec. "Imaginary modes" and Sec. "Convergence" for the relax/FFT
  hyperparameters cited at Tier 1/2.
- SSCHA: Monacelli et al., **arXiv:2103.03973**, "The stochastic
  self-consistent harmonic approximation". Foundational paper for Tier 4.
- TDEP / temperature-dependent effective potential at Tier 3:
  Hellman & Abrikosov, Phys. Rev. B **88**, 144301 (2013); modern MLIP
  workflow recap in `hiphive` docs.
- atomate2 PhononMaker for the DFT cross-check pattern at Tier 1/2.
