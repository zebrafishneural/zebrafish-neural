# Research and implementation roadmap

## Current baseline

The shared live controller runs in a Node.js process with Chromium, screenshot input, model-driven cursor actions, event recording, and checkpoint resume. It operates permitted Wikipedia articles on the operator computer. A separate laboratory provides a deterministic synthetic visual–motor loop, a virtual arena, activity export, and an independent measured-centroid view.

The operator has launched the project token, ZNEURO, manually on Pons. The confirmed creation transaction is documented in the [token launch record](genesis.md). The controller did not perform that launch. Pons input, token-form execution, and signing remain outside the current runtime.

## Next milestone: reproducible browser experiments

Package recorded visual inputs, observation poses, model state, proposed actions, applied actions, and assistance into an aligned experiment record. Identify the model and adapter versions, viewport, preprocessing parameters, frame identifiers, and action timing.

Replay recorded inputs to check reproducibility of model outputs and action proposals. Compare ordinary operation with controls that disable motor output or change the input. Report the role of operator-supplied starting pages and scheduled article rotations separately from controller actions.

## Controlled browser evaluation

Use reproducible page layouts and documented visual targets to measure steering, action timing, link-selection outcomes, and sensitivity to contrast. Establish how stale frames, navigation, and recovery affect behavior. These tests evaluate the engineered controller; they do not establish semantic understanding of a web page.

The next infrastructure work is a stable feed hostname and an explicit uptime/restart arrangement. Any move from the operator computer to a separate host should preserve model state, data provenance, and the distinction between host uptime and model time.

## Measured activity playback

Select a small ZAPBench recording interval and package it as a separate recording adapter with its source, license, sample interval, and processing history. Display recorded activity with its own time axis and provenance, distinguishable from a running simulation.

Completion requires a reproducible extraction procedure, a data manifest, and a verified mapping between included traces and their cell identifiers. The existing population model should not be presented as the source of the recorded activity.

## Comparison with experimental data

Establish stimulus timing, cell or regional correspondence, and a calcium observation model before fitting parameters. Separate fitting and evaluation intervals, specify temporal and behavioral metrics, and report failed as well as successful model predictions. Benchmark results should identify the exact model and dataset versions used.

## Anatomical constraints

Evaluate coordinate registration and regional labels from mapZebrain. Extend network topology only where suitable connectivity evidence is available. Record unsupported connections as assumptions and retain the distinction between morphological overlap and confirmed synaptic connectivity.

## Open development

Source code and methods are published in [zebrafishneural/zebrafish-neural](https://github.com/zebrafishneural/zebrafish-neural). The included GitHub Actions workflow runs `npm test` and `npm run check`. Issues can follow the browser-recording, controlled-evaluation, infrastructure, measured-playback, and anatomical-registration milestones above.
