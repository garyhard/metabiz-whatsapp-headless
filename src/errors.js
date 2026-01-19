/**
 * Custom error classes for the automation service
 */

export class SessionNotFoundError extends Error {
  constructor(sessionId) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.statusCode = 404;
  }
}

export class InvalidInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInputError';
    this.statusCode = 400;
  }
}

export class AutomationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'AutomationError';
    this.statusCode = 500;
    this.details = details;
  }
}

export class BrowserCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserCrashError';
    this.statusCode = 500;
  }
}

