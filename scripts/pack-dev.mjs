import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";
import { createTestDb } from "@termix-ssh/plugin-sdk/testing";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out")) {
  throw new Error("Usage: npm run pack:dev -- [--out directory]");
}
const out = path.resolve(root, args[1] ?? ".");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "host-dev-metrics-"));

function namespace(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) namespace(file);
    else if (/\.(ts|tsx|json|sql|md)$/.test(entry.name)) {
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replaceAll("host-metrics", "host-dev-metrics")
          .replaceAll("host_metrics", "host_dev_metrics")
          .replaceAll("host_health", "host_health_dev")
          .replaceAll("Host Metrics", "Host Metrics dev")
          .replaceAll("hostMetricsLayouts", "hostMetricsDevLayouts")
          .replaceAll("hostMetricsTemplates", "hostMetricsDevTemplates")
          .replaceAll("server-stats", "server-stats-dev"),
      );
    }
    const renamed = entry.name
      .replaceAll("host-metrics", "host-dev-metrics")
      .replaceAll("host_metrics", "host_dev_metrics");
    if (renamed !== entry.name)
      fs.renameSync(file, path.join(directory, renamed));
  }
}

function run(script, ...extra) {
  const result = spawnSync("npm", ["run", script, "--", ...extra], {
    cwd: staging,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${script} failed (${result.signal ?? result.status})`);
}

function removeLegacyAdoption() {
  const file = path.join(staging, "src/backend/tables.ts");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let removed = 0;
  const transformed = ts.transform(source, [
    (context) => {
      const visit = (node) => {
        if (ts.isImportSpecifier(node) && node.name.text === "adoptLegacyTable")
          return undefined;
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "adoptLegacyTable"
        ) {
          assert.equal(node.arguments.length, 2);
          removed++;
          return ts.visitNode(node.arguments[1], visit);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit);
    },
  ]);
  try {
    assert.equal(
      removed,
      4,
      "Review the dev table isolation when upstream adoption changes",
    );
    fs.writeFileSync(
      file,
      ts.createPrinter().printFile(transformed.transformed[0]),
    );
  } finally {
    transformed.dispose();
  }
}

async function verifyDatabaseIsolation() {
  const protectedTables = [
    "host_metrics_preferences",
    "host_metrics_history",
    "host_health_checks",
    "host_health_history",
    "p_host_metrics_host_metrics_preferences",
    "p_host_metrics_host_metrics_history",
    "p_host_metrics_host_health_checks",
    "p_host_metrics_host_health_history",
    "p_host_metrics_layout_templates",
  ];
  const db = await createTestDb(staging, {
    before(sqlite) {
      for (const table of protectedTables)
        sqlite.exec(
          `CREATE TABLE "${table}" (marker TEXT); INSERT INTO "${table}" VALUES ('production');`,
        );
    },
  });
  try {
    for (const table of protectedTables)
      assert.deepEqual(db.sqlite.prepare(`SELECT * FROM "${table}"`).all(), [
        { marker: "production" },
      ]);
    const columns = db.sqlite
      .prepare(
        'PRAGMA table_info("p_host_dev_metrics_host_dev_metrics_history")',
      )
      .all();
    assert.ok(columns.some((column) => column.name === "swap_percent"));
    console.log(
      "ok  dev migrations preserve production and legacy tables; swap column exists",
    );
  } finally {
    db.close();
  }
}

try {
  for (const name of [
    "src",
    "tests",
    "locales",
    "migrations",
    "docs",
    "manifest.json",
    "authz.json",
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ]) {
    fs.cpSync(path.join(root, name), path.join(staging, name), {
      recursive: true,
    });
  }
  namespace(staging);
  // A dev plugin owns fresh tables, never core's legacy adoption rights.
  removeLegacyAdoption();
  fs.rmSync(path.join(staging, "migrations"), { recursive: true });
  const manifestPath = path.join(staging, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sourceVersion = manifest.version;
  manifest.version = "1.5.0-dev.hl24.2";
  const officialPrefix = "p_host_metrics_";
  const devPrefix = `p_${manifest.id.replaceAll("-", "_")}_`;
  assert.ok(
    !devPrefix.startsWith(officialPrefix) &&
      !officialPrefix.startsWith(devPrefix),
    "Development plugin table namespace must not overlap the official plugin",
  );
  manifest.author = {
    name: "frankieslab-homelab (development build; upstream Termix)",
  };
  manifest.repository = "https://github.com/Termix-SSH/Plugin-Host-Metrics";
  delete manifest.docs;
  delete manifest.video;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const changelogPath = path.join(staging, "CHANGELOG.md");
  fs.writeFileSync(
    changelogPath,
    fs
      .readFileSync(changelogPath, "utf8")
      .replace(`## ${sourceVersion}\n`, `## ${manifest.version}\n`),
  );
  const packagePath = path.join(staging, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  pkg.version = manifest.version;
  pkg.scripts["migrations:dev"] = "termix-plugin migrations";
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(staging, "node_modules"),
    "junction",
  );

  run("migrations:dev");
  await verifyDatabaseIsolation();
  // Legacy-upgrade tests apply to the production migrations, not fresh dev tables.
  run("test", "--maxWorkers=2", "--exclude=tests/backend/migrations.test.ts");
  run("typecheck");
  run("build");
  run("validate");
  run("pack", "--out", out);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
