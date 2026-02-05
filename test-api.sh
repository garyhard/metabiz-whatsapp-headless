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

echo -e "${YELLOW}=== WhatsApp Automation API Test Script ===${NC}"
echo -e "${YELLOW}Base URL: ${BASE_URL}${NC}\n"

read_cookie_payload() {
    local prompt="$1"
    local input=""
    read -p "$prompt" input
    if [[ "$input" == @* ]]; then
        local file="${input#@}"
        if [ -f "$file" ]; then
            input="$(cat "$file")"
        else
            echo "__INVALID_FILE__:${file}"
            return
        fi
    fi
    echo "$input"
}

build_json_payload() {
    local cookies_input="$1"
    local proxy_server="${2:-}"
    local proxy_username="${3:-}"
    local proxy_password="${4:-}"

    if command -v jq &> /dev/null; then
        if echo "$cookies_input" | jq -e . >/dev/null 2>&1; then
            local cookies_compact
            cookies_compact=$(echo "$cookies_input" | jq -c .)
            if [ -n "$proxy_server" ]; then
                if [ -n "$proxy_username" ] && [ -n "$proxy_password" ]; then
                    jq -n --argjson cookies "$cookies_compact" --arg server "$proxy_server" --arg username "$proxy_username" --arg password "$proxy_password" \
                        '{cookies: $cookies, proxy: {server: $server, username: $username, password: $password}}'
                elif [ -n "$proxy_username" ]; then
                    jq -n --argjson cookies "$cookies_compact" --arg server "$proxy_server" --arg username "$proxy_username" \
                        '{cookies: $cookies, proxy: {server: $server, username: $username}}'
                else
                    jq -n --argjson cookies "$cookies_compact" --arg server "$proxy_server" \
                        '{cookies: $cookies, proxy: {server: $server}}'
                fi
            else
                jq -n --argjson cookies "$cookies_compact" '{cookies: $cookies}'
            fi
        else
            if [ -n "$proxy_server" ]; then
                if [ -n "$proxy_username" ] && [ -n "$proxy_password" ]; then
                    jq -n --arg cookies "$cookies_input" --arg server "$proxy_server" --arg username "$proxy_username" --arg password "$proxy_password" \
                        '{cookies: $cookies, proxy: {server: $server, username: $username, password: $password}}'
                elif [ -n "$proxy_username" ]; then
                    jq -n --arg cookies "$cookies_input" --arg server "$proxy_server" --arg username "$proxy_username" \
                        '{cookies: $cookies, proxy: {server: $server, username: $username}}'
                else
                    jq -n --arg cookies "$cookies_input" --arg server "$proxy_server" '{cookies: $cookies, proxy: {server: $server}}'
                fi
            else
                jq -n --arg cookies "$cookies_input" '{cookies: $cookies}'
            fi
        fi
    else
        if [[ "$cookies_input" =~ ^[[:space:]]*[\[\{] ]]; then
            if [ -n "$proxy_server" ]; then
                if [ -n "$proxy_username" ] && [ -n "$proxy_password" ]; then
                    echo "{\"cookies\": ${cookies_input}, \"proxy\": {\"server\": \"${proxy_server}\", \"username\": \"${proxy_username}\", \"password\": \"${proxy_password}\"}}"
                elif [ -n "$proxy_username" ]; then
                    echo "{\"cookies\": ${cookies_input}, \"proxy\": {\"server\": \"${proxy_server}\", \"username\": \"${proxy_username}\"}}"
                else
                    echo "{\"cookies\": ${cookies_input}, \"proxy\": {\"server\": \"${proxy_server}\"}}"
                fi
            else
                echo "{\"cookies\": ${cookies_input}}"
            fi
        else
            local escaped_cookies
            escaped_cookies=$(printf '%q' "$cookies_input")
            escaped_cookies=${escaped_cookies#\'}
            escaped_cookies=${escaped_cookies%\'}
            escaped_cookies=$(echo "$escaped_cookies" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
            if [ -n "$proxy_server" ]; then
                local escaped_server
                escaped_server=$(printf '%q' "$proxy_server")
                escaped_server=${escaped_server#\'}
                escaped_server=${escaped_server%\'}
                escaped_server=$(echo "$escaped_server" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
                if [ -n "$proxy_username" ] && [ -n "$proxy_password" ]; then
                    local escaped_user escaped_pass
                    escaped_user=$(printf '%q' "$proxy_username")
                    escaped_user=${escaped_user#\'}
                    escaped_user=${escaped_user%\'}
                    escaped_user=$(echo "$escaped_user" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
                    escaped_pass=$(printf '%q' "$proxy_password")
                    escaped_pass=${escaped_pass#\'}
                    escaped_pass=${escaped_pass%\'}
                    escaped_pass=$(echo "$escaped_pass" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
                    echo "{\"cookies\": \"${escaped_cookies}\", \"proxy\": {\"server\": \"${escaped_server}\", \"username\": \"${escaped_user}\", \"password\": \"${escaped_pass}\"}}"
                elif [ -n "$proxy_username" ]; then
                    local escaped_user
                    escaped_user=$(printf '%q' "$proxy_username")
                    escaped_user=${escaped_user#\'}
                    escaped_user=${escaped_user%\'}
                    escaped_user=$(echo "$escaped_user" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
                    echo "{\"cookies\": \"${escaped_cookies}\", \"proxy\": {\"server\": \"${escaped_server}\", \"username\": \"${escaped_user}\"}}"
                else
                    echo "{\"cookies\": \"${escaped_cookies}\", \"proxy\": {\"server\": \"${escaped_server}\"}}"
                fi
            else
                echo "{\"cookies\": \"${escaped_cookies}\"}"
            fi
        fi
    fi
}

# Playwright-based proxy + cookie validation (via API)
echo -e "${YELLOW}0. Proxy Validate (Playwright)...${NC}"
read -p "Test proxy via Playwright now? (y/n) [n]: " do_proxy_check
do_proxy_check=${do_proxy_check:-n}
if [ "$do_proxy_check" = "y" ]; then
    read -p "Enter proxy server (e.g., http://host:port or socks5://host:port): " proxy_server
    if [ -z "$proxy_server" ]; then
        echo -e "${RED}Proxy server is required for proxy check.${NC}"
    else
        read -p "Enter proxy username [optional]: " proxy_username
        read -p "Enter proxy password [optional]: " proxy_password
        payload=$(jq -n --arg server "$proxy_server" --arg username "$proxy_username" --arg password "$proxy_password" \
          '{proxy: {server: $server, username: ($username | select(length>0)), password: ($password | select(length>0))}}')
        if [ -z "$payload" ] || [ "$payload" = "null" ]; then
          payload="{\"proxy\":{\"server\":\"${proxy_server}\"}}"
        fi
        echo -e "${YELLOW}Calling /api/cookies/validate-proxy (Playwright)...${NC}"
        response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -H "Content-Type: application/json" -H "x-api-key: ${API_KEY}" \
            -d "$payload" "${BASE_URL}/api/cookies/validate-proxy")
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | sed '$d')
        if [ "$http_code" -eq 200 ]; then
            echo -e "${GREEN}✓ Proxy OK${NC}"
            echo "Response: $body"
        else
            echo -e "${RED}✗ Proxy check failed (HTTP $http_code)${NC}"
            echo "Response: $body"
        fi
    fi
fi
echo ""

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

# Optional: clear all sessions
echo -e "${YELLOW}1b. Clear all sessions (danger)...${NC}"
read -p "Destroy all sessions now? (y/n) [n]: " do_clear_all
do_clear_all=${do_clear_all:-n}
if [ "$do_clear_all" = "y" ]; then
    response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -H "Content-Type: application/json" -H "x-api-key: ${API_KEY}" \
        -X POST "${BASE_URL}/api/sessions/clear-all")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ Cleared${NC}"
        echo "Response: $body"
    else
        echo -e "${RED}✗ Clear failed (HTTP $http_code)${NC}"
        echo "Response: $body"
    fi
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
        echo "Paste cookies as header string, JSON array, or @/path/to/cookies.json"
        cookie_string=$(read_cookie_payload "Enter cookies (or press Enter to skip): ")
        if [[ "$cookie_string" == __INVALID_FILE__:* ]]; then
            echo -e "${RED}Invalid file path: ${cookie_string#__INVALID_FILE__:}${NC}"
            cookie_string=""
        fi
        if [ -z "$cookie_string" ]; then
            echo -e "${YELLOW}Skipping session creation${NC}\n"
            SESSION_ID=""
        else
            # Ask for proxy (optional)
            read -p "Enter proxy server (e.g., http://proxy.example.com:8080 or socks5://proxy.example.com:1080) [optional]: " proxy_server
            proxy_username=""
            proxy_password=""
            if [ -n "$proxy_server" ]; then
                read -p "Enter proxy username [optional]: " proxy_username
                read -p "Enter proxy password [optional]: " proxy_password
            fi
            
            json_data=$(build_json_payload "$cookie_string" "$proxy_server" "$proxy_username" "$proxy_password")
            
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
            body=$(echo "$response" | sed '$d')
            if [ "$http_code" -eq 200 ]; then
                echo -e "${GREEN}✓ Session found and ready to use${NC}"
                echo "Response: $body" | jq '.' 2>/dev/null || echo "Response: $body"
            else
                echo -e "${RED}✗ Session not found or invalid${NC}"
                echo "Response: $body"
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
        body=$(echo "$response" | sed '$d')
        if [ "$http_code" -eq 200 ]; then
            echo -e "${GREEN}✓ Session found and ready to use${NC}"
            echo "Response: $body" | jq '.' 2>/dev/null || echo "Response: $body"
        else
            echo -e "${RED}✗ Session not found or invalid${NC}"
            echo "Response: $body"
            SESSION_ID=""
        fi
    fi
    echo ""
elif [ "$session_option" = "1" ]; then
    # Create new session (from initial prompt)
    echo "Note: This requires valid Facebook cookies"
    echo "Paste cookies as header string, JSON array, or @/path/to/cookies.json"
    cookie_string=$(read_cookie_payload "Enter cookies (or press Enter to skip): ")
    if [[ "$cookie_string" == __INVALID_FILE__:* ]]; then
        echo -e "${RED}Invalid file path: ${cookie_string#__INVALID_FILE__:}${NC}"
        cookie_string=""
    fi

    if [ -z "$cookie_string" ]; then
        echo -e "${YELLOW}Skipping session creation${NC}\n"
        SESSION_ID=""
    else
        # Ask for proxy (optional)
        read -p "Enter proxy server (e.g., http://proxy.example.com:8080 or socks5://proxy.example.com:1080) [optional]: " proxy_server
        proxy_username=""
        proxy_password=""
        if [ -n "$proxy_server" ]; then
            read -p "Enter proxy username [optional]: " proxy_username
            read -p "Enter proxy password [optional]: " proxy_password
        fi
        
        json_data=$(build_json_payload "$cookie_string" "$proxy_server" "$proxy_username" "$proxy_password")
        
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

# Test 3: Check Session Flow (if session was created)
if [ -n "$SESSION_ID" ]; then
    echo -e "${YELLOW}3. Testing Session Check...${NC}"
    response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/sessions/${SESSION_ID}/check" \
        -H "X-API-Key: ${API_KEY}")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    if [ "$http_code" -eq 200 ]; then
        echo -e "${GREEN}✓ Session check ok${NC}"
        echo "Response: $body"
    else
        echo -e "${RED}✗ Session check failed (HTTP $http_code)${NC}"
        echo "Response: $body"
    fi
    echo ""
fi

# Test 4: Update Cookies (optional)
if [ -n "$SESSION_ID" ]; then
    echo -e "${YELLOW}4. Testing Update Cookies...${NC}"
    read -p "Update cookies for this session? (y/n) [n]: " update_cookies
    update_cookies=${update_cookies:-n}
    if [ "$update_cookies" = "y" ]; then
        echo "Paste cookies as header string, JSON array, or @/path/to/cookies.json"
        new_cookie_string=$(read_cookie_payload "Enter new cookies: ")
        if [[ "$new_cookie_string" == __INVALID_FILE__:* ]]; then
            echo -e "${RED}Invalid file path: ${new_cookie_string#__INVALID_FILE__:}${NC}"
            new_cookie_string=""
        fi
        if [ -n "$new_cookie_string" ]; then
            json_data=$(build_json_payload "$new_cookie_string")
            response=$(curl ${CURL_OPTS} -s -w "\n%{http_code}" -X PUT "${BASE_URL}/api/sessions/${SESSION_ID}/cookies" \
                -H "X-API-Key: ${API_KEY}" \
                -H "Content-Type: application/json" \
                -d "${json_data}")
            http_code=$(echo "$response" | tail -n1)
            body=$(echo "$response" | sed '$d')
            if [ "$http_code" -eq 200 ]; then
                echo -e "${GREEN}✓ Cookies updated successfully${NC}"
                echo "Response: $body"
            else
                echo -e "${RED}✗ Cookies update failed (HTTP $http_code)${NC}"
                echo "Response: $body"
            fi
        else
            echo -e "${YELLOW}Skipping cookies update (empty input)${NC}"
        fi
    else
        echo -e "${YELLOW}Skipping cookies update${NC}"
    fi
    echo ""
fi

# Test 5: Send Message (if session was created)
if [ -n "$SESSION_ID" ]; then
    echo -e "${YELLOW}5. Testing Send Message...${NC}"
    
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
    
    # Test 6: Destroy Session
    echo -e "${YELLOW}6. Testing Destroy Session...${NC}"
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

# Test 7: Invalid API Key
echo -e "${YELLOW}7. Testing Invalid API Key...${NC}"
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
