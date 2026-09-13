# You vs the Fish

A separate human-vs-controller chess service and frontend. Each browser session owns its own game. The existing shared broadcast continues independently.

## Run locally

From the repository root, with Node.js 22 or later:

```powershell
npm.cmd ci
npm.cmd run build:chess-play
npm.cmd run chess:play
```

Open `http://127.0.0.1:4200/play/`. The server binds to loopback. Default state lives in `experiments/chess-play/data`, which is excluded from Git. Use `PLAY_DATA_DIR` to supply a different dedicated directory. The entire repository is required because the model, chess rules and visual assets are reused from `experiments/chess` and `dist/chess`.

## Player experience

Choose White, Black or random. Click a piece and a legal destination; arrow keys, Enter and Escape also work. Promotion opens an explicit piece selector. The server commits your move, queues the model's response and streams its actual candidate comparisons. No board position is optimistically committed by the client.

The fish body, eight-state network, candidate pair and integrated motor output reflect received model samples. Between decisions, the final sample is labeled as held. Each fish move has inspectable feature values, tournament margins and a saved numerical summary. The UI does not invent a verbal chain of thought.

Refresh resumes the saved game with a per-session bearer credential in browser storage. Credentials stay out of URLs and exports. PGN, game JSON and decision JSON are available to the session owner. Default retention is 24 hours from creation and each game is capped at 160 half-moves. Downloads should be saved before expiry.

## Model scope

The service imports the existing `decisionSteps` selector, original six frozen gains and chess.js 1.4.0. It is the same handcrafted four-feature adapter and eight-state controller used by the shared experiment. It is not a chess-trained model and does not learn from player games. Legal chess and action application are handled by chess.js; the neural tournament selects among all legal candidates. No engine shortlist or fabricated response is inserted.

## Verify a fish move

Select a committed fish move and click **Replay & verify**. A browser worker reruns the published selector from the saved position and decision seed. It checks every legal candidate and its four features, every tournament comparison and seeded tie-break, every stored eight-state sample, the selected move and the exact resulting FEN. It also checks the protocol, versions and SHA-256 of the six original frozen gains. Sample floating-point values use an absolute tolerance of `1e-12`; model versions and the gains themselves must match exactly.

The page first binds the decision to the displayed game: game ID, move number, reconstructed position, move history and the seed derived from the game seed. A downloaded verification report includes the result and record fingerprint; **Source file hashes** identifies the replay code. The unchanged original model source is pinned to [`36effb98570f2562d0e7a0ac443828477cf63ae2`](https://github.com/zebrafishneural/zebrafish-neural/tree/36effb98570f2562d0e7a0ac443828477cf63ae2/experiments/chess). The page's separate verifier link identifies the verifier release.

To check outside the website, download **Decision JSON** and use a separate checkout of the verifier revision linked on the page. From its repository root, with Node.js 22 or later:

```sh
node experiments/chess-play/verification/cli.mjs /path/to/decision.json
```

This command requires no package installation, account or API key. It prints JSON and exits `0` only for a matching replay; mismatches or invalid input exit `1`. Input is limited to 8 MiB and replay to 6,000 samples. Both the raw decision export and its explicit hashed storage wrapper are supported.

A match establishes consistency with the published computation, not which process or hardware ran on the server. Hashes identify content; they are not signatures. The standalone JSON check cannot authenticate game identity or seed provenance. If there is only one legal move, the report identifies a **forced move** with zero neural comparisons rather than claiming the network chose between alternatives. The visual retina is reconstructed by the selector but is not stored in the runtime's sample records.

## Development checks

```powershell
npm.cmd run test:chess-play
node --test experiments/chess-play/ops/supervisor.test.mjs
node experiments/chess-play/ops/verify-local.mjs
```

Tests cover private session boundaries, legality, duplicate and stale requests, exact selector agreement, complete feature-phase streaming, queues and limits, checkpoint/record integrity, interrupted decision recovery, retention and quota recovery, HTTP/CORS and authenticated WebSockets. Replay tests verify real committed runtime records and reject changed features, rates, hashes, seeds, FENs, modes and versions, including tampering that leaves the chosen move unchanged.

## Deployment

See [`../../docs/chess-play.md`](../../docs/chess-play.md) and [`ops/AWS-HANDOFF.txt`](ops/AWS-HANDOFF.txt). The Windows installation uses a dedicated account, task and data root. Caddy exposes only the play API, authenticated WebSocket and health route through a separate hostname. Port 4200 remains private. This installation does not copy or alter shared chess or learner data.

The Vercel frontend is built into `/play/`. Its `play-config.json` must be updated only after the intended HTTPS and WSS service is verified. Empty URLs select the same origin for local preview. A successful local test does not establish AWS readiness.
