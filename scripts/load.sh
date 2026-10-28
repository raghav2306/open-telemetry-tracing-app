#!/usr/bin/env bash
# Generate a mix of traffic so Jaeger has plenty of traces to explore.
#   ./scripts/load.sh                 # 30 requests against http://localhost:3000
#   ./scripts/load.sh 100             # 100 requests
#   BASE_URL=http://localhost:8080 ./scripts/load.sh 50
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
COUNT="${1:-30}"
AUTH="Authorization: Bearer demo-token"

# Weighted mix: mostly happy, some slow, a few failures.
SCENARIOS=(happy happy happy happy happy slow slow error declined soldout invalid noauth)

for i in $(seq 1 "$COUNT"); do
  s=${SCENARIOS[$RANDOM % ${#SCENARIOS[@]}]}
  if [ "$s" = noauth ]; then
    out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' "$BASE_URL/api/demo/happy")
  else
    out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -H "$AUTH" "$BASE_URL/api/demo/$s")
  fi
  printf '%3d  %-9s -> HTTP %s s\n' "$i" "$s" "$out"
done
echo "Done. Open the Jaeger UI (http://localhost:16686) and search for service 'api-gateway'."
