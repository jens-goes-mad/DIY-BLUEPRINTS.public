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

import java.util.Map;
import java.util.UUID;

/**
 * Retries whatever DocumentIndexServiceImpl's direct write path couldn't
 * apply (see its javadoc -- a row only exists here because a direct save
 * threw). NOT yet a @Component/@Scheduled bean, same reasoning as every
 * other new class in this RFC pass (STATE.md): once a real Postgres
 * container and polling schedule are wired in, the only remaining step is
 * annotating this class and its applyPending() method -- nothing about
 * the logic itself needs to change.
 *
 * Each apply is a lookup-by-natural-key upsert (findByX, update if
 * present else insert), not a raw re-save by primary key -- the payload
 * doesn't carry the original entity's own id, deliberately, so retrying
 * the same event twice (at-least-once delivery) is naturally idempotent
 * without any separate dedup table.
 */
public class OutboxWorker {

  private static final Logger log = LoggerFactory.getLogger(OutboxWorker.class);
  private static final ObjectMapper JSON = new ObjectMapper();

  private final OutboxRepository outbox;
  private final CustomerRepository customers;
  private final DocumentRepository documents;
  private final BranchRepository branches;

  public OutboxWorker(OutboxRepository outbox, CustomerRepository customers,
                       DocumentRepository documents, BranchRepository branches) {
    this.outbox = outbox;
    this.customers = customers;
    this.documents = documents;
    this.branches = branches;
  }

  /** Intended to run on a short, frequent schedule (seconds, not minutes) once wired in -- this is the fast retry path. */
  public void applyPending() {
    for (OutboxEvent event : outbox.findByProcessedAtIsNullOrderByIdAsc()) {
      try {
        apply(event);
        event.markProcessed();
        outbox.save(event);
      } catch (Exception e) {
        event.recordFailure(e.getMessage());
        outbox.save(event);
        log.error("[outbox] retry failed for event {} ({}), attempt {}: {}",
            event.getId(), event.getEventType(), event.getAttempts(), e.getMessage());
      }
    }
  }

  @SuppressWarnings("unchecked")
  private void apply(OutboxEvent event) throws Exception {
    Map<String, String> payload = JSON.readValue(event.getPayload(), Map.class);
    switch (event.getEventType()) {
      case "customer_upserted" -> applyCustomer(payload);
      case "document_upserted" -> applyDocument(payload);
      case "branch_upserted" -> applyBranch(payload);
      case "branch_deleted" -> applyBranchDeletion(payload);
      default -> throw new IllegalStateException("unknown outbox event type: " + event.getEventType());
    }
  }

  private void applyCustomer(Map<String, String> p) {
    // id is the readable slug itself now (see Customer.java) -- the same
    // one the coordinator already used to create the actual git repo, so
    // looking it up directly by id is enough; no separate slug field to
    // search by.
    Customer customer = customers.findById(p.get("id"))
        .orElseGet(() -> new Customer(p.get("id"), p.get("displayName")));
    // status isn't carried in the payload and defaults to PROVISIONING for
    // a brand-new row -- acceptable simplification for this pass; revisit
    // if a retried customer needs to preserve a status change too.
    customers.save(customer);
  }

  private void applyDocument(Map<String, String> p) {
    String customerId = p.get("customerId");
    Document document = documents.findByCustomerIdAndDocId(customerId, p.get("docId"))
        .orElseGet(() -> new Document(customerId, p.get("docId"), p.get("title")));
    documents.save(document);
  }

  private void applyBranch(Map<String, String> p) {
    UUID documentId = UUID.fromString(p.get("documentId"));
    Branch branch = branches.findByDocumentIdAndVersionName(documentId, p.get("versionName"))
        .orElseGet(() -> new Branch(documentId, p.get("versionName"), p.get("gitRef"),
            Boolean.parseBoolean(p.get("isDefault")), nullIfLiteral(p.get("createdBy"))));
    branch.setHeadCommitSha(nullIfLiteral(p.get("headCommitSha")));
    branches.save(branch);
  }

  private void applyBranchDeletion(Map<String, String> p) {
    UUID documentId = UUID.fromString(p.get("documentId"));
    branches.findByDocumentIdAndVersionName(documentId, p.get("versionName")).ifPresent(branches::delete);
  }

  private static String nullIfLiteral(String s) {
    return "null".equals(s) ? null : s; // String.valueOf(null) at the call site produced the literal "null"
  }
}
