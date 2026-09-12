# Operator notes

## Chess release — 12 September 2026

The chess backend now runs independently on AWS Windows, using source pinned to `7ddcfde`. Its public read-only endpoints are `https://chess-feed.zebraneural.com` and `wss://chess-feed.zebraneural.com/ws`. The connection for the Vercel frontend at `https://zebraneural.com/chess/` is configured in `dist/chess/chess-config.json`. The existing AWS feed (`feed.zebraneural.com`) and persistent learner (`learning.zebraneural.com`) are preserved; model equations, training behavior and chess methods are unchanged.

The application is at `C:/ZebrafishNeuralChess/app`, with persistent state at `C:/ZebrafishNeuralChess/data`. The `ZebraChessService` account runs one headless game owner and one read-only relay. The owner listens privately on loopback port 4196 and the relay on loopback port 4396. Inspect the installed service-account tasks before restarting either process; do not start another `npm run chess` against the same data directory.

The validated transfer contained 685 files, including 668 decisions and 15 game archives. Its final active position was game 16, `chess-000016-ef4b806e`, at ply 33. The AWS owner advanced after import. The personal-computer owner is retired, and its data remains frozen as a backup. That computer's power and internet connection no longer affect the live backend.

The relay accepts only game state, saved game/decision records and read-only WebSocket snapshots. It shares one upstream connection, sends up to five public visual samples per second plus immediate position/status changes, and supports up to 128 simultaneous spectators with compression and bounded buffering. This is a configured ceiling, not a claim of load-tested capacity. Full decision traces remain available through the record endpoint. No desktop, browser feed, shell or project-file route is exposed through the chess relay.

The stable public hostname routes to the private read-only relay. Configure its HTTPS/WSS endpoints in `dist/chess/chess-config.json`, deploy the frontend and verify advancing positions before declaring the frontend cutover complete.

Restart recovers committed moves and recomputes an unfinished decision using its recorded seed. Do not copy or replace the Wikipedia/learning data directories for a chess update. To roll back ownership, stop the AWS owner and transfer and validate its latest state before starting a replacement owner. Resuming the frozen personal-computer backup after AWS has advanced would fork the game history. `npm run test:chess` checks chess, storage, recovery and relay behavior. The local standalone package has the same tests available with `npm test`.

`node scripts/build-chess.mjs` copies only the chess frontend into `dist/chess` and retains its existing connection configuration. The build never copies runtime data. The public homepage contains both a top-navigation link and a third experiment link beside Wikipedia and Target test.

## Historical original Wikipedia hosting notes

The model-process and Quick Tunnel instructions below document the original personal-computer deployment. They are retained for reference and do not describe the current AWS feed, persistent learner or chess backend. Their computer uptime and tunnel restart requirements no longer apply to the live AWS services.

The original public frontend was https://zebraneural.com, hosted on Vercel. Its live feed came from an isolated Chromium process on the operator's computer through an HTTPS tunnel. Closing a viewer did not stop that process; the original host needed to stay awake and online.

## Model process

Run these commands from the project directory in PowerShell:

```powershell
./runtime/local-host.ps1 -Action Status
./runtime/local-host.ps1 -Action Start
# To intentionally stop the model:
./runtime/local-host.ps1 -Action Stop
```

Start is idempotent when the supervisor is already running. The supervisor retries after a model-process exit. Checkpoints and local event logs are under ignored `runtime/data/`. No startup task has been installed for Windows login.

## Public feed after a computer or tunnel restart

The current feed uses a Cloudflare Quick Tunnel. Its URL is temporary and may change on restart. The model and the tunnel are separate processes; starting the model alone does not restore public access.

1. Start the model and confirm its status.
2. Start `cloudflared tunnel --url http://127.0.0.1:4388 --no-autoupdate --protocol quic` using an installed cloudflared executable. Keep that process running. Install cloudflared separately from its official release.
3. Copy the new HTTPS URL reported by cloudflared into the `endpoint` property of `dist/live-config.json`.
4. Deploy the updated frontend with `npx vercel deploy --prod` from this linked project.
5. Open https://zebraneural.com and confirm Live status, a fresh frame age, and advancing model time. A disconnected page reports the interruption.

A persistent tunnel hostname or a separately hosted runtime would remove the URL update on restarts. The current setup remains on this computer as requested.

## Frontend and privacy boundaries

Vercel publishes `dist/` and uses `vercel.json`. Runtime state, local environment files, and browser profiles are not served by the frontend. The browser starts with a fresh context and receives only permitted Wikipedia article pages. It does not capture the desktop, personal tabs, or files. The public feed is read-only.

## Browser-local target test

The homepage defaults to Wikipedia. Target test, also reachable at `/#target-test`, runs independently in each visitor's browser using synthetic retinal input and the unchanged eight-state model. It does not require a second server, send viewer actions to the shared host, or capture any desktop. The existing website layout and brain visualization are retained.

The local target model pauses when its tab is hidden or Wikipedia mode is selected. The shared Wikipedia process continues; switching modes does not stop it. The JSON export follows the selected mode: the current local target session or the shared recent-run recording. Target trial records, including failures and interventions, are memory-only and are lost on reset, reload or closing the page. They are not part of runtime checkpoints or host logs.

Verify mode switching, the direct target URL, trial completion, input interruption and both exports after a frontend release. The target adapter is `target-task-0.1.0`; the population model remains `zebra-rate-0.1.0`. See [target methods](docs/target-test.md). This feature does not migrate the host or change the shared feed's approximately 2 Hz screenshot rate.

## Token scope

The project operator launched ZNEURO manually on Pons. The [launch record](docs/genesis.md) contains the contract address and confirmed Robinhood Chain creation transaction. The Wikipedia controller continues its existing experiment independently; it did not perform the launch. Its runtime has no Pons integration, wallet access, transaction signing, or token-creation action.
