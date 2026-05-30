# CRYSTAL23 Advanced Physics — Magnetism & Non-Linear Optics

This module instructs the agent on implementing unrestricted spin models, complex magnetic ordering, and analytical Coupled-Perturbed calculations for non-linear optical (NLO) tensors.

## When to Use

- Modeling open-shell, magnetic transition-metal complexes and solids that require an unrestricted (UHF & UDFT) representation.
- Setting up antiferromagnetic or ferromagnetic spin ordering, including AFM supercells with explicitly defined atomic moments.
- Forcing a starting orbital occupancy template on transition metals in correlated insulators (e.g. antiferromagnetic transition metal oxides such as $MnO$, $NiO$, $CoO$) to avoid relaxing into a non-magnetic ground state.
- Computing analytical polarizabilities ($\alpha$), first hyperpolarizabilities ($\beta$), and second hyperpolarizabilities ($\gamma$) via Coupled-Perturbed Hartree-Fock (CPHF) and Coupled-Perturbed Kohn-Sham (CPKS) algorithms.
- Evaluating NLO tensors for Second Harmonic Generation (SHG) or the electro-optic Pockels effect under static or dynamic electric fields.

## 1. Unrestricted Spin Polarization (UHF & UDFT)

To model open-shell, magnetic transition-metal complexes and solids, the solver must operate in an unrestricted representation.

### Spinning Up: SPIN & SPINLOCK

In Block 3 (Hamiltonian):

Use SPIN to initialize the calculation with spin-up ($\alpha$) and spin-down ($\beta$) densities treated independently.

Add SPINLOCK to hold the total magnetization difference ($N_\alpha - N_\beta$) constant during initial electronic iterations, helping the solver locate metastable magnetic spin arrangements.

```
SPIN
SPINLOCK
4.0 20 <-- Lock magnetic moment to 4 Bohr Magnetons for the first 20 cycles
```

### Transition-Metal d-orbital Projections: FDOCCUP

In correlated insulators such as antiferromagnetic transition metal oxides ($MnO$, $NiO$, $CoO$), the default spin density guess often relaxes to a lower-symmetry, non-magnetic ground state. Use FDOCCUP in Block 3 to force a starting orbital occupancy template on specific transition metals.

```
FDOCCUP
[Number of atoms to constrain]
[Atom Index] [Number of d-electrons] [Spin constraint direction: 1 for UP, -1 for DOWN]
[Orbitals: 5 integers (1 or 0) for dz2, dxz, dyz, dx2-y2, dxy]
```

### Antiferromagnetic Supercell Configurations (AFM)

To construct an AFM ground state:

Double or expand the unit cell using SUPERCELL in Block 1 to ensure space-charge neutrality across opposing spin-density directions.

At the end of Block 1, define the atomic moments explicitly with ATOMSPIN:

```
ATOMSPIN
2
1 +1 <-- Metal atom 1 is spin-up
2 -1 <-- Metal atom 2 is spin-down
```

## 2. Non-Linear Optics (NLO) via CPHF & CPKS

CRYSTAL23 computes analytical polarizabilities ($\alpha$), first hyperpolarizabilities ($\beta$), and second hyperpolarizabilities ($\gamma$) via Coupled-Perturbed Hartree-Fock and Coupled-Perturbed Kohn-Sham algorithms.

### Dynamic & Static Electric Fields: POLARIZ

To evaluate optical responses under external fields, insert the POLARIZ sub-block in Block 3.

```
POLARIZ
MAXITER
120 <-- Maximum iterations for the Coupled-Perturbed solver
TOLER
1.D-5 <-- Convergence tolerance for the perturbed density matrix
DYNPOL
0.043 <-- Laser energy (0.043 Hartree corresponds to 1064nm, 0.0 is static)
END
```

### Hyperpolarizabilities and Higher Tensors: HYPERPOL

For calculating Second Harmonic Generation (SHG) or the electro-optic Pockels effect:

Replace POLARIZ with HYPERPOL.

Ensure tolerances are set to 8 8 8 8 16 (TOLINTEG) to prevent numerical noise from corrupting high-order derivatives.
