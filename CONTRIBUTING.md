# Contributing

Use a separate development installation and synthetic media. Preserve existing library data and configuration. Keep machine-specific settings out of source control.

For UI changes, reproduce the problem with directional keys, Select and Back before editing. Test loading, errors, rapid presses and late responses. Label keyboard input as simulated; do not claim projector compatibility without testing on the device. Recheck shared code on mobile and desktop.

Run the automated suites and follow `docs/QA-CHECKLIST.md`. Include the relevant results, client/version, input method and any unverified cases in the pull request. The backend is experimental: changes there should use dummy configuration, mocked transport and temporary directories.
