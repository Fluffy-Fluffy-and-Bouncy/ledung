# Spike for end-to-end encryption through the relay (#199)

The findings are in [../relay-e2e.md](../relay-e2e.md#spike-findings-199). Not production code, and not run by `npm run check`.

From the repository root, after `npm install`, in Git Bash (Windows) or any shell (macOS/Linux; change `os`, `arch` and `exe` in `fetch.sh` and `run.sh`, and set `SPIKE_ACCEPT_NEW=1` because the recorded sums are for the Windows files):

```sh
bash docs/steps/relay-e2e-spike/fetch.sh   # Caddy with caddy-l4, Pebble, its mock DNS, acme-client → .test/spike/ (git-ignored)
bash docs/steps/relay-e2e-spike/run.sh     # starts them on 127.0.0.1:51053–51481, runs spike.ts, stops them by port
```

No admin rights, no Docker, no hosts file, no real DNS, nothing on any server, no Let's Encrypt. `run-output.txt` is the last run's output. `stop.sh <ports…>` stops whatever listens on those ports, if a run was cut short.

**One run at a time per machine:** `run.sh` stops whatever listens on its eight fixed ports before it starts, so a second run would stop the first one's Caddy and Pebble. The ports are outside Ledung's test ports (4396–4399).

## What the recorded run used

| Tool | Version | Pinned how |
|---|---|---|
| Caddy + caddy-l4 | v2.11.7, layer4 v0.1.2 (Windows amd64) | Caddy's download service builds its current release and ignores a version parameter, so `fetch.sh` checks the file against the sum below and stops on a different build. Pinned instead: `xcaddy build v2.11.7 --with github.com/mholt/caddy-l4@v0.1.2` |
| Pebble, pebble-challtestsrv | v2.10.1 | release tag |
| acme-client | 5.4.0 | exact npm version (npm checks its integrity hash) |
| Node | v24.14.1 | — |

sha256 of the files, as recorded on 2026-10-18. These are our own record, not a publisher's value: neither Pebble's release nor Caddy's download service publishes a checksum. `fetch.sh` checks them before it runs anything it downloaded.

```
880206baa1c1a3c3cad1a649d50bf5e22bcfdd3bb06414de218a7486347f64fa  dl-caddy/caddy.exe
2539f3903302d75f897522b23b1b52b3300f5f992245f13d3bdf3967cf23af6d  dl-pebble/pebble.zip
f4621c6ce1ac025c4f49a7316ec3d16779df8c5b09276a2544f5a5198a95e32a  dl-challtestsrv/challtestsrv.zip
```

(and the three test certificate files from Pebble's source, listed in `fetch.sh`).
