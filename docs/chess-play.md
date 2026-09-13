# You vs the Fish

Each visitor gets a private chess game against the zebrafish-inspired controller. The server validates human moves, runs the fish's move selection, and saves committed positions. The board, 3D fish, candidate moves and eight-state activity trace show the same server decision. The existing shared, autonomous chess experiment remains a separate service and page.

This is a view of a computational decision process. The activity display is not a measurement of an animal's thoughts, a language-model explanation, or a reconstructed whole zebrafish brain. The chess adapter maps engineered position features into the rate model and scores legal candidates; see [chess methods](chess.md) and [model equations](model.md). This release does not train the model from human games or change the target learner's saved gains.

## Hosting boundary

| Component | Location | Role |
| --- | --- | --- |
| Player page | `https://zebraneural.com/play/` on Vercel | Board, controls, activity and private game credential |
| Play service | `127.0.0.1:4200` on AWS Windows | Authoritative private sessions and fish decisions |
| Public edge | `https://play-feed.zebraneural.com` | Caddy HTTPS and authenticated `/play-ws` |
| Installation | `C:\ZebrafishNeuralPlay\app` | Pinned complete source checkout |
| Persistent data | `C:\ZebrafishNeuralPlay\data` | Independent play-session state |
| Service identity | `ZebraPlayService` | Non-administrator account for this service only |
| Windows task | `ZebrafishNeuralPlay` | Gated startup and bounded restart policy |

The hostname and task are a deployment plan until the operator verifies them on AWS. The repository alone does not prove DNS, TLS, public availability or reboot recovery. The existing `feed`, `learning`, and `chess-feed` hostnames, service identities and data directories must remain unchanged.

## Authentication and protocol

`POST /api/play/games` with `{"color":"w"}`, `"b"` or `"random"` creates a session and returns `{gameId, token, state}`. There is no public game directory. The opaque token is the authority to read or act in that game; treat it as a credential. Do not publish it in URLs, analytics, logs, screenshots or bug reports. A different visitor cannot join or move in a game simply by learning its game ID.

Subsequent HTTP requests use `Authorization: Bearer <token>`. Mutating requests also require an exact allowed `Origin` and `Content-Type: application/json`. Browser cross-origin responses allow only configured origins; CORS is not a replacement for session authentication.

| Request | Purpose |
| --- | --- |
| `GET /healthz` | Small health response without player details or credentials |
| `GET /api/play/games/:id` | Authenticated current state |
| `POST /api/play/games/:id/move` | `{from,to,promotion?,expectedPly,requestId}` |
| `POST /api/play/games/:id/resign` | `{expectedPly,requestId}` ends the authenticated player's game |
| `GET /api/play/games/:id/moves/:ply` | Saved fish decision at a committed ply; human plies have no fish trace |
| `GET /api/play/games/:id/pgn` | Authenticated PGN export |
| `GET /play-ws` | WebSocket upgrade; authenticate in the first frame |

The first WebSocket message is `{"type":"subscribe","gameId":"...","token":"..."}`. Tokens are never query parameters. The stream sends direct snapshots with `game`, `status`, `selection`, `humanColor`, `streamId`, and `seq`. Further client messages are forbidden; moves use the authenticated HTTP route. Multiple tabs for one game observe the same authoritative position. Different sessions have separate positions, credentials and decision histories.

Moves carry both an expected ply and a unique request ID. A network retry uses the same ID and body, so it cannot apply a move twice. Illegal moves return `400`; an out-of-date position, wrong turn, finished game or incompatible reused request ID returns `409`. Missing or wrong credentials return `401`; expired sessions return `410`; exhausted capacity returns `503`. The page should reconnect and retrieve committed state after an interruption instead of assuming its last request failed.

Default resource limits are 128 sessions, two concurrent fish comparisons, a 24-hour session lifetime, 160 plies per game, and 512 MiB of game data. Session creation is limited to four per minute per source IP and forty globally per minute. These are bounds, not a measured concurrent-player capacity or uptime guarantee. Load-test on the actual AWS instance before increasing them. A browser refresh must resume a known game rather than create another on every reconnect.

