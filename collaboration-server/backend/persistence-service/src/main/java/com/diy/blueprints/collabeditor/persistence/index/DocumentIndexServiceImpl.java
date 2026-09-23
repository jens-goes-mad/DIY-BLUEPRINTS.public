package com.diy.blueprints.collabeditor.persistence.index;

import com.diy.blueprints.collabeditor.persistence.index.entity.Branch;
import com.diy.blueprints.collabeditor.persistence.index.entity.Customer;
import com.diy.blueprints.collabeditor.persistence.index.entity.Document;
import com.diy.blueprints.collabeditor.persistence.index.entity.OutboxEvent;
import com.diy.blueprints.collabeditor.persistence.index.repository.BranchRepository;
import com.diy.blueprints.collabeditor.persistence.index.repository.CustomerRepository;
import com.diy.blueprints.collabeditor.persistence.index.repository.DocumentRepository;
import com.diy.blueprints.collabeditor.persistence.index.repository.OutboxRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * NOT yet @Service-annotated -- see STATE.md's RFC section. This class is
 * otherwise final-shape Spring Data JPA code (constructor injection); the
 * only remaining wiring step, once a real Postgres container exists and
 * the JPA autoconfiguration exclusion in application.yml is lifted, is
 * adding @Service here.
 *
 * Write methods try the direct entity save first -- the fast, common-case
 * path -- and only fall back to a pending OutboxEvent row if that throws.
 * This is deliberate, not incidental: an outbox row recorded unconditionally
 * alongside every successful save (the classical textbook shape) would be
 * pointless here, since a save and its outbox row in the same transaction
 * either both happen or both roll back together -- there'd never be a
 * pending row for OutboxWorker to actually retry. Recording the outbox row
 * only on failure is what gives it a real job: catching writes that failed
 * outright. Never lets an index failure fail the caller's overall
 * operation -- git already has the real write by the time this runs (see
 * DocumentPersistenceCoordinator), so an index-side problem is deferred
 * work, not an error to surface.
 */
public class DocumentIndexServiceImpl implements DocumentIndexService {

  private static final Logger log = LoggerFactory.getLogger(DocumentIndexServiceImpl.class);
  private static final ObjectMapper JSON = new ObjectMapper();

  private final CustomerRepository customers;
  private final DocumentRepository documents;
  private final BranchRepository branches;
  private final OutboxRepository outbox;

  public DocumentIndexServiceImpl(CustomerRepository customers, DocumentRepository documents,
                                   BranchRepository branches, OutboxRepository outbox) {
    this.customers = customers;
    this.documents = documents;
    this.branches = branches;
    this.outbox = outbox;
  }

  @Override
  public List<Customer> listCustomers() {
    return customers.findAll();
  }

  @Override
  public Optional<Customer> getCustomer(String customerId) {
    return customers.findById(customerId);
  }

  @Override
  public List<Document> listDocuments(String customerId) {
    return documents.findByCustomerId(customerId);
  }

  @Override
  public Optional<Document> getDocument(String customerId, String docId) {
    return documents.findByCustomerIdAndDocId(customerId, docId);
  }

  @Override
  public List<Branch> listBranches(UUID documentId) {
    return branches.findByDocumentId(documentId);
  }

  @Override
  public Customer upsertCustomer(Customer customer) {
    try {
      return customers.save(customer);
    } catch (Exception e) {
      queuePending("customer_upserted", Map.of(
          "id", customer.getId(), "displayName", customer.getDisplayName()), e);
      return customer;
    }
  }

  @Override
  public Document upsertDocument(Document document) {
    try {
      // Callers (DocumentPersistenceCoordinator) construct a fresh
      // transient Document every time, including on what's semantically
      // an update -- find the real managed row by natural key first so a
      // repeat call updates it in place instead of colliding with the
      // (customerId, docId) unique constraint on a blind insert.
      Document toSave = documents.findByCustomerIdAndDocId(document.getCustomerId(), document.getDocId())
          .orElse(document);
      toSave.touch();
      return documents.save(toSave);
    } catch (Exception e) {
      queuePending("document_upserted", Map.of(
          "customerId", document.getCustomerId(),
          "docId", document.getDocId(),
          "title", String.valueOf(document.getTitle())), e);
      return document;
    }
  }

  @Override
  public Branch upsertBranch(Branch branch) {
    try {
      // Same reasoning as upsertDocument above: find the existing row by
      // (documentId, versionName) and update its headCommitSha in place,
      // rather than saving the caller's fresh transient instance and
      // colliding with the unique constraint on every call after the
      // first for the same branch.
      Branch toSave = branches.findByDocumentIdAndVersionName(branch.getDocumentId(), branch.getVersionName())
          .map(existing -> { existing.setHeadCommitSha(branch.getHeadCommitSha()); return existing; })
          .orElse(branch);
      return branches.save(toSave);
    } catch (Exception e) {
      queuePending("branch_upserted", Map.of(
          "documentId", branch.getDocumentId().toString(),
          "versionName", branch.getVersionName(),
          "gitRef", branch.getGitRef(),
          "isDefault", String.valueOf(branch.isDefault()),
          "headCommitSha", String.valueOf(branch.getHeadCommitSha()),
          "createdBy", String.valueOf(branch.getCreatedBy())), e);
      return branch;
    }
  }

  @Override
  public void deleteVersion(UUID documentId, String versionName) {
    try {
      branches.findByDocumentIdAndVersionName(documentId, versionName).ifPresent(branches::delete);
    } catch (Exception e) {
      queuePending("branch_deleted", Map.of("documentId", documentId.toString(), "versionName", versionName), e);
    }
  }

  /**
   * Best-effort: if even this fails, Postgres is genuinely unreachable and
   * nothing left in this class can help -- GitReconciliationService's
   * independent git-ref diff (not dependent on the outbox table at all) is
   * the actual backstop for that case. Logged loudly either way, matching
   * the "push until someone notices the logs" approach used throughout
   * this codebase's other retry paths.
   */
  private void queuePending(String eventType, Map<String, String> payload, Exception directWriteFailure) {
    log.error("[index] direct write failed for {}, queuing outbox retry: {}", eventType, directWriteFailure.getMessage());
    try {
      outbox.save(new OutboxEvent(eventType, JSON.writeValueAsString(payload)));
    } catch (Exception outboxAlsoFailed) {
      log.error("[index] outbox queue ALSO failed for {} -- relying entirely on the reconciliation sweep: {}",
          eventType, outboxAlsoFailed.getMessage());
    }
  }
}
