# Music API contract (v1)

What the desktop app's `daw-agent` expects from the backend. The embedded mock
(`apps/desktop/src-tauri/src/generation_server.rs`, on `http://127.0.0.1:8787`)
implements exactly this; a real backend only has to match it.

All bodies are JSON unless noted. Every endpoint except `/health` and
`/v1/auth/login` needs `Authorization: Bearer <token>` and answers `401`
otherwise. Errors are `{"error": "<message shown to the user>"}`.

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/v1/auth/login` | `{"email", "password"}` | `{"token", "user": {"email"}}` - `401` on bad credentials |
| `GET` | `/v1/songs` | - | `{"songs": [Song]}`: the tracks the caller owns, newest first |
| `GET` | `/v1/songs/{id}` | - | `Song` - `404` unless the caller owns it |
| `GET` | `/v1/assets/{filename}` | - | the stem audio (any `url` from `Song.assets`) |
| `POST` | `/v1/songs/{id}/uploads?filename={name}` | raw audio bytes | `{"upload": Upload}` - `400` bad name/empty, `404` unknown song, `413` too large |
| `GET` | `/v1/uploads/{id}` | - | the uploaded audio (any `url` from `Song.uploads`) |

```text
Song   = { id, title, owner, bpm, bars, created_at,
           assets:  [{ role, name, filename, url }],
           uploads: [Upload] }
Upload = { id, filename, size, url, created_at }
```

- `id` values may only use `A-Z a-z 0-9 - _`; `filename`s are plain file names.
  The agent rejects anything else rather than writing outside its folders.
- `url`s may be absolute or relative to the API base.
- `created_at` is Unix seconds. Upload names must end in `.wav`, `.aif`,
  `.aiff`, `.flac` or `.mp3`.
- `owner` is the owning account's email. The app only lists and opens tracks
  the signed-in user owns; it never generates new ones.
- Mock only: any email works with password `demo`, every account owns three
  demo tracks built from the same four stems, and uploads are held in memory
  until the app quits.
