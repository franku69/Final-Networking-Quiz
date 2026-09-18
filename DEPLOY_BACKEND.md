# Backend deployment notes

The frontend on GitHub Pages cannot provide live monitoring by itself. The backend handles rooms, identities, answer synchronization, timing, grading, reconnection, and score exports.

## Required private environment variables

- `PACKET_BANK_KEY` — decrypts `backend/questions.enc` in memory.
- `PACKET_TEACHER_KEY` — your CRM login key.

Never commit either value.

## Other environment variables

- `PACKET_DATA_DIR` — persistent data directory. The included Render blueprint uses `/var/data`.
- `PACKET_ALLOW_PAGES_ORIGINS=1` — allows HTTPS GitHub Pages/Pages-compatible frontend origins.
- `PACKET_ALLOWED_ORIGINS` — optional comma-separated exact HTTPS origins if you want to restrict CORS more tightly.
- `PORT` — normally supplied by the hosting service.

## Start command

```text
python backend/server.py --host 0.0.0.0 --port $PORT
```

## Health check

```text
GET /healthz
```

A correct health response identifies the 30-question bank and reports `live: true`.

## Data

The service stores active rooms, attempts, teacher sessions, submissions, and receipts in SQLite. For a cloud deployment, use persistent storage. Export scores after each section even when persistent storage is enabled.
