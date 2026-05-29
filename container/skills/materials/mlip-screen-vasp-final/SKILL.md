---
name: mlip-screen-vasp-final
description: Pareto-tier compute strategy — screen N candidate structures via mcp__mlip__screen_structures (MACE/CHGNet/MatterSim), then submit VASP DFT via mcp__atomate2__build_flow + mcp__jobflow_remote__submit_flow only on the top-K survivors. Use whenever user has >5 candidates and only wants final results on the best few.
---

# MLIP Screen → VASP Final (Pareto-tier compute)

## What this skill does

Two-tier compute strategy for materials screening campaigns. Run a cheap
universal MLIP (MACE-MP-0, CHGNet, or MatterSim) on the **full candidate set**
to get energies and forces in seconds-per-structure, rank the candidates, then
spend expensive VASP DFT on only the top-K survivors. The pattern saves 10-100×
of total VASP wall time versus running DFT on every candidate, while the
top-K selection is robust enough that the eventual DFT-ranked winner is almost
always inside the MLIP top-K. The pattern was validated at scale by TritonDFT
(arXiv:2603.03372) and is now standard practice for composition-space sweeps.

This skill wraps three MCP tools — `mcp__mlip__screen_structures` for the
screen tier, `mcp__atomate2__build_flow` for assembling the DFT chain, and
`mcp__jobflow_remote__submit_flow` for SLURM dispatch — into a single workflow
with explicit selection heuristics, an interleaved validation gate, and
MLIP energy-noise-floor caveats baked in.

## When to use it

- User provides more than 5 candidate structures and only wants final
  publication-quality results on the best handful.
- User explicitly asks to "screen", "rank", "filter", or "narrow down" a
  candidate set before DFT.
