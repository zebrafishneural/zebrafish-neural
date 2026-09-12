# Operator notes

## Chess release — 12 September 2026

The new `https://zebraneural.com/chess/` view uses an independent chess process on the operator's computer. This release does not change the AWS feed (`feed.zebraneural.com`) or persistent learner (`learning.zebraneural.com`). Earlier browser-tunnel setup notes below describe the original deployment and are not the current AWS cutover instructions.

`npm run chess` starts the game on loopback port 4196. `npm run chess:relay` starts its read-only relay on loopback port 4396. Start each command in a separate terminal. The active local preview currently runs from the separate `outputs/zebra-shared-chess-demo` directory; do not start another game against a different data directory if you intend to preserve that match. Copy validated data with the original process stopped before moving ownership to this checkout.

The relay accepts only game state, saved game/decision records and read-only WebSocket snapshots. It shares one upstream connection, sends up to five public visual samples per second plus immediate position/status changes, and supports up to 128 simultaneous spectators with compression and bounded buffering. This is a configured ceiling, not a claim of load-tested capacity. Full decision traces remain available through the record endpoint. No desktop, browser feed, shell or project-file route is exposed through the chess relay.

The temporary public bridge is a Cloudflare Quick Tunnel to `http://127.0.0.1:4396` with `--http-host-header 127.0.0.1:4396`. Its HTTPS/WSS URL is configured in `dist/chess/chess-config.json`; a restarted Quick Tunnel can have a different URL, requiring that file and the frontend to be redeployed. Keep the computer awake and the game, relay and tunnel processes running. A stable named tunnel or server migration is the next operational improvement.

The game saves to its own ignored `data/` directory. Restart recovers committed moves and recomputes an unfinished decision using its recorded seed. Do not copy or replace the Wikipedia/learning data directories for a chess update. `npm run test:chess` checks chess, storage, recovery and relay behavior. The local standalone package has the same tests available with `npm test`.

`node scripts/build-chess.mjs` copies only the chess frontend into `dist/chess` and retains its existing connection configuration. The build never copies runtime data. The public homepage contains both a top-navigation link and a third experiment link beside Wikipedia and Target test.

The public frontend is https://zebraneural.com, hosted on Vercel. Its live feed comes from an isolated Chromium process on this computer through an HTTPS tunnel. Closing a viewer does not stop that process. The computer must stay awake and online.

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
