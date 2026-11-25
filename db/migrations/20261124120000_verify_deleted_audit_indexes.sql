-- Partial expression indexes supporting /api/verify fallback lookups against
-- envelope_deleted records in system_audit_events without scanning the full
-- site audit log when checking unknown or unsigned files.

create index if not exists idx_system_audit_events_deleted_signed_pdf_sha256
  on public.system_audit_events ((metadata->>'signedPdfSha256'))
  where event = 'envelope_deleted'
    and metadata->>'signedPdfSha256' is not null;

create index if not exists idx_system_audit_events_deleted_evidence_sha256
  on public.system_audit_events ((metadata->>'evidenceSha256'))
  where event = 'envelope_deleted'
    and metadata->>'evidenceSha256' is not null;

create index if not exists idx_system_audit_events_deleted_recipient_evidence_sha256
  on public.system_audit_events ((metadata->>'recipientEvidenceSha256'))
  where event = 'envelope_deleted'
    and metadata->>'recipientEvidenceSha256' is not null;
