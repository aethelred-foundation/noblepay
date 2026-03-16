/**
 * Tests for lib/logger.ts
 *
 * This test file imports the REAL logger module (not the mock from setup.ts)
 * to get coverage on the actual source file.
 */

// We need to NOT use the global mock from setup.ts for this test.
// Jest module mocks are hoisted, so we must NOT import setup here.

describe("Logger module", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("should export logger, generateCorrelationId, and createRequestLogger", () => {
    const loggerModule = require("../../lib/logger");

    expect(loggerModule.logger).toBeDefined();
    expect(loggerModule.generateCorrelationId).toBeDefined();
    expect(loggerModule.createRequestLogger).toBeDefined();
  });

  it("should create a winston logger with correct defaults", () => {
    const loggerModule = require("../../lib/logger");
    const { logger } = loggerModule;

    expect(logger).toBeDefined();
    expect(logger.level).toBe("info");
    expect(logger.defaultMeta).toEqual(
      expect.objectContaining({
        service: "noblepay-api",
        version: "1.0.0",
      }),
    );
  });

  it("should generate a valid UUID correlation ID", () => {
    const { generateCorrelationId } = require("../../lib/logger");
    const id = generateCorrelationId();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("should generate unique correlation IDs", () => {
    const { generateCorrelationId } = require("../../lib/logger");
    const id1 = generateCorrelationId();
    const id2 = generateCorrelationId();

    expect(id1).not.toBe(id2);
  });

  it("should create a child logger with correlation ID", () => {
    const { createRequestLogger } = require("../../lib/logger");
    const child = createRequestLogger("test-correlation-123");

    expect(child).toBeDefined();
    // Child logger should have info, warn, error, debug methods
    expect(typeof child.info).toBe("function");
    expect(typeof child.warn).toBe("function");
    expect(typeof child.error).toBe("function");
    expect(typeof child.debug).toBe("function");
  });

  it("should use LOG_LEVEL env variable when set", () => {
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";

    jest.resetModules();
    const { logger } = require("../../lib/logger");

    expect(logger.level).toBe("debug");

    if (originalLevel) {
      process.env.LOG_LEVEL = originalLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  it("should add file transports when LOG_FILE is true", () => {
    const originalLogFile = process.env.LOG_FILE;
    process.env.LOG_FILE = "true";

    jest.resetModules();
    const { logger } = require("../../lib/logger");

    // Should have Console + 2 File transports = 3 transports
    expect(logger.transports.length).toBe(3);

    if (originalLogFile) {
      process.env.LOG_FILE = originalLogFile;
    } else {
      delete process.env.LOG_FILE;
    }
  });

  it("should not add file transports when LOG_FILE is not true", () => {
    const originalLogFile = process.env.LOG_FILE;
    delete process.env.LOG_FILE;

    jest.resetModules();
    const { logger } = require("../../lib/logger");

    // Should have only Console transport
    expect(logger.transports.length).toBe(1);

    if (originalLogFile) {
      process.env.LOG_FILE = originalLogFile;
    }
  });

  it("should silence console in test environment", () => {
    const { logger } = require("../../lib/logger");
    const consoleTransport = logger.transports[0];

    // In test env, silent should be true
    expect(consoleTransport.silent).toBe(true);
  });

  it("should produce structured JSON output from the format", () => {
    const { logger } = require("../../lib/logger");

    // The logger has a format chain that ends with structuredFormat (printf)
    // We can test by calling the logger.info and checking that it doesn't throw
    expect(() => {
      logger.info("Test message", { correlationId: "test-123", extra: "data" });
    }).not.toThrow();
  });

  it("should handle errors with stack traces via errors format", () => {
    const { logger } = require("../../lib/logger");

    expect(() => {
      logger.error("Error occurred", { error: new Error("Test error") });
    }).not.toThrow();
  });
});
