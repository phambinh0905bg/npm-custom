import * as api from "./base";

// Field names are camelCase because api/base.ts camelizes every response
// (`humps.camelizeKeys`) and decamelizes every request body. The backend's own
// names are snake_case; the mapping happens in one place, in base.ts.

export interface BulkSslHost {
	hostType: "proxy" | "redirection" | "dead";
	hostId: number;
	domainNames: string[];
	enabled?: boolean;
	currentCertificateId?: number;
	uncoveredDomains: string[];
	willChange?: boolean;
}

export interface BulkSslPreview {
	certificateId: number;
	niceName?: string;
	domainNames: string[];
	expiresOn?: string;
	hosts: BulkSslHost[];
}

export interface BulkSslTarget {
	hostType: "proxy" | "redirection" | "dead";
	hostId: number;
}

export interface BulkSslApplyPayload {
	targets: BulkSslTarget[];
	sslForced?: boolean;
	hstsEnabled?: boolean;
	hstsSubdomains?: boolean;
	http2Support?: boolean;
	allowUncovered?: boolean;
}

export interface BulkSslResultRow {
	hostType: string;
	hostId: number;
	status: "applied" | "error";
	domainNames?: string[];
	uncoveredDomains?: string[];
	message?: string;
}

export interface BulkSslResult {
	certificateId: number;
	applied: number;
	failed: number;
	results: BulkSslResultRow[];
}

/**
 * Preview the effect of applying a certificate, without changing anything.
 *
 * Pass `targets` for an explicit selection - the host type is part of the
 * identity, so proxy host #1 and 404 host #1 stay distinct. With no targets the
 * backend auto-matches every host whose domains the certificate covers.
 *
 * The target list travels as a JSON string in one query parameter: the
 * alternative (repeated targets[0][host_type]=...) depends on the server's query
 * parser, and this route validates its query with a plain JSON schema.
 */
export async function previewBulkCertificate(
	certificateId: number,
	targets?: BulkSslTarget[],
): Promise<BulkSslPreview> {
	return await api.get({
		url: `/nginx/certificates/${certificateId}/bulk-preview`,
		params: targets?.length
			? {
					targets: JSON.stringify(targets.map((t) => ({ host_type: t.hostType, host_id: t.hostId }))),
				}
			: undefined,
	});
}

export async function applyBulkCertificate(
	certificateId: number,
	payload: BulkSslApplyPayload,
): Promise<BulkSslResult> {
	return await api.post({
		url: `/nginx/certificates/${certificateId}/bulk-apply`,
		data: payload,
	});
}
