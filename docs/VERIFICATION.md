# Verification status

This is a source export of custom changes exercised on a personal Jellyfin setup. Its owner confirmed the iPhone Home → More info → Back fix, and confirmed projector browsing, search return, trailers, playback controls, Family playback and simplified actions during earlier tests.

Those confirmations apply to that installation. The portable builder/installer has separate isolated regression tests. No clean-host, universal installer or complete physical-client certification is claimed for this preview. Node DOM/router tests use simulated events and do not replace a real VIDAA remote or iPhone test.

The release includes tests for web navigation and TV focus/loading/playback, dashboard UI, queue ownership/order, copy progress, transfer controls, storage safeguards, shutdown validation, temporary backup/restore and configuration validation. CI runs these without private runtime settings. Windows-specific backend tests run on Windows.

Before deploying to another installation, record its exact versions and complete `QA-CHECKLIST.md`. Backend installation and remote administrative authentication remain development work.
