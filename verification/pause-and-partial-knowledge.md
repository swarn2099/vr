# Pausing and partial knowledge verification

The original extension automatically started any unfinished request when a workspace reopened. That could consume another session's model-call budget after a user had paused. Automatic start now requires an explicit fresh setup request marked `awaiting-vscode`, its matching request ID, and no saved cancellation. Paused, interrupted, completed and scan-only workspaces require explicit learning/resume.

The setup command also records the request ID in its `--no-open` status so a newly prepared workspace can still start as intended. The progress label now describes the configured maximum as a session limit, not a count of required calls.

The real compiled extension/service/database integration test:

1. Prepared three Git repositories and allowed one controlled model call.
2. Reached the call limit and paused.
3. Retrieved a saved behavior while unfinished jobs remained visible in coverage, without an additional understanding call.
4. Reopened with cleared VS Code workspace UI state and observed zero additional calls.
5. Reopened interrupted state and saved-cancellation state and observed zero additional calls.
6. Explicitly resumed with a larger limit and completed the configured code, connection, history and Jira stages.
7. Explicitly ran unchanged understanding again with zero additional model calls.

The model responses, VS Code APIs and Jira transport were controlled fixtures. These checks verify lifecycle and persistence, not semantic understanding quality or a provider's billing rules. `portable-host.json` records the results.
