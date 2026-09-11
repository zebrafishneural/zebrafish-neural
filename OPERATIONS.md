# Operator notes

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

Pons integration and transaction signing are pending. The current article browser has no wallet or token-creation action.
