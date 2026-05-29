---
name: parameter-recall
description: Recall converged INCAR/k-point/PSEUDO parameters from past CalcReports for the same material class + calc type via mcp__graphiti__search_similar. Returns recommended overrides for mcp__pymatgen_inputset__generate_inputs and surfaces conflicts when past calcs disagreed. Use during planning before generating fresh inputs.
---

# Parameter Recall (Graphiti-backed planning helper)

## What this skill does

During the **planning phase** of a materials calculation, this skill
queries Graphiti's bi-temporal entity graph for past
`CalcReport`s (see `container/agent-runner/src/schemas/matclaw_v2.py`)
whose `material.material_class`, `calc_type`, and `code` match the
calculation you are about to plan. It then aggregates the
`input_summary` keys from those past reports (`ENCUT`, `KSPACING`,
`EDIFF`, `ISMEAR`, k-point density, smearing width, pseudopotential
choice, etc.), votes per key, and emits a **recommendation block**
that the agent can hand to `mcp__pymatgen_inputset__generate_inputs`
as overrides. When past calcs disagree the conflict is surfaced
explicitly — the agent (and ultimately the user) decides; this skill
does not silently pick.

The skill never executes a calculation, never writes input files, and
never blocks. On zero recall it returns empty-handed and the agent
should fall through to the pymatgen-inputset defaults
(`MPRelaxSet`, `MatPESStaticSet`, etc.).

→ called from `skills/materials/research-plan/SKILL.md`
→ output feeds `skills/materials/dry-run-validate/SKILL.md`

## When to use it

- During the planning phase of any new DFT calculation that has a
  prior art on this cluster (Graphiti is non-empty for the class).
- When the user asks "what worked last time for X?" or "use the same
  parameters as the last NbOCl2 relax."
- When `material.material_class` is well-defined and discriminative
  — `2d-ferroelectric`, `oxide-perovskite`, `vdw-heterobilayer`,
  `metallic-alloy-fcc`, etc. Vague classes (`unknown`, `oxide`) give
  too-broad recall and degrade the recommendation.
- Before running `mcp__pymatgen_inputset__generate_inputs` so the
  overrides can be threaded in on first call (avoids a second pass).

**Do not use** when:

- The user is doing a **parameter convergence study** itself — they
  explicitly want fresh inputs, not recalled ones. Defer to
  `skills/electronic-structure/convergence-testing/SKILL.md`.
- The calc is the first of its `material_class` (Graphiti will return
  zero; just skip).
- The user pinned exact parameters in the prompt. Recall is advisory;
  user pins win.

## Decision tree

```
1. Extract from the active research-plan output + user prompt:
     material_class  ← from MaterialEntity.material_class
     calc_type       ← Literal["relax", "static", "bands", ...]
     code            ← Literal["vasp", "qe", "yambo", ...]
     functional      ← "PBE" / "PBEsol" / "HSE06" / "r2SCAN" / ...

2. If material_class is None or "unknown":
     → emit "skipped: material_class not assigned" and return.
     → research-plan should fill material_class before recall.

3. Call mcp__graphiti__search_similar with k=5:
     {
       "entity_type": "CalcReport",
       "filters": {
         "material.material_class": <material_class>,
         "calc_type": <calc_type>,
         "code": <code>,
       },
       "k": 5,
     }

4. Branch on the result count:

   Zero hits:
     → emit a "## Recall Summary" block stating "no prior calcs;
       defer to pymatgen defaults" and return.

   One hit:
     → take the single CalcReport. Its input_summary is the
       recommendation as-is. Surface code_version and
       completed_at — if completed_at is >6 months old, raise a
       "stale recall" warn (see Pitfalls §3).

   Two or more hits:
     → for each key K in the union of input_summary keys across
       hits, count occurrences of each value.
     → if a single value has strict majority (>50%), it's the
       recommendation for K.
     → otherwise K is a conflict — keep the per-hit values
       and surface them in a "## Conflict Block."

5. Optionally call mcp__graphiti__get_entity for any single
   calc_id to fetch the full CalcReport (for evidence pointers
   the agent can quote, e.g. the exact OUTCAR line that justified
   ENCUT = 600).

6. Emit the structured output below; do not generate inputs in
   this skill. The agent threads the Recommendation Block into
   mcp__pymatgen_inputset__generate_inputs as the overrides
   argument on the next step.
```

## MCP tools used

| Tool | When | Returns |
|---|---|---|
| `mcp__graphiti__search_similar` | every invocation | list of CalcReport summaries (calc_id, material, input_summary, verdict, code_version, completed_at) |
| `mcp__graphiti__get_entity` | optional, when an evidence pointer would help the user trust a recalled value | full CalcReport per calc_id (including `output_files: list[EvidencePointer]`) |

The skill **does not call** `mcp__pymatgen_inputset__generate_inputs`
itself — that's the next planning step. The recommendation block is
designed to be machine-readable so the agent can transcribe the keys
into the inputset call's `user_incar_settings` (VASP) or
`control_dict` (QE) argument.

## Output template

