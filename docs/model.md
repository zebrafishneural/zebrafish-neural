# Model specification

**Version:** `zebra-rate-0.1.0`

This reduced population model supports controlled software experiments with a visual–motor feedback loop. All coefficients are design parameters. The model has not been fitted to zebrafish physiology, calcium activity, or synaptic connectivity.

## State and numerical update

The state contains eight rates `r_i ∈ [0,1]`, fish position `(x,y)`, heading `θ`, and simulation time. Rates are continuous and dimensionless; they do not represent measured spikes or firing frequencies in hertz.

The interface advances the model with fixed `Δt = 0.02 s` Euler steps. With `clip` denoting restriction to `[0,1]`:

```text
u_i  = clip(drive_i + 0.10 r_i)
r_i' = clip(r_i + Δt/τ_i × (u_i − r_i))
```

All drives are calculated from the previous rates before any rate is updated. No stochastic network noise is used. Rendering and simulation clocks are separate: slow rendering reduces progress relative to wall time rather than increasing the numerical step size or skipping state updates.

| State | Model role | τ (s) |
| --- | --- | ---: |
| r0, r1 | Visual L/R | 0.12 |
| r2, r3 | Integrator L/R | 0.45 |
| r4 | Shared drive | 0.20 |
| r5, r6 | Motor L/R | 0.14 |
| r7 | Spinal drive | 0.12 |

These names describe model functions. They do not identify measured cell populations in the centroid dataset.

## Laboratory visual encoding

The shared live controller uses contrast from real browser screenshots, as specified in the shared-controller methods. The encoder below applies to the separate controlled laboratory and the homepage's browser-local target test. Both input adapters feed the same eight-state population equations; the target-test methods specify its trial settings and scoring separately.

The 32 × 16 retinal image is generated analytically from target bearing, distance, and size using a Gaussian contrast profile. It is not a screenshot of the rendered arena. Changes in fish pose affect the next observation.

Contrast is summed over each half of the image and over a central strip. The resulting features are:

```text
L = clip(19 × left_contrast_sum / 512)
R = clip(19 × right_contrast_sum / 512)
C = clip( 9 × center_contrast_sum / 512)
E = clip( 5 × total_contrast_sum / 512)  [looming only; otherwise 0]
```

The central strip contains samples with normalized horizontal coordinate `|px| < 0.16`. The baseline luminance is `0.05` for bright targets and `0.78` for the looming condition. Bright-target contrast is luminance above baseline; looming contrast is the luminance deficit below baseline. Intensity ranges from 0 to 1.

For looming, the Gaussian radius increases from `0.10` to `0.58` over 1.5 seconds; its contrast fades between 2.3 and 3 seconds. The moving target changes position over time, but the encoder has no separate temporal motion detector. These visual conventions are designed inputs, not a physiological retinal model.

## Population drives

Let `g = 1 − 0.7C(1 − E)`:

```text
drive0 = L
drive1 = R
drive2 = 0.50r0
drive3 = 0.50r1
drive4 = 0.45(r0 + r1)

non-looming:
drive5 = g*r0     + 0.12r2 + 0.08r4
drive6 = g*r1     + 0.12r3 + 0.08r4

looming:
drive5 = g*1.8*r1 + 0.12r3 + 0.08r4
drive6 = g*1.8*r0 + 0.12r2 + 0.08r4

drive7 = 0.55(r5 + r6) + 0.25E
```

The looming condition selects crossed visual and integrator routing from the start of the experiment. This is an explicit aversive control rule chosen by the model author. It is neither a learned association nor a circuit inferred from a connectome.

## Kinematics

```text
angular velocity ω = 3.2(r6 − r5) rad/s
forward speed    v = 0.15r7 arena units/s
```

Heading is updated before position. Positive `y` points downward in the arena. The position is confined to `x ∈ [0.045,0.955]` and `y ∈ [0.055,0.945]`; a boundary encounter reflects the heading. Position uses normalized arena coordinates rather than millimeters. Muscle dynamics, hydrodynamic forces, and body biomechanics are not modeled.

## Visualization and provenance

In the schematic view, the brightness of 5,220 drawing points is derived from eight model rates. These points do not have independent neural states. The measured-geometry view displays ZAPBench cell positions with neutral coloring and no activity assignment. The bundled centroid asset contains no region labels or connectivity.

## Recording and reproducibility

This section describes laboratory recordings. The shared runtime adds browser frame identifiers, action events, host checkpoints, and its own recording endpoint.

The initial state is `x=0.5`, `y=0.75`, `θ=−π/2`, with all rates zero. The browser session starts automatically with the moving-target stimulus at contrast 0.7, and continues beyond 60 model seconds without restarting the state. The population model is the initial view; measured anatomy remains available separately.

Pause enables the stimulus and intensity controls. Changing either resets the state and recording while retaining the pause. Restart also resets state and recording: a running session continues automatically, and a paused session stays paused. The simulation suspends while its tab is hidden and automatically resumes when visible unless manually paused. It does not advance hidden wall time on return. Reloading or closing the page ends the browser session; no persistent server runs the model.

Samples are recorded every five model steps, or `0.1 s`. Both the recording and the displayed trajectory use a rolling buffer of at most 600 samples, retaining the latest 60 model seconds. Old samples expire without resetting the model. JSON exports use schema version 2 and include the model version, configuration, time step, sample interval, `totalSteps`, units, provenance and samples. `durationSeconds` is total elapsed model time; `recording.startTimeSeconds` and `recording.endTimeSeconds` identify the retained interval, which may omit earlier session history. CSV exports contain time, pose, speed, angular velocity, and the eight rates, using the original session timestamps. Keep the JSON file with the CSV: the CSV does not carry configuration or provenance.

An experiment can be reproduced in code from its initial state with `makeState(config)` and repeated `step` calls using the same model version and total step count; then select the exported time interval. The interface does not yet import JSON recordings. Reproduction concerns the simulated trajectory and sampled values, not the export creation timestamp.

Continuous stepping does not imply constant activity or motion. The dark condition remains silent, and looming is a single presentation that fades after three model seconds. Restart repeats that presentation; the session does not silently cycle stimuli.

## Validation

`npm test` covers zero-contrast behavior, mirror symmetry, the designed looming avoidance rule, bounded state over 60 seconds, deterministic and chunked execution, pose-dependent retinal input, CSV columns, invalid time steps, and centroid count/checksum integrity. Session checks cover automatic start, ten minutes of uninterrupted model time with bounded recording, visibility suspension, manual pause, restart behavior and slow-frame timing.

These checks evaluate implementation behavior and data integrity. No calcium fit, spike-prediction benchmark, or biological whole-brain validation has been performed.
