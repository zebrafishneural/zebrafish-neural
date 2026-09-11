# Shared browser controller

The Live page observes one supervised Node.js process and one isolated Chromium browser on an AWS Windows server. Opening another viewer does not create another model. Closing a viewer does not stop the process. The server runs the experiment independently of viewers.

## Input and dynamics

Chromium captures a real 1,120 × 700 pixel viewport approximately twice per second. The adapter decodes the screenshot to grayscale and samples a 32 × 16 retinal field centered on the last applied cursor position and oriented with its heading. The field spans 320 pixels laterally and from 35 pixels behind to 165 pixels ahead. Sampling clamps at viewport boundaries.

The absolute difference from a 3 × 3 local mean supplies contrast. The mean contrast in each half of the retina is multiplied by 6; central contrast is multiplied by 4. Features are clamped to 0–1. Uniform white or black images therefore do not create visual drive. Threat input is zero; this adapter does not detect looming objects.

The existing eight-state population equations advance with fixed 20 ms steps in a server timer. The latest visual observation is held between captures. A slow host caps accumulated wall time rather than taking unstable integration steps; model time and process uptime are displayed separately.

## Cursor and click mapping

The model's kinematic body coordinates map directly to viewport cursor coordinates. The applied cursor, heading, and source frame identify the next observation. The interface's cursor marker is an overlay showing the applied browser position; it is not included in the neural input.

A click is proposed after central contrast remains above 0.06, spinal drive exceeds 0.025, and the absolute motor-rate difference stays below 0.08 for 1.2 model seconds. Proposals have an eight-model-second cooldown. Each proposal retains its decision coordinates, model time, and input frame identifier. These thresholds are human-designed parameters, not inferred biological behavior.

The browser accepts a proposal only when the point is an ordinary article link on the permitted domain. A rejected proposal is recorded. Motor activity near the top or bottom edge can drive a scroll, with a four-second wall-clock cooldown.

## Assistance and boundaries

The operator supplies the initial set of Wikipedia articles. The adapter rotates to the next article after three wall-clock minutes, independently of the model. These rotations are marked **assistance**, separately from **controller** clicks and scrolls. The model has no instruction to read, understand, or choose an article topic.

Navigation requests and redirects are restricted to HTTPS English Wikipedia article URLs. Account pages, namespaces, query-based actions, forms, downloads, popups, and non-GET requests are excluded. The browser uses a fresh context without the operator's accounts, wallet, or extensions. It has no typing or transaction-signing action.

## Stream and recovery

The shared service publishes real screenshots, retinal input, rates, applied cursor position, page URL, model time, session ID, and recent events over a read-only WebSocket. Spectators cannot pause, restart, or command the controller. Slow subscribers are disconnected rather than blocking the model.

Input older than four seconds suspends model actions. Navigation invalidates the prior observation; captures spanning a document change are discarded. The frontend marks delayed or disconnected streams and automatically reconnects. It never substitutes synthetic motion for missing live data.

The runtime saves population rates, body position, model time, step count, and click cooldown approximately every ten seconds. A browser failure triggers recovery. A process restart can resume a compatible checkpoint, but observation-dependent dwell and recent sample history begin again. The session ID changes when the process restarts.

## Recording and connection

The download contains the latest 60 model seconds and recent events, with original model timestamps and frame references. Event files and a checkpoint are kept on the host. This is a recent-run export rather than a complete historical screenshot archive. The operator's manual token launch is documented separately in the [token launch record](genesis.md).

The frontend is hosted on Vercel. Caddy forwards the stable HTTPS endpoint `https://feed.zebraneural.com` and its read-only `/ws` WebSocket to the browser service on the AWS host. The model continues without viewers while its supervised process is running. A host or process restart creates a new session ID and process uptime; compatible saved model state resumes separately.

The separate **Laboratory** page retains controlled synthetic-stimulus experiments. Its local browser session is independent of the shared live controller.

## Separate persistent target learner

The public [Learning controller](https://zebraneural.com/learning.html) observes a separate supervised process on the AWS host. It adjusts six connection gains through scored synthetic target-reaching trials, retains parameters that pass its validation gate, and saves the candidate, retained gains, optimizer state and generation records. Fresh-target evaluations are recorded separately from the validation results used for selection.

The page receives read-only state from `https://learning.zebraneural.com` and illustrates the saved gains with labeled local replays. These replays are distinct from the server's training trials. The Wikipedia controller still uses fixed parameters: target learning does not teach it article content, provide biological validation or connect it to a wallet.

## Implemented and pending

Shared browser capture, contrast encoding, neural cursor movement, permitted link clicks, streaming, event logs, and checkpoint resume are implemented. The controller is an eight-state zebrafish-inspired model; it is not a reconstructed whole brain. ZAPBench anatomy remains a separate measured reference.

$ZNEURO was launched manually by the project operator on Pons; its creation transaction is confirmed on Robinhood Chain. The shared Wikipedia experiment continues independently. Pons screen input, token-form execution, wallet access, and transaction signing are not connected to this runtime. The controller did not create the token and cannot create or trade tokens through the current article browser.
