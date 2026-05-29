---
name: research-plan
description: Build a structured multi-step plan for a materials-science investigation BEFORE executing any calculations. Covers material identification, target property selection, method-tier strategy (MLIP screening -> DFT -> GW), validation gates, memory recall, and artifact specification. Use at the start of any non-trivial investigation.
---

# Research Plan

## What this skill does

Before launching a multi-step materials investigation, draft an explicit plan that names the material, the target property, the method tier ladder (MLIP screening -> DFT -> many-body), the validation gates that must pass at each tier, the prior-knowledge to recall from Graphiti memory, and the artifacts the run will emit. The plan is a short markdown block emitted to the user (and persisted with the calc) so that every downstream step has an auditable rationale. Skipping this step is the dominant cause of wasted compute on dead-end calculations.

This skill ports the planning pattern from DREAMS (arXiv:2507.14267, `planNexeHighPlan.py`) and the pre-flight discipline from LARA-HPC (arXiv:2604.22571), adapted to MatClaw's MCP toolchain and CalcReport schema.

## When to use it

- The user asks a non-trivial materials question: "what's the band gap of NbOCl2", "screen these MOFs for CH4 uptake", "is this phase dynamically stable".
- The investigation will touch more than one solver tier (e.g. MLIP relax followed by DFT static, or DFT followed by GW).
- The user mentions "plan", "strategy", "approach", "roadmap", or asks "how would you...".
- The investigation will submit any SLURM job. Always plan before submitting.
- After a tier escalation (DFT to GW, harmonic to anharmonic) trigger this skill again to re-plan the next tier.

Skip this skill when the user asks a one-shot read-only question ("what's the lattice parameter of MP-149") or a single calculation with no method ambiguity ("relax this CIF with MACE").

## Decision tree

```
Is the material identified?
  NO  --> mcp__mp__get_structure (by formula) OR ask user for CIF/POSCAR
          OR mcp__mlip__generate (if user requested generative search)
  YES --> proceed

Has a similar calculation been done before?
  ALWAYS --> mcp__graphiti__search_similar(material=<formula>, calc_type=<type>)
             Record hit/miss in plan; reuse converged parameters if available
             (see -> skills/materials/parameter-recall/SKILL.md)

What is the target property?
  Structural (lattice, bulk modulus, EOS)
    --> Tier 1: MLIP relax (mace_mp medium)  Tier 2: DFT vc-relax
  Electronic (band gap, DOS, work function)
    --> Tier 1: PBE DFT  Tier 2: hybrid (HSE06) or +U  Tier 3: GW (if gap matters quantitatively)
  Vibrational (phonons, IR, Raman, thermal expansion)
    --> Tier 1: MLIP phonons (sanity)  Tier 2: phonopy + DFT
        If imaginary modes detected -> SSCHA
        (see -> skills/materials/imaginary-phonon-response/SKILL.md)
  Reaction / barrier (NEB, formation energy)
    --> Tier 1: MLIP NEB screen  Tier 2: DFT NEB on top candidates
  Adsorption / gas uptake
    --> Tier 1: GCMC with RASPA3 + classical FF  Tier 2: DFT-binding-energy spot checks

What is the accuracy target?
  Trend / screening      -> stop at Tier 1
  Comparison to literature -> Tier 2 with convergence test
  Quantitative experimental match -> Tier 3 with full convergence + error bars

What is the compute budget?
  No SLURM available     -> MLIP only, document the accuracy ceiling
  Single node hours      -> Tier 1 + spot-check Tier 2
  Cluster days           -> Full ladder
```

## MCP tools the agent should call

The planner is a thinking step, not a compute step, so most MCP calls in this skill are read-only lookups:

| Purpose | Tool | Note |
|---|---|---|
| Resolve material formula -> structure | `mcp__mp__get_structure` | Materials Project lookup; falls back to user-supplied CIF |
| Find related literature | `mcp__arxiv__search` | Optional; only when target property is unfamiliar |
| Recall prior similar calculations | `mcp__graphiti__search_similar` | ALWAYS call; record hit/miss in plan |
| Discover stored convergence parameters | `mcp__graphiti__search_nodes` | Filter by material class + calc_type |
| Pre-pin validator rules (do not run them yet) | `mcp__pymatgen_validation__validator_rules` | Returns the rule set the dry-run-validate skill will fire later |
| Probe configured SLURM workers (cost-of-plan estimate) | `mcp__jobflow_remote__list_workers` | Optional; confirms jobflow-remote is reachable before planning a submit |

Do NOT call solver-running tools (`mcp__atomate2__*`, `mcp__vaspilot__*`, `mcp__mlip__run`) from this skill. The plan is emitted first; execution happens after the user (or autopilot) approves it.

## Output template

