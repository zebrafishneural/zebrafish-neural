# Research and implementation roadmap

## v0.1: computational baseline

The current release implements a deterministic synthetic visual–motor loop, a virtual retina and arena, a schematic model view, an independent measured-centroid view, and activity recording. Browser sessions start automatically and retain the latest 60 model seconds without a run duration limit. Model equations, data transformations, and validation limits are documented.

The shared live controller now runs in a separate Node.js process with Chromium, screenshot input, model-driven cursor actions, event recording, and checkpoint resume. The current host is the operator computer. The next infrastructure step is a persistent server and stable hostname.

## Next milestone: Genesis browser adapter

The shared screenshot-to-cursor loop is implemented on permitted Wikipedia articles. Extend and evaluate that adapter against the Pons interface without signing or broadcasting transactions. Document which actions depend on model output and which require assistance from execution software.

A later Genesis launch would connect a controller-generated action to a prepared Pons token creation flow with operator-approved signing. Completion requires an aligned experiment record and a confirmed launch transaction. Pons integration and the token launch are pending; neither is part of the current website update.

## Measured activity playback

Select a small ZAPBench recording interval and package it as a separate recording adapter with its source, license, sample interval, and processing history. Display recorded activity with its own time axis and provenance. Playback must remain distinguishable from a running simulation.

Completion requires a reproducible extraction procedure, a data manifest, and a verified mapping between included traces and their cell identifiers. The existing population model should not be presented as the source of the recorded activity.

## Comparison with experimental data

Establish stimulus timing, cell or regional correspondence, and a calcium observation model before fitting parameters. Separate fitting and evaluation intervals, specify temporal and behavioral metrics, and report failed as well as successful model predictions. Benchmark results should identify the exact model and dataset versions used.

## Anatomical constraints

Evaluate coordinate registration and regional labels from mapZebrain. Extend network topology only where suitable connectivity evidence is available. Record unsupported connections as assumptions and retain the distinction between morphological overlap and confirmed synaptic connectivity.

## External visual environments

A controlled screenshot adapter and an explicit motor-to-cursor mapping now drive the shared browser. Visual encoding, dynamics, and action mapping are documented in the live-controller methods.

The planned Pons Genesis adapter would use this boundary. Simulation remains independent of transaction execution. The current release includes permitted article navigation and no financial transactions.

## Open development

Source code and methods are published in [zebrafishneural/zebrafish-neural](https://github.com/zebrafishneural/zebrafish-neural). The included GitHub Actions workflow runs `npm test` and `npm run check`. Initial issues can follow the Genesis adapter, measured-playback, evaluation, and anatomical-registration milestones above.
