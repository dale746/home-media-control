# Reusable client checklist

Record server/client versions, theme/plugin versions, display mode, device, input method and bundle hash. Mark each case pass/fail/unverified. Keyboard testing is simulated remote input.

- Browse multiple rows; move left/right/up/down; open a title; Back restores the poster and scroll position.
- Search, edit the query, open a result, open/close More, Back returns to the same search and selection.
- Play, pause, seek, resume and exit; audio stops when leaving playback.
- Open each visible menu with Select, navigate all controls, and close it with Back before leaving the page.
- Start a trailer, leave immediately; repeat while loading and while playing. No sound, late reopen or focus steal after leaving.
- Simulate unavailable trailers, timeouts and failed connections in a development environment. Back remains usable and loading ends.
- Repeat journeys and rapid input. No duplicate actions, trapped overlays, stale focus or endless spinners.
- TV description: Play/Resume, Trailer and heart accessible. Playback: Settings stays usable; unnecessary secondary actions stay out of the main path.
- Movies/TV genres, favourites, Family library and optional Discovery/Status links open and return correctly.
- Mobile: Home → More info → Back, including Back during loading, stays on Home. Check text wrapping, one Back arrow, portrait/landscape and player controls.
- Desktop: normal mouse/keyboard use remains usable; responsive layout has no clipped labels.
- Artwork cache: unavailable storage fails gracefully; normal media/video requests are not cached as artwork.
- Dashboard development instance: transfer Start/Stop acknowledgements match current state; owner pause and Force Start remain respected; dangerous confirmations are reachable and bounded.

Do not delete real media, shut down a shared server or interrupt another viewer for QA without explicit authorization.
