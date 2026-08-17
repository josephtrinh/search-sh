import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

const workspaceEnv = resolve(import.meta.dirname, "../../../.env");
if (existsSync(workspaceEnv)) process.loadEnvFile(workspaceEnv);

const host = process.env.WEB_HOST?.trim() || "0.0.0.0";
const port = process.env.WEB_PORT?.trim() || "3000";
const configuredOrigins = (process.env.WEB_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const interfaceOrigins = Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal && (entry.family === "IPv4" || entry.family === 4)).map((entry) => entry.address);
process.env.WEB_ALLOWED_ORIGINS = [...new Set([...configuredOrigins, ...interfaceOrigins])].join(",");
const portNumber = Number(port);
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new Error(`WEB_PORT must be an integer from 1 to 65535; received ${JSON.stringify(port)}`);
}

const nextBin = resolve(import.meta.dirname, "../node_modules/next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", "--hostname", host, "--port", port], {
  env: process.env,
  stdio: "inherit",
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
