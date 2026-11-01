# Architecture and boundaries

The web builder combines custom CSS, navigation, browse/history handling, artwork caching, directional input and TV playback modules into one asset. It supplies exact configured service origins and optional library links. `source/netflix-layout/extra-links.json` is a sanitized historical fixture for tests; the builder uses the links in your own config instead.

The Windows prototype uses qBittorrent's Web API and copies completed files over SSH. Bulk scheduling and interactive requests have separate routing. Manual pause/Force Start rules are covered by tests. Transfers stage and verify files before import, with disk-reserve and media-identity checks. Automatic cleanup must remain disabled until an operator has independently verified their own configuration.

The dashboard prototypes expose local status and bounded actions. Media holding defers permanent deletion to a separate confirmation. The Linux helpers assume the original deployment's directory layout and service arrangements. These assumptions are retained as **examples**, not portable defaults. Example IP addresses use documentation-only space; example domains end in `.invalid` where applicable. Historical variable names such as `pi` also cover a replacement Linux server.

No production deployment was changed to prepare this public export. Storage migration entry paths are disabled or omitted; no boot images, disk-formatting tools, private runtime settings, upstream compiled clients or media files are included.
