# Packet Quest — CS111 GitHub Pages + Live Teacher CRM

This repository is the GitHub-ready version of **Packet Quest: Networking and the Internet**.

## What students experience

The teacher posts **one GitHub Pages room link** in Google Meet. Each student opens it on a phone or PC, enters their identity, takes the 30-question multiple-choice quiz, submits, sees **“Your score is recorded”**, and can leave when permitted.

## What the teacher sees

`/teacher/` is the live CRM. It shows students joining, connection state, saved-answer progress, current question position, provisional score, final score, and submission time. Final grades are calculated by the backend, not by the student browser.

## Architecture

- `docs/` — public GitHub Pages game + teacher dashboard. **No answer key or teacher secret is stored here.**
- `backend/` — live API server. The 30-question bank is stored only as encrypted ciphertext (`questions.enc`).
- `render.yaml` — cloud deployment blueprint with persistent data storage.
- `.github/workflows/pages.yml` — publishes `docs/` to GitHub Pages.

The backend and Pages frontend are intentionally separate: GitHub Pages is static and cannot store live multi-student classroom data by itself.

## First deployment

Read **QUICK_START.md**. You need the separate private file `PRIVATE_PACKET_QUEST_SECRETS.txt`. Do **not** upload that private file to GitHub.

## Security boundary

This repository is designed to be safe to publish publicly: the plaintext answer bank and teacher key are not included. The backend decrypts the bank only when `PACKET_BANK_KEY` is supplied as a private hosting environment variable. Keep all score exports and teacher secrets private.

## Quiz content

- 30 multiple-choice questions
- CS111 Topic 4: Networking and the Internet
- Question/choice order shuffled independently per attempt
- Lightweight question-specific animated visual scenes
- Optional synthesized 8-bit BGM, off by default
- Responsive touch UI for phones, tablets, and PCs

## Important

Before a graded class, create a test room and complete one attempt using a real phone on mobile data. Confirm that the student appears in the teacher CRM and that the final score remains after the student closes the page.
