# QA Results — GitHub Pages + Live CRM build

Build: `7.1.0-stable`

## Passed checks in this build environment

- Encrypted question bank decrypts only with the private deployment key.
- Backend reports the expected 30-question bank and live health state.
- GitHub Pages-style cross-origin CORS passed for `GET /healthz`, `OPTIONS`, and `POST /api/quiz`.
- Teacher dashboard connected to a separate backend, authenticated, and created a room.
- `COPY ROOM LINK` produced a single GitHub Pages URL carrying both the room code and backend location.
- A 390×844 touch/mobile student joined and appeared in the teacher CRM.
- All 30 multiple-choice questions were answerable and visible in review.
- Server-side submission produced a final 30/30 QA score and the teacher CRM displayed the result.
- Student identity/grade remained in CRM after the student page closed.
- No page-level horizontal overflow in the tested 390×844 student or teacher view.
- No uncaught application JavaScript errors in the full teacher/student harness flow.
- Responsive student checks passed at 320×568, 360×800, 390×844, 412×915, 768×1024, 1024×768, 1366×768, 1920×1080, and 844×390. Answer controls remained at least 44px high.
- A 360×800 mobile flow submitted under 4× simulated CPU throttling.
- 45 concurrent simulated students joined, saved answers, and submitted successfully (180 live HTTP operations in the load run).
- JavaScript syntax checks passed for the public app modules.
- Python compile checks passed for the backend and temporary tunnel launcher.
- Public `docs/` contains no plaintext question/answer bank or production teacher secret.

## Important limits

- Browser navigation to local HTTP servers is blocked by this build environment, so responsive browser QA used the shipped DOM/CSS/JS with an HTTP bridge to the actual backend rather than normal URL navigation.
- GitHub Pages publication itself, a real cloud deployment, actual Google Meet conditions, mobile carrier networks, and the hosting provider's uptime cannot be certified from this environment.
- A real phone test with the final published URL is still required before the graded class.
- Persistent cloud storage depends on the hosting plan/provider. Export the score CSV after every section even when persistent storage is enabled.

## v7.1 deployment/performance revision

- Replaced the custom GitHub Pages deploy workflow with a validation-only workflow using `actions/checkout@v6`; publication is intended from `main/docs` via the repository Pages setting.
- Increased transient API timeout from 12s to 20s so slow mobile connections/backend warm-up are less likely to look like a configuration failure.
- Reduced idle student/teacher polling frequency while keeping immediate answer-save synchronization.
- Added automatic ultra-low effects for Save-Data, <=2 GB reported device memory, <=2 logical CPU threads, and reduced-motion devices.
- Removed the expensive full-screen CSS filter from the default low-effects mode.
- Added compact landscape-phone layout rules.
