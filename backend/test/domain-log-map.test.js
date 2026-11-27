import assert from "node:assert";
import { describe, it } from "node:test";
import {
	buildLogMapContent,
	domainLogFileName,
	isPlainDomainName,
	logMapVariable,
} from "../lib/domain-log-map.js";

describe("domain log map", () => {
	it("names the variable from the host type and id", () => {
		assert.strictEqual(logMapVariable("proxy_host", 7), "npm_domain_log_proxy_7");
		assert.strictEqual(logMapVariable("redirection_host", 3), "npm_domain_log_redirect_3");
		assert.strictEqual(logMapVariable("dead_host", 12), "npm_domain_log_dead_12");
		assert.throws(() => logMapVariable("stream", 1));
	});

	it("maps every configured domain to a file name and falls back to unknown", () => {
		const content = buildLogMapContent("proxy_host", 1, ["a.example.com", "b.example.com"]);
		assert.match(content, /^map \$host \$npm_domain_log_proxy_1 \{$/m);
		assert.match(content, /^\s+hostnames;$/m);
		assert.match(content, /^\s+default "unknown";$/m);
		assert.match(content, /^\s+"a\.example\.com" "a\.example\.com";$/m);
		assert.match(content, /^\s+"b\.example\.com" "b\.example\.com";$/m);
		// balanced braces: exactly one opening and one closing
		assert.strictEqual(content.split("{").length, 2);
		assert.strictEqual(content.split("}").length, 2);
	});

	it("renames a wildcard domain so the file has no glob character", () => {
		assert.strictEqual(domainLogFileName("*.example.com"), "wildcard.example.com");
		assert.strictEqual(domainLogFileName("APP.example.com"), "app.example.com");
		// The map key stays the wildcard, only the file name is rewritten
		const content = buildLogMapContent("proxy_host", 1, ["*.example.com"]);
		assert.match(content, /^\s+"\*\.example\.com" "wildcard\.example\.com";$/m);
	});

	it("drops values that could change the map's structure", () => {
		const injections = [
			'a"; } server { listen 1; #',
			"a.example.com\"; deny all; #",
			"a.example.com\n}",
			"a.example.com b",
			"a.example.com;",
			"../../etc/passwd",
			"a/b",
		];
		for (const value of injections) {
			assert.ok(!isPlainDomainName(value), `rules accept ${JSON.stringify(value)}`);
		}
		const content = buildLogMapContent("proxy_host", 1, ["ok.example.com", ...injections]);
		// Only the one legitimate domain appears
		assert.strictEqual(content.match(/^\s+"[^"]+" "[^"]+";$/gm).length, 1);
		assert.ok(!content.includes("deny all"));
		assert.ok(!content.includes("server {"));
	});

	it("accepts the domain shapes nginx itself accepts", () => {
		for (const value of [
			"example.com",
			"a.b.c.example.com",
			"xn--bcher-kva.example",
			"my-host.example.com",
			"*.example.com",
		]) {
			assert.ok(isPlainDomainName(value), `rules reject ${JSON.stringify(value)}`);
		}
	});
});
