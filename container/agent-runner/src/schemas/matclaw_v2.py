"""MatClaw v2 Pydantic schemas — CANONICAL SOURCE.

This file is the single source of truth for the structured-output
contracts used by every MCP tool return + every Claude-narrated
scientific claim in matclaw v2. Downstream consumers (Phase 2 MCP
wrappers tracked in beefcake-swarm/python/matclaw_wrappers/, the
TensorZero matclaw_calc_converged feedback metric, Graphiti entity
storage) vendor a copy from this file.

KEEP IN SYNC:
  - container/agent-runner/src/schemas/matclaw_v2.ts is auto-generated
    from this file via scripts/check-schema-sync.sh (py <-> ts drift
    detection runs in CI).
  - beefcake-swarm/python/matclaw_schemas/matclaw_v2.py is a vendored
    copy — when this file changes, re-vendor by copying it over and
    re-running beefcake-swarm/python/tests/test_matclaw_schemas.py.
  - Tests live alongside this file at test_matclaw_v2.py (this repo)
    and python/tests/test_matclaw_schemas.py (beefcake-swarm,
    vendored).

Design ref: docs/v2-roadmap.md §2 (this repo).
            beefcake-swarm/docs/matclaw-v2-roadmap.md §2 (vendored copy).
Beads:      beefcake-0vm61 (P0.1); beefcake-bde2x (P0.2 TS mirror).

Principle: "The LLM narrates; deterministic validators decide."
Every scientific claim emitted by the agent must cite at least one
EvidencePointer; every ConvergenceVerdict is machine-produced (not
LLM-synthesized) by a validator MCP tool.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Type aliases — shared across schemas
# ---------------------------------------------------------------------------

CodeName = Literal[
    "vasp",
    "qe",
    "yambo",
    "berkeleygw",
    "lammps",
    "crystal",
    "phonon",
]

VerdictLevel = Literal["pass", "warn", "fail", "inconclusive"]


# ---------------------------------------------------------------------------
# §2.1 EvidencePointer
# ---------------------------------------------------------------------------


class EvidencePointer(BaseModel):
    """A pointer to a specific span of bytes in a file that justifies a claim.

    Every scientific assertion in a CalcReport must cite at least one of
    these. The snippet is bounded so that downstream consumers (Graphiti,
    TensorZero, chat UI) never receive megabyte payloads inline; if the
    underlying file is larger, the caller should slice and the SHA-256
    allows post-hoc verification against the original file.
    """

    file_path: str = Field(
        ...,
        description="Absolute path inside the container or remote (ssh) host.",
    )
    remote_host: Optional[str] = Field(
        None,
        description="If the file is on a remote host, the user@host string.",
    )
    line_start: int = Field(..., ge=1, description="1-indexed first line.")
    line_end: int = Field(..., ge=1, description="1-indexed last line (inclusive).")
    sha256: Optional[str] = Field(
        None,
        description=(
            "SHA-256 of the file when read; allows post-hoc verification "
            "that the cited bytes are stable."
        ),
    )
    snippet: str = Field(
        ...,
        max_length=2000,
        description="The actual text from line_start..line_end, max 2KB.",
    )


# ---------------------------------------------------------------------------
# §2.2 ConvergenceVerdict
# ---------------------------------------------------------------------------


class ConvergenceVerdict(BaseModel):
    """The deterministic verdict from a validator MCP tool.

    Replaces the legacy "verifier subagent" pattern by being machine-
    produced: pymatgen-io-validation, phonopy's imaginary-mode detector,
    yambo's convergence-table parser, etc. emit verdicts; the LLM may
    quote them but must not synthesize them.
    """

    code: CodeName
    verdict: VerdictLevel
    calc_id: str = Field(
        ...,
        description=(
            "A stable identifier for the calculation, e.g. "
            "'<slurm_job_id>_<structure_hash>_<calc_type>'."
        ),
    )
    evidence: list[EvidencePointer] = Field(default_factory=list)
    reasons: list[str] = Field(
        default_factory=list,
        description="Human-readable per-rule violations.",
    )
    rules_passed: list[str] = Field(
        default_factory=list,
        description="Rule IDs from pymatgen-io-validation etc.",
    )
    rules_failed: list[str] = Field(default_factory=list)
    raw_validator_output: Optional[dict] = Field(
        None,
        description="Raw dict from the underlying library (e.g. pymatgen VaspValidator).",
    )
    timestamp_iso: str = Field(
        ...,
        description="UTC ISO-8601 of when the verdict was computed.",
    )


# ---------------------------------------------------------------------------
# §2.3 MaterialEntity + CalcReport
# ---------------------------------------------------------------------------


class MaterialEntity(BaseModel):
    """Canonical identity for a material — used as a Graphiti entity key."""

    formula: str = Field(..., description="Pretty formula, e.g. 'NbOCl2'.")
    structure_hash: str = Field(
        ...,
        description=(
            "Stable hash of the canonicalized Structure (pymatgen "
            "StructureMatcher fingerprint)."
        ),
    )
    space_group: Optional[str] = Field(
        None, description="International HM symbol, e.g. 'Pmn21' (#31)."
    )
    space_group_number: Optional[int] = Field(None, ge=1, le=230)
    nsites: int = Field(..., ge=1)
    elements: list[str] = Field(..., description="Sorted list of element symbols.")
    material_class: Optional[str] = Field(
        None,
        description="Human or skill-assigned class tag, e.g. '2d-ferroelectric'.",
    )
    mp_id: Optional[str] = Field(
        None, description="Materials Project mp-XXXX identifier if known."
    )
    notes: Optional[str] = None


CalcType = Literal[
    "relax",
    "static",
    "nscf",
    "bands",
    "dos",
    "phonon",
    "gw",
    "bse",
    "md",
    "wannier",
    "elastic",
    "optics",
]

CalcStatus = Literal["queued", "running", "completed", "failed", "aborted"]


class CalcReport(BaseModel):
    """Single source of truth for a completed calculation.

    Emitted by validator MCP tools after a calc terminates; consumed by
    Graphiti (entity storage), Mem0 (session memory), TensorZero
    (matclaw_calc_converged feedback metric, tagged by material_class),
    and the chat UI.
    """

    calc_id: str = Field(
        ...,
        description="Globally unique. Format: '<job_id>_<structure_hash>_<calc_type>'.",
    )
    material: MaterialEntity
    calc_type: CalcType
    code: CodeName
    code_version: Optional[str] = Field(None, description="e.g. 'VASP 6.4.3'.")
    functional: Optional[str] = Field(
        None, description="e.g. 'PBE', 'PBEsol', 'HSE06', 'r2SCAN'."
    )
    pseudopotentials: Optional[dict[str, str]] = Field(
        None, description="element -> POTCAR/UPF identifier."
    )
    input_summary: dict = Field(
        default_factory=dict,
        description=(
            "Key INCAR / &control parameters: ENCUT, KSPACING, EDIFF, "
            "ISMEAR, etc. Kept as a free-form dict because the relevant "
            "knobs vary per code."
        ),
    )
    status: CalcStatus
    verdict: Optional[ConvergenceVerdict] = None
    energy_ev: Optional[float] = Field(
        None, description="Final total energy in eV (per cell unless noted)."
    )
    energy_per_atom_ev: Optional[float] = None
    band_gap_ev: Optional[float] = None
    direct_gap_ev: Optional[float] = None
    max_force_ev_per_ang: Optional[float] = None
    elapsed_seconds: Optional[float] = None
    wall_seconds: Optional[float] = None
    n_electronic_steps: Optional[int] = None
    n_ionic_steps: Optional[int] = None
    output_files: list[EvidencePointer] = Field(
        default_factory=list,
        description="Pointers to OUTCAR, vasprun.xml, .out, etc.",
    )
    submitted_at: datetime
    completed_at: Optional[datetime] = None
    slurm_job_id: Optional[str] = None
    slurm_partition: Optional[str] = None
    slurm_nodes: Optional[list[str]] = None
    chat_session_id: Optional[str] = None
    chat_group: Optional[str] = None
    derived_from: Optional[str] = Field(
        None,
        description="calc_id of a parent calc (e.g. an NSCF derived from an SCF).",
    )
    tags: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# §2.4 MlipPrediction
# ---------------------------------------------------------------------------


MlipModel = Literal["mace-mp-0", "chgnet", "mattersim", "mattergen", "other"]


class MlipPrediction(BaseModel):
    """A single machine-learning interatomic potential prediction.

    Used in the Pareto-tier "MLIP screen → VASP final" pattern: cheap
    MLIP predictions narrow the candidate set before expensive DFT.
    """

    material: MaterialEntity
    model: MlipModel
    model_version: Optional[str] = None
    energy_ev: float
    forces_max_ev_per_ang: float
    forces_rms_ev_per_ang: float
    uncertainty_meta: Optional[dict] = Field(
        None, description="Model-specific uncertainty quantification."
    )
    elapsed_seconds: float
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# §2.5 SchedulerJobState
# ---------------------------------------------------------------------------


SlurmState = Literal[
    "PENDING",
    "RUNNING",
    "COMPLETED",
    "CANCELLED",
    "FAILED",
    "TIMEOUT",
    "OUT_OF_MEMORY",
    "UNKNOWN",
]


class SchedulerJobState(BaseModel):
    """SLURM job snapshot returned by the schedule_task poll loop."""

    job_id: str
    state: SlurmState
    elapsed: Optional[str] = Field(None, description="HH:MM:SS.")
    estimated_remaining: Optional[str] = None
    nodes: list[str] = Field(default_factory=list)
    stdout_tail: Optional[str] = Field(None, max_length=4000)
    stderr_tail: Optional[str] = Field(None, max_length=4000)
    expected_outputs_present: dict[str, bool] = Field(
        default_factory=dict,
        description="filename -> exists (relative to the calc working dir).",
    )