## Saved state and recovery

Each session has a `play_<32 hex characters>.json` checkpoint and separate `play_<id>-<ply>.json` fish decision records in its own data directory. The checkpoint includes the token hash, committed game, request IDs, expiry and any pending decision seed/FEN. Writes use a temporary file, a flush and an atomic rename; the SHA-256 wrapper detects record corruption. This is an integrity check, not a public signature or encryption.

A human move and pending fish decision are committed together before the job enters the queue. After an interruption the service restarts that decision from its saved seed and position; it does not resume at the exact animation frame. A fish decision record is written before its resulting move is committed, and an orphan record is unavailable through the API until that ply is committed. Persisted request IDs make an already-committed human move safe to retry after restart.

Sessions expire 24 hours after creation. Expired API requests return `410` while the session is still present, and streams close; a removed session can no longer be authenticated. Their local session/decision files are reclaimed every minute, on a subsequent new-game creation, and at service startup. These games are therefore temporary sessions, not a permanent public research archive. Export PGN before expiry if a game needs to be retained. This cleanup never targets the autonomous chess or learning directories.

## Windows preparation

Use a new complete checkout at `C:\ZebrafishNeuralPlay\app`, pinned to the reviewed release commit. Do not install over `C:\ZebrafishNeuralChess\app` or copy its game history into this service. Install Node.js 22 or newer and locked dependencies with `npm.cmd ci`, then run the play tests and `node --test experiments/chess-play/ops/supervisor.test.mjs`. The additional `node experiments/chess-play/ops/verify-local.mjs` runs the HTTP/WS verification against disposable data on a dynamically allocated loopback port. It does not establish public TLS or AWS readiness.

In an elevated PowerShell window, supply a dedicated account password through the credential dialog:

```powershell
$playCredential = Get-Credential -UserName "$env:COMPUTERNAME\ZebraPlayService" -Message 'Dedicated local play-service account'
& 'C:\ZebrafishNeuralPlay\app\experiments\chess-play\ops\prepare-windows.ps1' -ServiceCredential $playCredential
Remove-Variable playCredential
```

The preparation script creates the local account if absent, rejects an administrator account, configures an independent task **disabled in its initial definition**, and leaves the activation marker absent. It grants read access to code/configuration and write access to this service's data, logs and runtime directories. Inspect the effective ACLs before activation, especially if files came from an existing directory with explicit permissions. Existing account passwords are not reset. Task Scheduler stores the supplied logon credential; no password is written into the application configuration.

The script sets `PLAY_PORT=4200`, `PLAY_DATA_DIR=C:\ZebrafishNeuralPlay\data`, `PLAY_ORIGINS=https://zebraneural.com`, and `PLAY_TRUST_PROXY=loopback`. The trust setting is appropriate only when the supplied Caddy proxy connects directly from the same host and overwrites `X-Forwarded-For` with its actual remote peer. Do not put a second proxy in front without reviewing how client addresses reach the rate limiter.

The task launches the shipped `host-service.mjs` runner using an absolute `node.exe` path, starts at boot without an interactive login, ignores duplicate starts, and retries a failed run after one minute for up to 999 attempts. Its healthy execution time is unlimited. The runner imports the backend in the same Node process, so there is no child owner to orphan. It keeps stdout and stderr to five files of at most 5 MiB each, and records its exact PID under `runtime\owner.json`. A missing production gate starts no backend. A raw-port inbound block is added for 4200; no allow rule is added.

Preparation is not an activation or a reboot test. The script does not create DNS, edit Caddy, change AWS security groups, deploy Vercel, restart another application, or reboot the server.

## DNS and the HTTPS edge

Create one DNS A record: `play-feed.zebraneural.com` → `16.192.97.162`. Preserve all other records. Reuse the existing supervised Caddy installation and certificate storage. Back up its active configuration, append only [the play host block](../experiments/chess-play/ops/Caddyfile.play.template), validate the **complete** resulting configuration, and perform one validated reload. Never replace existing host or global blocks with this snippet.

