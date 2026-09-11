# Zebrafish Neural Genesis

**Project:** Zebrafish Neural · **Planned ticker:** $ZNEURO · **Updates:** [@zebrafishneural](https://x.com/zebrafishneural)

## Project objective

**A token launched through a zebrafish-inspired neural controller.**

This describes the proposed Genesis experiment. A launch performed through this controller has not yet been demonstrated. The website streams a shared controller operating a real browser, and provides a separate controlled laboratory. Pons integration and the token launch are pending.

## Proposed mechanism

1. A browser adapter samples the Pons screen and encodes it as retinal input.
2. The model processes that input. An explicit action mapping translates motor outputs into cursor movement.
3. A controller-generated action triggers a prepared token launch. The operator supplies the token details and economic settings and approves transaction signing.
4. The experiment records its inputs, model outputs, browser actions and transaction result together. A completed Genesis record must include a confirmed transaction, not just a click or a signing request.

The adapter, action mapping and execution software are human-designed parts of the experiment. Any automated assistance must be identified in the event log. The controller would not independently invent the token's identity, choose its economic settings or authorize spending.

## Current implementation

| Component | Status |
| --- | --- |
| Synthetic retinal input and eight-state model | Implemented |
| Virtual fish movement and activity export | Implemented |
| Measured ZAPBench cell positions | Included as separate reference geometry |
| Shared browser screenshot input and cursor control | Implemented for permitted Wikipedia articles |
| Pons screen and token-creation flow | Not connected |
| Wallet signing and token creation | Not implemented |
| Controller-driven launch demonstration | Pending |
| Genesis transaction | Pending |

The shared controller runs independently of viewers while the operator computer is awake and connected. Its browser screenshots, model rates and actions are broadcast to all spectators. The separate laboratory retains local synthetic experiments. The shared browser does not control Pons, connect a wallet or send a transaction. There is no token address or launch transaction attributed to this controller in this release.

## Evidence for a future Genesis record

A reproducible record should identify the model version, initial state, visual inputs, action mapping, model outputs and any assistance from execution software. The recording and event log should align with the confirmed transaction. Replays and a control run with model output disabled should establish which actions depended on the controller. A recording hash can identify an artifact, but cannot establish that causal relationship by itself.

## Biological scope

The controller is zebrafish-inspired and uses eight population states with hand-set parameters. It is not a complete reconstructed zebrafish brain. The 71,721 measured ZAPBench centroids are an independent anatomy reference and do not drive the simulation. Token creation would demonstrate an engineered sensorimotor interaction, not biological understanding of tokens or financial decisions.