- Batch evaluation across a composition space (e.g., "all rocksalt
  M-X binaries with M in {Li, Na, K, Mg, Ca}").
- Pareto-front problems where two or more properties trade off and the
  agent needs a coarse ranking before paying for DFT.
- Materials Project pull-downs where the user wants to filter the
  query result before committing compute.

Do **not** use this skill when:

- Candidate count is ≤5 — the MLIP tier is overhead; go straight to DFT.
- User wants electronic-structure properties (band gap, DOS, dielectric
  tensor). MLIPs cannot predict these — see *Common pitfalls*.
- User wants final-quality numbers, not a ranking. Even when MLIPs agree
  with DFT in ordering, absolute energies and forces are noisy at the
  10-50 meV/atom level.

## Decision tree

```
Count the candidates (N).

N ≤ 5
  --> Skip screen tier entirely. Build a DFT Flow per candidate directly:
      mcp__atomate2__build_flow(maker="MPRelaxMaker", structures=[...])
      mcp__jobflow_remote__submit_flow(...)
  --> Stop. Do not invoke this skill's screen step.

5 < N ≤ 50
  --> Screen with MACE-MP-0 small (fastest universal MLIP, ~0.5 s/structure).
  --> top_k = max(3, N // 5)        # e.g. N=20 → top_k=4
  --> Validation gate → skills/materials/dry-run-validate/SKILL.md
      on every survivor before submit.

N > 50
  --> Screen with CHGNet (~5× faster than MACE-MP-0 on CPU,
      comparable accuracy for energy ordering).
  --> top_k = max(5, N // 10)       # e.g. N=120 → top_k=12
  --> If GPU is available and N > 200, prefer
      → skills/mlip-guide/torchsim-batch/SKILL.md for the screen tier;
      batch-MD on GPU is 10-100× faster than per-structure ASE+MLIP.
  --> Validation gate → skills/materials/dry-run-validate/SKILL.md
      on every survivor before submit.

For all survivors (the top-K from any branch):
  --> Build atomate2 Flow:
      - Default: MPRelaxMaker (single relax) for ranking-level results.
      - Pareto-final: MPGGADoubleRelaxMaker (relax → relax) when
        the survivors will be cited.
      - With electronic followup: chain MPRelaxMaker → MPStaticSet for
        accurate energy + DOS proxy.
  --> Submit via mcp__jobflow_remote__submit_flow with worker assignment
      hint (default worker pool; one job per survivor).
  --> Poll via the schedule_task scheduler; collect CalcReports.

Ranking criterion for the screen tier:
  --> Default: energy_per_atom_ev (stability proxy).
  --> Force-based: forces_max_ev_per_ang as a secondary sort key —
      structures with max force > 0.5 eV/Å after MLIP relax are
      suspect (the MLIP gave up or the structure is far from a basin).
  --> Band gap: DO NOT use the MLIP for band-gap ranking.
      If the user asked for band-gap ranking, refuse the MLIP screen
      and either (a) run a MatPESStaticSet on all candidates instead
      or (b) point them at → skills/high-throughput/batch-screening/SKILL.md
      for the MP-tagged band-gap shortcut.
```

## MCP tools

### `mcp__mlip__screen_structures`

Runs the chosen MLIP on a list of structures, returns one `MlipPrediction`
per structure (per the Phase 0 schema in
`container/agent-runner/src/schemas/matclaw_v2.py`).

```python
result = await mcp__mlip__screen_structures(
    structures=[s1, s2, ..., sN],   # list of pymatgen Structure dicts
    model="mace-mp-0",               # or "chgnet", "mattersim"
    model_size="small",              # only honored by mace-mp-0
    relax=True,                       # relax before reporting energy
    fmax=0.05,                        # eV/Å convergence
)
# result -> {predictions: [MlipPrediction, ...], elapsed_seconds: float}
```

### `mcp__mlip__list_models`

Lists available MLIP models, sizes, and recommended use cases.
Call this once at the start of a session to confirm what's installed
in the per-group container — model availability differs between
ai-proxy and the SLURM worker nodes.

### `mcp__atomate2__build_flow`

Assembles a jobflow `Flow` from one of atomate2's makers, returning a
serialized flow ready for submission.

```python
flow = await mcp__atomate2__build_flow(
    maker="MPRelaxMaker",            # or "MPGGADoubleRelaxMaker", "MPStaticSet"
    structure=top_k_survivor,        # one survivor; call once per survivor
    user_incar_settings={"NCORE": 4, "ENCUT": 520},
    user_kpoints_settings={"reciprocal_density": 64},
)
```

### `mcp__jobflow_remote__submit_flow`

Submits the Flow to the SLURM queue via jobflow-remote, returns the
submission ID for polling.

```python
submit = await mcp__jobflow_remote__submit_flow(
    flow=flow,
    worker="default",                # SLURM partition: gpu_ai for swarm-friendly
    resources={"nodes": 1, "time": "08:00:00"},
)
# submit -> {job_id: str, calc_id: str, slurm_partition: str}
```

The returned `calc_id` is the stable identifier downstream tools (TensorZero
feedback, Graphiti entity store) will join on; surface it in the chat reply.

## Output template

After the screen tier completes and the final-tier jobs are submitted,
print a single Markdown block in the chat:

```markdown
## Screening Tier Summary
- candidates: N = 32
- model: mace-mp-0 (small)
- elapsed: 18.4 s (~0.6 s/structure)
- pre-filter (max force > 0.5 eV/Å): dropped 3 candidates

## Ranked Candidates (top_k = 6)
| rank | formula     | E/atom (eV) | F_max (eV/Å) | F_rms (eV/Å) | space group | submitted |
|------|-------------|-------------|--------------|--------------|-------------|-----------|
| 1    | LiCoO2      | -7.412      | 0.031        | 0.011        | R-3m        | yes       |
| 2    | LiNiO2      | -7.298      | 0.044        | 0.014        | R-3m        | yes       |
| 3    | LiMnO2      | -7.190      | 0.038        | 0.013        | Pmmn        | yes       |
| 4    | LiFeO2      | -7.142      | 0.046        | 0.016        | I41/amd     | yes       |
| 5    | LiVO2       | -7.083      | 0.051        | 0.018        | R-3m        | yes       |
| 6    | LiTiO2      | -7.011      | 0.049        | 0.017        | I41/amd     | yes       |

## Final DFT Submissions
| calc_id                  | maker             | slurm job_id | worker  | partition |
|--------------------------|-------------------|--------------|---------|-----------|
| sub_LiCoO2_relax_a3f...  | MPRelaxMaker      | 1924         | default | gpu_ai    |
| sub_LiNiO2_relax_b1e...  | MPRelaxMaker      | 1925         | default | gpu_ai    |
| ...                                                                             |

Poll with `schedule_task` every ~10 min; collect CalcReports on completion.
```

Persist the same table as JSON next to the screen tier outputs (one file
per campaign) so the agent — and the Graphiti store — can replay the
ranking later.

## Common pitfalls

- **Using the MLIP for electronic properties.** MLIPs predict
  energy/forces/stress only. Band gaps, DOS, charge densities, dielectric
  tensors are *not* in scope. If the user asks the MLIP to rank by band
  gap, refuse — either fall back to MP-tagged values or run actual DFT.
  → `skills/mlip-guide/universal-mlip/SKILL.md` documents the exclusion
  in detail.
- **Trusting MLIP energy differences below ~50 meV/atom.** The Materials
  Project training error for MACE-MP-0 is roughly ±20-30 meV/atom on
  energies and ±50 meV/atom on relative formation energies. Below that,
  the ranking is dominated by model noise; do not present a single
  "winner" when the top-2 are within 50 meV/atom — submit both to DFT.
- **Screening on a property different from the one you'll measure with
  DFT.** Ranking on MLIP energies and then deciding the winner with
  DFT elastic moduli is a Pareto-violation in disguise — the MLIP-top-K
  may have already filtered out the elastic winner. Either (a) screen
  on the actual target property if the MLIP supports it (energies only),
  or (b) widen top_k by 2-3× when the final measure differs.
- **Picking top_k too small.** Good universal MLIPs typically mis-rank
  by ±2 positions in the top 10. A top_k of 3 from a 30-candidate pool
  is too aggressive; use `max(3, N // 5)` as the floor. Tightening
  later is cheap; reopening the screen later is expensive.
- **Skipping the validation gate.** The MLIP-relaxed POSCAR is *not*
  guaranteed to be a sensible INCAR-compatible input. Always run
  → `skills/materials/dry-run-validate/SKILL.md` on every survivor
  before `submit_flow`. NELECT, ENMAX, MAGMOM, and ISMEAR are the
  usual failure modes; the dry-run catches them in milliseconds.
- **Not pinning the MLIP model version.** Universal MLIPs ship new
  checkpoints often. Record `model_version` from `MlipPrediction` in
  the output JSON so re-runs are reproducible and Graphiti recall
  can disambiguate runs.

## References

- TritonDFT — Pareto-tier validation at scale: arXiv:2603.03372
  (the canonical evidence that MLIP top-K reliably contains the
  DFT-ranked winner for composition sweeps).
- MACE-MP-0: github.com/ACEsuit/mace (universal MLIP, MP-trained).
- CHGNet: github.com/CederGroupHub/chgnet (charge-informed MLIP).
- MatterSim: github.com/microsoft/mattersim (broader chemistry,
  newer training set).
- atomate2: github.com/materialsproject/atomate2
  (`MPRelaxMaker`, `MPGGADoubleRelaxMaker`, `MPStaticSet`).
- jobflow-remote: github.com/Matgenix/jobflow-remote
  (SLURM dispatch layer).
- → `skills/materials/research-plan/SKILL.md` — call before screening
  to record the campaign's hypothesis and stop criterion.
- → `skills/materials/dry-run-validate/SKILL.md` — call between
  the screen tier and `submit_flow` to catch INCAR-level failures.
- → `skills/mlip-guide/universal-mlip/SKILL.md` — when the user
  asks "what does MACE actually know how to predict?"
- → `skills/mlip-guide/torchsim-batch/SKILL.md` — for the screen
  tier when N > 200 and GPU is available.
- → `skills/high-throughput/screening-workflow/SKILL.md` — the legacy
  monolithic alternative; this skill replaces its top-half (MP query
  + MACE screen) with MCP-tool calls while reusing the same heuristics.