The skill always emits one Markdown block, structured so the agent
can parse it deterministically. Three subsections; the Conflict
Block is omitted when there are no conflicts.

```markdown
## Recommendation Block

material_class: <class>
calc_type: <type>
code: <code>
recall_count: <N>

| Parameter | Recommended value | Vote | Source calc_ids |
|---|---|---|---|
| ENCUT      | 600 (eV)        | 3/3 | <id1>, <id2>, <id3> |
| KSPACING   | 0.25 (1/Å)      | 2/3 | <id1>, <id2>        |
| EDIFF      | 1e-6            | 3/3 | <id1>, <id2>, <id3> |
| ISMEAR     | 0               | 3/3 | <id1>, <id2>, <id3> |

functional: PBE          (3/3)
pseudopotentials: SSSP-efficiency 1.3.0  (3/3)

## Conflict Block

| Parameter | Per-calc values                  | Recommendation |
|---|---|---|
| SIGMA     | 0.05 (×2), 0.1 (×1)              | needs decision |
| LDAU_U Nb | 1.5 eV (×1), 2.0 eV (×1)         | needs decision |

Resolve conflicts by:
1. Preferring the calc with the most recent code_version.
2. Preferring "pass" verdicts over "warn" / "fail".
3. Surfacing the disagreement to the user if step 1 & 2 don't break
   the tie.

## Recall Summary

| calc_id     | code_version | completed_at | verdict | functional |
|---|---|---|---|---|
| <id1>       | VASP 6.4.3   | 2026-04-12   | pass    | PBE        |
| <id2>       | VASP 6.4.3   | 2026-03-29   | pass    | PBE        |
| <id3>       | VASP 6.4.1   | 2025-11-08   | warn    | PBE        |
```

If recall returns zero hits, emit only the Recall Summary block
with the line `recall: empty (no prior CalcReports for
<material_class>/<calc_type>/<code>); pymatgen defaults will be used`.

## Common pitfalls

1. **Cross-class contamination.** Recalling 2D parameters for a
   bulk calc (or vice versa) is a frequent regression — 2D needs
   large `c`-axis vacuum + `ISMEAR=0`; bulk often runs
   `ISMEAR=-5` (tetrahedron) at higher k-density. Always require
   exact `material_class` match. Do **not** fall back to a coarser
   class (e.g. `2d-anything` ← `2d-ferroelectric`); accept the zero
   recall and let the agent use pymatgen defaults.

2. **Functional mismatch.** A hybrid (HSE06, r2SCAN) run cannot
   reuse a PBE run's `ENCUT` blindly — hybrids generally need a
   higher cutoff and tighter `EDIFF`. If the recalled calc's
   `functional` differs from the planned `functional`, surface
   that in the Conflict Block even when other keys agree, and
   mark `ENCUT` and `EDIFF` as "needs decision."

3. **Stale recalls.** A CalcReport whose `completed_at` is more
   than 6 months old, or whose `code_version` differs from the
   current cluster build, should be flagged. VASP/QE pseudopotential
   sets get re-released; what passed in October may produce a
   different total energy today. The Recall Summary table makes
   `code_version` + `completed_at` first-class so the user can spot
   this without opening Graphiti.

4. **Trusting recalled parameters blindly.** Per arXiv:2506.13538
   (MCP security empirical study), recalled values are
   untrusted inputs. The agent **must** still run
   `mcp__pymatgen_validation__validate_vasp_directory` on the
   resulting calc and emit a `ConvergenceVerdict`. Recall is a
   warm start, not a substitute for the deterministic validator.

5. **k=5 is a heuristic.** If your `material_class` is broad
   (e.g. `oxide-perovskite` across hundreds of compositions) raise
   `k` to 10 or 20 to get a stable majority vote. If the class is
   narrow (`NbOCl2-monolayer`) k=3 is plenty. Don't go below k=3 —
   you cannot detect a conflict with two hits.

6. **`input_summary` is a free-form dict.** The
   `CalcReport.input_summary` schema is deliberately untyped (see
   matclaw_v2.py §2.3). Different past calcs may use different key
   names — `ENCUT` vs `encut`, `KSPACING` vs `kspacing`. Normalize
   keys to uppercase for VASP and lowercase-snake for QE before
   voting.

## References

- `container/agent-runner/src/schemas/matclaw_v2.py` — `CalcReport`,
  `MaterialEntity`, `ConvergenceVerdict`, `EvidencePointer`.
- `docs/v2-roadmap.md` §3.2 — Graphiti MCP registration in `claude.ts`
  (HTTP-SSE at `http://ai-proxy:8000/sse`).
- `docs/v2-roadmap.md` §4 Phase 3 — this skill is item #3 in the new
  `materials/` family.
- arXiv:2506.13538 — MCP security empirical study (untrusted MCP
  return values; rationale for Pitfall #4).
- `skills/materials/research-plan/SKILL.md` — upstream caller;
  fills `material_class` before invoking recall.
- `skills/materials/dry-run-validate/SKILL.md` — downstream gate;
  receives the merged inputset+overrides and validates before
  SLURM submit.
