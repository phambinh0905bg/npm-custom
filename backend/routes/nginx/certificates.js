import express from "express";
import dnsPlugins from "../../certbot/dns-plugins.json" with { type: "json" };
import internalBulkSsl from "../../internal/bulk-ssl.js";
import internalCertificate from "../../internal/certificate.js";
import errs from "../../lib/error.js";
import jwtdecode from "../../lib/express/jwt-decode.js";
import apiValidator from "../../lib/validator/api.js";
import validator from "../../lib/validator/index.js";
import { debug, express as logger } from "../../logger.js";
import { getValidationSchema } from "../../schema/index.js";

const router = express.Router({
	caseSensitive: true,
	strict: true,
	mergeParams: true,
});

/**
 * /api/nginx/certificates
 */
router
	.route("/")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/nginx/certificates
	 *
	 * Retrieve all certificates
	 */
	.get(async (req, res, next) => {
		try {
			const data = await validator(
				{
					additionalProperties: false,
					properties: {
						expand: {
							$ref: "common#/properties/expand",
						},
						query: {
							$ref: "common#/properties/query",
						},
					},
				},
				{
					expand: typeof req.query.expand === "string" ? req.query.expand.split(",") : null,
					query: typeof req.query.query === "string" ? req.query.query : null,
				},
			);
			const rows = await internalCertificate.getAll(res.locals.access, data.expand, data.query);
			res.status(200).send(rows);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	})

	/**
	 * POST /api/nginx/certificates
	 *
	 * Create a new certificate
	 */
	.post(async (req, res, next) => {
		try {
			const payload = await apiValidator(getValidationSchema("/nginx/certificates", "post"), req.body);
			req.setTimeout(900000); // 15 minutes timeout
			const result = await internalCertificate.create(res.locals.access, payload);
			res.status(201).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * /api/nginx/certificates/dns-providers
 */
router
	.route("/dns-providers")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/nginx/certificates/dns-providers
	 *
	 * Get list of all supported DNS providers
	 */
	.get(async (req, res, next) => {
		try {
			if (!res.locals.access.token.getUserId()) {
				throw new errs.PermissionError("Login required");
			}
			const clean = Object.keys(dnsPlugins).map((key) => ({
				id: key,
				name: dnsPlugins[key].name,
				credentials: dnsPlugins[key].credentials,
			}));

			clean.sort((a, b) => a.name.localeCompare(b.name));
			res.status(200).send(clean);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Test HTTP challenge for domains
 *
 * /api/nginx/certificates/test-http
 */
router
	.route("/test-http")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * POST /api/nginx/certificates/test-http
	 *
	 * Test HTTP challenge for domains
	 */
	.post(async (req, res, next) => {
		try {
			const payload = await apiValidator(getValidationSchema("/nginx/certificates/test-http", "post"), req.body);
			req.setTimeout(60000); // 1 minute timeout

			const result = await internalCertificate.testHttpsChallenge(res.locals.access, payload);
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Validate Certs before saving
 *
 * /api/nginx/certificates/validate
 */
router
	.route("/validate")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * POST /api/nginx/certificates/validate
	 *
	 * Validate certificates
	 */
	.post(async (req, res, next) => {
		if (!req.files) {
			res.status(400).send({ error: "No files were uploaded" });
			return;
		}

		try {
			const result = await internalCertificate.validate(res.locals.access, {
				files: req.files,
			});
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Specific certificate
 *
 * /api/nginx/certificates/123
 */
router
	.route("/:certificate_id")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/nginx/certificates/123
	 *
	 * Retrieve a specific certificate
	 */
	.get(async (req, res, next) => {
		try {
			const data = await validator(
				{
					required: ["certificate_id"],
					additionalProperties: false,
					properties: {
						certificate_id: {
							$ref: "common#/properties/id",
						},
						expand: {
							$ref: "common#/properties/expand",
						},
					},
				},
				{
					certificate_id: req.params.certificate_id,
					expand: typeof req.query.expand === "string" ? req.query.expand.split(",") : null,
				},
			);
			const row = await internalCertificate.get(res.locals.access, {
				id: Number.parseInt(data.certificate_id, 10),
				expand: data.expand,
			});
			res.status(200).send(row);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	})

	/**
	 * DELETE /api/nginx/certificates/123
	 *
	 * Update and existing certificate
	 */
	.delete(async (req, res, next) => {
		try {
			const result = await internalCertificate.delete(res.locals.access, {
				id: Number.parseInt(req.params.certificate_id, 10),
			});
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Upload Certs
 *
 * /api/nginx/certificates/123/upload
 */
router
	.route("/:certificate_id/upload")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * POST /api/nginx/certificates/123/upload
	 *
	 * Upload certificates
	 */
	.post(async (req, res, next) => {
		if (!req.files) {
			res.status(400).send({ error: "No files were uploaded" });
			return;
		}

		try {
			const result = await internalCertificate.upload(res.locals.access, {
				id: Number.parseInt(req.params.certificate_id, 10),
				files: req.files,
			});
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Renew LE Certs
 *
 * /api/nginx/certificates/123/renew
 */
router
	.route("/:certificate_id/renew")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * POST /api/nginx/certificates/123/renew
	 *
	 * Renew certificate
	 */
	.post(async (req, res, next) => {
		req.setTimeout(900000); // 15 minutes timeout
		try {
			const result = await internalCertificate.renew(res.locals.access, {
				id: Number.parseInt(req.params.certificate_id, 10),
			});
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Bulk apply a certificate to many hosts
 *
 * /api/nginx/certificates/123/bulk-preview  (dry run)
 * /api/nginx/certificates/123/bulk-apply
 */
router
	.route("/:certificate_id/bulk-preview")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/nginx/certificates/123/bulk-preview
	 *
	 * Lists the hosts this certificate would be applied to, and flags any host
	 * that serves a domain outside the certificate's SAN list.
	 */
	.get(async (req, res, next) => {
		try {
			// A selection from the UI is a list of {host_type, host_id} pairs, because a
			// proxy host #1 and a 404 host #1 are different hosts. It travels as either
			// repeated targets[0][host_type]=... params or a JSON array in `targets`.
			let targets = null;
			if (typeof req.query.targets === "string" && req.query.targets.trim() !== "") {
				try {
					targets = JSON.parse(req.query.targets);
				} catch {
					throw new errs.ValidationError("targets must be a JSON array of {host_type, host_id}");
				}
			}

			const data = await validator(
				{
					required: ["certificate_id"],
					additionalProperties: false,
					properties: {
						certificate_id: {
							$ref: "common#/properties/id",
						},
						host_ids: {
							anyOf: [
								{ type: "null" },
								{
									type: "array",
									items: { $ref: "common#/properties/id" },
									maxItems: 500,
								},
							],
						},
						targets: {
							anyOf: [
								{ type: "null" },
								{
									type: "array",
									minItems: 1,
									maxItems: 500,
									items: {
										type: "object",
										additionalProperties: false,
										required: ["host_type", "host_id"],
										properties: {
											host_type: {
												type: "string",
												enum: ["proxy", "redirection", "dead"],
											},
											host_id: {
												$ref: "common#/properties/id",
											},
										},
									},
								},
							],
						},
					},
				},
				{
					certificate_id: req.params.certificate_id,
					targets,
					// "1,2,3" is what a query string gives us
					host_ids:
						typeof req.query.host_ids === "string" && req.query.host_ids.trim() !== ""
							? req.query.host_ids.split(",").map((v) => Number.parseInt(v.trim(), 10))
							: null,
				},
			);

			const result = await internalBulkSsl.preview(res.locals.access, data);
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

router
	.route("/:certificate_id/bulk-apply")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * POST /api/nginx/certificates/123/bulk-apply
	 *
	 * Applies the certificate to every host in `targets`. Each host is reported
	 * individually, so one failure (e.g. an uncovered domain) does not stop the
	 * others and the caller can show exactly what happened.
	 */
	.post(async (req, res, next) => {
		req.setTimeout(900000); // 15 minutes: many hosts, one nginx reload each
		try {
			// Validate the body as sent, then attach the path parameter. Injecting
			// certificate_id before validation would fail: the schema forbids
			// additional properties (the id belongs in the path, not the body).
			const body = await apiValidator(
				getValidationSchema("/nginx/certificates/{certID}/bulk-apply", "post"),
				req.body ?? {},
			);
			const result = await internalBulkSsl.apply(res.locals.access, {
				...body,
				certificate_id: Number.parseInt(req.params.certificate_id, 10),
			});
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err} ${JSON.stringify(err.debug, null, 2)}`);
			next(err);
		}
	});

/**
 * Download LE Certs
 *
 * /api/nginx/certificates/123/download
 */
router
	.route("/:certificate_id/download")
	.options((_req, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/nginx/certificates/123/download
	 *
	 * Renew certificate
	 */
	.get(async (req, res, next) => {
		try {
			const result = await internalCertificate.download(res.locals.access, {
				id: Number.parseInt(req.params.certificate_id, 10),
			});
			res.status(200).download(result.fileName);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

export default router;
