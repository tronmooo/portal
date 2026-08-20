// One server instance, in its own process.
//
// Started by rig.ts. Its response cache, data-version memo and rate limiter are
// its own — which is the whole point: this is what lets the rig reproduce two
// instances disagreeing about how fresh the data is.
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../../server/storage";
import { registerRoutes } from "../../server/routes";
import { remoteStorage } from "./storage-rpc";

async function main() {
  const storageUrl = process.env.RIG_STORAGE_URL!;
  const userId = process.env.RIG_USER_ID!;
  const storage = await remoteStorage(storageUrl);

  const app = express();
  app.use(express.json({ limit: "60mb" }));
  app.use((req, _res, next) => {
    (req as any).userId = userId;
    requestStorageContext.run(storage, () => next());
  });
  const httpServer: Server = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  // The parent reads this line to learn the port.
  console.log(`RIG_INSTANCE_READY ${port}`);
}

main().catch((err) => {
  console.error("instance failed:", err);
  process.exit(1);
});
