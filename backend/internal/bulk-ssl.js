import errs from "../lib/error.js";
import { ssl as logger } from "../logger.js";
import certificateModel from "../models/certificate.js";
import deadHostModel from "../models/dead_host.js";
import proxyHostModel from "../models/proxy_host.js";
import redirectionHostModel from "../models/redirection_host.js";
import internalAuditLog from "./audit-log.js";

// The host tables that can carry a certificate. Streams are excluded: a stream
// has no server_name, so there is no domain to check the certificate against.
const HOST_TYPES = {
	proxy: { model: proxyHostModel, objectType: "proxy-host" },
	redirection: { model: redirectionHostModel, objectType: "redirection-host" },
	dead: { model: deadHostModel, objectType: "dead-host" },
};

/**
 * Turns a certificate's SAN list into a matcher.
 *
 * A wildcard entry (`*.example.com`) covers exactly one label, matching what
 * nginx and browsers do - `*.example.com` matches `a.example.com` but neither
 * `a.b.example.com` nor the apex `example.com`.
 *
 * @param   {String[]} names
 * @returns {Function} (domain) => Boolean
 */
const buildCertMatcher = (names) => {
	const exact = new Set();
	const wildcards = [];
	for (const name of names) {
		const lower = String(name).toLowerCase();
		if (lower.startsWith("*.")) {
			wildcards.push(lower.slice(2));
		} else {
			exact.add(lower);
		}
	}
	return (domain) => {
		const lower = String(domain).toLowerCase();
		if (exact.has(lower)) {
			return true;
		}
		const dot = lower.indexOf(".");
		if (dot === -1) {
			return false;
		}
		return wildcards.includes(lower.slice(dot + 1));
	};
};

/**
 * Reads the real SAN list of a certificate from its files.
 *
 * The `domain_names` column is not reliable - a custom certificate is routinely
 * stored with only its nice name, or with the literal "CloudFlare," - so the
 * SAN list is read from the PEM whenever the files can be reached. Falls back to
 * the stored column so a bulk apply still works where openssl is unavailable,
 * rather than failing outright.
 *
 * @param   {Object} certificate
 * @returns {Promise<String[]>}
 */
const getCertificateNames = async (certificate) => {
	const stored = Array.isArray(certificate.domain_names) ? certificate.domain_names : [];

	try {
		const fs = await import("node:fs");
		const internalCertificate = (await import("./certificate.js")).default;

		let certPath = null;
		if (certificate.provider === "letsencrypt") {
			certPath = `${internalCertificate.getLiveCertPath(certificate.id)}/fullchain.pem`;
		} else {
			certPath = `/data/custom_ssl/npm-${certificate.id}/fullchain.pem`;
		}

		if (!fs.existsSync(certPath)) {
			return stored;
		}

		const names = await internalCertificate.getCertificateDomainsFromFile(certPath);
		return names.length ? names : stored;
	} catch (err) {
		logger.warn(
			`Could not read the SAN list of certificate #${certificate.id}, using its stored domain names instead: ${err.message}`,
		);
		return stored;
	}
};

/**
 * @param   {Number} id
 * @returns {Promise<Object>}
 */
const loadCertificate = async (id) => {
	const certificate = await certificateModel
		.query()
		.where("is_deleted", 0)
		.andWhere("id", id)
		.first();

	if (!certificate) {
		throw new errs.ItemNotFoundError(id);
	}

	return certificate;
};

/**
 * @param   {Object} hostConfig
 * @param   {Number} id
 * @returns {Promise<Object>}
 */
const loadHost = async (hostConfig, id) =>
	hostConfig.model
		.query()
		.where("is_deleted", 0)
		.andWhere("id", id)
		.allowGraph(hostConfig.model.defaultAllowGraph)
		.withGraphFetched(`[${hostConfig.model.defaultExpand.join(", ")}]`)
		.first();

/**
 * Applies one certificate to many hosts at once.
 *
 * Only the SSL fields are touched and each host is re-rendered through the same
 * internalNginx.configure() path a manual edit uses, so the result is
 * indistinguishable from having opened every host in the UI one at a time.
 */
