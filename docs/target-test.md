# Browser-local target test

**Model:** `zebra-rate-0.1.0` · **Task adapter:** `target-task-0.1.0`

The Target test puts the existing eight-state controller in a small, measurable visual task. A target produces synthetic retinal input; the population model generates steering and forward movement; the task records whether the cursor reaches the target. The model equations and coefficients are unchanged. There is no learning between attempts.

Open [Target test](https://zebraneural.com/#target-test) directly, or select Target test beside Wikipedia on the homepage. The homepage opens the shared Wikipedia run by default. Each visitor's target experiment runs separately in that visitor's browser. It does not send commands to the shared Wikipedia controller.

## Two input adapters, one population model

| | Wikipedia | Target test |
| --- | --- | --- |
| Execution | One shared Node.js host and isolated Chromium context | A separate simulation in each viewer's browser |
| Visual input | A heading-oriented crop of a real browser screenshot, encoded as local contrast | A 32 × 16 Gaussian stimulus generated from virtual target bearing and distance |
| Movement | Model motor output applied to the isolated browser cursor | Model motor output moves a cursor in normalized arena coordinates |
| Observation | Shared browser frames, model rates and action log | Local arena, synthetic retina, model rates and trial log |
| Viewer controls | Read-only | Protocol, target placement, input interruption, pause and reset |

The target test does not take screenshots of the arena or the viewer's desktop. The target position is used to construct the sensory stimulus and score contact. It does not directly set cursor position or motor output. Labels, paths and other observer overlays are excluded from model input.

The same illustrative brain view displays the eight population rates. Its 5,220 drawing points are a visualization of those eight values, not independent neurons or recorded biological activity. The separate ZAPBench anatomy view remains independent of these dynamics.

## Protocols and scoring

Each attempt starts at `(x=0.5, y=0.75)`, facing upward with heading `−π/2`, and all eight rates reset to zero. Input intensity is `0.85`. Numerical integration uses fixed `0.02` model-second steps at both display speed settings.

| Protocol | Scheduled change | Scored contact |
| --- | --- | --- |
| Target reaching | Target remains at its initial position | Contact with the target |
| Target reversal | At 4 model seconds, target x becomes `1−x`; a target on the centerline moves to `x=0.8` | Only contact after the scheduled change counts |
| Input occlusion | Visual contrast is removed from 3 to 8 model seconds, or until the attempt ends | Contact with the target, including contact during the interruption |

An attempt is reached when the cursor lies within `0.065` normalized arena units of the target, with a limit of 30 model seconds. Contact on the final numerical step is checked before timeout. Position and distance use normalized coordinates, not physical lengths or screen pixels. Path length is accumulated from successive cursor positions. Contact time is elapsed model time for a reached attempt; it is absent for a miss or interruption.

Each protocol advances independently through the same fixed eight-target sequence, then repeats it:

```text
(0.25, 0.25), (0.75, 0.25), (0.50, 0.22), (0.20, 0.40),
(0.80, 0.40), (0.35, 0.18), (0.65, 0.18), (0.50, 0.35)
```

The sequence provides repeatable starting conditions. It is not a sampled biological benchmark or evidence of general task competence. Repeated trajectories from identical initial conditions reflect deterministic equations, not learning.

## Controls and interventions

Clicking the arena moves the target. Hide stimulus removes visual contrast; restoring it allows input to drive the rates again. Residual model activity can decay after input disappears, so motion need not stop immediately. These observer actions are logged and mark that attempt as an intervention.

Next target or a protocol change ends an unfinished attempt as Interrupted and starts a fresh state. The standard reached/trials count includes completed, uninterrupted attempts for the selected protocol only. Attempts with observer interventions and interrupted attempts remain in the records and export, but are excluded from that count. Reversal and occlusion scheduled by a protocol are part of the standard condition.

Pause preserves the current target, state and model time. The 4× setting requests faster model time while keeping the integration step unchanged; rendering and browser scheduling can limit wall-clock speed. Target simulation pauses when its browser tab is hidden or Wikipedia mode is selected. Returning does not simulate the elapsed hidden interval. The shared Wikipedia host continues independently.

## Session records and retention

Export session JSON while Target test is selected to save the current local target session. It includes model and task adapter versions, settings, the target sequence, completed attempts, outcomes, intervention events and sampled trajectories, plus the current unfinished attempt if one exists. Samples are taken every `0.1` model seconds and at trial start and finish. Each sample includes pose, model rates, input features, target visibility and accumulated path.

The target session is held in browser memory. Reset session, reload or closing the page discards that session; there is no automatic upload, daily archive or server checkpoint for target tests. Export before leaving if the record is needed. This differs from the shared Wikipedia host's checkpoints and bounded recent-run recording. Selecting Wikipedia changes the export control to that shared run's recording.

Inspect results by protocol and retain failed and intervened attempts alongside successes. The export enables inspection of these software runs; it does not constitute biological validation, a trained model or a research result about zebrafish behavior.

## Scope and deployment

The feature runs alongside the original website interface and uses its existing brain, retina and event panels. It remains a browser-local experiment with no learning between attempts. The shared Wikipedia runtime now runs separately on a supervised AWS Windows host; its screenshot feed remains approximately 2 Hz.

The public [Learning controller](https://zebraneural.com/learning.html) is a separate experiment that adjusts and saves six gains through scored synthetic trials. Its server checkpoints and generation history do not change the local target test's parameters or session-retention rules.

Neither experiment captures the operator's desktop or uses a wallet. The target experiment has no token-launch action, signing capability or control over the shared browser. The token contract and operator-launched record are unchanged.
