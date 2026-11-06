# Trying changes before they go live

The live site (https://househunt-western.github.io/) publishes whatever is on the **main** branch. So new work goes on its own **branch** first. You try it on your Mac and your phone, and it only goes live when you merge it into main.

## Open the project in VS Code

1. Open **Visual Studio Code**, then **File → Open Folder…** and pick `projects/london-housing`.
2. The bottom-left corner shows the branch you're on (for example `guest-browse`). Click it to switch branches. `main` is what's live.

## Preview a branch

1. **Terminal → Run Task… → Preview site**.
2. The panel that opens shows two addresses:
   - **On this Mac:** http://localhost:8770/site/
   - **On your phone:** the `http://172…:8770/site/` one. Your phone has to be on the same Wi-Fi as your Mac. If macOS asks whether Python can accept incoming connections, click **Allow**.
3. When you're done, click the bin icon on that terminal panel to stop it.

The preview uses the **real** database, so accounts and votes you make there are real. Use a test email, and **Leave group** on any test group afterwards. Phone alerts don't work in the preview (they need https), so test them on the live site.

## Run the tests

**Terminal → Run Task… → Run site tests**. All of them should say `pass`.

## Make it live

When you're happy with a branch, tell Claude "merge it". Or, in VS Code: switch to `main` (bottom-left), open the **Source Control** panel, then **⋯ → Branch → Merge…**, pick the branch, and **Sync Changes**. GitHub republishes the site in about a minute.

Nothing reaches your friends until that merge, so it's safe to try anything on a branch.
