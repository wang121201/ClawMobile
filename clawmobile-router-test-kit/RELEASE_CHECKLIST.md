# GitHub release checklist

- [ ] Run `./test_router_release.ps1` and retain the terminal summary.
- [ ] Run `./tools/New-ReleaseManifest.ps1` after the final source change.
- [ ] Verify `git status --ignored` shows `__pycache__`, `*.pyc`, outputs, captures, and logs as ignored.
- [ ] Run a repository secret scanner before the first push.
- [ ] Confirm no real `.env`, `.bashrc`, OpenClaw private config, API key, SSH key, raw SSE, or experiment output is staged.
- [ ] Confirm `THIRD_PARTY_NOTICES.md`, `clawbench-channel/LICENSE`, and the pinned OpenClaw commit remain in the staged release set.
- [ ] Decide whether private-network IPs and absolute `D:\codexdataspace` roots may be public; they are frozen provenance values.
- [ ] Preserve the frozen JSON configs and copied production files byte-for-byte when claiming reproduction of the existing experiments.
- [ ] Use a newly named config, design ID, output root, and campaign ID for any adapted environment.
- [ ] Run a live Smoke and use its exact matching gate before Formal collection.
