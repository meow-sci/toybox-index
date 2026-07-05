# purrTTY

A real terminal emulator inside Kitten Space Agency.

purrTTY runs actual shell sessions in draggable in-game windows — ConPTY
shells on Windows, POSIX-pty shells on Linux/macOS, and a cross-platform
in-game **Game Console** shell — rendered through KSA's ImGui.

## Features

- **Real shells**: PowerShell, cmd, bash, zsh… whatever your OS has, plus the
  built-in Game Console shell.
- **Faithful emulation**: terminal emulation is delegated to
  [libghostty-vt](https://github.com/ghostty-org/ghostty), the
  conformance-tested VT engine from Ghostty, so TUI apps, pagers, and editors
  just work (mostly VT100/xterm-compatible).
- **Multiple windows and tabs**, per-terminal theming (palette, fonts from
  nerdfonts.com, opacity), and **in-world terminals** rendered onto quads in
  the 3D scene — anchored to vehicle parts or camera billboards.
- **Layouts**: save/load named sets of terminals (2D and in-world) with
  startup commands.
- **One zip, every platform**: prebuilt native libs for win-x64, linux-x64,
  and osx-arm64 are bundled, so the same install works on Windows, macOS, and
  Linux.

Press **F12** (default) to toggle the terminal.

## For mod developers

purrTTY exports a published extension point: implement `ICustomShell` from
`purrTTY.CustomShellContract` and register it to surface your own shell (this
is how [gatOS](https://github.com/meow-sci/gatOS) plugs an entire Linux VM
into purrTTY terminals).
