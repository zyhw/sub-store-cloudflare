import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const options = parseOptions(args);

const SETUP_PATH = "config/agent-setup.local.json";
const SETUP_EXAMPLE_PATH = "config/agent-setup.example.json";
const LOCAL_WRANGLER_PATH = "cloudflare/wrangler.deploy.local.jsonc";
const SEED_SQL_PATH = "cloudflare/agent.seed.local.sql";
const ADMIN_SECRET = "SUB_STORE_ADMIN_TOKEN";
const DOWNLOAD_SECRET = "SUB_STORE_PUBLIC_DOWNLOAD_TOKEN";

const state = {
  createdSetup: false,
  renderedConfig: false,
  renderedSeed: false,
  createdD1: false,
  setSecrets: false,
  migrated: false,
  deployed: false,
  seeded: false,
  verified: false,
};

main();

function main() {
  banner("Sub-Store Cloudflare installer");
  const doctorOnly = flags.has("--doctor");

  checkCommand("node", ["--version"], { label: "Node.js" });
  checkCommand("pnpm", ["--version"], { label: "pnpm" });
  run("pnpm", ["run", "setup"], { label: "Install frontend and Worker dependencies", skip: doctorOnly });
  checkCommand("pnpm", ["--dir", "cloudflare", "exec", "wrangler", "--version"], { label: "Wrangler" });

  if (doctorOnly) {
    checkWranglerLogin({ soft: true });
    maybePrintSetupStatus();
    info("Doctor finished. Run `pnpm run install:cloudflare` to deploy.");
    return;
  }

  ensureSetupFile();
  const setup = readSetup();
  const deployment = setup.deployment && typeof setup.deployment === "object" ? setup.deployment : {};
  const workerName = stringValue(options.workerName, stringValue(deployment.workerName, "sub-store-cloudflare"));
  const d1DatabaseName = stringValue(options.d1DatabaseName, stringValue(deployment.d1DatabaseName, "sub-store-cloudflare"));
  const downloadTargets = normalizeTargets(deployment.downloadTargets);
  const adminToken = options.adminToken || process.env.SUB_STORE_ADMIN_TOKEN || generateToken();
  const downloadToken = options.downloadToken || process.env.SUB_STORE_PUBLIC_DOWNLOAD_TOKEN || generateToken();

  checkWranglerLogin({ soft: false });
  const databaseId = options.databaseId || process.env.CLOUDFLARE_D1_DATABASE_ID || stringValue(deployment.d1DatabaseId) || ensureD1(d1DatabaseName);

  run("node", ["scripts/render-wrangler-config.mjs", SETUP_PATH, LOCAL_WRANGLER_PATH, "--database-id", databaseId], {
    label: "Render local Wrangler deployment config",
  });
  state.renderedConfig = true;

  setSecret(ADMIN_SECRET, adminToken);
  setSecret(DOWNLOAD_SECRET, downloadToken);
  state.setSecrets = true;

  run("pnpm", ["run", "check"], { label: "Build and type-check" });
  run("pnpm", ["run", "migrate:remote"], { label: "Apply remote D1 migrations" });
  state.migrated = true;
  const deployResult = run("pnpm", ["run", "deploy:local"], { label: "Deploy Worker", capture: true, echo: true });
  state.deployed = true;

  run("pnpm", ["run", "seed:validate"], { label: "Validate seed setup" });
  run("pnpm", ["run", "seed:render"], { label: "Render seed SQL" });
  state.renderedSeed = true;
  run("pnpm", ["run", "seed:remote"], { label: "Import seed into D1" });
  state.seeded = true;

  const baseUrl = baseUrlFor(workerName, deployment, deployResult.stdout + deployResult.stderr);
  const verification = verifyDeployment({ baseUrl, adminToken, downloadToken, collections: setup.collections || [] });
  state.verified = verification.ok;

  printResult({
    baseUrl,
    adminToken,
    downloadToken,
    workerName,
    d1DatabaseName,
    databaseId,
    sources: setup.sources || [],
    collections: setup.collections || [],
    downloadTargets,
    verification,
  });
}

function ensureSetupFile() {
  if (existsSync(SETUP_PATH)) return;
  copyFileSync(SETUP_EXAMPLE_PATH, SETUP_PATH);
  state.createdSetup = true;
  warn(`${SETUP_PATH} was created from ${SETUP_EXAMPLE_PATH}.`);
  warn("Edit it with your real sources and collections, then rerun `pnpm run install:cloudflare`.");
  if (!flags.has("--use-example-setup")) {
    process.exit(2);
  }
}

