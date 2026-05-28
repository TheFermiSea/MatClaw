"""Roundtrip tests for matclaw_v2.py (canonical schemas).

Verifies the Phase 0 schemas (beefcake-0vm61):
  - Each schema can be instantiated with valid data.
  - JSON serialisation roundtrips losslessly.
  - Pydantic constraints (ge=1, max_length=2000, Literal narrowing) fire.
  - Nested composition (CalcReport contains MaterialEntity +
    ConvergenceVerdict + list[EvidencePointer]) works end-to-end.

Run locally (matclaw repo has no pytest infrastructure yet — these
tests are co-located with the canonical schemas so they ship together,
but the production CI invocation runs in beefcake-swarm against the
vendored copy):

    cd container/agent-runner/src/schemas
    python -m pytest test_matclaw_v2.py -v

Design ref: docs/v2-roadmap.md §2 (this repo).
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

# Sibling import — matclaw_v2.py lives in the same directory as this file.
from matclaw_v2 import (
    CalcReport,
    ConvergenceVerdict,
    EvidencePointer,
    MaterialEntity,
    MlipPrediction,
    SchedulerJobState,
)


# ---------------------------------------------------------------------------
# Fixtures — canonical instances used across tests
# ---------------------------------------------------------------------------


@pytest.fixture
def nbocl2_material() -> MaterialEntity:
    return MaterialEntity(
        formula="NbOCl2",
        structure_hash="sha256:f1b2c3d4",
        space_group="Pmn21",
        space_group_number=31,
        nsites=8,
        elements=["Cl", "Nb", "O"],
        material_class="2d-ferroelectric",
        mp_id="mp-12345",
    )


@pytest.fixture
def outcar_pointer() -> EvidencePointer:
    return EvidencePointer(
        file_path="/workspace/calcs/nbocl2_relax/OUTCAR",
        line_start=15123,
        line_end=15145,
        sha256="abcd" * 16,
        snippet=(
            "  reached required accuracy - stopping structural energy "
            "minimisation\n  --------------\n  TOTAL-FORCE (eV/Angst)"
        ),
    )


@pytest.fixture
def passing_verdict(outcar_pointer) -> ConvergenceVerdict:
    return ConvergenceVerdict(
        code="vasp",
        verdict="pass",
        calc_id="job-9123_sha256-f1b2c3d4_relax",
        evidence=[outcar_pointer],
        reasons=[],
        rules_passed=["ENCUT_geq_basis_max", "EDIFF_lt_1e-6", "forces_converged"],
        rules_failed=[],
        raw_validator_output={"valid": True, "n_warnings": 0},
        timestamp_iso="2026-05-27T18:42:11Z",
    )


# ---------------------------------------------------------------------------
# §2.1 EvidencePointer
# ---------------------------------------------------------------------------


class TestEvidencePointer:
    def test_construct_with_required_fields(self):
        ep = EvidencePointer(
            file_path="/tmp/foo.log",
            line_start=1,
            line_end=10,
            snippet="hello",
        )
        assert ep.file_path == "/tmp/foo.log"
        assert ep.remote_host is None
        assert ep.sha256 is None

    def test_roundtrip(self, outcar_pointer):
        as_json = outcar_pointer.model_dump_json()
        restored = EvidencePointer.model_validate_json(as_json)
        assert restored == outcar_pointer

    def test_line_start_must_be_positive(self):
        with pytest.raises(ValidationError, match="line_start"):
            EvidencePointer(
                file_path="/tmp/x", line_start=0, line_end=1, snippet="x"
            )

    def test_snippet_length_capped(self):
        # exactly 2000 OK
        EvidencePointer(
            file_path="/tmp/x", line_start=1, line_end=1, snippet="a" * 2000
        )
        # 2001 rejected
        with pytest.raises(ValidationError, match="snippet"):
            EvidencePointer(
                file_path="/tmp/x", line_start=1, line_end=1, snippet="a" * 2001
            )

    def test_missing_required_field(self):
        with pytest.raises(ValidationError):
            EvidencePointer(file_path="/tmp/x", line_start=1, line_end=1)  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# §2.2 ConvergenceVerdict
# ---------------------------------------------------------------------------


class TestConvergenceVerdict:
    def test_roundtrip_with_evidence(self, passing_verdict):
        as_json = passing_verdict.model_dump_json()
        restored = ConvergenceVerdict.model_validate_json(as_json)
        assert restored == passing_verdict
        assert len(restored.evidence) == 1
        assert restored.evidence[0].file_path.endswith("OUTCAR")

    def test_invalid_code_rejected(self):
        with pytest.raises(ValidationError, match="code"):
            ConvergenceVerdict(
                code="not-a-real-code",  # type: ignore[arg-type]
                verdict="pass",
                calc_id="x",
                timestamp_iso="2026-05-27T00:00:00Z",
            )

    def test_invalid_verdict_rejected(self):
        with pytest.raises(ValidationError, match="verdict"):
            ConvergenceVerdict(
                code="vasp",
                verdict="maybe",  # type: ignore[arg-type]
                calc_id="x",
                timestamp_iso="2026-05-27T00:00:00Z",
            )

    def test_defaults_for_optional_lists(self):
        v = ConvergenceVerdict(
            code="qe",
            verdict="inconclusive",
            calc_id="x",
            timestamp_iso="2026-05-27T00:00:00Z",
        )
        assert v.evidence == []
        assert v.reasons == []
        assert v.rules_passed == []
        assert v.rules_failed == []
        assert v.raw_validator_output is None


# ---------------------------------------------------------------------------
# §2.3 MaterialEntity + CalcReport
# ---------------------------------------------------------------------------


class TestMaterialEntity:
    def test_roundtrip(self, nbocl2_material):
        as_json = nbocl2_material.model_dump_json()
        restored = MaterialEntity.model_validate_json(as_json)
        assert restored == nbocl2_material

    def test_space_group_number_range(self):
        # 1 and 230 inclusive
        MaterialEntity(
            formula="X", structure_hash="h", nsites=1, elements=["X"],
            space_group_number=1,
        )
        MaterialEntity(
            formula="X", structure_hash="h", nsites=1, elements=["X"],
            space_group_number=230,
        )
        with pytest.raises(ValidationError):
            MaterialEntity(
                formula="X", structure_hash="h", nsites=1, elements=["X"],
                space_group_number=0,
            )
        with pytest.raises(ValidationError):
            MaterialEntity(
                formula="X", structure_hash="h", nsites=1, elements=["X"],
                space_group_number=231,
            )

    def test_nsites_positive(self):
        with pytest.raises(ValidationError):
            MaterialEntity(
                formula="X", structure_hash="h", nsites=0, elements=["X"]
            )


class TestCalcReport:
    def test_construct_minimal(self, nbocl2_material):
        report = CalcReport(
            calc_id="job-1_sha-2_relax",
            material=nbocl2_material,
            calc_type="relax",
            code="vasp",
            status="running",
            submitted_at=datetime(2026, 5, 27, 18, 30, tzinfo=timezone.utc),
        )
        assert report.verdict is None
        assert report.energy_ev is None
        assert report.output_files == []
        assert report.tags == []

    def test_roundtrip_full(self, nbocl2_material, passing_verdict, outcar_pointer):
        report = CalcReport(
            calc_id="job-9123_sha256-f1b2c3d4_relax",
            material=nbocl2_material,
            calc_type="relax",
            code="vasp",
            code_version="VASP 6.4.3",
            functional="PBE",
            pseudopotentials={"Nb": "Nb_sv", "O": "O", "Cl": "Cl"},
            input_summary={"ENCUT": 520, "KSPACING": 0.25, "EDIFF": 1e-6, "ISMEAR": 0},
            status="completed",
            verdict=passing_verdict,
            energy_ev=-123.456,
            energy_per_atom_ev=-15.432,
            band_gap_ev=1.87,
            direct_gap_ev=2.04,
            max_force_ev_per_ang=0.0042,
            elapsed_seconds=18450.0,
            wall_seconds=4612.5,
            n_electronic_steps=42,
            n_ionic_steps=7,
            output_files=[outcar_pointer],
            submitted_at=datetime(2026, 5, 27, 14, 0, tzinfo=timezone.utc),
            completed_at=datetime(2026, 5, 27, 19, 17, tzinfo=timezone.utc),
            slurm_job_id="9123",
            slurm_partition="gpu_ai",
            slurm_nodes=["vasp-03"],
            chat_session_id="sess-abc",
            chat_group="nbo_cl2",
            tags=["pareto-tier-final", "PBE-baseline"],
        )

        as_json = report.model_dump_json()
        restored = CalcReport.model_validate_json(as_json)

        assert restored == report
        assert restored.material.formula == "NbOCl2"
        assert restored.verdict is not None
        assert restored.verdict.verdict == "pass"
        assert restored.output_files[0].sha256 == "abcd" * 16
        assert restored.input_summary["ENCUT"] == 520

    def test_invalid_calc_type_rejected(self, nbocl2_material):
        with pytest.raises(ValidationError, match="calc_type"):
            CalcReport(
                calc_id="x",
                material=nbocl2_material,
                calc_type="frobnicate",  # type: ignore[arg-type]
                code="vasp",
                status="running",
                submitted_at=datetime(2026, 5, 27, tzinfo=timezone.utc),
            )

    def test_invalid_status_rejected(self, nbocl2_material):
        with pytest.raises(ValidationError, match="status"):
            CalcReport(
                calc_id="x",
                material=nbocl2_material,
                calc_type="relax",
                code="vasp",
                status="pending",  # not in CalcStatus literal  # type: ignore[arg-type]
                submitted_at=datetime(2026, 5, 27, tzinfo=timezone.utc),
            )


# ---------------------------------------------------------------------------
# §2.4 MlipPrediction
# ---------------------------------------------------------------------------


class TestMlipPrediction:
    def test_roundtrip(self, nbocl2_material):
        pred = MlipPrediction(
            material=nbocl2_material,
            model="mace-mp-0",
            model_version="2024.1",
            energy_ev=-122.10,
            forces_max_ev_per_ang=0.041,
            forces_rms_ev_per_ang=0.012,
            uncertainty_meta={"committee_std_ev": 0.018},
            elapsed_seconds=4.7,
            notes="screen tier; final calc via VASP",
        )
        as_json = pred.model_dump_json()
        restored = MlipPrediction.model_validate_json(as_json)
        assert restored == pred

    def test_invalid_model_rejected(self, nbocl2_material):
        with pytest.raises(ValidationError, match="model"):
            MlipPrediction(
                material=nbocl2_material,
                model="gpt-4",  # type: ignore[arg-type]
                energy_ev=0.0,
                forces_max_ev_per_ang=0.0,
                forces_rms_ev_per_ang=0.0,
                elapsed_seconds=1.0,
            )


# ---------------------------------------------------------------------------
# §2.5 SchedulerJobState
# ---------------------------------------------------------------------------


class TestSchedulerJobState:
    def test_roundtrip_running(self):
        st = SchedulerJobState(
            job_id="9123",
            state="RUNNING",
            elapsed="01:23:45",
            estimated_remaining="00:36:15",
            nodes=["vasp-03"],
            stdout_tail="... iteration 7 ...",
            stderr_tail=None,
            expected_outputs_present={"OUTCAR": True, "vasprun.xml": False},
        )
        restored = SchedulerJobState.model_validate_json(st.model_dump_json())
        assert restored == st
        assert restored.expected_outputs_present["OUTCAR"] is True

    def test_invalid_state_rejected(self):
        with pytest.raises(ValidationError, match="state"):
            SchedulerJobState(job_id="x", state="WAT")  # type: ignore[arg-type]

    def test_minimum_required_fields(self):
        st = SchedulerJobState(job_id="x", state="PENDING")
        assert st.nodes == []
        assert st.expected_outputs_present == {}
        assert st.elapsed is None
