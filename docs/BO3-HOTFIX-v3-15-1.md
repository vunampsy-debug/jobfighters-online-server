# PvP backend 3.15.1 — snapshot dispatch

The valid `state` handler relayed the snapshot but did not return. Dispatch then fell through to the generic unsupported-operation error. This sent `roomError` to the host even after successfully relaying a snapshot, clearing the frontend start-request latch. Version 3.15.1 terminates dispatch after relaying.

No room rules, damage, collision, networking rates or authority changed. The host still owns combat simulation and the server owns room lifecycle.

Regression: `npm test` launches a real local WebSocket backend and checks 1v1/2v2 snapshots, no unexpected host `roomError` after a ping ordering barrier, and round-two score/match-ID continuity. Passed on 2026-10-05: 1 test, 193.55 ms test body, 290.29 ms total.

Frontend companion: Job Fighters Classic 5.1.2 holds the completed round until server `startMatch`, latches one transition request, supports host retry, and blocks guest-only result-to-lobby actions.

Restore by redeploying commit `500bb15914f78186b66872ae7fdd8bb45ef777eb` or branch `backup/pre-v3-15-1-20261005`. Keep the frontend companion when restoring this backend; reverting it reintroduces snapshot error noise. No data migration is involved.
