# Apply the VR 0.2.0 scanner fix

Save `vr-0.2.0-scanner-fix.patch` in Downloads on the work Mac. Open a terminal in the VR source folder and run each command below only if the previous one succeeds:

```sh
git apply --check "$HOME/Downloads/vr-0.2.0-scanner-fix.patch"
git apply "$HOME/Downloads/vr-0.2.0-scanner-fix.patch"
npm run build
node scripts/stop-estate-service.mjs "$HOME/SpendManagementHackathon"
npm run setup -- "$HOME/SpendManagementHackathon"
```

Use your actual estate folder if its name differs. The stop command verifies the local estate service before stopping it; saved knowledge remains in place. If VR is still learning in another window, cancel that run first. The stopped background service must be restarted so it loads the rebuilt scanner.

The patch updates scanner, coverage and progress code and adds regression checks and the service-stop helper. It preserves your `package.json`, `package-lock.json`, installed dependencies and customer code. No additional `npm install` or VSIX repackaging is needed: portable mode runs the scanner service from the rebuilt VR folder.

If `git apply --check` fails, do not force it; the local source differs from the expected 0.2.0 files. Applying the same patch twice also fails this check.

After applying, the problematic file should be listed as skipped and scanning should proceed to the remaining repositories. New read/parser errors remain visible and can still stop setup. The existing ZIP release predates this patch; apply this patch after extracting or cloning that release.
