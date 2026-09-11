# Zebrafish Neural / $ZNEURO

**A zebrafish-inspired neural controller operating a real browser.**

One shared model receives Chromium screenshots, extracts visual contrast, and turns eight evolving population states into cursor movement, permitted link clicks, and scrolling. Spectators see the same browser, neural state, retinal input, and event log. The homepage also offers a browser-local target test with synthetic visual input, scored trials and JSON export. Each visitor runs an independent target session using the same model equations. A separate laboratory provides additional controlled experiments and measured anatomy inspection.

**Project token:** $ZNEURO was launched manually by the operator on [Pons](https://www.ponsfamily.com/launchpad/0xd563F5010291a270fC83092111571b5f9Df104B4). The [creation transaction](https://robinhoodchain.blockscout.com/tx/0xb88b19f765312360518944770acc8bb753474323a2259fbf9c0b09556f00c5fa) is confirmed on Robinhood Chain (chain ID 4663). The neural controller did not perform the launch; its Wikipedia browser experiment continues independently.

**Contract:** [0xd563F5010291a270fC83092111571b5f9Df104B4](https://robinhoodchain.blockscout.com/token/0xd563F5010291a270fC83092111571b5f9Df104B4). The token is named Zebrafish Neural, has symbol ZNEURO and 18 decimals. Contract source code is not explorer-verified; no contract audit is claimed. See the [launch record and experimental scope](docs/genesis.md).

- Website: [zebraneural.com](https://zebraneural.com)
- Updates: [@zebrafishneural](https://x.com/zebrafishneural)
- Source: [zebrafishneural/zebrafish-neural](https://github.com/zebrafishneural/zebrafish-neural)

## Current implementation

| Component | Implementation |
| --- | --- |
| Shared runtime | One Node.js process, one isolated Chromium context, one model |
| Input | Real screenshots at approximately 2 Hz; heading-oriented 32 × 16 retinal crop |
| Dynamics | Eight population rates; fixed 20 ms integration steps |
| Actions | Model-driven cursor, explicit click gate, edge scrolling |
| Navigation | Wikipedia article links; scheduled rotations labeled as assistance |
| Live view | Read-only WebSocket feed, shared run ID and state |
| Recovery | Stale-input suspension, browser retry, periodic checkpoints |
| Recording | Recent 60 model seconds, recent events and bounded host event files |
| Target test | Per-viewer synthetic target reaching, reversal and input occlusion; scored attempts and session JSON |
| Laboratory | Synthetic stimuli, virtual swimming, exports and separate anatomy viewer |
| Anatomy | 71,721 measured ZAPBench cell centroids, independent of model dynamics |

The model has hand-set parameters and has not been fitted to biological recordings. The 5,220 schematic drawing points represent eight states, not individually simulated neurons. Measured centroids do not supply connectivity or drive activity. This is not a complete zebrafish brain reconstruction.

## Run locally

Requires Node.js 22 or later. Install the shared browser runtime once:

```sh
npm ci
npx playwright install chromium
```

Run the model and frontend in separate terminals:

```sh
npm run runtime
# http://127.0.0.1:4388

npm run dev
# http://127.0.0.1:4173
```

For local-only use, set `dist/live-config.json` to `{"endpoint":"http://127.0.0.1:4388"}`. An HTTPS frontend needs an HTTPS runtime endpoint. The operator-computer setup uses a temporary HTTPS tunnel; restarting the tunnel may require updating its configured address.

The runtime opens a fresh browser context. It does not capture your desktop or use personal tabs, files, accounts, or a wallet. Viewers cannot start, stop, or command the shared model. The host must remain awake and online. Closing the website does not stop the shared process.

The homepage opens Wikipedia by default. Select Target test or open `/#target-test` for the independent local experiment. Target controls affect only that browser's simulation. It pauses when hidden or when Wikipedia is selected, while the shared host continues. Target records stay in memory until exported; reset, reload or closing the page discards them. See the [target-test methods](docs/target-test.md) for protocols, input mapping, scoring and retention.

On Windows, `./runtime/local-host.ps1 -Action Start` starts the supervised model in the background; use `-Action Status` to inspect it and `-Action Stop` to stop it. See [operator notes](OPERATIONS.md) for the public feed and restart procedure.

The laboratory alone requires no package installation: run `npm run dev` and open `/laboratory.html`.

## Validation and documentation

```sh
npm test
npm run docs
npm run check
```

Tests cover deterministic dynamics, data integrity, continuous sessions, screenshot contrast, mirrored steering, stale-input suspension, output-disabled controls, checkpoints, and navigation boundaries. All project text remains in English.

## Source layout

```text
dist/index.html         Shared live view
dist/live.js            Stream client and reconnect handling
dist/lib/target-task.js Browser-local target protocols, scoring and export
dist/live-config.json   Public runtime endpoint
dist/laboratory.html    Controlled synthetic experiments
dist/app.js             Laboratory controls and recording
dist/lib/model.js       Eight-state equations and kinematic body
dist/lib/brain-view.js  Schematic and measured-geometry renderer
dist/lib/session.js     Local laboratory clock
dist/data/              ZAPBench geometry and provenance
runtime/controller.mjs Screenshot encoder and action adapter
runtime/policy.mjs     Permitted navigation policy
runtime/server.mjs     Shared host, browser, stream and checkpoints
runtime/data/          Ignored local state and event logs
docs/                  Methods, runtime protocol and roadmap
tests/                 Behavior and integrity checks
```

The frontend deploys to Vercel from `dist/`. The continuous browser process runs separately on the operator computer. Vercel uses `vercel.json`.

## Methods and evidence

- [Shared browser input, actions and runtime](docs/runtime.md)
- [Browser-local target-test methods and records](docs/target-test.md)
- [Token launch record and experimental scope](docs/genesis.md)
- [Model equations and validation](docs/model.md)
- [Data provenance](docs/data.md)
- [Development roadmap](docs/roadmap.md)
- [Contribution guide](CONTRIBUTING.md)

The interaction concept takes inspiration from [FLYBRAIN](https://flybrain.online/) and its [repository](https://github.com/fruitflydev/flycoinrh). Fly connectivity, neuron identities, neurotransmitters, and code have not been transferred into this model.

## Licensing and publication

Application code uses the [MIT license](LICENSE). The bundled ZAPBench derivative is **CC BY 4.0**, with attribution in [NOTICE](NOTICE) and the data manifest. Source code, tests, and methods are available in the [public repository](https://github.com/zebrafishneural/zebrafish-neural).
