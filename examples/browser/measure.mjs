#!/usr/bin/env node
/**
 * The size of the example's bundles.
 *
 * The bundles are measured the way `scripts/check-budget.mjs` measures the
 * harness's own: gzipped, level 9. The ceiling is the same number — ADR 0004 D19
 * — and it is for the **whole thing**: the page's bundle and the worker's bundle
 * are what a browser downloads, so they are counted together.
 *
 * The example is not a layer, and the layer budgets do not cover it. The bundle
 * ceiling does: an example that pushes the browser bundle over the line has
 * broken the law the harness was measured against.
 *
 *   node measure.mjs <directory>
 *
 * Exits 1 when the total is over the ceiling, and 2 when the directory was not
 * named.
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

/** The ceiling: ADR 0004 D19, the number `scripts/check-budget.mjs` enforces. */
const CEILING = 30_000;

/** The bundles the build produces. */
const BUNDLES = ["app.js", "worker.js"];

const dir = process.argv[2];
if (!dir) {
	console.error("usage: measure.mjs <directory>");
	process.exit(2);
}

let total = 0;
for (const name of BUNDLES) {
	const file = join(dir, name);
	let size;
	try {
		size = gzipSync(readFileSync(file), { level: 9 }).byteLength;
	} catch {
		console.error(`FAIL the build produced no ${name} in ${dir}`);
		process.exit(1);
	}
	total += size;
	console.log(`bundle   ${name.padEnd(10)} ${String(size).padStart(6)} B gzip`);
}

console.log(
	`bundle   ${"total".padEnd(10)} ${String(total).padStart(6)} B gzip (ceiling ${CEILING} B)`,
);

if (total > CEILING) {
	console.error(
		`FAIL the example's bundle is ${total} B gzip, over the ${CEILING} B ceiling by ${total - CEILING} B`,
	);
	process.exit(1);
}
