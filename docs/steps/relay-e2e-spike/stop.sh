#!/usr/bin/env bash
# Stops whatever listens on the given ports, and only that (never by process name). Windows: netstat
# and taskkill; elsewhere: lsof and kill.
for port in "$@"; do
  if command -v taskkill >/dev/null 2>&1; then
    for pid in $(netstat -ano | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u); do
      [ "$pid" != "0" ] && taskkill //PID "$pid" //F >/dev/null 2>&1 && echo "stopped pid $pid on port $port"
    done
  else
    for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do kill "$pid" && echo "stopped pid $pid on port $port"; done
  fi
done
exit 0
