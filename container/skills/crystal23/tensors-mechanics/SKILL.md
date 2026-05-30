# CRYSTAL23 Tensors & Solid Mechanics

This document defines the advanced skill set required for the agent to run, troubleshoot, and evaluate mechanical, piezoelectric, ferroelectric, and elasto-optic tensor calculations in CRYSTAL23.

## When to Use

- Computing the elastic stiffness tensor ($C_{ij}$) and compliance tensor ($S_{ij}$), and deriving polycrystalline moduli via Voigt-Reuss-Hill (ELASTCON).
- Calculating piezoelectric and dielectric response, whether analytically via CPHF/CPKS (PIEZOCP) or numerically via Berry phase (PIEZOCON), or the full coupled electromechanical response (ELAPIEZO).
- Determining spontaneous ferroelectric polarization ($\mathbf{P}_{spont}$) along an adiabatic path via the Berry phase (BERRY).
- Computing photoelastic / elasto-optic tensors ($p_{ijkl}$) coupling mechanical strain with the dynamic electronic dielectric response (PHOTOELA).
- Driving mechanical-property workflows that require relaxed internal coordinates, tight SCF tolerances, and correct strain-amplitude sampling.

## 1. Elastic Constants Tensor ($\mathbf{C}$)

CRYSTAL23 computes the $6 \times 6$ elastic stiffness tensor ($C_{ij}$) and compliance tensor ($S_{ij}$) by applying automated finite strains to the lattice and evaluating the resulting stress tensors analytically or numerically.

### The ELASTCON Keyword Block

To initiate an elastic constant calculation, place the ELASTCON block at the end of Block 1 (Geometry Block).

```
ELASTCON
NSTRAIN
4
STEP
0.010
PRESSURE
0.0
TOLFOR
0.0001
TOLDEG
0.0001
RESTART
END
```

### Detailed Parameter Reference

NSTRAIN (Integer): The number of strain amplitudes applied along each independent strain direction. A minimum of 4 (two positive, two negative, e.g., $\eta = -0.01, -0.005, 0.005, 0.01$) is required to filter out anharmonic contributions via polynomial fitting.

STEP (Float): The maximum dimensionless strain amplitude ($\eta_{max}$). Recommended range is 0.005 to 0.015. If the step is too small, numerical noise dominates; if too large, the system escapes the quadratic harmonic regime.

PRESSURE (Float): Applies a hydrostatic pressure (in GPa) to compute the elastic constants of prestressed crystals.

TOLFOR & TOLDEG (Floats): Overrides the maximum force ($0.0001\text{ a.u.}$) and displacement ($0.0001\text{ a.u.}$) thresholds for geometry relaxation under strain. Under strain, internal atomic coordinates must be relaxed to capture the non-clamped ion contributions.

RESTART: Instructs the solver to read the existing checkpoint files if an HPC queue walltime interrupt occurred during a previous strain run.

### Polycrystalline Elastic Properties (Voigt-Reuss-Hill)

Once the $6 \times 6$ stiffness tensor ($C_{ij}$) is computed, CRYSTAL23 calculates the isotropic polycrystalline moduli using three approximation bounds:

Voigt Bound ($G_V, K_V$): Assumes uniform strain across grain boundaries.

Reuss Bound ($G_R, K_R$): Assumes uniform stress across grain boundaries.

Voigt-Reuss-Hill (VRH) Average ($G_H, K_H$): The arithmetic mean of the Voigt and Reuss limits, representing the physical isotropic average:

$$K_{VRH} = \frac{K_V + K_R}{2}$$

$$G_{VRH} = \frac{G_V + G_R}{2}$$

## 2. Piezoelectric and Dielectric Response

Piezoelectricity couples stress ($\sigma_{kl}$) and strain ($\epsilon_{kl}$) with electric field ($E_k$) and polarization ($P_i$). Under periodic boundary conditions, CRYSTAL23 supports two complementary methodologies.

### Method 1: CPHF/CPKS Analytical Piezoelectricity (PIEZOCP)

This method solves the Coupled-Perturbed Hartree-Fock/Kohn-Sham equations analytically to obtain the direct piezoelectric tensor ($e_{ij}$) and the converse tensor ($d_{ij}$). It is highly recommended for 3D insulating structures due to its speed and lack of numerical derivative noise.

#### Block 1 Setup

Place at the end of the geometry block:

```
PIEZOCP
END
```

#### Block 3 Tolerances

For stable analytical convergence, the agent must enforce tight SCF tolerances:

```
TOLINTEG
8 8 8 8 16
```

### Method 2: Numerical Berry Phase Piezoelectricity (PIEZOCON)

For systems where analytical linear response is unstable, or for 2D slabs, the numerical finite-strain approach is used. Polarization is computed at each strain state via the modern theory of polarization (Berry Phase).

```
PIEZOCON
NSTRAIN
4
STEP
0.005
END
```

### Unified Tensor Workflow: ELAPIEZO

To calculate the complete, coupled electromechanical response, use ELAPIEZO. It resolves:

Elastic stiffness tensor ($C_{ij}$)

Direct piezoelectric tensor ($e_{ij}$)

Dielectric tensor ($\chi_{ij}$)

```
ELAPIEZO
NSTRAIN
4
STEP
0.010
END
```

## 3. Spontaneous Polarization ($\mathbf{P}_{spont}$) via Berry Phase

Spontaneous ferroelectric polarization must be calculated as a difference along an adiabatic path connecting a centrosymmetric (non-polar) reference phase to the polar ground-state phase:

$$\Delta \mathbf{P} = \mathbf{P}_{\text{polar}} - \mathbf{P}_{\text{non-polar}}$$

### The BERRY Keyword Block

To invoke the calculation, insert the BERRY keyword in Block 3 of your self-consistent run.

```
BERRY
DIRECT
1 0 0
END
```

### Detailed Parameters

DIRECT: Specifies that the polarization is computed along a direct reciprocal lattice vector.

1 0 0 (Integers): The lattice vector defining the projection path (e.g., $a$-axis).

Quantum of Polarization: The polarization computed via the Berry phase is multi-valued (defined modulo the quantum of polarization $\mathbf{P}_q$):

$$\mathbf{P}_q = \frac{e \mathbf{R}}{\Omega}$$

where $e$ is the electron charge, $\mathbf{R}$ is the lattice vector in the direction of polarization, and $\Omega$ is the unit cell volume. The agent must verify that the difference along the adiabatic path is unwrapped correctly, avoiding artificial jumps equal to integer multiples of $\mathbf{P}_q$.

## 4. Photoelastic and Elasto-Optic Tensors (PHOTOELA)

The photoelastic tensor ($p_{ijkl}$) measures the change in the optical dielectric impermeability tensor ($\Delta ( \epsilon^{-1} )_{ij}$) due to mechanical strain:

$$\Delta ( \epsilon^{-1} )_{ij} = p_{ijkl} \eta_{kl}$$

This calculation couples elastic strain with the dynamic electronic dielectric response.

### Input Configuration

Place at the end of Block 1:

```
PHOTOELA
NSTRAIN
4
STEP
0.010
END
```

And in Block 3, define the optical frequency of interest within the analytical solver:

```
POLARIZ
DYNPOL
0.043
END
```
