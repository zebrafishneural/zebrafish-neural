# Shared Chess — local experiment

An autonomous chess match with one server-owned position for every viewer. The fish's moves come from a documented adapter around the project's eight-population controller. An automatic, seeded opponent chooses legal moves with a preference for captures, checks and promotions. Viewers watch; no player input endpoint exists.

## Run

Requires Node.js 22 or later. Run `npm install`, then `npm start` in this directory. Open <http://127.0.0.1:4196/>. Use `npm test` for the selector, storage, recovery and shared-stream checks.

The process binds only to loopback. `PORT` changes the local HTTP port; `CHESS_DATA_DIR` selects an independent data directory. A process-level loopback lease prevents two instances from owning the same data directory. Keep the terminal/process running for autonomous play. The browser does not own or advance the game.

This preview does not contact the production controller or learner, use a wallet, change learned weights, or publish to Vercel. The external navigation links open the existing project pages. The 3D Fish link opens the separate local preview on port 4195.

## How a fish move is selected

1. chess.js enumerates all legal moves in the current position, including special moves.
2. Four explicit features are calculated for each candidate: captured piece value, whether the destination is attacked, control of the four central squares, and whether the move gives check. These are handcrafted inputs, not learned perception or an engine evaluation.
3. A seeded tournament presents pairs of candidates as left/right feature cues. Each feature lasts six integration steps. Every pair is also presented with sides swapped, resetting the controller before each orientation.
4. The original external-input controller equations integrate at 20 ms per step. The six gains are fixed at `[0.5, 0.45, 1, 0.12, 0.08, 0.55]`. Motor output is integrated over each orientation; `(forward margin - swapped margin) / 2` selects the pair winner. Exact ties use recorded seeded random choices.
5. The final winning legal move and its complete decision record are saved before the new board is broadcast.

The selector uses no chess search engine. The separate opponent is a weighted random legal-move bot, not a human. New matches receive new seeds, alternate the fish's color, and cycle through four disclosed opening prefixes. Opening moves are labeled separately and are not attributed to the controller. Wins and losses result from actual play; the demo never forces an outcome. Draws include normal rule-based endings and a disclosed limit of 160 half-moves.

This controller is not trained for chess. There is no learning update after these games. Target-reaching checkpoints are not imported or modified. The Motor-to-Spinal gain affects spinal activity, but has no feedback path to the motor-difference vote. The other gains are genuine model parameters; changing a gain does not guarantee a different selected move.

## What the visualization means

The brain uses the site's existing `BrainView` component. Its eight rates are the actual states emitted during candidate selection. Its dense geometry is a synthetic illustration of those populations, not measured neuron coordinates or a biological connectome. “Left” and “right” indicate the two candidate input channels, not chessboard directions. The 32 × 16 input image is reconstructed from the published feature cue.

The runtime advances multiple model samples per timer tick to keep the match watchable. The browser displays the latest emitted sample and labels samples held between comparisons. The full sampled trace is saved in the decision JSON. Disconnection stops live updates and displays a stale connection state; the server can continue while no browser is open.

## Records and recovery

The local `data` directory contains the active checkpoint, its previous verified version, immutable decision files and finished-game archives. Checkpoint writes are atomic, verified with canonical JSON SHA-256 digests, and fail closed on corruption. Hashes detect content changes; they are not a public signature or a tamper-proof external ledger.

A pending move's seed and position are committed before comparison begins. If interrupted, that uncommitted comparison runs again from its start with the same inputs and seed. Finished moves retain the complete legal history, including the history needed for repetition rules. Records are committed before viewers see a move. A completed game whose archive write was interrupted is recovered from the checkpoint.

- `GET /api/state` — current authoritative snapshot
- `WS /ws` — read-only snapshot stream with per-boot stream ID and sequence numbers
- `GET /api/games` — completed-game summaries
- `GET /api/games/:id` — current or archived game JSON
- `GET /api/games/:id.pgn` — PGN export
- `GET /api/games/:id/moves/:ply` — a recorded fish decision with all candidate features, comparisons, samples and parameters

The move inspector is local to each viewer and does not change the shared board. No endpoint resets a game or accepts a move. POST requests and unrecognized browser origins are rejected. Public hosting would require a separate supervised service and deployment review; this preview remains local.

## Source provenance

- `public/lib/model.js` and `public/lib/brain-view.js`: copied from the existing [Zebrafish Neural project](https://github.com/zebrafishneural/zebrafish-neural). The UI uses the same population labels and visual component.
- `public/lib/chess.js`: pinned [chess.js 1.4.0](https://github.com/jhlywa/chess.js/tree/v1.4.0), BSD-2-Clause; license included beside the file.
- `ws`: pinned 8.21.3, MIT; its license is included with the installed dependency.

The model geometry and this chess adapter are software components. This demo bundles no ZAPBench data.
