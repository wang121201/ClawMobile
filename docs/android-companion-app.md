# Android App

The ClawMobile Android app is the recommended phone-native interface for
ClawMobile. It includes an app-local runtime for everyday tasks, skills, shared
content, token visibility, and trusted-agent messaging. Termux/OpenClaw remains
available as an optional Shell Runtime for users who want shell-backed tools and
full OpenClaw workflows.

Download the latest APK from the public ClawMobile release page:

- [Latest ClawMobile release](https://github.com/ClawMobile/ClawMobile/releases/latest)
- APK: [`ClawMobile-v0.2.0.apk`](https://github.com/ClawMobile/ClawMobile/releases/latest/download/ClawMobile-v0.2.0.apk)
- SHA-256: `8e19579a9a3786c18dd0bcaa3579fd4b424e2aaa9844c48b8d41abca30764494`

If you installed an earlier debug-signed test APK, uninstall it before installing
this release-signed APK.

## What It Adds

- App-local task execution without requiring Termux setup.
- Optional Shell Runtime setup for Termux/OpenClaw users.
- Runtime status for model access, local tools, Accessibility, ADB, skills,
  and optional shell services.
- A task chat UI for sending requests to the active phone runtime.
- Task completion notifications when long-running work finishes after you leave
  the app.
- Share-sheet intake for text, URLs, images, and files from other apps.
- A skills browser for built-in skills, generated skills, draft imports, and
  shared skills.
- A social/contact UI for trusted agent messaging and skill sharing.
- Accessibility-based demo recording and optional UI control, enabled only after
  Android system consent.
- A terminal/debug surface for setup logs, runtime logs, and shell commands when
  Shell Runtime is used.

## Social And Trusted Contacts

The Social tab lets ClawMobile devices talk to each other through trusted
contacts:

- Create an Agent ID for this phone and share that public ID with people you trust.
- Add another ClawMobile device by its shared Agent ID and a local label.
- Exchange messages with trusted contacts from a conversation-style UI.
- Share generated skills as compact knowledge packages for review and import.
- Messages from unknown senders are filtered from the app UI by default.
- Keep the Recovery Key private. It is shown when a new Agent ID is generated
  or explicitly revealed, and restores the same Agent ID on another device.

## Runtime Modes

The app supports two runtime modes:

1. **App-local runtime:** built into the Android app. It can run tasks, use
   app-local tools, manage skills, process shared content, record demos, and
   communicate with trusted agents.
2. **Shell Runtime:** an optional Termux/OpenClaw backend connected through SSH
   setup and the local runtime protocol.

The app-local runtime is the recommended starting point. The Shell Runtime is
useful for users who need full OpenClaw compatibility, terminal access, or
shell-backed skills.

The local HTTP interface used by the Shell Runtime is an implementation detail.
It is not a stable public API; prefer the Android app or the `clawmobile` CLI
unless you are working on the runtime itself.

## What Still Runs In Termux

Termux is only required for Shell Runtime mode. In that mode, Termux hosts:

- the OpenClaw gateway and ClawMobile runtime
- the local companion HTTP server
- package installs, setup scripts, and runtime start commands
- the OpenClaw workspace and installed skills
- generated-skill artifacts, logs, and runtime state

The Android app controls and observes that optional local service through SSH
and HTTP.

## Recommended Setup Flow

1. Install the APK from the latest ClawMobile release.
2. Open the app and configure a model provider.
3. Use the app-local runtime from the Tasks, Skills, Social, and Settings tabs.
4. Optionally enable Accessibility or ADB for richer phone-control capabilities.
5. Optionally configure Shell Runtime if you need Termux/OpenClaw workflows.

ADB is optional, but enables richer phone-control capabilities. Accessibility is
also optional and requires explicit Android system consent before ClawMobile can
inspect or control visible UI.
