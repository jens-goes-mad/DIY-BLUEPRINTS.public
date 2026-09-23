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

  /** customerId is caller-supplied -- a readable, git-URL-friendly slug (e.g. "acme-corp"), not generated here. */
  public Customer createCustomer(String customerId, String displayName) {
    Customer customer = new Customer(customerId, displayName);
    index.upsertCustomer(customer); // status=PROVISIONING (entity default) -- visible-but-not-ready if this crashes here

    storage.initCustomer(customerId, new CustomerMeta(customerId, displayName));

    customer.setStatus(Customer.Status.READY);
    return index.upsertCustomer(customer);
  }

  public Document createDocument(DocumentRef doc, String title) {
    // Seeds an empty master version with just DocumentMeta -- no language
    // content yet (see DocumentStorageService/GitDocumentStorageService
    // javadoc: languages get added incrementally via save() as
    // translations land, all within this same version).
    String versionId = storage.createDocument(doc, new DocumentMeta(doc.docId(), title));

    Document document = index.upsertDocument(new Document(doc.customerId(), doc.docId(), title));
    Branch branch = new Branch(document.getId(), "master", gitRef(doc, "master"), true, "system");
    branch.setHeadCommitSha(versionId);
    index.upsertBranch(branch);
    return document;
  }

  public Branch createVersion(DocumentRef doc, String versionName, String fromVersionName) {
    String versionId = storage.createVersion(doc, versionName, fromVersionName);

    UUID documentId = index.getDocument(doc.customerId(), doc.docId())
        .orElseThrow(() -> new IllegalStateException("document not found in index: " + doc.docId()))
        .getId();
    Branch branch = new Branch(documentId, versionName, gitRef(doc, versionName), false, "system");
    branch.setHeadCommitSha(versionId);
    return index.upsertBranch(branch);
  }

  public void deleteVersion(DocumentRef doc, String versionName) {
    storage.deleteVersion(doc, versionName);
    UUID documentId = index.getDocument(doc.customerId(), doc.docId())
        .map(Document::getId)
        .orElse(null);
    if (documentId != null) {
      index.deleteVersion(documentId, versionName);
    }
  }

  public String saveSnapshot(DocumentRef doc, String versionName, String language,
                              byte[] contentBytes, String markdown, String changelogJson, String author) {
    String versionId = storage.save(doc, versionName, language, contentBytes, markdown, changelogJson, author);

    index.getDocument(doc.customerId(), doc.docId()).ifPresent(document -> {
      Branch b = new Branch(document.getId(), versionName, gitRef(doc, versionName), "master".equals(versionName), author);
      b.setHeadCommitSha(versionId);
      index.upsertBranch(b);
    });
    return versionId;
  }

  public MergeOutcome mergeBranch(DocumentRef doc, String sourceVersionName, String targetVersionName, String language,
                                   byte[] mergedContentBytes, String mergedMarkdown, String author) {
    MergeOutcome outcome = storage.merge(doc, sourceVersionName, targetVersionName, language,
        mergedContentBytes, mergedMarkdown, author);

    if (outcome.merged()) {
      index.getDocument(doc.customerId(), doc.docId()).ifPresent(document -> {
        Branch b = new Branch(document.getId(), targetVersionName, gitRef(doc, targetVersionName),
            "master".equals(targetVersionName), author);
        b.setHeadCommitSha(outcome.commitId());
        index.upsertBranch(b);
      });
    }
    return outcome;
  }

  private static String gitRef(DocumentRef doc, String versionName) {
    return "refs/heads/docs/" + doc.docId() + "/" + versionName;
  }
}