const internalBulkSsl = {
	/**
	 * Works out what a bulk apply would change, without changing anything.
	 *
	 * @param   {Access} access
	 * @param   {Object} data
	 * @param   {Number} data.certificate_id
	 * @param   {Array<{host_type: String, host_id: Number}>} [data.targets]
	 *          explicit selection. The host type is part of the identity: proxy
	 *          host #1 and 404 host #1 are different hosts that happen to share an
	 *          id, so an id alone cannot identify one.
	 * @param   {Number[]} [data.host_ids]  legacy id-only selection, still honoured
	 *          but only when it cannot be ambiguous (see below)
	 * @returns {Promise}
	 */
	preview: async (access, data) => {
		await access.can("certificates:get", data.certificate_id);

		const certificate = await loadCertificate(data.certificate_id);
		const names = await getCertificateNames(certificate);
		const covers = buildCertMatcher(names);
		const explicit = Array.isArray(data.targets) ? data.targets : null;
		// A bare list of ids can't say which host table an id belongs to, so it was
		// only ever safe to read as "auto-match, but include these ids". Kept for the
		// public API, where callers pass ids alone.
		const legacyIds = !explicit && Array.isArray(data.host_ids) ? data.host_ids : null;

		const hosts = [];
		for (const [hostType, hostConfig] of Object.entries(HOST_TYPES)) {
			const rows = await hostConfig.model
				.query()
				.where("is_deleted", 0)
				.allowGraph(hostConfig.model.defaultAllowGraph)
				.withGraphFetched(`[${hostConfig.model.defaultExpand.join(", ")}]`)
				.orderBy("id", "ASC");

			for (const row of rows) {
				const domains = Array.isArray(row.domain_names) ? row.domain_names : [];
				const uncovered = domains.filter((domain) => !covers(domain));

				let selected;
				let matched;
				if (explicit) {
					// An explicit selection is exactly what it lists - no auto-match, so
					// picking one proxy host never drags in an unrelated host of another
					// type that shares its id.
					selected = explicit.some((t) => t.host_type === hostType && t.host_id === row.id);
					matched = false;
				} else if (legacyIds) {
					selected = legacyIds.includes(row.id);
					matched = false;
				} else {
					selected = false;
					// Auto-match: a host is offered when every domain it serves is
					// covered by the certificate.
					matched = uncovered.length === 0 && domains.length > 0;
				}

				if (!selected && !matched) {
					continue;
				}

				hosts.push({
					host_type: hostType,
					host_id: row.id,
					domain_names: domains,
					enabled: !!row.enabled,
					current_certificate_id: row.certificate_id || 0,
					uncovered_domains: uncovered,
					will_change: row.certificate_id !== certificate.id || !row.ssl_forced,
				});
			}
		}

		return {
			certificate_id: certificate.id,
			nice_name: certificate.nice_name,
			domain_names: names,
			expires_on: certificate.expires_on,
			hosts,
		};
	},

	/**
	 * Applies a certificate to a set of hosts.
	 *
	 * @param   {Access} access
	 * @param   {Object} data
	 * @param   {Number} data.certificate_id
	 * @param   {Array<{host_type: String, host_id: Number}>} data.targets
	 * @param   {Boolean} [data.ssl_forced]
	 * @param   {Boolean} [data.hsts_enabled]
	 * @param   {Boolean} [data.hsts_subdomains]
	 * @param   {Boolean} [data.http2_support]
	 * @param   {Boolean} [data.allow_uncovered]  apply to hosts serving a domain the cert
	 *                                            does not cover
	 * @returns {Promise}
	 */
	apply: async (access, data) => {
		await access.can("certificates:get", data.certificate_id);

		const certificate = await loadCertificate(data.certificate_id);
		const names = await getCertificateNames(certificate);
		const covers = buildCertMatcher(names);

		const sslForced = typeof data.ssl_forced === "boolean" ? data.ssl_forced : true;
		const hstsEnabled = typeof data.hsts_enabled === "boolean" ? data.hsts_enabled : false;
		const hstsSubdomains = hstsEnabled && data.hsts_subdomains === true;
		// HTTP/2 is opt-in: a bulk change must never turn a protocol on for every
		// host at once without the operator asking for it.
		const http2 = data.http2_support === true;

		const results = [];
		for (const target of data.targets || []) {
			const hostConfig = HOST_TYPES[target.host_type];
			if (!hostConfig) {
				results.push({
					host_type: target.host_type,
					host_id: target.host_id,
					status: "error",
					message: `Unsupported host type: ${target.host_type}`,
				});
				continue;
			}

			try {
				const row = await loadHost(hostConfig, target.host_id);
				if (!row) {
					throw new errs.ItemNotFoundError(target.host_id);
				}

				const domains = Array.isArray(row.domain_names) ? row.domain_names : [];
				const uncovered = domains.filter((domain) => !covers(domain));
				if (uncovered.length > 0 && data.allow_uncovered !== true) {
					throw new errs.ValidationError(
						`This certificate does not cover ${uncovered.join(", ")} - confirm explicitly to apply it anyway`,
					);
				}

				// Every SSL field is written explicitly: a partial patch would let the
				// model inherit stale values from the certificate being replaced.
				const patch = {
					certificate_id: certificate.id,
					ssl_forced: sslForced,
					hsts_enabled: hstsEnabled,
					hsts_subdomains: hstsSubdomains,
					http2_support: http2,
				};

				await hostConfig.model.query().where("id", row.id).patch(patch);

				if (row.enabled) {
					await internalNginxConfigure(hostConfig, row.id);
				}

				await internalAuditLog.add(access, {
					action: "updated",
					object_type: hostConfig.objectType,
					object_id: row.id,
					meta: {
						...patch,
						bulk_ssl_apply: true,
						certificate_id_previous: row.certificate_id || 0,
					},
				});

				results.push({
					host_type: target.host_type,
					host_id: row.id,
					status: "applied",
					domain_names: domains,
					uncovered_domains: uncovered,
				});
			} catch (err) {
				logger.error(`Bulk SSL apply failed for ${target.host_type} host #${target.host_id}: ${err.message}`);
				results.push({
					host_type: target.host_type,
					host_id: target.host_id,
					status: "error",
					message: err.message,
				});
			}
		}

		return {
			certificate_id: certificate.id,
			applied: results.filter((r) => r.status === "applied").length,
			failed: results.filter((r) => r.status === "error").length,
			results,
		};
	},
};

/**
 * Re-renders one host's nginx config after its SSL fields changed. The nginx
 * module imports the host models, so it is imported lazily to keep the module
 * graph acyclic.
 *
 * @param   {Object} hostConfig
 * @param   {Number} id
 * @returns {Promise}
 */
const internalNginxConfigure = async (hostConfig, id) => {
	const internalNginx = (await import("./nginx.js")).default;
	const fresh = await loadHost(hostConfig, id);
	return internalNginx.configure(hostConfig.model, hostConfig.objectType, fresh);
};

export default internalBulkSsl;