function readSetup() {
  return JSON.parse(readFileSync(SETUP_PATH, "utf8"));
}

function ensureD1(name) {
  const existing = findD1(name);
  if (existing?.uuid) {
    info(`Using existing D1 database ${name} (${existing.uuid}).`);
    return existing.uuid;
  }

  const result = run("pnpm", ["--dir", "cloudflare", "exec", "wrangler", "d1", "create", name], {
    label: `Create D1 database ${name}`,
    capture: true,
  });
  state.createdD1 = true;
  const databaseId = parseDatabaseId(result.stdout);
  if (!databaseId) {
    fail(
      [
        `Could not read the new D1 database id from Wrangler output.`,
        `Rerun with an explicit id:`,
        `pnpm run install:cloudflare -- --database-id <database-id>`,
      ].join("\n"),
    );
  }
  return databaseId;
}

function findD1(name) {
  const result = run("pnpm", ["--dir", "cloudflare", "exec", "wrangler", "d1", "list", "--json"], {
    label: "List D1 databases",
    capture: true,
    soft: true,
  });
  if (result.status !== 0) return undefined;
  try {
    const databases = JSON.parse(result.stdout);
    return databases.find((item) => item.name === name);
  } catch {
    return undefined;
  }
}

function parseDatabaseId(output) {
  const uuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid?.[0] || "";
}

function setSecret(key, value) {
  const result = spawnSync("pnpm", ["--dir", "cloudflare", "exec", "wrangler", "secret", "put", key, "--config", "wrangler.deploy.local.jsonc"], {
    input: `${value}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(`Failed to set ${key}.\n${result.stderr || result.stdout}`);
  }
  info(`Set Worker secret ${key}.`);
}

function verifyDeployment({ baseUrl, adminToken, downloadToken, collections }) {
  const checks = [];
  const adminPaths = ["/api/env", "/api/templates", "/api/sources", "/api/collections"];
  for (const path of adminPaths) {
    checks.push(fetchCheck(`${baseUrl}${path}?token=${encodeURIComponent(adminToken)}`, path));
  }

  const collectionId = collections.map((collection) => stringValue(collection.id || collection.name)).find(Boolean);
  if (collectionId) {
    checks.push(fetchCheck(`${baseUrl}/api/link/collection/${encodeURIComponent(collectionId)}?token=${encodeURIComponent(adminToken)}`, `/api/link/collection/${collectionId}`));
    checks.push(fetchCheck(`${baseUrl}/download/collection/${encodeURIComponent(collectionId)}/mihomo?token=${encodeURIComponent(downloadToken)}`, `/download/collection/${collectionId}/mihomo`));
  }

  const failedChecks = checks.filter((check) => !check.ok);
  return {
    ok: failedChecks.length === 0,
    checks,
  };
}

function fetchCheck(url, label) {
  const result = spawnSync("curl", ["-fsS", "--max-time", "30", url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) {
    info(`Verified ${label}.`);
    return { label, ok: true };
  }
  warn(`Verification failed for ${label}: ${String(result.stderr || result.stdout).trim()}`);
  return { label, ok: false, error: String(result.stderr || result.stdout).trim() };
}

function baseUrlFor(workerName, deployment, deployOutput = "") {
  const adminHostname = stringValue(deployment.adminHostname);
  if (adminHostname && !adminHostname.endsWith(".workers.dev")) return `https://${adminHostname}`;
  if (adminHostname.endsWith(".workers.dev")) return `https://${adminHostname}`;
  const deployedUrl = parseDeployUrl(deployOutput);
  if (deployedUrl) return deployedUrl;
  const subdomain = options.workersDevSubdomain || process.env.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN || "";
  if (subdomain) return `https://${workerName}.${subdomain}.workers.dev`;
  const accountSubdomain = parseWorkersDevSubdomain();
  if (accountSubdomain) return `https://${workerName}.${accountSubdomain}.workers.dev`;
  warn("Could not infer the workers.dev subdomain. Verification URLs may need manual adjustment.");
  return `https://${workerName}.<your-workers-subdomain>.workers.dev`;
}

function parseDeployUrl(output) {
  const match = String(output).match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i);
  return match?.[0] || "";
}

function parseWorkersDevSubdomain() {
  const result = run("pnpm", ["--dir", "cloudflare", "exec", "wrangler", "whoami"], {
    label: "Read workers.dev subdomain",
    capture: true,
    soft: true,
  });
  if (result.status !== 0) return "";
  const match = result.stdout.match(/([a-z0-9-]+)\.workers\.dev/i);
  return match?.[1] || "";
}

function printResult({ baseUrl, adminToken, downloadToken, workerName, d1DatabaseName, databaseId, sources, collections, downloadTargets, verification }) {
  banner("Deployment result");
  console.log(`Worker: ${workerName}`);
  console.log(`D1: ${d1DatabaseName} (${databaseId})`);
  console.log(`Admin URL: ${baseUrl}/?token=${adminToken}`);
  console.log("");
  console.log("Download URLs:");
  for (const collection of collections) {
    const id = stringValue(collection.id || collection.name);
    if (!id) continue;
    console.log(`- ${collection.name || id}`);
    console.log(`  ${baseUrl}/download/collection/${encodeURIComponent(id)}?token=${downloadToken}`);
    for (const target of downloadTargets) {
      console.log(`  ${baseUrl}/download/collection/${encodeURIComponent(id)}/${target}?token=${downloadToken}`);
    }
  }
  console.log("");
  console.log(`Sources: ${sources.length}`);
  console.log(`Collections: ${collections.length}`);
  console.log(`Verification: ${verification.ok ? "passed" : "needs manual check"}`);
  console.log("");
  console.log("Privacy check:");
  run("git", ["status", "--short"], { label: "git status --short", passthrough: true, soft: true });
  console.log("");
  info(`Private local files remain ignored: ${SETUP_PATH}, ${LOCAL_WRANGLER_PATH}, ${SEED_SQL_PATH}.`);
}

function checkWranglerLogin({ soft }) {
  const result = run("pnpm", ["--dir", "cloudflare", "exec", "wrangler", "whoami", "--json"], {
    label: "Check Cloudflare login",
    capture: true,
    soft: true,
  });
  if (result.status === 0) {
    info("Cloudflare login is active.");
    return;
  }

  const message = [
    "Cloudflare login is required before deployment.",
    "If you do not have a Cloudflare account, create one first.",
    "",
    "Then run:",
    "pnpm --dir cloudflare exec wrangler login",
    "",
    "After login, resume with:",
    "pnpm run install:cloudflare",
  ].join("\n");

  if (soft) {
    warn(message);
    return;
  }
  fail(message, 2);
}

function maybePrintSetupStatus() {
  if (!existsSync(SETUP_PATH)) {
    warn(`${SETUP_PATH} is missing. The installer will create it from ${SETUP_EXAMPLE_PATH}.`);
    return;
  }
  run("pnpm", ["run", "seed:validate"], { label: "Validate local setup", soft: true });
}

function checkCommand(command, commandArgs, { label }) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    fail(`${label} is required.\n${result.stderr || result.stdout}`);
  }
  info(`${label}: ${firstLine(result.stdout || result.stderr)}`);
}

