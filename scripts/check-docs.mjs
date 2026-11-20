#!/usr/bin/env node
/**
 * Document integrity checks for the MiHa decision record.
 *
 * Three independent checks, each usable as a standalone verifier:
 *
 *   bun scripts/check-docs.mjs links        relative links + ADR supersedes graph
 *   bun scripts/check-docs.mjs decisions    decision labels: contiguous, defined, referenced
 *   bun scripts/check-docs.mjs attribution  numbers in research docs must carry a source
 *
 * Exit code 0 means the check passed, 1 means it failed. Output is one line per
 * finding, then a summary.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOC_DIRS = ["docs"];
const TOP_DOCS = ["README.md"];

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith(".md")) out.push(full);
	}
	return out;
}

function markdownFiles() {
	const files = [];
	for (const dir of DOC_DIRS) files.push(...walk(join(ROOT, dir)));
	for (const file of TOP_DOCS) {
		const full = join(ROOT, file);
		try {
			statSync(full);
			files.push(full);
		} catch {}
	}
	return files.sort();
}

const findings = [];
const fail = (file, message) => findings.push(`${relative(ROOT, file)}: ${message}`);

/* ------------------------------------------------------------------ links */

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks() {
	const files = markdownFiles();
	const supersededBy = new Map();

	for (const file of files) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(LINK)) {
			const target = match[1];
			if (/^(https?:|mailto:|#)/.test(target)) continue;
			const clean = target.split("#")[0];
			if (clean === "") continue;
			const resolved = resolve(dirname(file), clean);
			try {
				statSync(resolved);
			} catch {
				fail(file, `broken link -> ${target}`);
			}
		}

		const status = text.match(/^- \*\*Status:\*\*.*$/m);
		if (status && /Superseded/i.test(status[0])) {
			const link = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(status[0]);
			if (link) {
				supersededBy.set(file, resolve(dirname(file), link[2].split("#")[0]));
			}
		}
	}

	for (const [file, target] of supersededBy) {
		try {
			statSync(target);
		} catch {
			fail(file, `supersedes target missing -> ${relative(ROOT, target)}`);
		}
	}

	// A supersedes chain must terminate and must not loop.
	for (const start of supersededBy.keys()) {
		const seen = new Set();
		let current = start;
		while (supersededBy.has(current)) {
			if (seen.has(current)) {
				fail(start, `supersedes chain loops at ${relative(ROOT, current)}`);
				break;
			}
			seen.add(current);
			current = supersededBy.get(current);
		}
	}
}

/* -------------------------------------------------------------- decisions */

const DECISION_HEADING = /^#{2,4}\s+D(\d+)\b.*$/gm;
const LABEL_REFERENCE = /\bD(\d+)\b/g;

function adrFiles() {
	return markdownFiles().filter((file) => file.includes(`${join("docs", "adr")}`));
}

function definedDecisions() {
	const defined = new Map();
	for (const file of adrFiles()) {
		const text = readFileSync(file, "utf8");
		const labels = [];
		for (const match of text.matchAll(DECISION_HEADING)) labels.push(Number(match[1]));
		defined.set(file, labels);
	}
	return defined;
}

function checkDecisions() {
	const defined = definedDecisions();
	const allLabels = new Set();

	for (const [file, labels] of defined) {
		if (labels.length === 0) {
			fail(file, "defines no decision");
			continue;
		}
		const unique = new Set(labels);
		if (unique.size !== labels.length) {
			fail(file, `duplicate decision label(s): ${labels.filter((l, i) => labels.indexOf(l) !== i).join(", ")}`);
		}
		const sorted = [...unique].sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i] !== sorted[i - 1] + 1) {
				fail(file, `decision labels are not consecutive (found ${sorted.join(", ")})`);
				break;
			}
		}
		for (const label of unique) allLabels.add(label);
	}

	const adrSet = new Set(defined.keys());
	for (const file of markdownFiles()) {
		const text = readFileSync(file, "utf8");
		const own = defined.get(file);
		for (const match of text.matchAll(LABEL_REFERENCE)) {
			const label = Number(match[1]);
			if (own && own.includes(label)) continue;
			if (allLabels.has(label)) continue;
			fail(file, `references D${label}, which no ADR defines`);
		}
	}

	// An ADR that defines decisions nobody references is a decision nobody acts on.
	for (const [file, labels] of defined) {
		if (!adrSet.has(file)) continue;
		const references = new Set();
		for (const other of markdownFiles()) {
			if (other === file) continue;
			for (const match of readFileSync(other, "utf8").matchAll(LABEL_REFERENCE)) {
				references.add(Number(match[1]));
			}
		}
		const orphans = labels.filter((label) => !references.has(label));
		if (orphans.length === labels.length) {
			fail(file, `no decision in this ADR is referenced anywhere else`);
		}
	}
}

/* ------------------------------------------------------------ attribution */

const HAS_NUMBER = /\d[\d.,]*\s*(?:ms|s\b|MiB|KiB|GiB|KB|MB|GB|%|×|x\b|LOC|files?|bytes?)/;
const HAS_SOURCE = /[A-Za-z0-9_./-]+\.[A-Za-z]{1,6}:\d+|https?:\/\/|\bmeasured\b|\bcited\b|\bour own\b|\bper §/i;
/** A caption line that declares provenance for the table below it. */
const IS_SOURCE_CAPTION = /^(?:source|measured|derived|provenance)\s*:/i;

function checkAttribution() {
	const files = markdownFiles().filter((file) => file.includes(join("docs", "research")));
	for (const file of files) {
		const lines = readFileSync(file, "utf8").split("\n");
		let inTable = false;
		let tableCaption = "";
		let tableStart = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const isRow = /^\s*\|/.test(line);

			if (isRow && !inTable) {
				inTable = true;
				tableStart = i;
				// The caption is the whole block of text directly above the table:
				// walk up over the contiguous non-blank, non-table lines.
				const block = [];
				for (let j = i - 1; j >= 0; j--) {
					const candidate = lines[j].trim();
					if (candidate === "" || /^\s*\|/.test(candidate)) {
						if (block.length > 0) break;
						continue;
					}
					block.unshift(candidate);
				}
				tableCaption = block.join(" ");
			}

			if (!isRow) {
				inTable = false;
				continue;
			}

			if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;

			if (!HAS_NUMBER.test(line)) continue;

			const rowHasSource = HAS_SOURCE.test(line);
			const captionHasSource = HAS_SOURCE.test(tableCaption) || IS_SOURCE_CAPTION.test(tableCaption);
			if (!rowHasSource && !captionHasSource) {
				fail(file, `line ${i + 1}: measurement without a source — ${line.trim().slice(0, 110)}`);
			}
		}
	}
}

/* ------------------------------------------------------------------- main */

const mode = process.argv[2];
const checks = { links: checkLinks, decisions: checkDecisions, attribution: checkAttribution };

if (!checks[mode]) {
	console.error(`usage: bun scripts/check-docs.mjs <${Object.keys(checks).join("|")}>`);
	process.exit(2);
}

checks[mode]();

if (findings.length > 0) {
	for (const finding of findings) console.log(`FAIL ${finding}`);
	console.log(`\n${mode}: ${findings.length} finding(s)`);
	process.exit(1);
}

console.log(`${mode}: OK`);
