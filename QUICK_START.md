# QUICK START — your exact Google Meet workflow

## A. Upload this repository to GitHub

Upload the **contents of `Packet_Quest_GitHub_Ready`** to a GitHub repository. The repository may be public: the real answer bank is encrypted.

**Never upload `PRIVATE_PACKET_QUEST_SECRETS.txt`.** It is supplied separately from this repository ZIP.

## B. Turn on GitHub Pages — one time only

1. Open the GitHub repository.
2. Go to **Settings → Pages**.
3. Under **Build and deployment → Source**, select **Deploy from a branch**.
4. Choose branch **main** and folder **/docs**, then **Save**.
5. Your student page will be:
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`
6. Your teacher CRM will be:
   `https://YOUR-USERNAME.github.io/YOUR-REPO/teacher/`

The custom repository workflow now validates the app only; it does not deploy Pages. GitHub publishes the static `/docs` folder directly. See `FIRST_TIME_GITHUB_SETUP.md`.

You do not have to hard-code the backend URL into the repository. The teacher CRM can pair with it later.

## C. Deploy the live backend once

### Recommended cloud workflow

This repository includes `render.yaml`.

1. In your hosting provider, create the backend from this GitHub repository using the included blueprint.
2. When asked for private environment variables, copy from `PRIVATE_PACKET_QUEST_SECRETS.txt`:
   - `PACKET_BANK_KEY`
   - `PACKET_TEACHER_KEY`
3. Keep `PACKET_ALLOW_PAGES_ORIGINS=1`.
4. The recommended blueprint mounts persistent storage at `/var/data` so a normal process restart does not erase class records.
5. Wait for `/healthz` to report the live Packet Quest server.
6. Copy the backend HTTPS URL, for example:
   `https://packet-quest-cs111-live.example-host.com`

A persistent cloud backend is preferable for a graded class. Hosting providers can charge for persistent services/storage; check the provider before confirming a paid resource.

### Temporary no-cloud-backend alternative

If you do not deploy a persistent cloud service, the repository also includes:

- `SETUP_LOCAL_BACKEND.bat`
- `RUN_TEMP_BACKEND_TUNNEL.bat`

Run setup once and paste the two private values from `PRIVATE_PACKET_QUEST_SECRETS.txt`. Then the tunnel launcher produces a temporary HTTPS backend URL. Keep that terminal open for the entire quiz. This is useful for testing, but a temporary tunnel is less dependable than a persistent cloud service.

## D. Pair your teacher CRM with the backend

1. Open your GitHub Pages `/teacher/` URL.
2. If it asks for **LIVE BACKEND HTTPS URL**, paste the backend URL and choose **TEST & CONNECT BACKEND**.
3. Enter `PACKET_TEACHER_KEY` from your private secrets file.
4. Create the section room and choose the time limit.

The backend URL is remembered in your browser. You can change it later using **CHANGE BACKEND**.

## E. Your class later

1. Open Google Meet.
2. Open the GitHub Pages teacher CRM on your computer.
3. Create/select the room.
4. Click **COPY ROOM LINK**.
5. Paste that **one GitHub Pages link** into Google Meet.
6. Students tap it on phone or PC and enter their name/student ID.
7. Their names immediately appear in the CRM.
8. Once everyone is present, press **START FOR EVERYONE**.
9. Watch live progress and scores.
10. Students submit and wait until they see **YOUR SCORE IS RECORDED**.
11. They may leave Google Meet when you allow it; their server record stays in your CRM.
12. Export **SCORES CSV** after the section.

The shared student URL automatically includes the room code and live backend location. Students do not configure servers, install software, or receive your teacher key.

## F. Pre-class test — do this before grading

Use a real phone on mobile data:

1. Create a TEST room.
2. Copy its room link.
3. Open it on the phone.
4. Join under a test name.
5. Confirm the name appears in CRM.
6. Start the room.
7. Answer several questions and verify progress updates.
8. Submit.
9. Confirm the final score appears in CRM.
10. Close the phone page and verify the score still remains.

Only after this should you create the actual section room.
