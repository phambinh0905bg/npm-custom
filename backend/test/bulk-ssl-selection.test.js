import assert from "node:assert";
import { describe, it } from "node:test";

/**
 * Regression test for the bulk-SSL selection identity.
 *
 * The bug: a selection from the proxy host table used to travel as a bare list of
 * numeric ids. Proxy host #1 and 404 host #1 are different hosts that share an id,
 * so selecting proxy #1 also pulled 404 #1 into the dialog.
 *
 * The fix: a selection is a list of {host_type, host_id} pairs. This file tests the
 * pure matching rule that both `preview()` and `apply()` rely on.
 */

// Mirrors the selection logic in internal/bulk-ssl.js preview():
// explicit targets decide membership by (type, id); no targets means auto-match.
const selectHosts = (rows, { targets, legacyIds, covers }) => {
	const explicit = Array.isArray(targets) ? targets : null;
	const legacy = !explicit && Array.isArray(legacyIds) ? legacyIds : null;

	const out = [];
	for (const [hostType, hosts] of Object.entries(rows)) {
		for (const host of hosts) {
			const uncovered = host.domain_names.filter((d) => !covers(d));
			let selected;
			let matched;
			if (explicit) {
				selected = explicit.some((t) => t.host_type === hostType && t.host_id === host.id);
				matched = false;
			} else if (legacy) {
				selected = legacy.includes(host.id);
				matched = false;
			} else {
				selected = false;
				matched = uncovered.length === 0 && host.domain_names.length > 0;
			}
			if (selected || matched) {
				out.push({ host_type: hostType, host_id: host.id, uncovered, selected, matched });
			}
		}
	}
	return out;
};

const allDomains = () => true;

// Two hosts that share id 1 - this is what production actually had.
const rows = {
	proxy: [{ id: 1, domain_names: ["media.example.com"] }],
	redirection: [{ id: 1, domain_names: ["old.example.com"] }],
	dead: [{ id: 1, domain_names: ["*.example.com", "example.com"] }],
};

describe("bulk SSL selection identity", () => {
	it("an explicit proxy selection does not drag in a same-id host of another type", () => {
		const picked = selectHosts(rows, {
			targets: [{ host_type: "proxy", host_id: 1 }],
			covers: allDomains,
		});
		assert.deepStrictEqual(
			picked.map((h) => h.host_type),
			["proxy"],
		);
		assert.strictEqual(picked[0].host_id, 1);
	});

	it("an explicit 404 selection does not include the proxy host with the same id", () => {
		const picked = selectHosts(rows, {
			targets: [{ host_type: "dead", host_id: 1 }],
			covers: allDomains,
		});
		assert.deepStrictEqual(
			picked.map((h) => h.host_type),
			["dead"],
		);
	});

	it("a multi-type explicit selection keeps exactly those hosts", () => {
		const picked = selectHosts(rows, {
			targets: [
				{ host_type: "proxy", host_id: 1 },
				{ host_type: "dead", host_id: 1 },
			],
			covers: allDomains,
		});
		assert.deepStrictEqual(
			picked.map((h) => `${h.host_type}:${h.host_id}`),
			["proxy:1", "dead:1"],
		);
	});

	it("an explicit selection never widens to auto-match when the cert covers more", () => {
		const picked = selectHosts(rows, {
			targets: [{ host_type: "dead", host_id: 1 }],
			covers: allDomains, // covers every row, yet only the selected one comes back
		});
		assert.strictEqual(picked.length, 1);
		assert.ok(!picked[0].matched);
	});

	it("no targets means auto-match on domain coverage", () => {
		const picked = selectHosts(rows, {
			covers: (d) => d.endsWith("example.com"),
		});
		assert.deepStrictEqual(
			picked.map((h) => h.host_type).sort(),
			["dead", "proxy", "redirection"],
		);
		assert.ok(picked.every((h) => h.matched));
	});

	it("auto-match skips a host serving a domain outside the certificate", () => {
		const picked = selectHosts(rows, {
			covers: (d) => d === "media.example.com",
		});
		assert.deepStrictEqual(
			picked.map((h) => h.host_type),
			["proxy"],
		);
	});

	it("legacy id-only selection is still id-only, and documented as ambiguous", () => {
		// Kept for callers of the public API that pass ids alone: the behaviour is
		// unchanged, it just cannot distinguish two hosts sharing an id.
		const picked = selectHosts(rows, { legacyIds: [1], covers: allDomains });
		assert.strictEqual(picked.length, 3);
	});
});
