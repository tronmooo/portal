/**
 * Integration test app factory.
 *
 * Creates a real Express instance with routes registered but:
 *  - Auth middleware bypassed (isSupabaseStorage returns false in mocks)
 *  - Storage replaced with InMemoryStorage via vi.mock in each test file
 *  - AI engine mocked to avoid real Anthropic API calls
 *
 * Usage in test files:
 *   vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
 *   vi.mock("../../server/ai-engine", () => aiEngineMock());
 *   const app = await buildTestApp();
 */

import express, { type Express } from "express";
import { createServer } from "http";
import type { InMemoryStorage } from "./mock-storage";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Returns the mock factory for the storage module.
 * Pass this to vi.mock().
 */
export function storageModuleMock(mockStorage: InMemoryStorage) {
  return {
    storage: mockStorage,
    isSupabaseStorage: () => false,
    requestStorageContext: new AsyncLocalStorage(),
    createScopedStorage: () => mockStorage,
    formatTrackerValues: (_name: string, values: Record<string, any>) =>
      JSON.stringify(values),
  };
}

/**
 * Returns the mock factory for the AI engine module.
 * Prevents Anthropic API calls in tests.
 */
export function aiEngineMock() {
  return {
    processMessage: async () => ({
      message: "Test AI response",
      actions: [],
    }),
    processFileUpload: async () => ({
      message: "File processed",
      documentId: "test-doc-id",
    }),
    getActionLog: () => [],
  };
}

/**
 * Build a test Express app with routes registered.
 * Must be called AFTER vi.mock() calls have taken effect.
 */
export async function buildTestApp(): Promise<Express> {
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.text({ type: "text/csv", limit: "10mb" }));

  // Register routes (storage mock is already in place via vi.mock)
  const { registerRoutes } = await import("../../server/routes");
  await registerRoutes(httpServer, app);

  // Generic error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: err.message || "Internal Server Error" });
  });

  return app;
}
