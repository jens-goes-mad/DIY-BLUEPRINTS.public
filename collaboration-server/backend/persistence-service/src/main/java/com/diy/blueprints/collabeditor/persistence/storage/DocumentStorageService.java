package com.diy.blueprints.collabeditor.persistence.storage;

import com.diy.blueprints.collabeditor.persistence.BlameLine;
import com.diy.blueprints.collabeditor.persistence.MergeOutcome;

import java.util.List;
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
 * A version is a unit of change that may touch several languages over
 * its lifetime, not a per-language branch namespace (revised design --
 * see DocumentRef's javadoc and STATE.md's RFC section): it typically
 * starts by changing one language (often the source/master language) and
 * picks up translations incrementally, all within the same version,
 * until merging to master represents "every language is ready to ship."
 * That's why language is a parameter alongside versionName on the
 * content methods below, not part of DocumentRef itself.
 *
 * Distinct on purpose from DocumentIndexService (Postgres-backed queries)
 * -- this interface is about content and history, that one is about fast
 * lookups. Collapsing them into one interface would blur exactly the line
 * this RFC draws between the two.
 *
 * listDocuments/listVersions/loadChangelog/history/findMergeBase are all
 * on this interface too (revised -- see STATE.md), even though today's
 * only implementation happens to answer them by walking git refs/blame:
 * "what documents does this customer have," "what versions does this
 * document have," "who last touched this line," and "where did these two
 * versions diverge" are questions any version-aware storage backend has
 * to be able to answer, not git-specific concerns -- unlike, say, a raw
 * ref name or a JGit type, which really would leak the implementation.
 * The dividing line is "could a different backend answer this in its own
 * way," not "does the current implementation happen to use git for it."
 */
public interface DocumentStorageService {

  /** Provisions storage for a brand-new customer and durably records its identity. Idempotent: a no-op if already provisioned. */
  void initCustomer(String customerId, CustomerMeta meta);

  /** Every document belonging to this customer. */
  List<String> listDocuments(String customerId);

  /** Provisions a brand-new document (seeding its master version, no language content yet) and durably records its identity. Returns the initial version's identifier. */
  String createDocument(DocumentRef doc, DocumentMeta meta);

  /** Every version (branch) this document has. */
  List<String> listVersions(DocumentRef doc);

  /** Every language present in this version's tree. */
  List<String> listLanguages(DocumentRef doc, String versionName);

  /**
   * versionName is usually a real named version, but may also be an
   * opaque revision identifier this interface previously handed back (see
   * save()/createVersion()/findMergeBase()) -- e.g. loading content as of
   * the merge-base commit before a 3-way merge, which has no version name
   * of its own.
   */
  Optional<byte[]> load(DocumentRef doc, String versionName, String language);

  /**
   * The changelog committed alongside the most recent save for this
   * language -- individual per-save chunks since the previous commit on
   * this version, not the whole history (see save()'s own changelogJson
   * parameter). Empty string if nothing has been saved yet.
   */
  String loadChangelog(DocumentRef doc, String versionName, String language);

  /**
   * Writes contentBytes/markdown/changelogJson for one language within
   * this version. Returns an opaque identifier for the resulting version
   * state so the caller (DocumentPersistenceCoordinator) can record it as
   * branches.head_commit_sha. Every other language already present in
   * this version's tree, and the document's own meta.json, are carried
   * forward untouched.
   */
  String save(DocumentRef doc, String versionName, String language,
              byte[] contentBytes, String markdown, String changelogJson, String author);

  /** Returns the new version's current identifier (same as fromVersionName's). */
  String createVersion(DocumentRef doc, String versionName, String fromVersionName);

  void deleteVersion(DocumentRef doc, String versionName);

  MergeOutcome merge(DocumentRef doc, String sourceVersionName, String targetVersionName, String language,
                      byte[] mergedContentBytes, String mergedMarkdown, String author);

  /** Per-line attribution for this language's content, oldest surviving edit per line. Empty list if nothing has been saved yet. */
  List<BlameLine> history(DocumentRef doc, String versionName, String language);

  /**
   * The commit/revision both versions diverged from -- needed before a
   * merge, to detect conflicts by decoding what each version actually
   * changed relative to this shared ancestor. Null if the versions share
   * no history at all.
   */
  String findMergeBase(DocumentRef doc, String versionA, String versionB);
}
