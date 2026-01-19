# Headless Meta Business Suite WhatsApp Automation Service

A headless browser automation service that replicates Chrome extension functionality for sending WhatsApp messages via Meta Business Suite. The service runs on a cloud server and can handle ~100 concurrent browser sessions, each lasting ~3 days.

## Features

- **Headless Browser Automation**: Uses Playwright with custom fingerprinting to avoid detection
- **Session Management**: Create, manage, and destroy browser sessions with persistent cookie storage
- **Unique Fingerprinting**: Each session gets a unique but realistic browser fingerprint
- **REST API**: Simple HTTP API for session and message management
- **API Key Authentication**: Secure API key-based authentication
- **Activity Simulation**: Subtle human-like activity to keep sessions alive
- **Graceful Shutdown**: Properly closes all browser sessions on server shutdown

## Technology Stack

- **Runtime**: Node.js (ES Modules)
- **Browser Automation**: Playwright with custom fingerprinting
- **API Framework**: Express.js
- **Authentication**: API key middleware
- **Storage**: In-memory Map (sessionId → browser instance)

## Prerequisites

- Node.js 18+ (with ES modules support)
- npm or yarn
- Sufficient system resources:
  - For ~100 sessions: 64-128GB RAM, 32-64 CPU cores
  - Each browser instance: ~500MB-1GB RAM, ~0.2-0.4 CPU cores

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd metabiz-whatsapp-headless
```

2. Install dependencies:
```bash
npm install
```

3. Install Playwright browsers:
```bash
npx playwright install chromium
```

4. Create a `.env` file in the project root:
```bash
# Generate a secure API key (run this command):
# openssl rand -hex 32

# Create .env file
cat > .env << EOF
API_KEY=your-secret-api-key-here
PORT=3000
DEV_MODE=false
HEADLESS=true
EOF
```

Or manually create `.env` with:
```
API_KEY=your-secret-api-key-here
PORT=3000
DEV_MODE=false
HEADLESS=true
```

**Environment Variables:**
- `API_KEY` (required): API key for authentication
- `PORT` (optional): Server port (default: 3000)
- `DEV_MODE` (optional): Set to `true` to preserve sessions across server restarts (default: `false`)
- `HEADLESS` (optional): Set to `false` to run browser in visible mode for debugging (default: `true`)

**Note**: The `.env` file is already in `.gitignore` and will not be committed to version control.

## Usage

### Start the Server

```bash
npm start
```

Or for development with auto-reload (sessions preserved across restarts):
```bash
npm run dev
```

**Dev Mode (`DEV_MODE=true` or `npm run dev`):**
- **Sessions persist across restarts**: When you restart the server, all active sessions are automatically recreated using saved cookie strings and fingerprints
- **Session metadata saved**: Session information (cookies, fingerprints) is saved to `profiles/sessions.json`
- **Sessions preserved on shutdown**: When you stop the server, sessions are NOT destroyed - they remain in the metadata file and will be recreated on next startup
- **Useful for development**: You don't need to recreate sessions every time you restart the server while coding

**Production Mode (`DEV_MODE=false` or `npm start`):**
- **Sessions destroyed on shutdown**: All browser sessions are properly closed and cleaned up when the server stops
- **No session persistence**: Sessions are not saved to disk
- **Useful for production**: Ensures clean shutdown and proper resource cleanup

The server will start on port 3000 (or the port specified in `PORT` environment variable).

### Health Check

```bash
curl http://localhost:3000/health
```

## Testing

### Quick Test Scripts

Two test scripts are provided for local testing:

#### Option 1: Interactive Bash Script

```bash
# Make sure API_KEY is set in .env or export it
export API_KEY=your-api-key-here

# Run the interactive test script
./test-api.sh
```

The script will guide you through:
1. Health check
2. Creating a session (requires Facebook cookies)
3. Sending a message
4. Destroying a session
5. Testing invalid API key

### Manual Testing with curl

#### 1. Health Check (no auth required)
```bash
curl http://localhost:3000/health
```

#### 2. Create Session
```bash
curl -X POST http://localhost:3000/api/sessions \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{"cookies": "datr=abc123;sb=def456;c_user=123456789;xs=xyz789;fr=token123;"}'
```

#### 3. Send Message
```bash
# Replace SESSION_ID with the sessionId from step 2
curl -X POST http://localhost:3000/api/sessions/SESSION_ID/send-message \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "extension": "62",
    "phoneNumber": "87769691301",
    "message": "Hello from API!"
  }'
