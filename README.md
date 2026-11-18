# pi-herdr-core-remote

A [Pi](https://pi.dev) package that starts **local** and switches Pi's normal coding tools to a machine saved in [Herdr Core](https://github.com/herdrdev/herdr-core). Pi itself, its model credentials, session history, extensions, and locally discovered skills/instructions remain local.

## Requirements

- Pi 1.5.2+, Node.js 22+ and `hc` on the local `PATH`.
- A machine registered with `hc machine add <name>`, connected and running a compatible Herdr Core. The remote must have `bash` and `rg` (ripgrep) for shell and search tools. Unix-like paths and command-line utilities are required.
- The remote working directory must already exist and be accessible. Connection failures **never** cause a remote call to run locally.

## Install

```sh
pi install /home/adam/Workshop/pi-herdr-core-remote
# Or try without changing Pi's configuration:
pi -e /home/adam/Workshop/pi-herdr-core-remote
```

For distribution, install via `pi install git:github.com/<owner>/pi-herdr-core-remote` or publish to npm. The package uses Pi's built-in extension API and needs no additional runtime dependencies.

## Commands

```text
/hc-remote                                Show current target (local initially)
/hc-remote fileserver /home/adam/hc-core-test
/hc-remote fileserver                     Use that machine's default home directory
/hc-remote-path subdirectory              Change remote cwd (relative to current remote cwd)
/hc-remote-path /absolute/path             Change remote cwd to absolute path
/hc-remote-path                            Show remote cwd
/hc-remote local                           Return to Pi's original local directory/tools
/hc-remote status                          Show current target
```

A directory is verified **before** switching. Failed changes leave the previous target intact. Switching is session-scoped: a new/resumed session or `/reload` starts local again. No configuration is persisted. Remote relative tool paths resolve under the selected remote cwd; absolute tool paths refer to the **remote** filesystem. `!` commands follow the active target too. Path completion and Pi's own project instructions still use Pi's local directory.

The extension overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and user `!` commands. It uses `hc file write --on` for atomic writes, `hc file read --on` for ranged text reads, and `hc exec --on` for commands, binary reads, and searches. It keeps Pi's built-in tool schemas and result renderers. `grep`/`find` use remote `rg` and need to be enabled in Pi if not already selected.

### Powerbar

The package registers an optional `hc-remote` segment with [pi-powerbar](https://github.com/juanibiapina/pi-powerbar). Enable **Herdr Core Remote** in `/extension-settings` → Powerbar → left or right segments. It displays `machine:/remote/path` while connected and disappears in local mode. Install/load pi-powerbar **before** this package. The package does not touch any Git or JJ segments.

## Limits

- `hc exec` returns output at completion, not as live chunks. Commands have Herdr Core's 600-second maximum timeout; remote command output is bounded by Core (oversized output errors rather than silently truncating). Ctrl-C cancels the `hc` request and remote process.
- `hc file write` accepts at most 8 MiB per file. Text reads page through `hc file read`; image reads use `hc exec` and are subject to Core's output limit.
- Remote shell uses `bash -lc`. Remote `rg` must be available for `grep`/`find`; file listings use `ls`. Directory and file names containing newlines are not supported by `ls`/`find` parsing.
- This changes tool execution, **not** Pi's actual process cwd, session path, project trust, local context-file discovery, third-party tools, or locally installed skills. `~` is expanded by Pi using the local home directory; use absolute remote paths instead. Any other extension that overrides the same tools may conflict depending on load order.

## Tests

```sh
npm test                         # path tests; remote tests skipped
HC_TEST_MACHINE=fileserver HC_TEST_CWD=/home/adam/hc-core-test npm test
```

Remote tests create and remove uniquely named files in the chosen directory. To run the extension integration test outside Pi, link a Pi 1.5.2 `node_modules` installation as `./node_modules` (development only). Pi supplies those packages when loading the installed extension.
