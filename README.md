# Home Media Control

**Development preview — a community export of a working personal Jellyfin setup.**

Home Media Control adds compact navigation, clearer remote focus, reliable Back behaviour, trailer escape handling, artwork caching and a simpler couch interface to Jellyfin's web client. It also includes experimental sources for a Windows download/copy worker and a local media-control dashboard.

This is an add-on, not a Jellyfin fork or a complete media-server installer. No media, accounts, credentials, download sources or private installation state are included.

## Start with the web interface

Requirements: Python 3.11 or later, an existing Jellyfin server, and administrator access to its **native web-client directory**. Node.js 22 or later is needed only for tests. The web code was developed against Jellyfin Web 12.3.0 with Jellyfin Enhanced and Jellyfin Custom Theme; other versions and combinations need verification.

1. Download or clone this repository.
2. Copy `web-config.example.json` to `web-config.local.json`. Set `services.jellyfin` to your exact server origin, such as `http://media-server.local:8096`. Optional Discovery and Status addresses can remain `null`. Addresses must include the correct scheme and port, without a path or credentials.
3. Build a bundle:

   ```sh
   python tools/build_web.py --config web-config.local.json
   ```

4. Back up your installation, then install into the directory containing Jellyfin's existing `index.html`:

   ```sh
   python tools/install_web.py --web-root /path/to/jellyfin-web
   ```

   This writes one custom asset and adds its script tag. It preserves upstream scripts and keeps a timestamped backup outside the served directory. It does not restart Jellyfin. Use an account with permission to write that directory.
5. Reload the client, then complete [the couch checklist](docs/QA-CHECKLIST.md). To undo the change, use the exact backup path printed by the installer:

   ```sh
   python tools/install_web.py --restore /path/to/printed/backup
   ```

Restoration refuses to overwrite files changed since installation. A Jellyfin upgrade may replace its web directory; review and rebuild the add-on after upgrading. Container changes are normally temporary: **this preview does not provide a Docker installation hook**. Operators must arrange a persistent integration themselves.

Custom Theme and Enhanced are optional upstream projects, installed separately. If another theme already injects navigation or playback controls, test the combination on a copy first. The exported appearance layer contains the styling used by the original setup; it is not a bundled copy of either plugin.

## What is included

- Compact Home, Movies, TV, Live TV, Collections and Search navigation.
- Webview/iPhone routing fixes, returning to the previous title and search selection.
- TV mode actions and directional focus, loading cancellation, trailer cleanup and simpler playback controls.
- Bounded artwork caching where the client supports the necessary browser storage APIs. This is a cache, not an offline film library; storage can be evicted by the device.
- Dashboard UI, transfer Start/Stop controls, queue-owner rules, verified copy helpers, media holding and shutdown prototypes, with regression tests.

Web styling applies to browser-based clients, including compatible webview wrappers. Native clients such as Swiftfin and Jellyfin for Android TV have their own interfaces and will not inherit this theme. A browser simulation cannot prove a physical remote works.

## Experimental backend sources

`source/pc-downloads`, `source/status-dashboard` and `source/media-hold` preserve the custom integration work for review and development. **They are not ready for an unattended general-purpose installation.** They still use reserved demonstration hosts, example storage identities, expected filesystem layouts and operator-supplied settings. There is no one-command installer, disk formatter, OS image, or bundled downloader.

Do not run these service entry points against your library without reviewing and adapting their configuration and privilege boundaries. Keep administration interfaces private; the current loopback dashboard/token model is not a complete internet-facing authentication system. The web builder can link to an existing dashboard, but it does not install one. See [architecture and limitations](docs/ARCHITECTURE.md) and [security](SECURITY.md).

## Tests

```sh
python -m unittest discover -s tools -p "test_*.py"
python tools/test_backend.py
node --test source/*/test*.cjs
python tools/check_release.py
```

On Windows PowerShell, use `node --test (Get-ChildItem source -Recurse -Filter '*.cjs').FullName` because wildcard expansion differs. Backend regression tests run in fresh temporary directories with dummy settings and block non-loopback network access. Windows-specific file/process cases are covered on Windows; see the checked-in CI workflow and [verification notes](docs/VERIFICATION.md).

## Roadmap

- Replace the backend's remaining example constants with one validated configuration model.
- Add supported Windows/Linux installation, upgrade and rollback paths.
- Design authenticated administration for remote dashboards.
- Expand clean-host and physical-device testing, including native clients where feasible.

Contributions are welcome. Please include a reproduction, the client/version/input method, and regression coverage. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence and credits

Custom source in this export is offered under GPL-3.0-or-later; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Upstream projects retain their own licences. Jellyfin, qBittorrent, Seerr, Radarr, Sonarr, Custom Theme and Enhanced are independent projects; this preview is not an official release from them.