```

#### 4. Destroy Session
```bash
curl -X DELETE http://localhost:3000/api/sessions/SESSION_ID \
  -H "X-API-Key: your-api-key-here"
```

#### 5. Test Invalid API Key
```bash
curl -X GET http://localhost:3000/api/sessions \
  -H "X-API-Key: invalid-key"
# Should return 401 Unauthorized
```

## API Documentation

All API endpoints require the `X-API-Key` header with your API key.

### 1. Create Session

Create a new browser session with cookies.

**Endpoint:** `POST /api/sessions`

**Headers:**
```
X-API-Key: <your-api-key>
Content-Type: application/json
```

**Body:**
```json
{
  "cookies": "datr=...;sb=...;c_user=...;xs=...;fr=...;"
}
```

**Response (201):**
```json
{
  "sessionId": "uuid",
  "status": "active"
}
```

**Errors:**
- `401`: Invalid API key
- `400`: Invalid cookies format
- `500`: Failed to create browser/session

**Example:**
```bash
curl -X POST http://localhost:3000/api/sessions \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"cookies": "datr=abc123;sb=def456;c_user=123456789;xs=xyz789;fr=token123;"}'
```

### 2. Destroy Session

Destroy a browser session and clean up resources.

**Endpoint:** `DELETE /api/sessions/:sessionId`

**Headers:**
```
X-API-Key: <your-api-key>
```

**Response (200):**
```json
{
  "ok": true,
  "message": "Session destroyed"
}
```

**Errors:**
- `401`: Invalid API key
- `404`: Session not found

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/sessions/123e4567-e89b-12d3-a456-426614174000 \
  -H "X-API-Key: your-api-key"
```

### 3. Send Message

Send a WhatsApp message through a session.

**Endpoint:** `POST /api/sessions/:sessionId/send-message`

**Headers:**
```
X-API-Key: <your-api-key>
Content-Type: application/json
```

**Body:**
```json
{
  "extension": "62",
  "phoneNumber": "87769691301",
  "message": "Hello! This is a test message."
}
```

**Response (200):**
```json
{
  "ok": true,
  "message": "Message sent successfully"
}
```

**Errors:**
- `401`: Invalid API key
- `404`: Session not found
- `400`: Invalid input (missing fields)
- `500`: Automation failed (with error details)

**Example:**
```bash
curl -X POST http://localhost:3000/api/sessions/123e4567-e89b-12d3-a456-426614174000/send-message \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "extension": "62",
    "phoneNumber": "87769691301",
    "message": "Hello!"
  }'
```

## Architecture

### Session Lifecycle

1. **Create Session**: Browser instance is created with unique fingerprint and persistent context
2. **Cookie Setup**: Cookies are parsed and set for Facebook domains
3. **Navigation**: Browser navigates to Meta Business Suite inbox
4. **Activity Simulation**: Subtle activity (mouse movements, scrolls) every 5-10 minutes
5. **Message Sending**: Automation flow replicates Chrome extension behavior
6. **Destroy Session**: All resources are cleaned up (browser, context, page, timers)

### Browser Fingerprinting

Each session gets a unique but realistic fingerprint with custom overrides:
- **Screen Resolution**: Common values (1920x1080, 1366x768, etc.)
- **User-Agent**: Chrome 120-121 with slight version variation
- **Hardware**: Random `hardwareConcurrency` (2, 4, 8, 16) and `deviceMemory` (4, 8, 16)
- **Platform**: Windows, macOS, or Linux
- **Language**: Fixed to English (en-US) for consistent button text matching
- **Timezone**: Fixed to America/New_York for consistent button text matching
- **Navigator Overrides**: `webdriver` set to false, `plugins` array populated, `languages` set
- **Chrome Object**: Window.chrome object added to mimic real Chrome browser

### Automation Flow

The automation service replicates the exact flow from the Chrome extension:

