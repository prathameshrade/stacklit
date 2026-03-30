# StackIt - Minimal Q&A Forum Platform

A full-stack minimal Q&A forum built from your provided frontend, with a Node.js + SQLite backend.

## Features implemented

- Guest role:
  - View questions and answers
- User role:
  - Register and login
  - Ask question (title, rich text description, tags)
  - Post answer using rich text editor
  - Upvote/downvote questions and answers
  - Accept one answer (question owner only)
- Admin role:
  - Access admin-only APIs for moderation
  - Moderate users/reports/questions/answers via API
- Notifications:
  - Bell icon with unread count
  - Dropdown list of notifications
  - Notifications for:
    - New answer on your question
    - Mentions in answers using @username
  - Mark all as read

## Tech stack

- Frontend: provided `stackit.html` + `app.js`
- Backend: Express
- Database: SQLite (`stackit.db`)
- Auth: JWT

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start server:

```bash
npm start
```

3. Open in browser:

```text
http://localhost:3000
```

## Seed accounts

- Admin:
  - username: `admin`
  - password: `admin123`
- Users:
  - username: `priya_k`, `tanvir_r`, `lisa_dev`, `dev_max`
  - password: `user123`

## API overview

- Auth:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `GET /api/me`
- Questions:
  - `GET /api/questions?sort=newest|active|unanswered|votes&search=`
  - `GET /api/questions/:id`
  - `POST /api/questions`
  - `POST /api/questions/:id/vote`
- Answers:
  - `POST /api/answers`
  - `POST /api/answers/:id/vote`
  - `POST /api/answers/:id/accept`
- Notifications:
  - `GET /api/notifications`
  - `POST /api/notifications/read-all`
- Admin:
  - `GET /api/admin/summary`
  - `GET /api/admin/users`
  - `POST /api/admin/users/:id/ban`
  - `GET /api/admin/reports`
  - `POST /api/admin/reports/:id/status`
  - `DELETE /api/admin/questions/:id`
  - `DELETE /api/admin/answers/:id`

## Notes

- Rich text formatting, links, emoji insertion, image upload, and alignment are handled by the existing editor in your frontend.
- For this minimal implementation, image upload is embedded as base64 in editor content.
- The frontend keeps your original visual style and upgrades it to API-driven data.

## Security hardening added

- Security headers via `helmet` (with safe defaults for this inline-script frontend)
- Rate limiting:
  - Global API limiter on `/api`
  - Stricter auth limiter on `/api/auth`
- Strict CORS allow-list (`CLIENT_ORIGIN` + local development origins)
- Disabled `x-powered-by`
- Reduced JSON body limit to `1mb` with strict JSON parsing
- Input validation:
  - Positive integer validation for route IDs
  - Sort/search query allow-list and length limits
  - Stronger password policy (8+ chars, letters and numbers)
- Server-side sanitization of rich text and tags using `sanitize-html`
  - Blocks script tags and javascript URLs
  - Allows safe formatting tags used by the editor

### Optional production settings

- Set `JWT_SECRET` to a strong random value
- Set `CLIENT_ORIGIN` to your deployed frontend origin
- Set `NODE_ENV=production`
