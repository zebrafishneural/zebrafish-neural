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

## Verification

```powershell
npm.cmd run test:chess-play
node --test experiments/chess-play/ops/supervisor.test.mjs
node experiments/chess-play/ops/verify-local.mjs
```

Tests cover private session boundaries, legality, duplicate and stale requests, exact selector agreement, complete feature-phase streaming, queues and limits, checkpoint/record integrity, interrupted decision recovery, retention and quota recovery, HTTP/CORS and authenticated WebSockets.

## Deployment

See [`../../docs/chess-play.md`](../../docs/chess-play.md) and [`ops/AWS-HANDOFF.txt`](ops/AWS-HANDOFF.txt). The Windows installation uses a dedicated account, task and data root. Caddy exposes only the play API, authenticated WebSocket and health route through a separate hostname. Port 4200 remains private. This installation does not copy or alter shared chess or learner data.

The Vercel frontend is built into `/play/`. Its `play-config.json` must be updated only after the intended HTTPS and WSS service is verified. Empty URLs select the same origin for local preview. A successful local test does not establish AWS readiness.
