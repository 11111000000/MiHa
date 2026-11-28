#!/usr/bin/env sh
# The live check against MiniMax.
#
# One streamed request to the OpenAI-compatible endpoint, with the key taken from
# the environment. The key goes into the request header and nowhere else: it is
# never printed, never written to a file and never passed on a command line.
#
# The header is handed to curl on its **standard input** (`-K -`), not on its
# command line. Every user on the host can read the process table while a
# request is in flight, and an argument is in the process table: a key in
# `curl -H "Authorization: Bearer …"` is a key every user on the host can read
# for as long as the request lasts. A config on stdin is not.
#
# It prints the status and the first records of the stream, and a line about the
# shape of the answer — the fields that arrived, whether the stream carried a
# terminal marker, and the usage it reported. That is what the fieldwork slice
# reads to learn whether the provider still answers the way the fixture says it
# does.
#
# Without MINIMAX_API_KEY there is nothing to check, so the script says so and
# fails: a check that passes without the thing it checks proves nothing.

# The repo-local secrets: the provider's key, read from .env when it is there.
if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  . "$(dirname "$0")/../.env"
  set +a
fi

set -e

BASE_URL="${MINIMAX_BASE_URL:-https://api.minimax.io/v1}"
MODEL="${MINIMAX_MODEL:-MiniMax-M2.5-highspeed}"

if [ -z "${MINIMAX_API_KEY:-}" ]; then
	echo "minimax-smoke: MINIMAX_API_KEY is not set, so there is no key to check" >&2
	exit 1
fi

BODY='{"model":"'"$MODEL"'","messages":[{"role":"user","content":"Reply with the single word: ready"}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":64}'

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# The key travels in the config, which curl reads from its standard input. The
# shell expands it into the here-document, so it never becomes an argument of
# any process.
STATUS=$(curl -sS -N --max-time 90 -o "$TMP" -w '%{http_code}' \
	-K - \
	-X POST "$BASE_URL/chat/completions" \
	-H "content-type: application/json" \
	--data "$BODY" <<CURL_CONFIG
header = "Authorization: Bearer $MINIMAX_API_KEY"
CURL_CONFIG
) || {
	echo "minimax-smoke: the request to $BASE_URL did not complete" >&2
	exit 1
}

echo "minimax-smoke: $BASE_URL answered $STATUS for model $MODEL"

if [ "$STATUS" != "200" ]; then
	echo "minimax-smoke: the provider answered with:" >&2
	head -c 400 "$TMP" >&2
	echo "" >&2
	exit 1
fi

RECORDS=$(grep -c '^data: ' "$TMP" || true)
echo "minimax-smoke: the stream carried $RECORDS records"

echo "minimax-smoke: the first three records:"
grep '^data: ' "$TMP" | head -n 3

for FIELD in content reasoning_content tool_calls finish_reason; do
	if grep -q "\"$FIELD\"" "$TMP"; then
		echo "minimax-smoke: the stream carried $FIELD"
	fi
done

if grep -q '\[DONE\]' "$TMP"; then
	echo "minimax-smoke: the stream carried the [DONE] marker"
else
	echo "minimax-smoke: the stream carried no [DONE] marker"
fi

echo "minimax-smoke: the usage it reported:"
grep '"usage":{' "$TMP" | tail -n 1 || echo "minimax-smoke: no usage record"
