#!/usr/bin/env bash
# Runs the spike from scratch: Pebble's mock DNS, Pebble, Caddy with caddy-l4, then spike.ts.
# Run fetch.sh first. Everything listens on 127.0.0.1 only, on ports 51053-51481; nothing needs admin
# rights, Docker, the hosts file or real DNS. Stops what it started (by port) when it ends.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
export SPIKE_DIR="${SPIKE_DIR:-$repo/.test/spike}"
cd "$SPIKE_DIR"
rm -rf caddy-data logs && mkdir -p logs
exe=.exe
PORTS="51053 51055 51400 51401 51443 51480 51444 51481"

stop() { bash "$here/stop.sh" $PORTS; }
trap stop EXIT
stop

# A for every name is 127.0.0.1; no AAAA, so nothing tries ::1. Only DNS and its management API.
./dl-challtestsrv/pebble-challtestsrv$exe -defaultIPv4 127.0.0.1 -defaultIPv6 "" \
  -dnsserver 127.0.0.1:51053 -management 127.0.0.1:51055 \
  -http01 "" -https01 "" -tlsalpn01 "" -doh "" >logs/challtestsrv.log 2>&1 &
# No sleeps in validation, and no random nonce rejections, so the run is quick and repeatable.
PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0 \
  ./dl-pebble/pebble$exe -config "$here/pebble.json" -dnsserver 127.0.0.1:51053 >logs/pebble.log 2>&1 &
./dl-caddy/caddy$exe run --config "$here/Caddyfile" --adapter caddyfile >logs/caddy.log 2>&1 &

# Wait for Caddy's local CA root (made on start for site.test) and Pebble's directory.
for _ in $(seq 1 50); do
  [ -f caddy-data/pki/authorities/local/root.crt ] && curl -fsS --cacert dl-pebble/pebble.minica.pem https://127.0.0.1:51400/dir >/dev/null 2>&1 && break
  sleep 0.2
done

echo "== versions =="
./dl-caddy/caddy$exe version
./dl-caddy/caddy$exe list-modules --versions | grep -E '^layer4\.(matchers\.tls|handlers\.proxy) '
./dl-pebble/pebble$exe -version
node -e "console.log('acme-client', require('./node/node_modules/acme-client/package.json').version, '· node', process.version)"
echo

# Pebble's API certificate is signed by its own minica root.
NODE_EXTRA_CA_CERTS="$SPIKE_DIR/dl-pebble/pebble.minica.pem" node "$here/spike.ts"
status=$?

# The same two checks by hand, as a phone would: the ordinary site and an unknown Ledung name.
echo
echo "== curl, as a phone =="
curl -sS --ssl-no-revoke --resolve site.test:51443:127.0.0.1 --cacert caddy-data/pki/authorities/local/root.crt https://site.test:51443/; echo
curl -sS --resolve nobody.l.test:51443:127.0.0.1 -k https://nobody.l.test:51443/ 2>&1 | head -1
# "Port 80" only redirects a Ledung name to https; Caddy holds no certificate for it.
curl -sS --resolve copper7meadow4.l.test:51480:127.0.0.1 -o /dev/null -w 'port 80: %{http_code} -> %{redirect_url}\n' http://copper7meadow4.l.test:51480/x
echo "spike.ts exit $status"
exit $status
