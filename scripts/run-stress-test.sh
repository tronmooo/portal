#!/bin/bash
# Stress test: Run 10 complex multi-intent queries and capture full results

set -e

API="https://portol.me"
RESULTS_DIR="/home/user/workspace/lifeos/docs/stress-test-results"
mkdir -p "$RESULTS_DIR"

# Authenticate
TOKEN=$(curl -s -X POST "$API/api/auth/signin" \
  -H "Content-Type: application/json" \
  -d '{"email":"tron@aol.com","password":"password"}' | jq -r '.session.access_token')

echo "Auth token obtained: ${TOKEN:0:20}..."

# Read queries
QUERIES=$(cat /home/user/workspace/lifeos/docs/stress-test-queries.json)

for i in $(seq 0 9); do
  QUERY=$(echo "$QUERIES" | jq -r ".[$i]")
  echo ""
  echo "================================================================"
  echo "QUERY $((i+1))/10"
  echo "================================================================"
  echo "$QUERY" | head -c 120
  echo "..."
  
  START=$(date +%s%N)
  
  RESP=$(curl -s -X POST "$API/api/chat" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$QUERY" '{message: $msg}')" \
    --max-time 90 2>&1) || RESP='{"error":"timeout or connection error"}'
  
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  
  echo "Time: ${ELAPSED}ms"
  
  # Save full response
  echo "$RESP" > "$RESULTS_DIR/query-$((i+1))-response.json"
  
  # Extract key info
  REPLY=$(echo "$RESP" | jq -r '.reply // .error // "NO RESPONSE"' 2>/dev/null || echo "PARSE ERROR")
  ACTIONS=$(echo "$RESP" | jq -r '[.actions[]?.type] | join(", ")' 2>/dev/null || echo "none")
  ACTION_COUNT=$(echo "$RESP" | jq -r '.actions | length' 2>/dev/null || echo "0")
  
  echo "Actions ($ACTION_COUNT): $ACTIONS"
  echo "Reply preview: $(echo "$REPLY" | head -c 300)"
  echo ""
  
  # Save summary
  cat > "$RESULTS_DIR/query-$((i+1))-summary.txt" <<EOF
Query $((i+1)):
$QUERY

Time: ${ELAPSED}ms
Actions ($ACTION_COUNT): $ACTIONS

Full Reply:
$REPLY
EOF

  # Small delay between queries to avoid rate limiting
  sleep 2
done

echo ""
echo "================================================================"
echo "ALL 10 QUERIES COMPLETE"
echo "Results saved to: $RESULTS_DIR"
echo "================================================================"

# Now verify what actually got saved in the database
echo ""
echo "=== DATABASE VERIFICATION ==="

echo "Tasks (last 15):"
curl -s "$API/api/tasks" -H "Authorization: Bearer $TOKEN" | jq '[.[] | select(.status != "done") | {title: .title, status: .status, dueDate: .dueDate, linkedProfiles: .linkedProfiles}] | sort_by(.title) | .[:15]' 2>/dev/null

echo ""
echo "Recent Expenses (last 10):"
curl -s "$API/api/expenses" -H "Authorization: Bearer $TOKEN" | jq '[.[-10:] | .[] | {description: .description, amount: .amount, category: .category, date: .date}]' 2>/dev/null

echo ""
echo "Recent Events (next 30 days):"
curl -s "$API/api/events" -H "Authorization: Bearer $TOKEN" | jq '[.[] | select(.date >= "2026-03-28") | {title: .title, date: .date, time: .time, category: .category}] | sort_by(.date) | .[:15]' 2>/dev/null

echo ""
echo "Trackers (names):"
curl -s "$API/api/trackers" -H "Authorization: Bearer $TOKEN" | jq '[.[] | .name] | sort' 2>/dev/null

echo ""
echo "Profiles (names + types):"
curl -s "$API/api/profiles" -H "Authorization: Bearer $TOKEN" | jq '[.[] | {name: .name, type: .type}] | sort_by(.name)' 2>/dev/null

echo ""
echo "Habits:"
curl -s "$API/api/habits" -H "Authorization: Bearer $TOKEN" | jq '[.[] | {name: .name, frequency: .frequency, currentStreak: .currentStreak}]' 2>/dev/null

echo ""
echo "Obligations (last 5 created):"
curl -s "$API/api/obligations" -H "Authorization: Bearer $TOKEN" | jq '[.[-5:] | .[] | {name: .name, amount: .amount, frequency: .frequency}]' 2>/dev/null
