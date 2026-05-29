---
name: dry-run-validate
description: Pre-flight validation of VASP/QE input directories BEFORE SLURM submission. Catches missing POTCAR, NELECT/ENMAX mismatches, smearing-vs-gap inconsistencies, MAGMOM defects, k-mesh too coarse, and other LARA-HPC-style gates. Hard fails block submission; soft fails warn. Always run this before mcp__jobflow_remote__submit_flow.
---

# Dry-Run Validate — Pre-Flight Gates Before SLURM Submission

## What this skill does

Runs a pre-flight check on a fully-prepared VASP or QE input directory and returns a structured verdict before any compute resources are consumed. Wraps `mcp__pymatgen_validation__validate_vasp_directory` with additional LARA-HPC-style gates (POTCAR presence, NELECT vs valence count, ENMAX vs PAW maxima, ISMEAR vs estimated band gap, MAGMOM length-matches-sites, k-mesh density vs cell metrics). Hard fails block the submit. Soft fails surface as warnings with a confirm-or-fix prompt. The goal is to catch the ~80% of avoidable job failures at the controller, before they burn cluster time.

## When to use it

- **Always before SLURM submit.** Run this immediately before any `mcp__jobflow_remote__submit_flow` or any other cluster-dispatch call.
- The user says "submit", "run on cluster", "send to vasp-0x", "queue this", or anything that means "go".
- Right after `mcp__pymatgen_inputset__generate_inputs` writes a directory, before adding it to a flow.
- After hand-edits to INCAR / KPOINTS / POSCAR / POTCAR.
- When restarting a previously failed job with modified inputs.

Do not skip this gate on the assumption that a calculation "looks similar" to one that ran before — PAW pseudo swaps, geometry changes, and spin-config flips all invalidate prior validation.

## Decision tree

```
Input directory ready --> Dry-run validate

1. Read inputs
   - Read(INCAR), Read(KPOINTS), Read(POSCAR), ls(POTCAR or check potcar/)
   - For QE: Read(*.in), ls(pseudo/)

2. Call mcp__pymatgen_validation__validate_vasp_directory(directory, calc_id)
   - Parse the returned ConvergenceVerdict

3. Run LARA-HPC supplementary gates (this skill, not pymatgen-io-validation):
   - POTCAR presence: every POSCAR species has a matching POTCAR block
   - NELECT consistency: explicit NELECT (if set) matches sum-of-ZVAL
   - ENMAX sanity: INCAR ENCUT >= max(POTCAR ENMAX) * 1.3 (1.0 for static, 1.3 for relax)
   - ISMEAR vs gap: known gap > 0.5 eV --> ISMEAR in {0, -1}; metal --> ISMEAR in {1, 2, -5}
   - MAGMOM length: len(MAGMOM tokens) == number of POSCAR atoms (after expansion)
   - K-mesh density: k * a >= 25 (relax) / 30 (static / DOS) / 40 (optics)

4. Combine into a single verdict:

   verdict == "pass" AND all supplementary gates pass
     --> proceed to mcp__jobflow_remote__submit_flow

   verdict == "warn" OR any supplementary gate is soft-fail
     --> surface every reason to the user as a table
     --> ask explicit yes/no confirmation
     --> if user says "submit anyway", record the override in the calc_report

   verdict == "fail" OR any supplementary gate is hard-fail
     --> BLOCK submission; print rule names and fixes
     --> offer the relevant repair skill:
         missing POTCAR    --> skills/structure-tools/input-generation
         wrong ENCUT       --> skills/electronic-structure/convergence-testing
         ISMEAR/gap clash  --> skills/electronic-structure/scf-relax
         MAGMOM mismatch   --> skills/magnetic-properties/spin-polarized
         coarse k-mesh     --> skills/kpath-utilities/bulk-kpath
     --> NEVER auto-override a fail without an explicit user rationale
```

## MCP tools to invoke

```text
mcp__pymatgen_validation__validate_vasp_directory(
    directory: str,            # absolute path to the VASP run dir
    calc_id: str,              # CalcReport id; links to TZ feedback later
    task_type: str = "relax",  # "relax" | "static" | "static_dielectric" | "static_optical"
    functional: str = "PBE",   # "PBE" | "PBEsol" | "SCAN" | "r2SCAN" | "HSE06"
) -> ConvergenceVerdict
    # verdict: "pass" | "warn" | "fail"
    # reasons: list[{rule, severity, message, fix?}]

mcp__pymatgen_validation__validator_rules(
    task_type: str,
    functional: str,
) -> list[ValidatorRule]
    # Returns the active rule set for transparency; use when explaining a fail to the user.

mcp__pymatgen_inputset__preview_inputs(
    directory: str,
) -> InputSetPreview
    # Returns parsed INCAR dict, KPOINTS summary, POSCAR composition, POTCAR symbols + ENMAX.
    # Use this to drive the supplementary gates without reparsing files manually.
```

## Supplementary gate spec