1. Open WhatsApp modal (find button by data-surface or text)
2. Click "New WhatsApp number" button
3. Select extension from dropdown (expand, search, select first option)
4. Fill phone number in tel input
5. Fill message in textarea or contenteditable
6. Click "Send Message" button

Each step has proper error handling and timeouts (15-30 seconds).

## Configuration

Configuration is managed via environment variables (see Installation section above for `.env` setup):

Browser settings are configured in `src/config.js`:
- Headless mode: Controlled by `HEADLESS` env var (default: `true`)
- Browser args: Optimized for resource usage and detection avoidance

## Deployment

### Production Deployment

#### Option A: PM2 Deploy (matches `~/waha-web` workflow)

If you already deploy via:

```bash
pm2 deploy ecosystem.config.cjs production
```

This repo includes the same Capistrano-style structure under `/opt`:
- `/opt/metabiz-whatsapp-headless/current`
- `/opt/metabiz-whatsapp-headless/shared` (logs + `.env`)

**Steps:**

1. Update `ecosystem.config.cjs` `deploy.production.repo` to your Git repo URL.
2. Create `.env.production` locally (repo root), then copy it to the server:

```bash
./copy-env-to-server.sh
```

3. First-time setup:

```bash
pm2 deploy ecosystem.config.cjs production setup
```

4. Deploy:

```bash
pm2 deploy ecosystem.config.cjs production
```

#### Option B: Manual PM2 start

1. **Process Manager**: Use PM2 for process management
```bash
npm install -g pm2
pm2 start src/server.js --name whatsapp-automation
pm2 save
pm2 startup
```

2. **Environment Variables**: Set in `.env` file or system environment
```bash
export API_KEY=your-secret-api-key
export PORT=3000
```

3. **System Requirements**: 
   - 64-128GB RAM for ~100 concurrent sessions
   - 32-64 CPU cores
   - Sufficient disk space for browser profiles

4. **Monitoring**: Monitor memory usage and browser instance count
```bash
# Check PM2 status
pm2 status

# Monitor logs
pm2 logs whatsapp-automation

# Monitor resources
pm2 monit
```

### Graceful Shutdown

The server handles SIGTERM and SIGINT signals gracefully:
1. Stops accepting new requests
2. Closes all browser sessions
3. Exits cleanly

## Troubleshooting

### Session Creation Fails

- Check that cookies are valid and in correct format
- Verify system has sufficient resources (RAM, CPU)
- Check browser profile directory permissions

### Message Sending Fails

- Verify session is still active (not destroyed)
- Check that cookies haven't expired
- Ensure Meta Business Suite UI hasn't changed (selectors may need updates)
- Check browser console logs for errors

### Browser Crashes

- Sessions are automatically cleaned up on crash
- Recreate session with fresh cookies
- Check system resources (memory, CPU)

### High Memory Usage

- Each browser instance uses ~500MB-1GB RAM
- Monitor with `pm2 monit` or system monitoring tools
- Destroy unused sessions regularly
- Consider horizontal scaling for more sessions

## Development

### Project Structure

```
headless-metabiz-whatsapp/
├── src/
│   ├── server.js              # Express server entry point
│   ├── config.js              # Configuration
│   ├── routes/
│   │   ├── sessions.js        # Session endpoints
│   │   └── messages.js        # Send message endpoint
│   ├── middleware/
│   │   └── auth.js            # API key validation
│   ├── services/
│   │   ├── sessionManager.js  # Session lifecycle
│   │   ├── browserFactory.js  # Browser creation
│   │   └── automation.js      # WhatsApp automation
│   ├── utils/
│   │   ├── fingerprint.js    # Generate fingerprints
│   │   └── cookies.js         # Parse cookies
│   └── errors.js              # Custom error classes
├── profiles/                  # Browser profiles (gitignored)
├── test-api.sh               # Interactive bash test script
├── package.json
└── README.md
```

### Running Tests

Currently, manual testing is recommended:
1. Create a session with valid cookies
2. Send a test message
3. Verify message appears in Meta Business Suite
4. Destroy session

## Security Considerations

- **API Key**: Keep your API key secret and rotate regularly
- **Cookies**: Cookies contain authentication tokens - handle securely
- **Network**: Use HTTPS in production
- **Firewall**: Restrict access to API endpoints

## License

ISC

## Support

For issues or questions, please refer to the project repository.

