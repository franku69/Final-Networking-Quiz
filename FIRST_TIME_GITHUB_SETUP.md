# FIRST-TIME GITHUB PAGES FIX

The old failed workflow was not a game-code failure. GitHub returned `Get Pages site failed: Not Found` because Pages had not been enabled for the repository yet.

This build deliberately uses the simpler branch publishing path. It does not need a custom Pages deployment action.

## Do this once for `franku69/Networking-Quiz`

1. GitHub → **Networking-Quiz → Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Branch: **main**.
4. Folder: **/docs**.
5. Click **Save**.
6. Wait for GitHub to publish the site.

Student site:
`https://franku69.github.io/Networking-Quiz/`

Teacher CRM:
`https://franku69.github.io/Networking-Quiz/teacher/`

The repository's own Actions workflow is now validation-only. A green `Validate Packet Quest` check verifies the public files and source syntax; GitHub Pages itself handles publication from `/docs`.

## Why this is more reliable

The quiz is already a static site; there is no build step. Publishing directly from `main/docs` avoids a custom Pages API setup step and avoids the failure you saw before Pages existed.
