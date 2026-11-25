# OEMS backend starter

This is the first server-side implementation for the Online Examination Management System. It uses Node.js built-in `node:sqlite` support and creates a private SQLite database on first start.

## Requirements

- Node.js 22.13 or newer
- No npm packages are required

## Run locally

```powershell
npm run create-admin
npm start
```

The admin command prints a random temporary password once; the account must change it after signing in. Store that password securely. The server listens on `http://127.0.0.1:3000` by default. Set `PORT` and `HOST` to override the listener, and `OEM_DB_PATH` to choose a database location outside the public web root.

The database contains actual learner and assessment data. Do not commit it, put it in a public repository, or serve it as a static file. Keep backups private and encrypted. Use a private persistent disk for any server deployment.

## API outline

All API routes use JSON. Sign-in sets an HttpOnly, SameSite=Strict session cookie; the opaque session token is stored only as a hash. Mutating requests are same-origin checked. The API has these initial routes:

- `GET /api/health`
- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/password`
- `GET|POST /api/users`, `PATCH /api/users/:id` (admin)
- `GET|POST /api/questions`, `PUT|DELETE /api/questions/:id` (lecturer/admin)
- `GET|POST /api/exams`, `GET /api/exams/:id`, `POST /api/exams/:id/schedule`, `DELETE /api/exams/:id`
- `POST /api/exams/:id/start` (student)
- `PUT /api/attempts/:id/answers/:questionId`, `POST /api/attempts/:id/submit`
- `GET /api/attempts/:id`, `PUT /api/attempts/:id/marks`
- `POST /api/exams/:id/publish|unpublish`, `GET /api/results`
- `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/announcements`
- `GET|PUT /api/settings`, `GET /api/activity`

Correct answers and marking notes are not returned in student exam or attempt responses. The server enforces roles, exam windows, one attempt per student/exam, submission deadlines, and mark locking after publication.

## Connected frontend and limitations

Open `/oems.html` while the server is running to use the connected frontend. It authenticates through the API and reads and writes exam data on the server; it does not use browser `localStorage` for application state. The root page also links to the app.

This is a local demo, not a public deployment or a production-ready exam service. Do not use real learner or assessment data until production hosting, HTTPS, private persistent storage, tested backups, broader end-to-end coverage, and an independent security review are complete. No public hosting has been performed.

For production, deploy behind HTTPS, configure `OEM_PUBLIC_ORIGIN` to the exact public origin, set `NODE_ENV=production`, and use a host with a private persistent disk. GitHub Pages cannot run this backend or store its private SQLite database.
