import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { BenchmarkEngine } from "./engine.js";
import { acquireInstanceLock, loadOwnerId, recoverOwnedProcesses } from "./lifecycle.js";
import { PreviewManager } from "./preview.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { createStore } from "./store.js";

const defaultConfig = fileURLToPath(new URL("../../../arena.config.yaml", import.meta.url));
const config = loadConfig(process.env.LLM_ARENA_CONFIG ?? defaultConfig);
const releaseLock = acquireInstanceLock(config.dataDir);
const ownerId = loadOwnerId(config.dataDir);
recoverOwnedProcesses(ownerId);
const store = createStore(join(config.dataDir, "arena.sqlite"));
store.recoverInterruptedRuns();

if (store.listModels().length === 0) {
  for (const initial of config.initialModels) {
    const { profiles, ...input } = initial;
    const model = store.createModel(input);
    for (const profile of profiles) {
      store.createExecutionProfile({
        modelId: model.id,
        name: profile.name,
        parameters: profile.parameters,
        calibrated: false,
        ggufSha256: null,
      });
    }
  }
}

const supervisor = new ProcessSupervisor(ownerId, config.defaults.processGraceMs);
const engine = new BenchmarkEngine(store, config, supervisor);
const preview = new PreviewManager(store, config, supervisor);
const removedPreviewRoots = preview.cleanupOrphaned();
if (removedPreviewRoots.length) console.log(`Removed ${removedPreviewRoots.length} orphan preview root(s)`);
const app = buildApp({ store, config, engine, preview });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await preview.stop();
  await engine.stop();
  await app.close();
  store.close();
  releaseLock();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("uncaughtException", (error) => {
  app.log.error(error);
  void shutdown().finally(() => process.exit(1));
});
process.once("unhandledRejection", (error) => {
  app.log.error(error);
  void shutdown().finally(() => process.exit(1));
});

await app.listen({ host: config.server.host, port: config.server.port });
engine.wake();
console.log(`LLM Arena API listening on http://${config.server.host}:${config.server.port}`);
