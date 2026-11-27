import cn from "classnames";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { useEffect, useMemo, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Modal from "react-bootstrap/Modal";
import {
	applyBulkCertificate,
	type BulkSslPreview,
	type BulkSslResult,
	type BulkSslTarget,
	type Certificate,
	previewBulkCertificate,
} from "src/api/backend";
import { Button, Loading } from "src/components";
import { useCertificates } from "src/hooks";
import { T, intl } from "src/locale";
import styles from "./BulkCertificateModal.module.css";

// Stable identity for a (host type, host id) pair - used as a row key and as the
// member of the excluded set. Kept at module scope so the memos below can depend
// on it without it changing every render.
const hostKey = (hostType: string, hostId: number) => `${hostType}:${hostId}`;

/**
 * Opens the bulk apply dialog.
 *
 * @param certificateId  preselected certificate, or null to let the user pick one
 *                       inside the dialog
 * @param targets        explicit host selection from the proxy host table; omitted
 *                       means "auto-match every host this certificate covers"
 */
const showBulkCertificateModal = (certificateId?: number | null, targets?: BulkSslTarget[]) => {
	EasyModal.show(BulkCertificateModal, { certificateId: certificateId ?? null, targets });
};

interface Props extends InnerModalProps {
	certificateId?: number | null;
	targets?: BulkSslTarget[];
}

const BulkCertificateModal = EasyModal.create(
	({ certificateId: initialCertificateId, targets: initialTargets, visible, remove }: Props) => {
		const certificates = useCertificates(["owner"]);

		const [certificateId, setCertificateId] = useState<number | null>(initialCertificateId ?? null);
		const [preview, setPreview] = useState<BulkSslPreview | null>(null);
		const [result, setResult] = useState<BulkSslResult | null>(null);
		const [loading, setLoading] = useState(!!initialCertificateId);
		const [submitting, setSubmitting] = useState(false);
		const [error, setError] = useState<string | null>(null);
		const [excluded, setExcluded] = useState<Set<string>>(new Set());
		const [sslForced, setSslForced] = useState(true);
		const [hstsEnabled, setHstsEnabled] = useState(false);
		const [allowUncovered, setAllowUncovered] = useState(false);

		// The certificate list arrives after the dialog opens, so default the
		// selection to the first one when the caller didn't name a certificate.
		useEffect(() => {
			if (certificateId === null && certificates.data?.length) {
				setCertificateId(certificates.data[0].id ?? null);
			}
		}, [certificateId, certificates.data]);

		useEffect(() => {
			if (certificateId === null) {
				setLoading(false);
				return;
			}
			let cancelled = false;
			setLoading(true);
			setError(null);
			// The exclusion set belongs to the previous certificate's host list.
			setExcluded(new Set());
			setAllowUncovered(false);
			previewBulkCertificate(certificateId, initialTargets)
				.then((data) => {
					if (!cancelled) {
						setPreview(data);
					}
				})
				.catch((err) => {
					if (!cancelled) {
						setError(err.message || "Unknown error");
						setPreview(null);
					}
				})
				.finally(() => {
					if (!cancelled) {
						setLoading(false);
					}
				});
			return () => {
				cancelled = true;
			};
		}, [certificateId, initialTargets]);

		// A host serving a domain outside the certificate's SAN list would produce a
		// name-mismatch warning in the browser, so it is never applied by default.
		const uncoveredCount = useMemo(
			() => (preview?.hosts || []).filter((h) => (h.uncoveredDomains || []).length > 0).length,
			[preview],
		);

		const targets: BulkSslTarget[] = useMemo(() => {
			const rows = preview?.hosts || [];
			return rows
				.filter((host) => !excluded.has(hostKey(host.hostType, host.hostId)))
				.filter((host) => allowUncovered || (host.uncoveredDomains || []).length === 0)
				.map((host) => ({ hostType: host.hostType, hostId: host.hostId }));
		}, [preview, excluded, allowUncovered]);

		const toggleHost = (hostType: string, hostId: number) => {
			const k = hostKey(hostType, hostId);
			setExcluded((previous) => {
				const next = new Set(previous);
				if (next.has(k)) {
					next.delete(k);
				} else {
					next.add(k);
				}
				return next;
			});
		};

		const onSubmit = async () => {
			if (submitting || targets.length === 0 || certificateId === null) {
				return;
			}
			setSubmitting(true);
			setError(null);
			try {
				const applied = await applyBulkCertificate(certificateId, {
					targets,
					sslForced,
					hstsEnabled,
					hstsSubdomains: hstsEnabled,
					http2Support: false,
					allowUncovered,
				});
				setResult(applied);
			} catch (err: any) {
				setError(err.message || "Unknown error");
			}
			setSubmitting(false);
		};

		const hostTypeLabel = (hostType: string) => {
			switch (hostType) {
				case "proxy":
					return intl.formatMessage({ id: "proxy-hosts" });
				case "redirection":
					return intl.formatMessage({ id: "redirection-hosts" });
				default:
					return intl.formatMessage({ id: "dead-hosts" });
			}
		};

		const certList = certificates.data || [];

		const certificateRow = (cert: Certificate) => {
			const active = cert.id === certificateId;
			// The stored `domain_names` column is not trustworthy: a custom certificate
			// is routinely saved with only its nice name, or with junk like
			// ["CloudFlare,"]. The preview reads the real SAN list out of the PEM, so
			// the selected certificate shows that instead.
			const names =
				active && preview?.domainNames?.length ? preview.domainNames : cert.domainNames || [];
			return (
				<button
					key={cert.id}
					type="button"
					className={cn(styles.certOption, active && styles.certOptionActive)}
					onClick={() => setCertificateId(cert.id ?? null)}
					title={names.join(", ")}
				>
					<input type="radio" className="form-check-input m-0" checked={active} readOnly tabIndex={-1} />
					<span className={styles.certName}>{cert.niceName || names.join(", ")}</span>
					{cert.expiresOn ? (
						<span className={cn(styles.certMeta, "text-secondary")}>{cert.expiresOn}</span>
					) : null}
					<span className={styles.certDomains}>
						{names.map((name: string) => (
							<span key={name} className={cn("badge bg-azure-lt", styles.certBadge)}>
								{name}
							</span>
						))}
					</span>
				</button>
			);
		};

		return (
			<Modal show={visible} onHide={remove} size="lg" centered className="modal-dialog-scrollable-none">
				<Modal.Header closeButton>
					<Modal.Title>
						<T id="bulk-ssl.title" />
					</Modal.Title>
				</Modal.Header>

				<Modal.Body className="p-3">
					<div className={styles.body}>
						{error && (
							<Alert variant="danger" dismissible onClose={() => setError(null)} className="mb-0">
								{error}
							</Alert>
						)}

						{/* Zone 1 - certificate picker */}
						<div className={cn(styles.zone, styles.certZone)}>
							<div className={styles.zoneHeader}>
								<T id="bulk-ssl.certificate" />
								{certList.length > 0 && (
									<span className="badge bg-secondary-lt ms-auto">{certList.length}</span>
								)}
							</div>
							<div className={styles.zoneBody}>
								{certificates.isLoading ? (
									<Loading noLogo />
								) : certList.length === 0 ? (
									<div className="p-3 text-secondary small">
										<T id="bulk-ssl.no-certificates" />
									</div>
								) : (
									certList.map(certificateRow)
								)}
							</div>
						</div>

						{/* Zone 2 - host list (the only scrolling zone) */}
						<div className={cn(styles.zone, styles.hostZone)}>
							<div className={styles.zoneHeader}>
								<T id="bulk-ssl.hosts" />
								{preview && (
									<span className="ms-auto text-secondary">
										{targets.length}/{preview.hosts.length}
									</span>
								)}
							</div>
							<div className={styles.zoneBody}>
								{loading ? (
									<Loading noLogo />
								) : !preview || preview.hosts.length === 0 ? (
									<div className="p-3 text-secondary small">
										<T id="bulk-ssl.no-hosts" />
									</div>
								) : (
									<table className={cn("table table-sm table-vcenter", styles.hostTable)}>
										<thead>
											<tr>
												<th className="w-1" />
												<th>
													<T id="bulk-ssl.column.domains" />
												</th>
												<th>
													<T id="bulk-ssl.column.type" />
												</th>
												<th>
													<T id="bulk-ssl.column.certificate" />
												</th>
											</tr>
										</thead>
										<tbody>
											{preview.hosts.map((host) => {
												const k = hostKey(host.hostType, host.hostId);
												const checked =
													!excluded.has(k) && (allowUncovered || (host.uncoveredDomains || []).length === 0);
												const changedCert = host.currentCertificateId !== preview.certificateId;
												return (
													<tr key={k}>
														<td>
															<input
																type="checkbox"
																className="form-check-input m-0"
																checked={checked}
																disabled={(host.uncoveredDomains || []).length > 0 && !allowUncovered}
																onChange={() => toggleHost(host.hostType, host.hostId)}
															/>
														</td>
														<td className={styles.hostDomains}>
															{(host.domainNames || []).join(", ")}
															{(host.uncoveredDomains || []).length > 0 && (
																<div className="text-danger small mt-1">
																	<T id="bulk-ssl.uncovered" /> {(host.uncoveredDomains || []).join(", ")}
																</div>
															)}
															{!host.enabled && (
																<div className="text-secondary small">
																	<T id="bulk-ssl.disabled" />
																</div>
															)}
														</td>
														<td className="text-secondary small">{hostTypeLabel(host.hostType)}</td>
														<td className="text-secondary small">
															{changedCert ? (
																<>
																	#{host.currentCertificateId || "—"} → #{preview.certificateId}
																</>
															) : (
																<T id="bulk-ssl.already-set-short" />
															)}
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								)}
							</div>
						</div>

						{/* Zone 3 - options. One row; the explanation is the row's tooltip so it
						    costs no vertical height. */}
						<div className={cn(styles.zone, styles.optionsZone)}>
							<div
								className={styles.optionsRow}
								title={intl.formatMessage({ id: "bulk-ssl.warning" })}
							>
								<label className="form-check">
									<input
										type="checkbox"
										className="form-check-input"
										checked={sslForced}
										onChange={(e) => setSslForced(e.target.checked)}
									/>
									<span className="form-check-label small">
										<T id="bulk-ssl.force-ssl-short" />
									</span>
								</label>
								<label className="form-check">
									<input
										type="checkbox"
										className="form-check-input"
										checked={hstsEnabled}
										onChange={(e) => setHstsEnabled(e.target.checked)}
									/>
									<span className="form-check-label small">
										<T id="bulk-ssl.hsts" />
									</span>
								</label>
								{uncoveredCount > 0 && (
									<label className="form-check">
										<input
											type="checkbox"
											className="form-check-input"
											checked={allowUncovered}
											onChange={(e) => setAllowUncovered(e.target.checked)}
										/>
										<span className="form-check-label small text-danger">
											<T id="bulk-ssl.allow-uncovered-short" /> ({uncoveredCount})
										</span>
									</label>
								)}
							</div>
						</div>

						{result && (
							<div className="mt-1">
								<Alert variant={result.failed ? "warning" : "success"} className="mb-2">
									<T
										id="bulk-ssl.result-summary"
										data={{ applied: result.applied, failed: result.failed }}
									/>
								</Alert>
								<ul className="list-unstyled mb-0">
									{result.results.map((row) => (
										<li key={`${row.hostType}:${row.hostId}`} className="mb-1 text-break">
											{row.status === "applied" ? (
												<span className="badge bg-success-lt me-1">OK</span>
											) : (
												<span className="badge bg-danger-lt me-1">FAIL</span>
											)}
											<span className="text-secondary small">
												{hostTypeLabel(row.hostType)} #{row.hostId}
											</span>
											{row.domainNames?.length ? (
												<span className="ms-2">{row.domainNames.join(", ")}</span>
											) : null}
											{row.message ? <div className="text-danger small mt-1">{row.message}</div> : null}
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				</Modal.Body>

				<Modal.Footer>
					<Button data-bs-dismiss="modal" onClick={remove} disabled={submitting}>
						{result ? <T id="action.close" /> : <T id="cancel" />}
					</Button>
					{!result && (
						<Button
							type="submit"
							actionType="primary"
							className="ms-auto"
							isLoading={submitting}
							disabled={submitting || loading || targets.length === 0}
							onClick={onSubmit}
						>
							<T id="bulk-ssl.apply" />
							{targets.length > 0 && <span className="ms-1">({targets.length})</span>}
						</Button>
					)}
				</Modal.Footer>
			</Modal>
		);
	},
);

export { BulkCertificateModal, showBulkCertificateModal };
