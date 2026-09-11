# Challenge the fish

Open [Challenge](https://zebraneural.com/challenge.html) to compare the original controller with a frozen copy of six saved gains on a task you configure. Both controllers start from the same pose and follow the same target schedule. Their movement comes from the same eight-state population equations; different trajectories produce different retinal observations.

This is a separate, browser-local experiment. It does not train either controller, change the shared learner's weights, or send commands to the Wikipedia browser.

## Task and input

Each arm starts at `(x=0.5, y=0.8)`, facing upward at `−π/2`, with all eight rates at zero. Integration uses fixed `0.02` model-second steps and a maximum duration of 30 model seconds. The original arm uses the published baseline gains; the comparison arm uses the exact six gains selected when the challenge opens. Both sets stay fixed throughout the trial.

Target bearing and distance generate the existing synthetic 32 × 16 retinal stimulus. Target coordinates supply the stimulus and contact scoring; they do not directly set motor output or move the cursor. There are no screenshots, desktop images, taste sensors or language-model actions in this task. Rates are normalized, unitless model values rather than measured spikes.

| Starting task | Schedule |
| --- | --- |
| First contact | A stationary visible target |
| Moving target | Horizontal movement with reflection at the arena bounds |
| Switch sides | Target x becomes `1−x` at 4 model seconds; only later contact counts |
| Lights out | Visual input is removed at 4 seconds and restored 3 seconds later |

The controls can change target position, motion, contrast, contact radius and the occlusion schedule. Target x is bounded to `0.1–0.9`, y to `0.1–0.85`, and the initial target must be outside the contact radius. Sweep speed is `0.06 × speed` arena units per model second, with speed from `0.2–1.5`. Contrast ranges from `0.15–1` and contact radius from `0.035–0.09`. Occlusion can begin at `2–12` seconds and last `1–8` seconds. These are task parameters, not biological units.

Editing a task resets its trial. Pause and playback speed affect only the local presentation; integration steps and scoring stay the same. The local run suspends while its tab is hidden. None of these controls pause or reset the AWS learner.

## Outcomes

An arm reaches the target when its cursor lies within the configured contact radius, subject to the switch task's post-switch condition. The same radius is used for the observer's target circle and the contact test. Contact is checked before timeout on the final step. Each arm records success or timeout, time to target, path length and closest distance. A miss has no time to target; its time cost is the full 30-second limit.

Both arms receive the same target position, motion, visibility schedule and contrast. Each arm's own pose determines its retinal input. A comparison can end with either arm faster, only one successful, a tie or two misses. Those outcomes are retained without treating the saved gains as a guaranteed improvement.

## Server recomputation

After a completed trial, a separate Vercel server execution recomputes both arms from the submitted task configuration and exact gains. The request contains inputs, not a score for the server to accept. The page compares the returned outcomes with its local results and reports an unavailable or failed check explicitly.

This verifies reproducibility under the same software model and inputs. It does not independently authenticate the source of submitted gains, constitute peer review, or establish biological validity. The response identifier identifies that calculation; it is not a signed certificate or a permanent archived result.

The parameter endpoint reads the public learner's saved gains. If that request fails, the page labels the original-parameter fallback. Recomputing a submitted challenge uses its pinned gains and does not replace them with a newer checkpoint. No verification request writes to AWS training state.

## Sharing and records

A public challenge link includes the task version, validated configuration and exact six gains. Reopening it reproduces those inputs even after the shared learner advances. Any generation or source metadata carried by a link is supplied metadata; server recomputation does not attest its origin.

Download result JSON to retain the configuration, original and comparison gains, trajectories, actual results, events and any server-check response. Local progress is held in browser memory; reload or closing the page ends that run. A share link describes an experiment to repeat, rather than a saved claim about its outcome.

## Interpretation

Visitor-designed challenges are exploratory software tests. Repeatedly adjusting a task is not an independent held-out benchmark, and one success does not show broad superiority. The shared learner's training, validation gate and fresh-target evaluations remain separate from these comparisons. The controller is an engineered eight-state model, not a reconstructed whole zebrafish brain; measured ZAPBench anatomy remains a separate reference. This experiment provides no wallet access, token launch or trading action.
