# Job Fighters Online Server v1.1.0

Render WebSocket server for Job Fighters Classic.

## v1.1.0 change
Adds canonical `startMatch` support. The server stores and broadcasts the full match-start payload so guests cannot remain stuck on the waiting/character-select screen after the host starts the match.

## Deploy
```bash
npm install
npm start
```

Render settings:
- Build Command: `npm install`
- Start Command: `npm start`
- Runtime: Node
