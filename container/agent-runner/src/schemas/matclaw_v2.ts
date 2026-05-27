/* tslint:disable */
/* eslint-disable */
/**
/* This file was automatically generated from pydantic models by running pydantic2ts.
/* Do not modify it by hand - just update the pydantic models and then re-run the script
*/

/**
 * Single source of truth for a completed calculation.
 *
 * Emitted by validator MCP tools after a calc terminates; consumed by
 * Graphiti (entity storage), Mem0 (session memory), TensorZero
 * (matclaw_calc_converged feedback metric, tagged by material_class),
 * and the chat UI.
 */
export interface CalcReport {
  /**
   * Globally unique. Format: '<job_id>_<structure_hash>_<calc_type>'.
   */
  calc_id: string;
  material: MaterialEntity;
  calc_type:
    | "relax"
    | "static"
    | "nscf"
    | "bands"
    | "dos"
    | "phonon"
    | "gw"
    | "bse"
    | "md"
    | "wannier"
    | "elastic"
    | "optics";
  code: "vasp" | "qe" | "yambo" | "berkeleygw" | "lammps" | "crystal" | "phonon";
  /**
   * e.g. 'VASP 6.4.3'.
   */
  code_version?: string | null;
  /**
   * e.g. 'PBE', 'PBEsol', 'HSE06', 'r2SCAN'.
   */
  functional?: string | null;
  /**
   * element -> POTCAR/UPF identifier.
   */
  pseudopotentials?: {
    [k: string]: string;
  } | null;
  /**
   * Key INCAR / &control parameters: ENCUT, KSPACING, EDIFF, ISMEAR, etc. Kept as a free-form dict because the relevant knobs vary per code.
   */
  input_summary?: {
    [k: string]: unknown;
  };
  status: "queued" | "running" | "completed" | "failed" | "aborted";
  verdict?: ConvergenceVerdict | null;
  /**
   * Final total energy in eV (per cell unless noted).
   */
  energy_ev?: number | null;
  energy_per_atom_ev?: number | null;
  band_gap_ev?: number | null;
  direct_gap_ev?: number | null;
  max_force_ev_per_ang?: number | null;
  elapsed_seconds?: number | null;
  wall_seconds?: number | null;
  n_electronic_steps?: number | null;
  n_ionic_steps?: number | null;
  /**
   * Pointers to OUTCAR, vasprun.xml, .out, etc.
   */
  output_files?: EvidencePointer[];
  submitted_at: string;
  completed_at?: string | null;
  slurm_job_id?: string | null;
  slurm_partition?: string | null;
  slurm_nodes?: string[] | null;
  chat_session_id?: string | null;
  chat_group?: string | null;
  /**
   * calc_id of a parent calc (e.g. an NSCF derived from an SCF).
   */
  derived_from?: string | null;
  tags?: string[];
}
/**
 * Canonical identity for a material — used as a Graphiti entity key.
 */
export interface MaterialEntity {
  /**
   * Pretty formula, e.g. 'NbOCl2'.
   */
  formula: string;
  /**
   * Stable hash of the canonicalized Structure (pymatgen StructureMatcher fingerprint).
   */
  structure_hash: string;
  /**
   * International HM symbol, e.g. 'Pmn21' (#31).
   */
  space_group?: string | null;
  space_group_number?: number | null;
  nsites: number;
  /**
   * Sorted list of element symbols.
   */
  elements: string[];
  /**
   * Human or skill-assigned class tag, e.g. '2d-ferroelectric'.
   */
  material_class?: string | null;
  /**
   * Materials Project mp-XXXX identifier if known.
   */
  mp_id?: string | null;
  notes?: string | null;
}
/**
 * The deterministic verdict from a validator MCP tool.
 *
 * Replaces the legacy "verifier subagent" pattern by being machine-
 * produced: pymatgen-io-validation, phonopy's imaginary-mode detector,
 * yambo's convergence-table parser, etc. emit verdicts; the LLM may
 * quote them but must not synthesize them.
 */
export interface ConvergenceVerdict {
  code: "vasp" | "qe" | "yambo" | "berkeleygw" | "lammps" | "crystal" | "phonon";
  verdict: "pass" | "warn" | "fail" | "inconclusive";
  /**
   * A stable identifier for the calculation, e.g. '<slurm_job_id>_<structure_hash>_<calc_type>'.
   */
  calc_id: string;
  evidence?: EvidencePointer[];
  /**
   * Human-readable per-rule violations.
   */
  reasons?: string[];
  /**
   * Rule IDs from pymatgen-io-validation etc.
   */
  rules_passed?: string[];
  rules_failed?: string[];
  /**
   * Raw dict from the underlying library (e.g. pymatgen VaspValidator).
   */
  raw_validator_output?: {
    [k: string]: unknown;
  } | null;
  /**
   * UTC ISO-8601 of when the verdict was computed.
   */
  timestamp_iso: string;
}
/**
 * A pointer to a specific span of bytes in a file that justifies a claim.
 *
 * Every scientific assertion in a CalcReport must cite at least one of
 * these. The snippet is bounded so that downstream consumers (Graphiti,
 * TensorZero, chat UI) never receive megabyte payloads inline; if the
 * underlying file is larger, the caller should slice and the SHA-256
 * allows post-hoc verification against the original file.
 */
export interface EvidencePointer {
  /**
   * Absolute path inside the container or remote (ssh) host.
   */
  file_path: string;
  /**
   * If the file is on a remote host, the user@host string.
   */
  remote_host?: string | null;
  /**
   * 1-indexed first line.
   */
  line_start: number;
  /**
   * 1-indexed last line (inclusive).
   */
  line_end: number;
  /**
   * SHA-256 of the file when read; allows post-hoc verification that the cited bytes are stable.
   */
  sha256?: string | null;
  /**
   * The actual text from line_start..line_end, max 2KB.
   */
  snippet: string;
}
/**
 * A single machine-learning interatomic potential prediction.
 *
 * Used in the Pareto-tier "MLIP screen → VASP final" pattern: cheap
 * MLIP predictions narrow the candidate set before expensive DFT.
 */
export interface MlipPrediction {
  material: MaterialEntity;
  model: "mace-mp-0" | "chgnet" | "mattersim" | "mattergen" | "other";
  model_version?: string | null;
  energy_ev: number;
  forces_max_ev_per_ang: number;
  forces_rms_ev_per_ang: number;
  /**
   * Model-specific uncertainty quantification.
   */
  uncertainty_meta?: {
    [k: string]: unknown;
  } | null;
  elapsed_seconds: number;
  notes?: string | null;
}
/**
 * SLURM job snapshot returned by the schedule_task poll loop.
 */
export interface SchedulerJobState {
  job_id: string;
  state: "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED" | "TIMEOUT" | "OUT_OF_MEMORY" | "UNKNOWN";
  /**
   * HH:MM:SS.
   */
  elapsed?: string | null;
  estimated_remaining?: string | null;
  nodes?: string[];
  stdout_tail?: string | null;
  stderr_tail?: string | null;
  /**
   * filename -> exists (relative to the calc working dir).
   */
  expected_outputs_present?: {
    [k: string]: boolean;
  };
}
