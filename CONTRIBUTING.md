# Contributing

Zebrafish Neural contributions should make the model, evidence, or experiment workflow easier to inspect and reproduce. Keep all project text, interface labels, documentation, and contributor-facing messages in English.

## Development workflow

1. Use Node.js 22 or later and start the application with `npm run dev`.
2. For changes to dynamics, update the model version and equations in `docs/model.md` together. Add tests that check a meaningful behavioral property or numerical constraint.
3. Run `npm test` and `npm run check`. For interface changes, inspect desktop and narrow layouts and exercise automatic start, pause, resume, restart, visibility suspension and rolling recording beyond 60 model seconds.
4. Document each new data asset with its source URL, license, attribution, units, transformations, and SHA-256 checksum. Track geometry, activity, and connectivity separately.
5. Describe the behavior change, validation performed, and remaining scientific assumptions in the pull request.

## Scientific presentation

The interface and exported recordings must read the same model state. Visual activity should be derived from that state rather than an independent decorative animation. Identify schematic geometry, measured positions, recorded activity, and inferred or designed connections explicitly.

State what each validation supports. Software tests do not establish biological fidelity, and spatial anatomy alone does not establish a functional circuit. Claims about cognition, emotion, or consciousness require evidence beyond this model's current scope.

Application code and bundled datasets have separate licenses. Preserve data attribution and provenance when adding or redistributing derived assets.
