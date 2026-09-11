# Persistent target learning

A separate server process adjusts six gains in the eight-state controller through scored target-reaching trials. It runs independently of viewers and saves each completed generation before displaying it. The original Wikipedia controller is unchanged.

## Run

Requires Node.js 22 or later; this process has no external package dependencies.

```sh
node experiments/learning-live/serve.mjs
# http://127.0.0.1:4189/
```

The learner starts automatically. It continues after the page closes. On restart, it restores the saved candidate, retained controller, optimizer, random-generator state and counters. Stop its process to stop training. The HTTP interface is read-only and provides no start, reset or import commands.

The default interval is 15 wall-clock seconds after the preceding generation has been saved. Computation time is additional. `LEARNING_INTERVAL_MS` changes the interval; `LEARNING_PORT` changes the loopback port. Running the learner requires the host to remain awake. A website deployment does not move this long-running process onto Vercel.

## Learning and selection

The six bounded gains and synthetic retinal encoder come from the earlier learning demo. The equations reproduce the fixed model at its original gains. This is software parameter optimization, not biological synaptic plasticity or learning article content.

Each generation uses a new seeded set of training scenarios. Matched positive and negative parameter perturbations estimate an evolution-strategy gradient; Adam updates the candidate. The retained controller is a separate parameter set. It changes only when the candidate passes the declared validation checks, including retaining previously successful validation cases and increasing mean reward.

The fixed validation set is repeatedly used for selection. It is not an independent test set. Reaching, reversal and input occlusion remain separate task protocols. No target coordinates are supplied directly to motor output: they generate the synthetic retinal stimulus and score contact.

A fresh test set is evaluated initially and every ten generations. Original and retained parameters face the same scenarios. No-input controls are included. These test results are recorded but never used by the optimizer or promotion rule. Results may regress; passing the validation gate does not guarantee improvement on unseen tasks.

The browser visualizations run deterministic local replays using the actual saved gains. They are labeled as replays, separate from the server's training rollouts. Opening or interacting with a replay does not train, pause or reset the shared learner.

## Persistence and downloadable records

Private host data lives in `data/`, which is excluded from Git and deployment uploads.

- `checkpoint.json` is the committed state, with a learner hash and matching generation-record hash.
- `checkpoint.previous.json` keeps the preceding committed checkpoint.
- `records/generation-*.json` retains per-generation measurements, scenario/configuration references, weights and any fresh-target evaluation. Full checkpoint histories are not duplicated into every record.

The service writes the generation record and atomically replaces the checkpoint before publishing the new state. A failed save pauses learning and leaves the preceding state visible. An uncommitted record file is excluded from downloads and can be replaced on the next attempt at that generation.

Episode counters describe committed evaluations. An interrupted or unsaved proposal can consume additional computation that is not included in the restored checkpoint. The status endpoint omits per-case histories and optimizer details to keep the observer stream small; checkpoint downloads retain the full resumable state.

Endpoints accept only GET and HEAD:

```text
/api/status                     Latest committed learner state and process status
/api/checkpoint                 Complete committed checkpoint envelope
/api/records                    Latest 100 committed generation records
/api/records?date=YYYY-MM-DD     Committed records for one UTC date
```

Download timestamps and generation IDs establish which saved state a response represents. The public Vercel proxy briefly caches responses to reduce host traffic. A hash is an integrity check on the exported bytes, not an independent attestation of the experiment.

To reproduce a checkpoint, pass its `learner` field to `importLearner` and use `advanceLearner`. Configuration, random state and optimizer state determine the continuation. Old demo checkpoints use a different schema and must not be substituted for this learner's checkpoint.

## Verification

```sh
node --test experiments/learning-live/*.test.mjs
node scripts/build-learning.mjs
npm run check
```

Tests cover real bounded parameter updates, deterministic continuation, promotion gates, separate evaluation sets, persistence and the read-only API. The learning server does not connect to personal browser tabs, read the desktop, operate a wallet or change the Wikipedia runtime.