The new host proxies only `/healthz`, `/api/play/*`, and `/play-ws` to loopback. Everything else receives `404`. It preserves `Origin` and `Authorization`, overwrites the client-IP header, and handles WebSocket upgrades. Do not add permissive CORS headers, a hardcoded trusted Origin, a public file server, or a route to any other port. Keep 4200 private in both Windows and AWS; retain private protection for existing service/admin ports. A successful external connection test does not constitute an AWS security-group audit.

Until the new service is activated, allowed routes may return `502`. That is expected preparation behavior, not proof the application is running. Check public and server-origin DNS, trusted certificates without disabling validation, HTTP-to-HTTPS redirects, and rejection of project/config/data paths. A Caddy reload can reconnect current streams; verify advancing Wikipedia frames, the learner, and the existing shared chess game afterward. Roll back only the new Caddy change if preservation checks fail.

References: [Caddy reverse proxy and WebSocket behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Caddy validated reload](https://caddyserver.com/docs/command-line#caddy-reload), [Windows task settings](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset).

## Activation and verification

After preparation, code tests and DNS/TLS checks succeed, explicitly activate only the new service:

```powershell
& 'C:\ZebrafishNeuralPlay\app\experiments\chess-play\ops\activate-windows.ps1' -Action Start
```

This creates `C:\ZebrafishNeuralPlay\ops\production.enabled`, enables the task, starts it, and waits for loopback health. It does not report public readiness. Verify exactly one play-service Node process against the task action and `owner.json`, and confirm the API listener is loopback 4200. A separate data-ownership lease also binds a derived loopback-only port; it is not an API or public route. Do not infer process identity from `node.exe` alone.

From a different computer, with the repository's locked dependencies installed:

```powershell
node experiments/chess-play/ops/verify-public.mjs https://play-feed.zebraneural.com https://zebraneural.com 16.192.97.162
```

The checker deliberately creates two private test games, plays one human move, waits for a real fish response, verifies same-game WSS consistency and different-game isolation, tests missing/wrong credentials and denied origins, checks exports, and attempts an external connection to raw port 4200. It resigns its test games afterward. Reports contain no game tokens. Do not run it repeatedly against rate limits; a failed or incomplete probe is not a pass.

Before public release, also verify the real `/play/` page on desktop and mobile: select each color, promote a pawn, inspect a saved fish decision, recover after refresh/disconnection, resign, start a new game, and export PGN. Confirm observed activity belongs to that game and a visible comparison can be distinguished from a committed move. The original homepage, Wikipedia, target test, learning, challenge, and shared chess links must continue to work.

A Task Scheduler startup trigger is configuration evidence only. Perform crash recovery and RDP-disconnection tests against the new service and inspect saved games before claiming them passed. Schedule an actual AWS reboot only when an appropriate maintenance window has been agreed for **all** hosted experiments, then verify new and existing services afterward. Report reboot readiness as untested until that test actually occurs.

Only after public checks pass should the frontend configuration point `/play/` to this HTTPS/WSS host and the announcement call it live. Rollback can remove the new navigation link or disable the new frontend entry without changing `/chess/` or the other experiments.

## Stopping and updating

```powershell
& 'C:\ZebrafishNeuralPlay\app\experiments\chess-play\ops\activate-windows.ps1' -Action Status
& 'C:\ZebrafishNeuralPlay\app\experiments\chess-play\ops\activate-windows.ps1' -Action Stop
```

Stop disables this task and removes its gate. The runner notices within one second and calls the backend's graceful shutdown in the same process. Recovery still uses committed state because a power loss or forced Windows termination can be abrupt. The command reports a remaining listener or ownership record instead of killing arbitrary processes. Diagnose only the recorded PID after checking its command line.

For a code update, stop this service, confirm its listener is gone, back up the complete `data` directory and installed release metadata, then install a reviewed pinned revision and its lockfile in `app`. Run tests on isolated data and reactivate. Never overwrite, discard or merge the play data as part of a frontend deployment. Keep state backups private: possession of recoverable session credentials or full records may disclose individual games. Rollback after a schema change requires the matching code and validated data backup; do not blindly resume incompatible data.
