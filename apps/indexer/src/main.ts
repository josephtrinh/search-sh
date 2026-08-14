import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "./config";
import { IndexRunner } from "./runner";

const worker = new Worker("catalog-indexing", async (job) => { const runner = new IndexRunner(); try { await runner.run(job); } finally { await runner.close(); } }, { connection: redis, concurrency: 1 });
worker.on("completed", (job) => console.log(JSON.stringify({ event: "index.completed", jobId: job.id })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "index.failed", jobId: job?.id, error: error.message })));

async function shutdown() { await worker.close(); process.exit(0); }
process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
