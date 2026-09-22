package com.diy.blueprints.collabeditor.persistence.storage;

/**
 * Written once, as _customer.meta.json at repo root, when a customer's repo
 * is created. Same rationale as DocumentMeta: lets even a fully-lost
 * `customers` table be reconstructed by scanning repos on disk and reading
 * each one's own metadata file, not just its documents/branches.
 */
public record CustomerMeta(String customerId, String slug, String displayName) {
}
