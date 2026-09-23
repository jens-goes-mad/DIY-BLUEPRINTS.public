package com.diy.blueprints.collabeditor.persistence.reconcile;

import com.diy.blueprints.collabeditor.persistence.index.DocumentIndexService;
import com.diy.blueprints.collabeditor.persistence.index.entity.Branch;
import com.diy.blueprints.collabeditor.persistence.index.entity.Customer;
import com.diy.blueprints.collabeditor.persistence.index.entity.Document;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentRef;
import com.diy.blueprints.collabeditor.persistence.storage.GitDocumentStorageService;
import com.diy.blueprints.collabeditor.persistence.storage.StorageException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;

/**
 * The actual durability guarantee behind the RFC's index (STATE.md) --
 * the outbox (OutboxWorker) is only the fast path; if Postgres is
 * unreachable at the exact instant of a git write, neither the direct
 * index update nor the outbox row happens, and this is what eventually
 * notices and repairs it, because it derives everything from git's own
 * ref state directly, never from anything already in Postgres.
 *
 * Named and typed for git specifically, on purpose -- reconciliation is
 * inherently about diffing an actual git repo's ref state, not a generic
 * storage concern, so this depends on the concrete GitDocumentStorageService
 * rather than the DocumentStorageService interface. The UI/API layer only
 * ever sees the generic interface; this class is internal wiring between
 * one specific implementation of it and the Postgres index, same as
 * GitDocumentStorageService.findMergeBase is a git-only extra method that
 * was never worth forcing onto the generic contract either.
 *
 * Two cadences once wired in, mirroring the pattern already built and
 * verified for collab-server's own git-checkpoint retry: a startup sweep
 * (catches drift from whenever persistence-service was last down) and a
 * coarser periodic sweep (10-15 min, not seconds -- ref reads are cheap
 * individually but add up across hundreds of repos on a tight interval,
 * and the outbox already covers the common case). NOT yet a @Component/
 * @Scheduled bean, same reasoning as everything else in this RFC pass.
 */
public class GitReconciliationService {

  private static final Logger log = LoggerFactory.getLogger(GitReconciliationService.class);

  private final GitDocumentStorageService storage;
  private final DocumentIndexService index;

  public GitReconciliationService(GitDocumentStorageService storage, DocumentIndexService index) {
    this.storage = storage;
    this.index = index;
  }

  public void reconcileAll() {
    for (Customer customer : index.listCustomers()) {
      if (customer.getStatus() != Customer.Status.READY) continue;
      try {
        reconcileCustomer(customer);
      } catch (StorageException e) {
        log.error("[reconcile] failed for customer {}: {}", customer.getId(), e.getMessage());
      }
    }
  }

  public void reconcileCustomer(Customer customer) {
    Map<String, String> observedRefs = storage.listAllRefs(customer.getId()); // ref path -> tip SHA

    for (Map.Entry<String, String> entry : observedRefs.entrySet()) {
      RefParts parts = RefParts.parse(entry.getKey());
      if (parts == null) continue; // doesn't match our naming convention -- not one of ours, skip

      Document document = index.getDocument(customer.getId(), parts.docId())
          .orElseGet(() -> recoverDocument(customer, parts));

      Branch existing = index.listBranches(document.getId()).stream()
          .filter(b -> b.getVersionName().equals(parts.versionName()))
          .findFirst().orElse(null);

      String observedSha = entry.getValue();
      if (existing == null || !observedSha.equals(existing.getHeadCommitSha())) {
        Branch branch = new Branch(document.getId(), parts.versionName(), entry.getKey(),
            "master".equals(parts.versionName()), null);
        branch.setHeadCommitSha(observedSha);
        index.upsertBranch(branch);
        log.info("[reconcile] {} branch {} -> {}", existing == null ? "recovered" : "corrected", entry.getKey(), observedSha);
      }
    }

    // Deletion pass: any branch row whose ref no longer exists in git.
    for (Document document : index.listDocuments(customer.getId())) {
      for (Branch branch : index.listBranches(document.getId())) {
        if (!observedRefs.containsKey(branch.getGitRef())) {
          index.deleteVersion(document.getId(), branch.getVersionName());
          log.info("[reconcile] removed stale branch row {}", branch.getGitRef());
        }
      }
    }
  }

  /**
   * A branch ref with no matching Document row at all -- recovers full
   * identity, including title, from that branch's own meta.json (written
   * once at document creation, document-level not language-scoped,
   * inherited by every version via ordinary git ancestry -- see
   * DocumentMeta's javadoc). This is exactly the gap that writing
   * metadata into git, not only Postgres, was decided to close.
   */
  private Document recoverDocument(Customer customer, RefParts parts) {
    String title = null;
    try {
      DocumentRef doc = new DocumentRef(customer.getId(), parts.docId());
      title = storage.readDocumentMeta(doc, parts.versionName())
          .map(DocumentMeta::title)
          .orElse(null);
    } catch (StorageException e) {
      log.error("[reconcile] failed to read meta.json for {}: {}", parts.docId(), e.getMessage());
    }
    log.info("[reconcile] recovered document {} (title={})", parts.docId(), title);
    return index.upsertDocument(new Document(customer.getId(), parts.docId(), title));
  }

  /** refs/heads/docs/<docId>/<versionName> */
  private record RefParts(String docId, String versionName) {
    static RefParts parse(String ref) {
      String prefix = "refs/heads/docs/";
      if (!ref.startsWith(prefix)) return null;
      String[] parts = ref.substring(prefix.length()).split("/", 2);
      if (parts.length != 2) return null;
      return new RefParts(parts[0], parts[1]);
    }
  }
}
