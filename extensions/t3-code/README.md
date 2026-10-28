# T3 Code for Raycast

Four commands against the T3 Code server running on this computer, on macOS or Windows.

- **Prompt T3 Code** — write a prompt, attach files, pick a preset (project, model, permissions and workspace), optionally branch into a git worktree. Creates the thread, sends the prompt, opens the thread in T3 Code.
- **Waiting T3 Threads** — pinned and active threads whose agent has stopped, so the next move is yours.
- **Search T3 Threads** — every thread, grouped the way T3's sidebar groups them, with the actions T3 offers.
- **T3 Code Status** — shows in root search what needs you, what finished and what is working, refreshed every minute in the background.

## Threads

Both thread commands group threads into T3's sidebar sections, Pinned, Working, Active,
Snoozed and Settled, and show T3's status for each: Pending Approval, Awaiting Input,
Guest Request, Working, Connecting, Waiting, Failed, Plan Ready or Completed. Subagent
threads stay under their parent, as in the sidebar. The dropdown narrows the list to one
section or one project, and the search matches title, project, branch and status.

`↵` opens the thread in T3 Code. On protocol v2 servers the action panel also acts on it:

- **Reply** sends a follow-up. While the agent is working it is queued to run next, as T3's
  composer does.
- **Approve Request** and **Decline Request** answer a pending approval. Raycast can't show
  what the agent wants to do, so Approve asks for confirmation first.
- **Stop Agent**, **Settle** / **Unsettle**, **Snooze** / **Unsnooze**, **Pin** / **Unpin**,
  **Mark as Read** / **Mark as Unread**, **Rename**, **Archive** and **Delete**.
  Snooze offers the presets set in T3's settings. Settle, Snooze and Archive can be undone
  from the toast.
- **Copy Thread Link** copies the `t3code://` link that opens the thread.

An action only shows when the server reports the capability it needs.

## T3 Code Status

A background command, since menu bar commands aren't available on Windows. Its subtitle in
root search reads like `🟠 2 need you · 🟢 1 done · 🔵 3 working`: red or orange for threads
waiting on you (red when one failed, and the thread's title when there is only one), green for
finished runs you haven't opened, blue for running agents. Idle threads only show when nothing
else does, otherwise it reads `All quiet`. Opening it shows Waiting T3 Threads when something
needs you, and Search T3 Threads otherwise. Raycast turns background refresh on the first time
you open the command.

## Prompt T3 Code

- **Files** take any file type, up to 8 per prompt: images up to 10 MB, other files up to 50 MB.
  A screenshot on the clipboard is attached when the command opens, unless it was already sent.
  `⌘⇧V` (`Ctrl+Shift+P` on Windows, where `Ctrl+Shift+V` is Paste as Plain Text) attaches a
  screenshot copied later, or the files copied in Finder or File Explorer. `⌘⇧A` (`Ctrl+Shift+A`)
  attaches the files selected there, and `⌘Y` (`Ctrl+Y`) previews what is attached. Protocol v1
  servers accept images only.
- **Preset** is the project, model, permissions and workspace in one choice. Starred presets come
  first, then the combinations you used recently. `⌘D` stars the current settings, and again
  unstars them. Choose Custom… for the separate fields. Model names show the provider and effort,
  for example `Claude · Sonnet 5.5 · high · 1M`.
- `↵` sends and opens the thread in T3 Code. `⌘⇧↵` (`Ctrl+Shift+↵`) sends and leaves T3 Code alone.
- Worktrees need the project folder on this computer, because the base branch is read from its git
  repository.

## Setup

Issue a token and paste it into the extension preferences on first run. The two scopes
are all the extension uses: reading threads, and creating and acting on them.

On macOS:

```
# Server address: the running server publishes it here.
ORIGIN=$(node -p "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.t3/userdata/server-runtime.json','utf8')).origin")
# If that file is missing or has no origin, or you set the Server Origin preference,
# use that value instead:
# ORIGIN=http://127.0.0.1:3773

# Issue the token with the CLI at the server's own version.
VERSION=$(curl -s $ORIGIN/.well-known/t3/environment | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).serverVersion")
npx t3@$VERSION auth session issue --ttl 365d --label raycast --scope orchestration:read --scope orchestration:operate --token-only
```

On Windows, in PowerShell. The desktop app installs its own CLI, already at the app's version:

```
& "$env:USERPROFILE\.t3\bin\t3.cmd" auth session issue --ttl 365d --label raycast --scope orchestration:read --scope orchestration:operate --token-only
```

The CLI must match the server's version: a token issued by a different version can be
written to the previous database, and the server then rejects it. The macOS commands use
only `node`, `curl` and `npx`, which come with macOS and Node.

Revoke it with `t3 auth session revoke`, list sessions with `t3 auth session list`.

The server origin comes from `~/.t3/userdata/server-runtime.json` unless the
`Server Origin` preference is set, so a restarted server on a new port needs no
reconfiguration.

## How it talks to T3

Everything runs against the T3 Code server on this machine, over loopback:

- `GET /api/orchestration/shell` for projects and threads.
- `GET /.well-known/t3/environment` for the server's orchestration protocol version.
- `GET /api/auth/websocket-ticket`, then a WebSocket to `/ws`, for creating threads and acting on
  them on protocol v2.
- `POST /api/orchestration/dispatch` for `thread.create` and `thread.turn.start` on protocol v1.

On protocol v2 the extension sends the `x-t3-orchestration-protocol` header and maps the
v2 thread fields onto the v1 shape. v2 removed thread creation over HTTP, so Prompt T3 Code
uses one `orchestration.launchThread` call over the WebSocket: it creates the thread, prepares
the worktree and sends the first message. Attachments are uploaded first through
`attachments.createUploadUrl`. On v1 the images travel inside the turn as data URLs.
Thread actions go through `orchestration.dispatchCommand` on the same WebSocket.

Opening a thread follows its deep link, `t3code://threads/<environmentId>/<threadId>`,
which T3 Code 0.1.0 and later navigate to directly. The environment id comes from
`/.well-known/t3/environment`. Older servers fall back to driving the command palette:
the extension activates T3 Code, types the thread's title, project and branch, and
presses Enter only when that query matches exactly one thread; otherwise the palette
stays open on the narrowed list for you to pick from. macOS asks for Accessibility
permission the first time the fallback runs.

The app is found by release channel. The stable build is named `T3 Code (Beta)`
(`T3 Code (Alpha)` before the rename) and the Nightly build `T3 Code (Nightly)`. With the
`App Name` preference empty, the extension picks one from the running server's version, or
from the installed apps when no server is running. Set the preference to override it.

On v1 the extension creates worktrees itself with `git worktree add`, since the HTTP
dispatch handler passes commands straight to the engine and never runs the
server's worktree bootstrap. The path matches T3's own convention,
`~/.t3/worktrees/<repo>/<branch>`. On v2 the server prepares the worktree.

The preset list comes from the threads you ran recently, so the extension carries no model
list of its own. Provider names, custom models, starred models and snooze presets are read
from `~/.t3/userdata/settings.json` and `model-manifest.json`, read-only.

## Development

```
npm install
npm run dev
```

The extension stays on `@raycast/api` 1.104 so it installs on older Raycast versions. On
Windows, Raycast 2 loads development builds from a folder only the 2.x CLI writes to, so
develop with that CLI instead of `npm run dev`:

```
npx -p @raycast/api@latest ray develop
```
