#!/bin/bash

# Test script for WhatsApp Automation API
# Make sure the server is running: npm start

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Optional: first argument or ENV_FILE env var can point to an env file (e.g. .env.production)
ENV_FILE="${ENV_FILE:-}"
if [ -z "$ENV_FILE" ] && [ -n "${1:-}" ]; then
  ENV_FILE="$1"
fi

# Load from explicit env file first (if provided)
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

# Then, if API_KEY still empty, fall back to local .env
if [ -z "${API_KEY:-}" ] && [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

API_KEY="${API_KEY:-your-api-key-here}"
PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"
# Extra curl options (e.g. -k for self-signed SSL). You can override this via env.
CURL_OPTS="${CURL_OPTS:--k}"

echo -e "${YELLOW}=== WhatsApp Automation API Test Script ===${NC}\n"

# Test 1: Health Check
echo -e "${YELLOW}1. Testing Health Check...${NC}"
response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" "${BASE_URL}/health")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')
if [ "$http_code" -eq 200 ]; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "Response: $body"
else
    echo -e "${RED}✗ Health check failed (HTTP $http_code)${NC}"
    echo "Response: $body"
fi
echo ""

# Test 2: Create or Reuse Session
echo -e "${YELLOW}2. Session Management...${NC}"
echo -e "${API_KEY}"

# Check if there are existing sessions
check_response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/sessions" \
    -H "X-API-Key: ${API_KEY}" 2>/dev/null)
check_http_code=$(echo "$check_response" | tail -n1)
check_body=$(echo "$check_response" | sed '$d')
session_count=0
first_session_id=""

if [ "$check_http_code" -eq 200 ]; then
    session_count=$(echo "$check_body" | jq -r '.count // 0' 2>/dev/null || echo "0")
    first_session_id=$(echo "$check_body" | jq -r '.sessions[0].sessionId // empty' 2>/dev/null || echo "")
fi

echo "Options:"
echo "  1) Create new session (requires cookies)"
echo "  2) List existing sessions"
echo "  3) Reuse existing session"
if [ "$session_count" -gt 0 ] && [ -n "$first_session_id" ]; then
    echo "  4) Use first session (${first_session_id:0:8}...) and continue"
    default_option="4"
else
    default_option="1"
fi
read -p "Choose option [${default_option}]: " session_option
session_option=${session_option:-$default_option}

SESSION_ID=""

if [ "$session_option" = "2" ]; then
    # List sessions
    while true; do
        echo -e "${YELLOW}Listing active sessions...${NC}"
        response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/sessions" \
            -H "X-API-Key: ${API_KEY}")
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | sed '$d')
        
        # Extract session count and first session ID
        if [ "$http_code" -eq 200 ]; then
            echo "$body" | jq '.' 2>/dev/null || echo "$body"
            session_count=$(echo "$body" | jq -r '.count // 0' 2>/dev/null || echo "0")
            first_session_id=$(echo "$body" | jq -r '.sessions[0].sessionId // empty' 2>/dev/null || echo "")
        else
            echo -e "${RED}Failed to list sessions (HTTP $http_code)${NC}"
            echo "$body"
            session_count=0
            first_session_id=""
        fi
        
        echo ""
        echo "Options:"
        echo "  1) Create new session (requires cookies)"
        echo "  2) List existing sessions (refresh)"
        echo "  3) Reuse existing session"
        if [ "$session_count" -gt 0 ] && [ -n "$first_session_id" ]; then
            echo "  4) Use first session and continue to message testing"
            default_option="4"
        else
            default_option="1"
        fi
        read -p "Choose option [${default_option}]: " session_option
        session_option=${session_option:-$default_option}
        
        if [ "$session_option" = "1" ] || [ "$session_option" = "3" ]; then
            break
        elif [ "$session_option" = "4" ]; then
            if [ "$session_count" -gt 0 ] && [ -n "$first_session_id" ]; then
                SESSION_ID="$first_session_id"
                echo -e "${GREEN}✓ Using first session: ${SESSION_ID}${NC}"
                echo ""
                break
            else
                echo -e "${RED}No sessions available for option 4${NC}"
                session_option="1"
                break
            fi
        elif [ "$session_option" != "2" ]; then
            echo -e "${RED}Invalid option${NC}"
            session_option="$default_option"
            break
        fi
        # If option 2, loop continues to refresh list
    done
    
    # Handle the selected option
    if [ "$session_option" = "1" ]; then
        # Create new session
        echo "Note: This requires valid Facebook cookies"
        read -p "Enter cookie string (or press Enter to skip): " cookie_string
        if [ -z "$cookie_string" ]; then
            echo -e "${YELLOW}Skipping session creation${NC}\n"
            SESSION_ID=""
        else
            # Properly escape the cookie string for JSON using jq (most reliable)
            if command -v jq &> /dev/null; then
                json_data=$(jq -n --arg cookies "$cookie_string" '{cookies: $cookies}')
            else
                # Fallback: Use printf with %q for shell escaping, then manually construct JSON
                escaped_cookies=$(printf '%q' "$cookie_string")
                escaped_cookies=${escaped_cookies#\'}
                escaped_cookies=${escaped_cookies%\'}
                escaped_cookies=$(echo "$escaped_cookies" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
                json_data="{\"cookies\": \"${escaped_cookies}\"}"
            fi
            
            response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/sessions" \
                -H "X-API-Key: ${API_KEY}" \
                -H "Content-Type: application/json" \
                -d "${json_data}")
            
            http_code=$(echo "$response" | tail -n1)
            body=$(echo "$response" | sed '$d')
            
            if [ "$http_code" -eq 201 ]; then
                echo -e "${GREEN}✓ Session created successfully${NC}"
                echo "Response: $body"
                SESSION_ID=$(echo "$body" | grep -o '"sessionId":"[^"]*' | cut -d'"' -f4)
                echo -e "${GREEN}Session ID: ${SESSION_ID}${NC}"
            else
                echo -e "${RED}✗ Session creation failed (HTTP $http_code)${NC}"
                echo "Response: $body"
                SESSION_ID=""
            fi
            echo ""
        fi
    elif [ "$session_option" = "3" ]; then
        # Reuse existing session
        read -p "Enter existing session ID: " SESSION_ID
        if [ -n "$SESSION_ID" ]; then
            # Verify session exists
            response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/sessions/${SESSION_ID}" \
                -H "X-API-Key: ${API_KEY}")
            http_code=$(echo "$response" | tail -n1)
            if [ "$http_code" -eq 200 ]; then
                echo -e "${GREEN}✓ Session found and ready to use${NC}"
            else
                echo -e "${RED}✗ Session not found or invalid${NC}"
                SESSION_ID=""
            fi
        fi
        echo ""
    elif [ "$session_option" = "4" ]; then
        # Use first session automatically
        if [ "$session_count" -gt 0 ] && [ -n "$first_session_id" ]; then
            SESSION_ID="$first_session_id"
            echo -e "${GREEN}✓ Using first session: ${SESSION_ID}${NC}"
        else
            echo -e "${RED}No sessions available${NC}"
            SESSION_ID=""
        fi
        echo ""
    else
        # Invalid option - skip session management
        SESSION_ID=""
    fi
elif [ "$session_option" = "3" ]; then
    # Reuse existing session
    read -p "Enter existing session ID: " SESSION_ID
    if [ -n "$SESSION_ID" ]; then
        # Verify session exists
        response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/sessions/${SESSION_ID}" \
            -H "X-API-Key: ${API_KEY}")
        http_code=$(echo "$response" | tail -n1)
        if [ "$http_code" -eq 200 ]; then
            echo -e "${GREEN}✓ Session found and ready to use${NC}"
        else
            echo -e "${RED}✗ Session not found or invalid${NC}"
            SESSION_ID=""
        fi
    fi
    echo ""
elif [ "$session_option" = "1" ]; then
    # Create new session (from initial prompt)
    echo "Note: This requires valid Facebook cookies"
    read -p "Enter cookie string (or press Enter to skip): " cookie_string

    if [ -z "$cookie_string" ]; then
        echo -e "${YELLOW}Skipping session creation${NC}\n"
        SESSION_ID=""
    else
        # Properly escape the cookie string for JSON using jq (most reliable)
        if command -v jq &> /dev/null; then
            json_data=$(jq -n --arg cookies "$cookie_string" '{cookies: $cookies}')
        else
            # Fallback: Use printf with %q for shell escaping, then manually construct JSON
            escaped_cookies=$(printf '%q' "$cookie_string")
            escaped_cookies=${escaped_cookies#\'}
            escaped_cookies=${escaped_cookies%\'}
            escaped_cookies=$(echo "$escaped_cookies" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
            json_data="{\"cookies\": \"${escaped_cookies}\"}"
        fi
        
        response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/sessions" \
            -H "X-API-Key: ${API_KEY}" \
            -H "Content-Type: application/json" \
            -d "${json_data}")
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | sed '$d')
        
        if [ "$http_code" -eq 201 ]; then
            echo -e "${GREEN}✓ Session created successfully${NC}"
            echo "Response: $body"
            SESSION_ID=$(echo "$body" | grep -o '"sessionId":"[^"]*' | cut -d'"' -f4)
            echo -e "${GREEN}Session ID: ${SESSION_ID}${NC}"
        else
            echo -e "${RED}✗ Session creation failed (HTTP $http_code)${NC}"
            echo "Response: $body"
            SESSION_ID=""
        fi
        echo ""
    fi
elif [ "$session_option" = "4" ]; then
    # Use first session automatically (from initial prompt)
    if [ "$session_count" -gt 0 ] && [ -n "$first_session_id" ]; then
        SESSION_ID="$first_session_id"
        echo -e "${GREEN}✓ Using first session: ${SESSION_ID}${NC}"
        echo ""
    else
        echo -e "${RED}No sessions available for option 4${NC}"
        SESSION_ID=""
        echo ""
    fi
fi

# Test 3: Send Message (if session was created)
if [ -n "$SESSION_ID" ]; then
    echo -e "${YELLOW}3. Testing Send Message...${NC}"
    
    # Default values
    DEFAULT_EXTENSION="62"
    DEFAULT_PHONE="87769691301"
    # Generate random word
    RANDOM_WORDS=("test" "hello" "world" "demo" "sample" "check" "verify" "confirm")
    RANDOM_WORD=${RANDOM_WORDS[$RANDOM % ${#RANDOM_WORDS[@]}]}
    DEFAULT_MESSAGE="hari ${RANDOM_WORD}"
    
    read -p "Enter extension [${DEFAULT_EXTENSION}]: " extension
    extension=${extension:-$DEFAULT_EXTENSION}
    
    read -p "Enter phone number [${DEFAULT_PHONE}]: " phone
    phone=${phone:-$DEFAULT_PHONE}
    
    read -p "Enter message [${DEFAULT_MESSAGE}]: " message
    message=${message:-$DEFAULT_MESSAGE}
    
    if [ -n "$extension" ] && [ -n "$phone" ] && [ -n "$message" ]; then
        response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/sessions/${SESSION_ID}/send-message" \
            -H "X-API-Key: ${API_KEY}" \
            -H "Content-Type: application/json" \
            -d "{\"extension\": \"${extension}\", \"phoneNumber\": \"${phone}\", \"message\": \"${message}\"}")
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | sed '$d')
        
        if [ "$http_code" -eq 200 ]; then
            echo -e "${GREEN}✓ Message sent successfully${NC}"
            echo "Response: $body"
        else
            echo -e "${RED}✗ Message sending failed (HTTP $http_code)${NC}"
            echo "Response: $body"
        fi
    else
        echo -e "${YELLOW}Skipping message test (missing input)${NC}"
    fi
    echo ""
    
    # Test 4: Destroy Session
    echo -e "${YELLOW}4. Testing Destroy Session...${NC}"
    read -p "Destroy session ${SESSION_ID}? (y/n) [n]: " confirm
    confirm=${confirm:-n}
    if [ "$confirm" = "y" ]; then
        response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X DELETE "${BASE_URL}/api/sessions/${SESSION_ID}" \
            -H "X-API-Key: ${API_KEY}")
        
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | sed '$d')
        
        if [ "$http_code" -eq 200 ]; then
            echo -e "${GREEN}✓ Session destroyed successfully${NC}"
            echo "Response: $body"
        else
            echo -e "${RED}✗ Session destruction failed (HTTP $http_code)${NC}"
            echo "Response: $body"
        fi
    else
        echo -e "${YELLOW}Skipping session destruction${NC}"
    fi
    echo ""
else
    echo -e "${YELLOW}Skipping message and destroy tests (no session created)${NC}\n"
fi

# Test 5: Invalid API Key
echo -e "${YELLOW}5. Testing Invalid API Key...${NC}"
response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/sessions" \
    -H "X-API-Key: invalid-key")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')
if [ "$http_code" -eq 401 ]; then
    echo -e "${GREEN}✓ Invalid API key correctly rejected (HTTP 401)${NC}"
else
    echo -e "${RED}✗ Invalid API key test failed (expected 401, got $http_code)${NC}"
fi
echo ""

echo -e "${YELLOW}=== Testing Complete ===${NC}"

