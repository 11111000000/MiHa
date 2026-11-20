#!/usr/bin/env node
/**
 * The budgets of ADR 0004 D19, enforced.
 *
 *   bundle      the browser bundle, minified and gzipped, must fit the ceiling
 *   layer       each layer's code lines must fit its own budget
 *   dependency  the package must declare no runtime dependencies
 *   type        no `any` may appear in the source
 *
 * "Code lines" is counted as: lines that are not blank and do not begin with a
 * comment marker. The metric is simple and reproducible on purpose — a cleverer
 * counter would parse strings, and a counter that can be fooled is not a budget.
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const BUNDLE_LIMIT_BYTES = 30_000;
const LAYER_LIMITS = {
	root: 50,
	core: 1500,
	schema: 500,
	llm: 600,
	exchange: 700,
	worker: 500,
	trace: 400,
};
const DEPENDENCY_LIMIT = 0;

const findings = [];
const fail = (message) => findings.push(message);

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

function isCommentLine(line) {
	const trimmed = line.trim();
	return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("*/");
}

function codeLines(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "" && !isCommentLine(line));
}

/* ------------------------------------------------------------------ bundle */

function checkBundle() {
	const outDir = mkdtempSync(join(tmpdir(), "miha-budget-"));
	try {
		execFileSync(
			"bun",
			["build", "--target=browser", "--minify", "--outfile", join(outDir, "bundle.js"), join(ROOT, "src/index.ts")],
			{ cwd: ROOT, stdio: "pipe" },
		);
		const raw = readFileSync(join(outDir, "bundle.js"));
		const gz = gzipSync(raw, { level: 9 }).byteLength;
		const headroom = BUNDLE_LIMIT_BYTES - gz;
		console.log(`bundle   ${gz} B gzip (limit ${BUNDLE_LIMIT_BYTES} B, headroom ${headroom} B)`);
		if (gz > BUNDLE_LIMIT_BYTES) {
			fail(`bundle is ${gz} B gzip, over the ${BUNDLE_LIMIT_BYTES} B ceiling by ${-headroom} B`);
		}
	} catch (error) {
		fail(`bundle build failed: ${error.message}`);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

/* ------------------------------------------------------------------- layers */

function checkLayers() {
	const files = walk(join(ROOT, "src"));
	const perLayer = new Map();
	for (const file of files) {
		const relativePath = relative(join(ROOT, "src"), file);
		const segments = relativePath.split("/");
		const layer = segments.length === 1 ? "root" : segments[0];
		perLayer.set(layer, (perLayer.get(layer) ?? 0) + codeLines(file).length);
	}
	for (const [layer, limit] of Object.entries(LAYER_LIMITS)) {
		const used = perLayer.get(layer) ?? 0;
		const state = used > limit ? "over" : "ok";
		console.log(`layer    ${layer.padEnd(9)} ${String(used).padStart(5)} / ${limit} lines ${state}`);
		if (used > limit) fail(`layer ${layer} is ${used} lines, over its budget of ${limit}`);
	}
	for (const layer of perLayer.keys()) {
		if (!(layer in LAYER_LIMITS)) fail(`layer ${layer} has no declared budget`);
	}
}

/* -------------------------------------------------------------- dependencies */

function checkDependencies() {
	const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const declared = Object.keys(manifest.dependencies ?? {}).length + Object.keys(manifest.optionalDependencies ?? {}).length;
	console.log(`deps     ${declared} runtime (limit ${DEPENDENCY_LIMIT})`);
	if (declared > DEPENDENCY_LIMIT) {
		fail(`the package declares ${declared} runtime dependencies, the limit is ${DEPENDENCY_LIMIT}`);
	}
}

/* --------------------------------------------------------------------- types */

const ANY_PATTERN = /(:\s*any\b)|(\bas\s+any\b)|(\bany\[\])|(<any>)/;

function checkTypes() {
	const files = walk(join(ROOT, "src"));
	const offenders = [];
	for (const file of files) {
		for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
			if (isCommentLine(line)) continue;
			if (ANY_PATTERN.test(line)) {
				offenders.push(`${relative(ROOT, file)}:${index + 1}`);
			}
		}
	}
	console.log(`types    ${offenders.length} 'any' in source`);
	for (const offender of offenders) fail(`'any' at ${offender}`);
}

/* --------------------------------------------------------------------- main */

checkBundle();
checkLayers();
checkDependencies();
checkTypes();

if (findings.length > 0) {
	console.log("");
	for (const finding of findings) console.log(`FAIL ${finding}`);
	process.exit(1);
}
console.log("\nbudget: OK");
