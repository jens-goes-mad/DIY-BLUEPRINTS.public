package com.diy.blueprints.collabeditor.persistence.storage;

/**
 * Identifies a single document: which customer, which document, which
 * language variant. Bundles the (customerId, docId, language) triple that
 * was previously repeated as three separate parameters across every
 * DocumentStorageService method -- language is part of document identity
 * on purpose (see STATE.md's RFC section: two languages of the same docId
 * are independent documents, not branches of one).
 */
public record DocumentRef(String customerId, String docId, String language) {
}
