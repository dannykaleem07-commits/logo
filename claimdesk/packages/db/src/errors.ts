/** Base class for persistence errors so the API can map them to HTTP codes by `code`. */
export class DbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown when a row that must exist is missing. */
export class NotFoundError extends DbError {
  readonly entity: string;
  readonly id: string;
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} ${id} not found`);
    this.entity = entity;
    this.id = id;
  }
}

/** Base for every append-only violation (ledger, events, evidence, audit log). */
export class ImmutableError extends DbError {
  readonly entity: string;
  constructor(entity: string, operation: 'update' | 'delete') {
    super('IMMUTABLE', `${entity} is append-only: ${operation} is not permitted. Record a correcting row that references the original (supersedesId).`);
    this.entity = entity;
  }
}

export class LedgerImmutableError extends ImmutableError {
  constructor(operation: 'update' | 'delete') {
    super('ledger_entries', operation);
  }
}

export class EventImmutableError extends ImmutableError {
  constructor(operation: 'update' | 'delete') {
    super('claim_events', operation);
  }
}

export class EvidenceImmutableError extends ImmutableError {
  constructor(operation: 'update' | 'delete') {
    super('evidence', operation);
  }
}

export class AuditImmutableError extends ImmutableError {
  constructor(operation: 'update' | 'delete') {
    super('audit_log', operation);
  }
}

/** A document workflow transition that the status machine does not allow (e.g. approving a blocked draft). */
export class DocumentStateError extends DbError {
  readonly documentId: string;
  readonly status: string;
  constructor(documentId: string, status: string, message: string) {
    super('DOCUMENT_STATE', message);
    this.documentId = documentId;
    this.status = status;
  }
}

/** Verification may only move to 'verified' by a human with a source URL (ARCHITECTURE convention 6). */
export class VerificationError extends DbError {
  constructor(message: string) {
    super('VERIFICATION', message);
  }
}

/** Generic invalid-argument error for repository inputs. */
export class ValidationError extends DbError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}
