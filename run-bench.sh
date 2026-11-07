#!/bin/bash
# Benchmarks every JS runtime variant in turn with k6, then builds benchmark-report.html.
# Usage: bash run-bench.sh [runtime ...]   (default: all)
set -e
cd "$(dirname "$0")"

ALL=(node node-cluster deno deno-parallel bun bun-reuseport)
RUNTIMES=("${@:-${ALL[@]}}")
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="./results/${TIMESTAMP}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

port_of() { for i in "${!ALL[@]}"; do if [ "${ALL[$i]}" = "$1" ]; then echo $((8001 + i)); fi; done; }

for rt in "${RUNTIMES[@]}"; do
    [ -n "$(port_of "$rt")" ] || { echo -e "${RED}Unknown runtime: ${rt}${NC} (choose from: ${ALL[*]})"; exit 1; }
done

mkdir -p "$RESULTS_DIR"
chmod -R a+rwX ./results  # k6 container runs as non-root and must write here

echo -e "${BLUE}[1/4] Building images...${NC}"
docker compose build

echo -e "${BLUE}[2/4] Starting services...${NC}"
docker compose up -d db $(printf 'app-%s ' "${ALL[@]}")

echo -e "${BLUE}[3/4] Waiting for services + smoke tests...${NC}"
for rt in "${RUNTIMES[@]}"; do
    port=$(port_of "$rt")
    for _ in $(seq 60); do
        curl -sf "http://localhost:${port}/api/health" >/dev/null && break
        sleep 1
    done
    if docker compose --profile bench run --rm -e BASE_URL="http://app-${rt}:8000" -e K6_OUT= \
        k6 run --quiet /scripts/smoke.js >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓ ${rt} (port ${port})${NC}"
    else
        echo -e "  ${RED}✗ ${rt} smoke test failed${NC}"; exit 1
    fi
done

echo -e "${BLUE}[4/4] Running benchmarks...${NC}"
for i in "${!RUNTIMES[@]}"; do
    rt="${RUNTIMES[$i]}"
    # Start every runtime from the same 100 seeded posts. Otherwise rows
    # written by earlier runs make the list query slower for later runtimes.
    docker compose exec -T db psql -q -U bench -d js_bench \
        -c "DELETE FROM posts WHERE id > 100" -c "VACUUM ANALYZE posts" >/dev/null
    echo -e "${CYAN}━━━ Benchmarking: ${rt^^} (http://app-${rt}:8000) ━━━${NC}"
    docker compose --profile bench run --rm \
        -e BASE_URL="http://app-${rt}:8000" \
        -e RUNTIME="${rt}" \
        -e K6_OUT="${K6_RAW:+json=/results/${TIMESTAMP}/${rt}_raw.json}" \
        k6 run /scripts/benchmark.js 2>&1 | tee "${RESULTS_DIR}/${rt}_output.txt"
    if [ $i -lt $((${#RUNTIMES[@]} - 1)) ]; then
        echo -e "${YELLOW}  Cooling down for 10 seconds...${NC}"; sleep 10
    fi
done

echo -e "${YELLOW}[Report] Generating benchmark-report.html...${NC}"
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/src" -w /src node:26.13.0-slim node report/build.mjs
echo -e "${GREEN}Done.${NC} Results in ${RESULTS_DIR}/, report in benchmark-report.html"
