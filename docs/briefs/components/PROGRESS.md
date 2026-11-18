# Progress: reusable components (`17`)

The lead's log, one line per step (*How to run this set* in the README). Read this, not old transcripts, to pick the run back up.

| Step | Agent | State | Merge | Notes |
|---|---|---|---|---|
| W1 | rc-w1 | merged | 402eb5a | rebased; status tables merged into W's. Error `answered` added. Q1 must change the bad_request line in ui-fake-host.test.ts. V2 switches `InGamePrompts.onChat` to `Messages.Chat.decode` |
| K1 | rc-k1 | merged | 45227fa | rebased on F1, status tables combined; add takes ids or names, not cells; kit load skips missing prefabs with a warning |
| F1 | rc-f1 | merged | bfe56c0 | .litematic now listed; format change replaces old prefab file; 17 status table started (W2 extends) |
| K2 | rc-k2 | merged | e99305d | labels win over names and cells; stamp tool only, not scripts. Reminder cost estimated (3–4 chars/token), not counted with a tokenizer |
| Q1 | rc-q1 | merged | 65e430f (17 conflict markers committed there; fixed in the next commit) | ids c1…; uncelled prefabs get #n; no set labels in candidates; line `[Show candidates (n)]`. Open: 13's status row still says all candidates.* answer bad_request (W's file, for Z) |
| V1 | rc-v1 | merged | 7decd2d | ThumbnailGrid, OrbitPreview (package-private) in client/ui/screen |
| W2 | rc-w2 | merged | a2c39d5 | library.write.{prefab,palette,procedure,knowledge}; stale hash = existing `conflict`; save flash = job "save", #ffffff. Lead fixed 13's stale candidates row. Seen once: ENOTEMPTY teardown race in test/unit/server/library.test.ts (passed on rerun). Silo W complete |
| V2 | rc-v2 | running | | |
| Q2 | rc-q2 | merged | aff4b6b | placed like stamp (rotate, base anchor on `at`), untinted #ffffff, overlay players, resent on resync. Rotation copied from stamp's prefabFrame into ui/candidates.ts (ui/ can't import ops/): Q3 dedupes into core/ if the layer rules allow |
| K3 | rc-k3 | merged | 8af5746 | reminder via InGameRequestsOptions.componentSet on build/ask/plan and scan events (scan kept: spec says each request). Q3 must apply it to the picks event too. Silo K complete |
| E1 | rc-e1 | merged | 1242463 | stale hash = EntryChangedError → conflict; read-only checked before hash; palette edits weights/remove/drop/rename only; no instance → bad_request; LibraryHost.paletteIndex wired in server/index.ts. Lead fixed W's piece 6 row |
| F2 | rc-f2 | merged | f7107a8 | Session.saveFlash hook wired to UiFeed.saveFlash; linked check in the feed (anchored-only docs get none); not a session event, so never in replay. Silo F complete |
| Q3 | rc-q3 | merged | d04738b | closed request reopens under its own id (mod's counter; accepted by lead); list with no request → {request: null}, 13 updated; rotation now core/rotate.ts orientBox, no copy. Lead fixed the ENOTEMPTY flake in test/unit/server/library.test.ts (4c8ee87). Silo Q complete |
| E2 | rc-e2 | running | | |
