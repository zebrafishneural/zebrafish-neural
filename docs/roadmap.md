# Research and implementation roadmap

## Current baseline

The shared live controller runs in a Node.js process with Chromium, screenshot input, model-driven cursor actions, event recording, and checkpoint resume. It operates permitted Wikipedia articles on the operator computer. The homepage also provides an independent browser-local target test: target reaching, a scheduled target reversal, and a visual interruption, with scored attempts and JSON export. It uses synthetic Gaussian retinal input and unchanged model equations; it is not a shared browser-pixel experiment. A separate laboratory provides additional synthetic stimuli, a virtual arena, activity export, and an independent measured-centroid view.

The operator has launched the project token, ZNEURO, manually on Pons. The confirmed creation transaction is documented in the [token launch record](genesis.md). The controller did not perform that launch. Pons input, token-form execution, and signing remain outside the current runtime.

## Next milestone: reproducible browser experiments

Package recorded visual inputs, observation poses, model state, proposed actions, applied actions, and assistance into an aligned experiment record. Identify the model and adapter versions, viewport, preprocessing parameters, frame identifiers, and action timing.

Replay recorded inputs to check reproducibility of model outputs and action proposals. Compare ordinary operation with controls that disable motor output or change the input. Report the role of operator-supplied starting pages and scheduled article rotations separately from controller actions.

## Controlled browser evaluation

The released browser-local target test makes input changes, population response and steering visible with fixed starting conditions. Each trial resets the model state; intervention trials remain in the export and are excluded from standard success counts. This records behavior of the engineered controller without implying training or biological validation.

The next evaluation step is to use reproducible page layouts and documented visual targets with the real screenshot adapter to measure steering, action timing, link-selection outcomes, and sensitivity to contrast. Establish how stale frames, navigation, and recovery affect behavior. Results from synthetic input and screenshot input must be reported separately. These tests do not establish semantic understanding of a web page.

The next infrastructure work is a stable feed hostname and an explicit uptime/restart arrangement. Any move from the operator computer to a separate host should preserve model state, data provenance, and the distinction between host uptime and model time.

## Measured activity playback

Select a small ZAPBench recording interval and package it as a separate recording adapter with its source, license, sample interval, and processing history. Display recorded activity with its own time axis and provenance, distinguishable from a running simulation.

Completion requires a reproducible extraction procedure, a data manifest, and a verified mapping between included traces and their cell identifiers. The existing population model should not be presented as the source of the recorded activity.

## Market-data replay and paper trading

A longer-term direction is to test the controller in an environment built from historical market data, then record simulated actions in a paper-trading environment. This would require an explicit mapping from market observations to model input, defined actions and repeatable evaluation before considering any real orders. The current controller receives no market data, places no orders and does not learn from trading outcomes. No trading performance or profitability result has been established, and no delivery date is set.

## Comparison with experimental data

Establish stimulus timing, cell or regional correspondence, and a calcium observation model before fitting parameters. Separate fitting and evaluation intervals, specify temporal and behavioral metrics, and report failed as well as successful model predictions. Benchmark results should identify the exact model and dataset versions used.

## Anatomical constraints

Evaluate coordinate registration and regional labels from mapZebrain. Extend network topology only where suitable connectivity evidence is available. Record unsupported connections as assumptions and retain the distinction between morphological overlap and confirmed synaptic connectivity.

## Open development

Source code and methods are published in [zebrafishneural/zebrafish-neural](https://github.com/zebrafishneural/zebrafish-neural). The included GitHub Actions workflow runs `npm test` and `npm run check`. Issues can follow the browser-recording, controlled-evaluation, infrastructure, measured-playback, and anatomical-registration milestones above.
