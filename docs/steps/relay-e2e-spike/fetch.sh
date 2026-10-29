#!/usr/bin/env bash
# Downloads the spike's tools into .test/spike/ (git-ignored), each into its own new folder, and checks
# every file against the sha256 of the recorded run (run-output.txt) before anything is executed.
# Windows amd64 builds; on macOS or Linux change os/arch/exe below and set SPIKE_ACCEPT_NEW=1 (the
# recorded sums are for the Windows files). No admin rights, no Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
spike="${SPIKE_DIR:-$here/../../../.test/spike}"
mkdir -p "$spike"
cd "$spike"

PEBBLE_TAG=v2.10.1
ACME_CLIENT=5.4.0
os=windows; arch=amd64; exe=.exe

# The files the recorded run used. These are our own record, not a publisher's value: Pebble's release
# has no checksum file, and Caddy's download service publishes none.
expected() {
  cat <<EOF
880206baa1c1a3c3cad1a649d50bf5e22bcfdd3bb06414de218a7486347f64fa  dl-caddy/caddy$exe
2539f3903302d75f897522b23b1b52b3300f5f992245f13d3bdf3967cf23af6d  dl-pebble/pebble.zip
c87fb918d9bac8db11aa54493b5f0cf6e0725a3fe73f617d1c64737e1ab4caf9  dl-pebble/cert.pem
0977979255b0e0721c17335c056b627f66a43cf56e5a52f3cda81fb111ecf00e  dl-pebble/key.pem
0c502e52627ff7de972c7e9e065640103b4589b4e2d23d3fcf21bef1e3c8c67c  dl-pebble/pebble.minica.pem
f4621c6ce1ac025c4f49a7316ec3d16779df8c5b09276a2544f5a5198a95e32a  dl-challtestsrv/challtestsrv.zip
EOF
}

# Caddy with the layer4 module, built by Caddy's download service. The service builds its current
# release and ignores a version parameter (asked for v2.10.0 on 2026-10-18, got v2.11.7), so the
# recorded run's Caddy can only be checked by its sum, not asked for. Pinned alternative, with Go:
#   xcaddy build v2.11.7 --with github.com/mholt/caddy-l4@v0.1.2
if [ ! -f dl-caddy/caddy$exe ]; then
  mkdir dl-caddy
  curl -fsSL -o "dl-caddy/caddy$exe" "https://caddyserver.com/api/download?os=$os&arch=$arch&p=github.com%2Fmholt%2Fcaddy-l4"
fi

# Pebble, Let's Encrypt's test CA, and the test certificate and CA from its source at the same tag.
if [ ! -f dl-pebble/pebble.zip ]; then
  mkdir dl-pebble
  curl -fsSL -o dl-pebble/pebble.zip "https://github.com/letsencrypt/pebble/releases/download/$PEBBLE_TAG/pebble-$os-$arch.zip"
  raw="https://raw.githubusercontent.com/letsencrypt/pebble/$PEBBLE_TAG"
  for f in test/certs/localhost/cert.pem test/certs/localhost/key.pem test/certs/pebble.minica.pem; do
    curl -fsSL -o "dl-pebble/$(basename "$f")" "$raw/$f"
  done
fi

# Pebble's companion mock DNS server: answers every name with 127.0.0.1 and serves CAA records we
# set, so Pebble can resolve *.l.test without the hosts file or real DNS.
if [ ! -f dl-challtestsrv/challtestsrv.zip ]; then
  mkdir dl-challtestsrv
  curl -fsSL -o dl-challtestsrv/challtestsrv.zip "https://github.com/letsencrypt/pebble/releases/download/$PEBBLE_TAG/pebble-challtestsrv-$os-$arch.zip"
fi

# Nothing downloaded runs before this check.
if ! expected | sha256sum -c -; then
  if [ "${SPIKE_ACCEPT_NEW:-}" = 1 ]; then
    echo "fetch.sh: files differ from the recorded run; going on because SPIKE_ACCEPT_NEW=1" >&2
  else
    echo "fetch.sh: files differ from the recorded run (above). Delete them to download again, or set SPIKE_ACCEPT_NEW=1 to use them anyway." >&2
    exit 1
  fi
fi
[ -f dl-pebble/pebble$exe ] || (cd dl-pebble && unzip -q pebble.zip && find . -name "pebble$exe" -exec mv {} . \;)
[ -f dl-challtestsrv/pebble-challtestsrv$exe ] || (cd dl-challtestsrv && unzip -q challtestsrv.zip && find . -name "pebble-challtestsrv$exe" -exec mv {} . \;)

# acme-client, the library the proposal picks, at the recorded version, in a folder of its own (not
# the repo's dependencies). npm checks the package's own integrity hash.
if [ ! -d node/node_modules/acme-client ]; then
  mkdir -p node
  (cd node && npm init -y >/dev/null && npm install --no-audit --no-fund "acme-client@$ACME_CLIENT")
fi

"./dl-caddy/caddy$exe" version
"./dl-caddy/caddy$exe" list-modules --versions | grep -E '^layer4\.(matchers\.tls|handlers\.proxy) '
"./dl-pebble/pebble$exe" -version
node -e "console.log('acme-client', require('./node/node_modules/acme-client/package.json').version)"
