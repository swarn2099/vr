# VR 0.2.0 release verification

Verified on 10 September 2026 on macOS ARM64 with Node.js 24.14.0.

This report describes the original ZIP release. The later scanner fix passed 36 tests and a nine-repository recovery check; see [scanner-fix-report.md](scanner-fix-report.md). The GitHub source checkout excludes generated installers and the ZIP's release manifest.

## Results

| Check | Result |
| --- | --- |
| TypeScript type checking | Passed |
| Automated engineering tests | 34 passed; 0 failed or skipped |
| Three-repository setup and understanding orchestration | Passed |
| Cross-repository learning and checkpoint validation | Passed |
| History and Jira interpretation orchestration | Passed |
| Unchanged second understanding run | 0 additional model calls |
| Optional Jira failure, cancellation and call-budget handling | Passed |
| VSIX installation through the actual VS Code CLI | Passed in an isolated temporary profile |
| Fresh ZIP extraction and independent `npm install` | Passed |
| Setup and extension integration from that fresh installation | Passed |
| Packaged extension assets match the compiled build | Passed |
| Preserved V1 comparison files | 1,165 hashes checked; no changes |

The fresh-install check verified every file in the release manifest before installing dependencies. It used the distributed, prebuilt executables without rebuilding. The VS Code CLI install check left the normal VS Code profile unchanged.

## What the integration test proves

The setup command, compiled extension, local service and database operated against three temporary Git repositories, including React and Java source. The test exercised current-code learning, connection learning within and across repositories, history, Jira interpretation, progress reporting and reuse of completed work. The fixture made 11 model calls and produced 39 UI progress messages.

The VS Code host APIs, model responses and company-hosted Jira transport were controlled fixtures. This validates the orchestration and data flow; it does not measure model understanding quality or prove access to a real work account. Semantic search was disabled in this host fixture.

## First work-Mac run

The user must complete native workspace-trust/model-access prompts, choose the work-approved model and select the existing Jira search tool and project keys. The company's actual Jira schema, authentication and network access have not been tested here. An unsupported or unavailable optional source is reported as a gap, while interrupted or budget-limited learning remains incomplete.

The release supports a supervised pilot. These checks do not establish exhaustive cross-service discovery or an improvement over agents without VR.

## Evidence

- `tests.txt`: automated test results.
- `portable-host.json`: source-folder integration results.
- `fresh-install.json`: fresh dependency installation and extracted-package integration results.
- `vscode-install.json`: actual VS Code CLI installation result.
- `package-integrity.json`: packaged asset and frozen V1 integrity checks.

`RELEASE-MANIFEST.json` in the release folder records the SHA-256 digest of each distributed file. The adjacent ZIP checksum identifies the final archive.
