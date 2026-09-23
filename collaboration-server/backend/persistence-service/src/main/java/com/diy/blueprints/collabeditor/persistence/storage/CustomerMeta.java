package com.diy.blueprints.collabeditor.persistence.storage;

/**
 * Written once, as _customer.meta.json at repo root, when a customer's repo
 * is created. customerId is itself a readable, git-URL-friendly slug (the
 * repo's actual directory name -- see GitDocumentStorageService's javadoc),
 * not a UUID with a separate slug field; displayName is a friendlier label
 * for the same customer (e.g. "Acme Corp" for customerId "acme-corp").
 * Same rationale as DocumentMeta: lets even a fully-lost `customers` table
 * be reconstructed by scanning repos on disk and reading each one's own
 * metadata file, not just its documents/versions.
 */
public record CustomerMeta(String customerId, String displayName) {
}
