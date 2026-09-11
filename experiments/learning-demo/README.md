# Learning controller demo

An isolated, local experiment that learns six connection gains in the existing eight-state visual–motor controller. It preserves the released controller as a fixed reference. This directory does not change the deployed website or control the shared Wikipedia process.

## Run

Requires Node.js 22 or later. This demo has no additional package dependencies.

```sh
node experiments/learning-demo/serve.mjs
```

Open **http://127.0.0.1:4187/**. The server binds only to loopback. All demo text is English and the interface reuses the released site's styles, logo and brain renderer.

1. Choose a seed and generation budget, then start training.
2. Compare the original and validation-selected parameters on the same training scenario. Replays use the actual equations; they are not animations of prerecorded success.
3. Inspect changing gains and the separate training/validation histories. A selected checkpoint may remain the original baseline.
4. Pause after a generation, or wait for training to finish. Evaluate the separate test set once ready.
5. Export the checkpoint. Its weights, optimizer, random state, history and counters can be restored exactly.

Final evaluation freezes this run. Choose a different seed and reset to start another run. Reset affects only this demo. Replays pause when their browser tab is hidden; the server's training worker continues independently while its process is running.

## What learns

The baseline is `dist/lib/model.js`, unchanged from the released project. `core.js` uses its original sensory encoder and reproduces its updates exactly at the default gains. The learned model version is `zebra-rate-trainable-0.1.0`.

| Shared bilateral gain | Initial value | Allowed range |
| --- | ---: | ---: |
| Visual → integrator | 0.50 | 0.10–1.50 |
| Visual → shared drive | 0.45 | 0.10–1.35 |
| Visual → motor | 1.00 | 0.25–2.50 |
| Integrator → motor | 0.12 | 0–0.50 |
| Shared drive → motor | 0.08 | 0–0.35 |
| Motor → spinal drive | 0.55 | 0.15–1.65 |

The fixed time step, time constants, recurrence, visual encoder, motor scale factors, boundaries and task scoring are not optimized. Every trial resets position, heading and all eight temporary activity states. Supplied learned gains carry across trials.

This is episodic parameter optimization using a bounded antithetic evolution strategy with Adam. Each generation evaluates matched positive/negative perturbations on the same training scenarios, estimates a reward gradient and updates the six parameters. The validation reward selects a checkpoint; it does not generate the training gradient. Current weights and selected weights are recorded separately because later updates can make performance worse.

Reference: [Evolution Strategies as a Scalable Alternative to Reinforcement Learning](https://arxiv.org/abs/1703.03864). This implementation is a small, project-specific variant, not a reproduction of that paper's benchmarks or FLYBRAIN's plasticity mechanism.

## Task and reward

Seeded scenarios vary target position, initial position/heading and intensity. They cycle through reaching, reversal at 4 model seconds, and visual occlusion from 3 to 8 seconds. Occlusion scenarios start far enough away that they cannot finish before the interruption. The sensory image is the existing synthetic 32 × 16 Gaussian target stimulus, not a screenshot. Coordinates construct the stimulus and score contact; they never directly set motor output.

Each attempt lasts up to 30 model seconds. Contact radius is 0.065 arena units. Time cost is contact time for a success and 30 seconds for a miss. Path length is measured from actual position changes.

```text
reward = (reached ? 1 : 0)
       - 0.20 × timeCost / 30
       - 0.02 × min(1, pathLength / 4.5)
```

All failures remain in aggregate reward, time-cost and path metrics. Success rate is reported separately; a lower time cost alone must not be presented as improved reliability.

## Training, selection and final testing

The seeded train, validation and test sets use separate seed namespaces. The default interactive run uses 6 train, 6 validation and 8 test cases, 4 perturbation pairs and 12 generations. These are deliberately small demonstration settings, not a sufficient scientific evaluation.

Training never creates or evaluates test cases. Explicit final evaluation compares original, validation-selected and final-current weights on the same test cases. It then seals the run, including in exported checkpoints. These seeds and code are public: this is a reproducible software partition, not a blinded external benchmark or a tamper-proof attestation. Independent review has not been claimed.

The replay selector displays training scenarios only. Its visualizations are separate from the server rollouts used for reported training/test metrics. Both displayed controllers face the same environment, but receive observations from their own positions as their trajectories diverge.

## Records and persistence

The local server writes `data/checkpoint.json` atomically after every completed generation. That directory is ignored by Git and cannot be downloaded through a static file route. Use **Export checkpoint** for a deliberate export. A saved run loads as paused or complete on server restart, never as automatic resumed training.

Checkpoint validation checks versions, bounded parameters, optimizer shape, RNG progression, history/selection consistency and exact episode budgets. Import does not rerun training or certify that an externally supplied result is authentic. To verify an export, reproduce its training seed and configuration and compare the results.

## Verification and initial results

```sh
node --test experiments/learning-demo/*.test.mjs
node experiments/learning-demo/benchmark.mjs
```

The tests cover exact default-weight parity, real parameter effects, fixed scoring and zero-input behavior, deterministic resume, test partition separation, checkpoint rejection, and persistence through server restart.

The benchmark uses five predeclared seeds (`20260911` through `20260915`) and 32 held-out scenarios per run. Every run is retained in `results/initial-evaluation.json`, with full checkpoints alongside it. A separate no-input control uses the selected gains. Results are exploratory and include regressions. They do not establish that this optimizer beats other learning algorithms. A same-budget random-search control and broader evaluations remain future work.

The initial recorded benchmark reached **157/160 targets with the original parameters and 153/160 with the validation-selected parameters**. The selected parameters reduced mean time cost in four of five runs, but lost target successes in three runs. That trade-off is a reason to keep this as a demo. All no-input controls remained stationary and reached 0/160 targets. Parameter updates and checkpoint persistence work; an overall improvement in reliability has not been demonstrated.

Seed `20260911` is the first recorded example: both parameter sets reached 32/32 test targets; mean time cost was 11.1225 s for the baseline and 10.229375 s for the selected checkpoint. It is displayed as an example alongside the full five-run table, not selected as representative evidence of general improvement.

## Scope

The model has eight simulated population states with hand-designed structure. The brain drawing illustrates those states; it is not a reconstruction of zebrafish neural connectivity or a recording of biological activity. This demo does not implement biological synaptic plasticity, semantic reading, Wikipedia learning, market-data input, wallet signing or trading. Transfer to the screenshot-based controller would require a separate evaluation.

The production runtime, its uptime and data, root deployment configuration, released `dist/` files and main GitHub branch are outside this demo change.