| Gate | Severity | Trigger | Fix hint |
|---|---|---|---|
| POTCAR-missing | hard-fail | A POSCAR species has no POTCAR block | Regenerate via `mcp__pymatgen_inputset__generate_inputs` |
| NELECT-mismatch | hard-fail | `abs(NELECT - sum(ZVAL)) > 0.1` and user did not set NELECT for a charged cell | Remove NELECT, or document charge offset |
| ENCUT-too-low | hard-fail | `ENCUT < max(POTCAR.ENMAX) * 1.0` for static, `* 1.3` for relax | Raise ENCUT; rerun |
| ISMEAR-vs-gap | hard-fail | `ISMEAR == -5` and material's known gap > 0.5 eV (Materials Project lookup, if available) | Switch to ISMEAR=0 with SIGMA=0.05 |
| MAGMOM-length | hard-fail | `len(MAGMOM tokens)` does not match expanded POSCAR atom count | Regenerate MAGMOM via the spin-polarized skill |
| K-mesh-too-coarse | soft-fail | `min(k_i * a_i) < 25` for relax, `< 30` for static | Increase KPOINTS grid; rerun |
| Hybrid-without-PRECFOCK | soft-fail | `LHFCALC = .TRUE.` and `PRECFOCK` not set | Add `PRECFOCK = Fast` for screening or `Normal` for production |
| LDAU-missing-params | hard-fail | `LDAU = .TRUE.` and LDAUL/LDAUU/LDAUJ missing | Provide DFT+U params via dft-corrections/hubbard-u |
| NSW-vs-IBRION | hard-fail | `IBRION = -1` and `NSW > 0` | Pick one of: static (NSW=0) or relax (NSW>0 with IBRION>=1) |
| LREAL-large-cell | soft-fail | `LREAL = .FALSE.` and cell has > 50 atoms | Switch to `LREAL = Auto` |

A soft-fail surfaces to the user but does not block. A hard-fail blocks.

## Output template

The skill MUST emit this Markdown block before returning control. Replace placeholders, keep the table even if empty.

```markdown
### Dry-Run Verdict for {calc_id}

**Verdict:** pass | warn | fail
**Directory:** {abs_dir}
**Task type:** {task_type}    **Functional:** {functional}

| Gate | Severity | Status | Detail |
|---|---|---|---|
| validate_vasp_directory | hard-fail | pass | All pymatgen-io-validation rules satisfied |
| POTCAR-present           | hard-fail | pass | 4/4 species matched |
| NELECT-consistency       | hard-fail | pass | sum(ZVAL)=64 matches implicit NELECT |
| ENCUT-vs-ENMAX           | hard-fail | pass | ENCUT=520 >= 1.3 * max_ENMAX=400 |
| ISMEAR-vs-gap            | hard-fail | warn | Gap unknown; assuming insulator; ISMEAR=0 is safe |
| MAGMOM-length            | hard-fail | n/a  | ISPIN=1 |
| K-mesh-density           | soft-fail | pass | k * a >= 30 in all directions |

**Hard-block reasons:**
- (none) | - {rule}: {message} {fix}

**Soft-warn reasons:**
- (none) | - {rule}: {message} {fix}

**Recommended actions:**
- (proceed to submit) | (revise inputs per fix list) | (override with documented rationale)
```

## Common pitfalls

- **Skipping the gate "just this once."** The skill exists because the cost of running the gate is ~1 s and the cost of a wasted SLURM allocation is ~1 GPU-hour. The gate is mandatory; if you do skip it (e.g., the validator service is down), record `validation_skipped: true` in the CalcReport so the failure can be attributed correctly.
- **Treating warn as ignorable for hybrid functionals.** Hybrid (HSE, PBE0) runs are 10-100x slower than PBE. A k-mesh-too-coarse warning at PBE costs minutes to redo; the same warning ignored for HSE06 costs a day of cluster time. For LHFCALC=.TRUE. or METAGGA=SCAN/R2SCAN runs, treat all soft-fails as confirmation-required.
- **Overriding fail verdicts without rationale.** A documented `--override` flag is supported, but it MUST carry a one-sentence rationale string that lands in the CalcReport. Examples of legitimate overrides: deliberately charged supercell (NELECT-mismatch), benchmark study of basis convergence (ENCUT-too-low), known-metal alloy with gap = 0 (ISMEAR-vs-gap). Examples of illegitimate overrides: "the user is impatient", "this worked before".
- **Validating before inputs are complete.** Running the gate before POTCAR has been concatenated or before MAGMOM has been written produces meaningless failures. Always confirm the directory has at minimum INCAR + KPOINTS + POSCAR + POTCAR (VASP) or *.in + pseudo/ (QE) before invoking the validator.
- **Trusting a stale ConvergenceVerdict.** Verdicts are calc_id-scoped. Re-validate any time the input directory changes, even for one-character edits.

## See also

- `skills/materials/research-plan/SKILL.md` — calls this skill as the final gate before flow submission.
- `skills/electronic-structure/convergence-testing/SKILL.md` — fixes for ENCUT/k-mesh failures.
- `skills/electronic-structure/scf-relax/SKILL.md` — fixes for ISMEAR / NSW / IBRION inconsistencies.
- `skills/magnetic-properties/spin-polarized/SKILL.md` — fixes for MAGMOM length mismatches.
- `skills/dft-corrections/hubbard-u/SKILL.md` — fixes for missing LDAU parameters.

## References

- LARA-HPC: arXiv:2604.22571 and gitlab.com/l_sim/lara-hpc — the pattern source for the supplementary gate set. LARA enforces a pre-submit pass over `INCAR` keys, k-mesh, and pseudopotential consistency on the controller side, returning a structured verdict that the agent must satisfy before any sbatch call. This skill paraphrases the same approach for the MatClaw v2 controller (read-only reference; no LARA code is copied).
- pymatgen-io-validation: github.com/materialsproject/pymatgen-io-validation — the upstream rule library wrapped by `mcp__pymatgen_validation__*`. Source of truth for the rule semantics; this skill adds gates on top, never replaces them.
