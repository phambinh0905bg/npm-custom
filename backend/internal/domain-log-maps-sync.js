import fs from "node:fs";
import { LOG_MAP_HOST_TYPES, removeLogMap, writeLogMap } from "../lib/domain-log-map.js";
import { global as logger } from "../logger.js";
import deadHostModel from "../models/dead_host.js";
import proxyHostModel from "../models/proxy_host.js";
import redirectionHostModel from "../models/redirection_host.js";

// Matches the directory docker/rootfs/etc/nginx/nginx.conf includes from the http
// block, and the access_log path in the host templates.
const LOG_MAP_DIR = "/data/nginx/domains";
const DOMAIN_LOG_DIR = "/data/logs/domains";

const MODELS = {
	proxy_host: proxyHostModel,
	redirection_host: redirectionHostModel,
	dead_host: deadHostModel,
};

/**
 * Rewrites every per-domain access log map from the database, regenerates the
 * host configs that reference them, and clears out maps belonging to hosts that
 * no longer exist.
 *
 * Why this runs at startup: an upgrade replaces the application code, but the
 * nginx configs on disk were rendered by the previous version and don't mention
 * the new per-domain access_log yet, and the maps they would need were never
 * generated. Without this pass every existing host would keep logging only to its
 * aggregate file until someone happened to save it in the UI.
 *
 * @returns {Promise<{mapsWritten: Number, mapsRemoved: Number, configsChanged: Number, failed: Number, reload: Boolean}>}
 */
const domainLogMapsSync = {
	sync: async () => {
		fs.mkdirSync(LOG_MAP_DIR, { recursive: true });
		fs.mkdirSync(DOMAIN_LOG_DIR, { recursive: true });

		const result = { mapsWritten: 0, mapsRemoved: 0, configsChanged: 0, failed: 0, reload: false };
		const expected = new Set();

		// Imported lazily: internal/nginx.js imports the host models, so a top-level
		// import here would create a cycle with index.js's import order.
		const internalNginx = (await import("./nginx.js")).default;

		for (const [hostType] of Object.entries(LOG_MAP_HOST_TYPES)) {
			const model = MODELS[hostType];
			let rows;
			try {
				rows = await model
					.query()
					.where("is_deleted", 0)
					.allowGraph(model.defaultAllowGraph)
					.withGraphFetched(`[${model.defaultExpand.join(", ")}]`);
			} catch (err) {
				logger.error(`Could not read ${hostType} rows for the domain log maps: ${err.message}`);
				result.failed++;
				continue;
			}

			for (const row of rows) {
				const domains = Array.isArray(row.domain_names) ? row.domain_names : [];
				if (!row.enabled || domains.length === 0) {
					removeLogMap(LOG_MAP_DIR, hostType, row.id);
					continue;
				}

				expected.add(`${hostType}-${row.id}.conf`);

				try {
					if (writeLogMap(LOG_MAP_DIR, hostType, row.id, domains)) {
						result.mapsWritten++;
					}
				} catch (err) {
					logger.error(`Could not write the domain log map for ${hostType} #${row.id}: ${err.message}`);
					result.failed++;
					continue;
				}

				// Re-render the host config so it picks up the per-domain access_log.
				// The file is compared before and after, because a rewrite that changes
				// nothing should not force an nginx reload on every container start.
				try {
					const configPath = internalNginx.getConfigName(hostType, row.id);
					const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, { encoding: "utf8" }) : null;
					await internalNginx.generateConfig(hostType, row);
					const after = fs.existsSync(configPath) ? fs.readFileSync(configPath, { encoding: "utf8" }) : null;
					if (before !== after) {
						result.configsChanged++;
					}
				} catch (err) {
					// A host whose stored values no longer render is left as it is; the
					// normal save path reports the problem on the host itself.
					logger.error(`Could not regenerate the config for ${hostType} #${row.id}: ${err.message}`);
					result.failed++;
				}
			}
		}

		// Remove maps whose host is gone (deleted while the container was down, or
		// left behind by an older build).
		try {
			for (const file of fs.readdirSync(LOG_MAP_DIR)) {
				if (file.endsWith(".conf") && !expected.has(file)) {
					fs.rmSync(`${LOG_MAP_DIR}/${file}`, { force: true });
					result.mapsRemoved++;
					result.reload = true;
				}
			}
		} catch (err) {
			logger.error(`Could not clean up stale domain log maps: ${err.message}`);
			result.failed++;
		}

		if (result.mapsWritten || result.configsChanged || result.mapsRemoved) {
			result.reload = true;
		}

		if (result.reload) {
			try {
				await internalNginx.reload();
				logger.info(
					`Domain log maps synced: ${result.mapsWritten} maps written, ${result.configsChanged} configs regenerated, ` +
						`${result.mapsRemoved} maps removed${result.failed ? `, ${result.failed} failed` : ""}; nginx reloaded`,
				);
			} catch (err) {
				// nginx starts from the on-disk config before the backend, so a failed
				// reload leaves a working server serving the previous config.
				logger.error(`Nginx reload after the domain log map sync failed: ${err.message}`);
				result.failed++;
			}
		} else {
			logger.info("Domain log maps are up to date");
		}

		return result;
	},
};

export default domainLogMapsSync;