The skill emits a markdown block of this exact shape (the schema is enforced by the agent-runner's Phase 0 `MatClawV2Plan` model when structured outputs are on):

```markdown
## Plan: <one-line objective>

**Material**
- Formula: <pretty formula>
- Source: <MP id | user CIF | generative model>
- Space group / dimensionality: <SG, 3D|2D|1D|0D>
- Magnetic state assumed: <NM | FM | AFM | unknown>

**Target property**
- Property: <band gap | formation energy | phonon BZ | adsorption isotherm | ...>
- Accuracy target: <screening | literature-compare | quantitative-experimental>
- Acceptance gate: <numeric threshold or "convergence verdict = pass">

**Method tiers**
| Tier | Method | Tool | Expected wall time | Stop if |
|---|---|---|---|---|
| 1 | MACE-MP relax | `mcp__mlip__run` | minutes | fmax < 0.01 eV/A |
| 2 | PBE SCF static | `mcp__atomate2__static` via VASP | hours | ConvergenceVerdict=pass |
| 3 | HSE06 or GW (conditional) | `mcp__phonon_gw__gw_screen` | days | gap stable +/- 0.1 eV |

**Validation gates** (pre-pinned, fired by -> skills/materials/dry-run-validate/SKILL.md)
- ENMAX coverage: required >= max recommended ENMAX of all POTCARs
- NELECT parity: even for non-magnetic, odd electron count flags magnetism
- ISMEAR appropriate for the gap class (-5 for insulators, 0 or 1 for metals)
- MAGMOM init nonzero for any d/f species
- Pseudopotential family consistent across species

**Memory recall**
- Graphiti hit: <yes | no>
- Reused parameters from: <calc_id or "none">
- Past pitfalls flagged: <list any retrieved warnings>

**Expected artifacts**
- CalcReport JSON (always)
- Band structure PNG (if electronic tier reached)
- Convergence curves (kpoint, encut) PNG
- vasprun.xml or QE *.out (raw outputs cached, not user-facing)
- CIF of final relaxed structure
```

### Worked example: NbOCl2 band gap to experimental accuracy

```markdown
## Plan: Determine the band gap of NbOCl2 to compare with optical experiment (~1.95 eV)

**Material**
- Formula: NbOCl2
- Source: mp-1234567 via mcp__mp__get_structure
- Space group: Cmma (#67), 2D layered
- Magnetic state assumed: NM (d^1 but reportedly nonmagnetic in bulk)

**Target property**
- Property: fundamental band gap (direct/indirect distinction)
- Accuracy target: quantitative-experimental (~0.1 eV)
- Acceptance gate: HSE06 gap within 0.1 eV of GW gap, or GW gap stable across NBANDS doubling

**Method tiers**
| Tier | Method | Tool | Expected wall time | Stop if |
|---|---|---|---|---|
| 1 | MACE-MP relax | `mcp__mlip__run` | 10 min | fmax < 0.005 eV/A |
| 2 | PBE SCF + band path | `mcp__atomate2__bands` | 4 h | ConvergenceVerdict=pass; gap reported |
| 3 | HSE06 single-shot @ PBE geometry | `mcp__atomate2__hse_bands` | 1 d | gap converged in NKRED |
| 4 | G0W0 @ PBE if HSE-PBE disagree by >0.3 eV | `mcp__phonon_gw__gw_screen` | 3 d | quasi-particle gap stable +/- 0.1 eV vs NBANDS |

**Validation gates**
- ENMAX >= 1.3 * max(POTCAR ENMAX), NBANDS >= 2 * occupied for GW
- KPOINTS >= 8x8x1 (2D, vacuum in c)
- ISMEAR = -5 (insulator), SIGMA = 0.05
- LASPH = .TRUE. for HSE/GW

**Memory recall**
- Graphiti hit: yes (one prior calc of related NbOI2 with HSE06)
- Reused parameters from: calc_id 91a3f... (ENCUT=520, KSPACING=0.20)
- Past pitfalls flagged: NbOI2 needed LMAXMIX=4 for d-electron convergence

**Expected artifacts**
- CalcReport JSON (per tier)
- PBE / HSE / GW band structure PNGs
- Convergence curves (ENCUT, NBANDS) PNG
- Final relaxed CIF
```

## Common pitfalls

- **Skipping memory recall.** Always call `mcp__graphiti__search_similar` before drafting tiers. Past calculations of related materials almost always pin reusable parameters and warn about known traps; ignoring them is the leading source of recomputation.
- **Over-relying on MLIP for electronic properties.** MACE and friends are force fields; they have no Kohn-Sham eigenvalues. Use them for geometry, never for band gaps, DOS, work functions, or charge density. If the target property is electronic, MLIP is at most a Tier-0 pre-relax.
- **Picking GW before DFT is converged.** A many-body correction on a non-converged DFT calculation is noise stacked on noise. Tier 2 must report a passing ConvergenceVerdict (k-points, ENCUT, electronic) before Tier 3 is queued.
- **Planning without an accuracy target.** "Compute the band gap" is underspecified. Force the user (or self-specify with rationale) to pick one of screening / literature-compare / quantitative-experimental. The accuracy target selects the highest tier and the acceptance gate.
- **Filling the plan with steps that have no acceptance criterion.** Every tier row needs a "stop if" condition. Without it, the executor cannot decide when to escalate or when to declare success.

## References

- DREAMS, arXiv:2507.14267 (`planNexeHighPlan.py` planner/replanner pattern). DREAMS has no LICENSE file, so the structural idea is paraphrased rather than copied; credit upstream.
- LARA-HPC, arXiv:2604.22571 — pre-flight validation gates and capability/restriction framing for multi-agent HPC plans.
- Master skill index: -> skills/materials-compute/SKILL.md
- Companion skills:
  - -> skills/materials/parameter-recall/SKILL.md (Graphiti convergence-parameter lookup)
  - -> skills/materials/dry-run-validate/SKILL.md (LARA-HPC-style INCAR sanity check before submit)
  - -> skills/materials/mlip-screen-vasp-final/SKILL.md (Tier-1 -> Tier-2 Pareto pipeline)
  - -> skills/materials/imaginary-phonon-response/SKILL.md (phonopy detection + SSCHA escalation)
