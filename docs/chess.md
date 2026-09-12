# Watch the Fish Play Chess

Open [the chess experiment](../dist/chess/). One server owns the game; all spectators see the same committed position. The process runs on the operator's computer for this release. Closing a spectator tab does not stop it. If that computer or its connection goes offline, the page reports the interruption and retains its last received state.

## Players and outcomes

The fish alternates between White and Black across games. The page identifies its color and last move beside the existing 3D fish model. Its opponent is an automatic, seeded bot that samples legal moves with a preference for captures, checks and promotions. No human plays either side in this release.

New games use new seeds and cycle through four disclosed starting prefixes: the normal starting position, `d4 d5`, `e4 e5`, and `Nf3 d5`. Prefix moves are labeled Opening; they are not attributed to the controller. Wins and losses follow actual checkmate. Draws include stalemate, insufficient material, repetition, the fifty-move rule and a disclosed 160-half-move limit. No result is predetermined.

## Board to neural input

chess.js enumerates every legal move. A handcrafted adapter measures four features for each candidate: captured piece value, whether its destination is attacked, control of the four central squares, and whether it gives check. These features do not constitute learned board perception or a chess engine search.

A seeded tournament presents two candidates through the controller's left and right input channels. Each feature is presented for six 20 ms steps. Every pair is compared again with its channels swapped and the model reset. All eight population states come from the same external-input equations used by the existing controller.

The vote integrates Motor L minus Motor R during each orientation. The combined margin is `(forward margin - swapped margin) / 2`. A positive margin selects the first candidate, a negative margin the second; exact ties use a recorded seeded draw. The winning candidate advances until one legal move remains. chess.js applies that selected move to the board.

## What viewers can inspect

The brain panel shows actual population rates from this selection process using the site's existing illustrative geometry. Left and right identify candidate input channels, not directions on the board. The 3D fish is a visual representation of the controller; its movement reflects received motor/spinal activity.

Each recorded fish move exposes all candidate features, pairwise margins, tie-breaks, parameters and sampled rates. Game JSON and PGN downloads preserve the full move history. Selecting a historical move changes only that viewer's inspector, not the live game.

## Training status and reproducibility

The chess experiment uses the original six frozen gains: `[0.5, 0.45, 1, 0.12, 0.08, 0.55]`. It performs no chess training or weight updates. The target-reaching learner remains a separate experiment; its learned checkpoints are not imported into this chess selector. The Motor-to-Spinal gain changes spinal activity but cannot change the motor vote because this model has no feedback from spinal drive to motor output.

The pending position and decision seed are saved before comparison starts. After an interruption, the unfinished decision is recomputed deterministically from its beginning. Completed decisions and full board history are retained. File hashes detect corruption; they are not an externally signed ledger. This release supports an inspectable engineering experiment, not a claim that zebrafish naturally play chess or that the model has biological chess competence.

Source: [chess implementation and tests](https://github.com/zebrafishneural/zebrafish-neural/tree/main/experiments/chess). Chess rules: [chess.js](https://github.com/jhlywa/chess.js), pinned version 1.4.0.
