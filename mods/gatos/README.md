# gatOS

A real, minimal **Alpine Linux** running inside Kitten Space Agency.

gatOS boots an Alpine guest in a QEMU microVM subprocess and drops you into it
through [purrTTY](https://github.com/meow-sci/purrtty) terminal windows over
SSH. Real `apk`, real shells, real pipes, jobs, pagers, and editors — no
hand-written fake terminal userland.

## The `/sim` filesystem

Live KSA vehicle telemetry is exposed to the guest **as a filesystem**,
mounted at `/sim` (a 9P server implemented in the mod). The entire unix
toolbox becomes the game API:

```sh
cat /sim/vessels/active/telemetry
watch -n1 cat /sim/vessels/active/altitude
echo 1 > /sim/vessels/active/ctl/throttle
```

You can write flight computers and autopilots in shell, Python, or anything
that can read and write files. The same surface is mirrored over HTTP (`/v1`)
and MQTT, and there is a TypeScript SDK. See the
[tutorial series](https://meow.science.fail/gatOS/) for a progressive guide to
writing flight programs.

## Platform notes

- **Windows** (`gatOS-windows-*.zip`): self-contained — bundles a win-x64
  QEMU, zero prerequisites.
- **Linux** (`gatOS-linux-*.zip`): requires a system QEMU
  (`qemu-system-x86_64` on PATH).

gatOS works best with purrTTY installed (its terminals appear as purrTTY
shells) but stays manageable from its own menu without it.

## Persistence

Guest disk state is stored as qcow2 overlays per save profile on top of a
pristine shipped base image — your in-guest changes survive across sessions.
