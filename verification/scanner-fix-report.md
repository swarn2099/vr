# Scanner fix for VR 0.2.0

The work-Mac screenshot showed a successful build and VSIX package, followed by setup stopping at repository 4 of 9 because `transactions.txt` contained a NUL character.

## Changes

- Files containing NUL characters are recorded as excluded, with the reason “binary data or unsupported text encoding”; they do not become model evidence or terminate scanning.
- Their paths remain in the database's file inventory and are reported in terminal scan progress.
- Unchanged scan retries return the same coverage details, including genuine errors, so a retry cannot accidentally hide a parse failure.
- A small service-stop helper authenticates and verifies the selected estate's local service before shutting it down cleanly. It refuses to stop an active setup or learning run and preserves the database.

This fix does not decode UTF-16 or other unsupported text encodings. Those files remain explicit exclusions. Dependency versions and the lockfile are not changed by the patch.

## Validation

- Type checking passed.
- All 36 automated tests passed, with no failures or skips.
- The real compiled setup/service completed a nine-repository fixture containing a binary `.txt` in repository 4.
- The exclusion remained visible on an unchanged retry.
- The service restarted cleanly and retained the product/repository identities, including recovery without an estate manifest.
- The three-repository host integration completed code, connections, history and Jira stages using controlled VS Code/model/Jira responses; its unchanged rerun made zero additional model calls.

These are fixture tests. The private Spend Management repositories on the work Mac have not been accessed or validated here.