function run(command, commandArgs, options = {}) {
  const label = options.label || [command, ...commandArgs].join(" ");
  if (options.skip) {
    info(`Skipped: ${label}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  info(label);
  const stdio = options.capture ? ["ignore", "pipe", "pipe"] : options.passthrough ? "inherit" : "inherit";
  const result = spawnSync(command, commandArgs, { encoding: "utf8", stdio });
  if (options.capture && options.echo) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0 && !options.soft) {
    printHandoff();
    if (options.capture && !options.echo) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    fail(`${label} failed.\n${result.stderr || result.stdout || ""}`);
  }
  return {
    status: result.status || 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function printHandoff() {
  console.error("");
  console.error("Current installer state:");
  for (const [key, value] of Object.entries(state)) {
    console.error(`- ${key}: ${value ? "yes" : "no"}`);
  }
  console.error("");
  console.error("Resume with:");
  console.error("pnpm run install:cloudflare");
  console.error("");
}

function generateToken() {
  return randomBytes(32).toString("base64url");
}

function normalizeTargets(targets) {
  const values = Array.isArray(targets) && targets.length > 0 ? targets : ["mihomo", "sing-box", "uri"];
  return [...new Set(values.map(String))];
}

function parseOptions(input) {
  const parsed = {};
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = input[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[toCamel(key)] = next;
      index += 1;
    } else {
      parsed[toCamel(key)] = true;
    }
  }
  return parsed;
}

function toCamel(input) {
  return input.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function stringValue(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim();
}

function firstLine(input) {
  return String(input).split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function banner(text) {
  console.log("");
  console.log(text);
  console.log("=".repeat(text.length));
}

function info(message) {
  console.log(`> ${message}`);
}

function warn(message) {
  console.warn(`! ${message}`);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
