package com.diy.blueprints.collabeditor.persistence.orchestration;

import com.diy.blueprints.collabeditor.persistence.MergeOutcome;
import com.diy.blueprints.collabeditor.persistence.index.DocumentIndexService;
import com.diy.blueprints.collabeditor.persistence.index.entity.Branch;
import com.diy.blueprints.collabeditor.persistence.index.entity.Customer;
import com.diy.blueprints.collabeditor.persistence.index.entity.Document;
import com.diy.blueprints.collabeditor.persistence.storage.CustomerMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentMeta;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentRef;
import com.diy.blueprints.collabeditor.persistence.storage.DocumentStorageService;

import java.util.UUID;

/**
 * The "assembling service" (RFC: multi-tenant scale, STATE.md) -- every
 * write that needs to touch both git and the Postgres index goes through
 * here, and only here, so the ordering rule (git write first, index
 * update second -- git is truth, a failed index update is deferred work,
 * never a reason to fail the caller) has exactly one place it can be
 * gotten wrong, not every call site. Reads never come through this class
 * at all -- see DocumentIndexService, called directly by controllers.
 *
 * NOT yet a @Service bean, same reasoning as everything else in this RFC
 * pass: its dependencies (DocumentIndexService's real implementation)
 * aren't Spring-managed yet either. See STATE.md.
 */
public class DocumentPersistenceCoordinator {

  private final DocumentStorageService storage;
  private final DocumentIndexService index;

  public DocumentPersistenceCoordinator(DocumentStorageService storage, DocumentIndexService index) {
    this.storage = storage;
    this.index = index;
  }

  public Customer createCustomer(String slug, String displayName) {
    UUID id = UUID.randomUUID();
    String repoPath = id.toString(); // GitDocumentStorageService derives the actual sharded path from the id itself

    Customer customer = new Customer(id, slug, displayName, repoPath);
    index.upsertCustomer(customer); // status=PROVISIONING (entity default) -- visible-but-not-ready if this crashes here

    storage.initCustomer(id.toString(), new CustomerMeta(id.toString(), slug, displayName));

    customer.setStatus(Customer.Status.READY);
    return index.upsertCustomer(customer);
  }

  public Document createDocument(DocumentRef doc, String title) {
    // Seeds an empty initial "master" version and records DocumentMeta in
    // the same commit (see DocumentStorageService/GitDocumentStorageService
    // javadoc for why these aren't two separate calls). Empty content is a
    // placeholder for this sketch -- once this is wired to a real caller
    // (collab-server), the actual initial Yjs state (which only Yjs itself
    // can produce) belongs here instead.
    String versionId = storage.createDocument(doc, new DocumentMeta(doc.docId(), doc.language(), title));

    Document document = index.upsertDocument(new Document(UUID.fromString(doc.customerId()), doc.docId(), doc.language(), title));
    Branch branch = new Branch(document.getId(), "master", gitRef(doc, "master"), true, "system");
    branch.setHeadCommitSha(versionId);
    index.upsertBranch(branch);
    return document;
  }

  public Branch createVersion(DocumentRef doc, String versionName, String fromVersionName) {
    String versionId = storage.createVersion(doc, versionName, fromVersionName);

    UUID documentId = index.getDocument(UUID.fromString(doc.customerId()), doc.docId(), doc.language())
        .orElseThrow(() -> new IllegalStateException("document not found in index: " + doc.docId() + "/" + doc.language()))
        .getId();
    Branch branch = new Branch(documentId, versionName, gitRef(doc, versionName), false, "system");
    branch.setHeadCommitSha(versionId);
    return index.upsertBranch(branch);
  }

  public void deleteVersion(DocumentRef doc, String versionName) {
    storage.deleteVersion(doc, versionName);
    UUID documentId = index.getDocument(UUID.fromString(doc.customerId()), doc.docId(), doc.language())
        .map(Document::getId)
        .orElse(null);
    if (documentId != null) {
      index.deleteVersion(documentId, versionName);
    }
  }

  public String saveSnapshot(DocumentRef doc, String versionName,
                              byte[] contentBytes, String markdown, String changelogJson, String author) {
    String versionId = storage.save(doc, versionName, contentBytes, markdown, changelogJson, author);

    index.getDocument(UUID.fromString(doc.customerId()), doc.docId(), doc.language()).ifPresent(document -> {
      Branch b = new Branch(document.getId(), versionName, gitRef(doc, versionName), "master".equals(versionName), author);
      b.setHeadCommitSha(versionId);
      index.upsertBranch(b);
    });
    return versionId;
  }

  public MergeOutcome mergeBranch(DocumentRef doc, String sourceVersionName, String targetVersionName,
                                   byte[] mergedContentBytes, String mergedMarkdown, String author) {
    MergeOutcome outcome = storage.merge(doc, sourceVersionName, targetVersionName,
        mergedContentBytes, mergedMarkdown, author);

    if (outcome.merged()) {
      index.getDocument(UUID.fromString(doc.customerId()), doc.docId(), doc.language()).ifPresent(document -> {
        Branch b = new Branch(document.getId(), targetVersionName, gitRef(doc, targetVersionName),
            "master".equals(targetVersionName), author);
        b.setHeadCommitSha(outcome.commitId());
        index.upsertBranch(b);
      });
    }
    return outcome;
  }

  private static String gitRef(DocumentRef doc, String versionName) {
    return "refs/heads/docs/" + doc.docId() + "/" + doc.language() + "/" + versionName;
  }
}
