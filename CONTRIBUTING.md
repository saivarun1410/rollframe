# Contributing to Rollframe

Thanks for helping improve Rollframe. This is an early macOS prototype. Camera preview lag, choppiness, and sizing are open issues; see [MEMORY.md](MEMORY.md) before working on them.

## Report an issue

Open a GitHub issue with your macOS version, camera or display type, steps to reproduce, expected behavior, and actual behavior. For preview lag, a measured motion-to-display delay is especially useful. Remove personal information from logs and screenshots. Do not upload recordings or camera footage without the subject's consent.

## Propose a change

1. Open an issue first for large design or capture-pipeline changes so the approach can be discussed.
2. Fork the repository and create a branch for your change.
3. Install Node.js 20+ and FFmpeg on macOS, then run `npm install`.
4. Make a focused change and run `npm run check`.
5. Open a pull request describing the behavior changed, how you tested it, and any remaining limitations. Include screenshots for visible interface changes using demo or redacted data.

Only the repository owner, [@saivarun1410](https://github.com/saivarun1410), merges pull requests. Submitting a PR does not grant merge access.

## Licensing

By contributing, you agree that your contribution may be distributed under the project's [MIT license](LICENSE). Adapted capture code retains its required third-party MIT notice in [LICENSE-justroll](LICENSE-justroll).
