# Security

This preview contains administrative prototypes. Keep them on trusted machines and private networks; do not expose a dashboard, downloader or control API anonymously to the internet.

Never commit runtime settings, tokens, passwords, SSH keys, machine logs, personal media, actual storage identifiers or generated bundles built with private service addresses. The example config is intentionally unconnected. The release checker detects common leaks; it is not a guarantee that every possible secret can be detected.

The web installer modifies only a chosen existing web client's index and its own asset, with external backups. It neither formats disks nor installs services. Review and test it on a copy first. Browser caches can retain artwork; use separate device accounts and clear site data when handing a device to someone else.

For a suspected vulnerability, use GitHub's private vulnerability reporting if available. Otherwise open an issue containing only a general description and a request for a private reporting channel. Do not include passwords, tokens, private URLs or a usable exploit against somebody else's installation.
