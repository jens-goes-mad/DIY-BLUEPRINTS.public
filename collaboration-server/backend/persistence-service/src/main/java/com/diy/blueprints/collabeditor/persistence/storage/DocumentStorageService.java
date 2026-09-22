package com.diy.blueprints.collabeditor.persistence.storage;

import com.diy.blueprints.collabeditor.persistence.MergeOutcome;

import java.util.Optional;

/**
 * Document content storage -- the durable truth (RFC: multi-tenant scale,
 * STATE.md). Deliberately the ONLY thing callers need, and deliberately
 * generic: no implementation-specific type may appear in this interface
 * (see GitDocumentStorageService for the one real implementation and its
 * reasoning), so a fake in-memory implementation can back unit tests for
 * merge/conflict logic without a real backing store, and so callers never
 * need to know or care what the implementation actually is.
 *
 * No method declares a checked exception -- a checked exception on an
 * abstraction interface forces every implementation (including a fake
 * test one that has no real I/O to fail) and every caller (most of whom
 * can't meaningfully recover from a storage failure anyway) to deal with
 * a failure mode as if it were part of the contract, when it's really an
 * implementation detail. Any real implementation failure surfaces as the
 * unchecked StorageException instead.
 *
 * initCustomer/createDocument each take their identifying metadata
 * up front, bundled with provisioning, rather than as a separate write
 * step -- they're never called independently of one another, and keeping
 * them separate methods only invited a caller to leak *how* an
 * implementation durably records that identity (in git's case, a file
 * every branch inherits via ordinary ancestry) as if it were a generic
 * primitive in its own right. This interface only promises the identity
 * is recorded durably enough to survive losing the Postgres index and be
 * recovered from storage alone -- not how.
 *
 * Distinct on purpose from DocumentIndexService (Postgres-backed queries)
 * -- this interface is about content and history, that one is about fast
 * lookups. Collapsing them into one interface would blur exactly the line
 * this RFC draws between the two.
 */
public interface DocumentStorageService {

  /** Provisions storage for a brand-new customer and durably records its identity. Idempotent: a no-op if already provisioned. */
  void initCustomer(String customerId, CustomerMeta meta);

  /** Provisions a brand-new document (seeding its initial version) and durably records its identity. Returns the initial version's identifier. */
  String createDocument(DocumentRef doc, DocumentMeta meta);

  Optional<byte[]> load(DocumentRef doc, String versionName);

  /**
   * Writes a new version carrying contentBytes/markdown/changelogJson for
   * this document. Returns an opaque identifier for that new version so
   * the caller (DocumentPersistenceCoordinator) can record it as
   * branches.head_commit_sha.
   */
  String save(DocumentRef doc, String versionName,
              byte[] contentBytes, String markdown, String changelogJson, String author);

  /** Returns the new version's current identifier (same as fromVersionName's). */
  String createVersion(DocumentRef doc, String versionName, String fromVersionName);

  void deleteVersion(DocumentRef doc, String versionName);

  MergeOutcome merge(DocumentRef doc, String sourceVersionName, String targetVersionName,
                      byte[] mergedContentBytes, String mergedMarkdown, String author);
}
